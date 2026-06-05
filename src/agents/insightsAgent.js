import Anthropic    from "@anthropic-ai/sdk";
import { query }    from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Main analysis function ────────────────────────────────────
export async function analyzeConversations(businessId, runId) {
  console.log(`🧠 Starting insights analysis for business ${businessId}`);

  try {
    // Fetch all conversations with messages
    const { rows: conversations } = await query(`
      SELECT
        c.id, c.customer_name, c.customer_phone,
        c.status, c.created_at,
        l.status             AS lead_status,
        l.collected_details,
        l.re_engagement_status,
        (
          SELECT json_agg(json_build_object(
            'role', m.role,
            'text', LEFT(m.content, 300),
            'ts',   m.created_at
          ) ORDER BY m.created_at)
          FROM messages m
          WHERE m.conversation_id = c.id
          LIMIT 20
        ) AS messages
      FROM conversations c
      LEFT JOIN leads l ON l.phone = c.customer_phone
                        AND l.business_id = c.business_id
      WHERE c.business_id = $1
      ORDER BY c.created_at DESC
      LIMIT 500
    `, [businessId]);

    // Get business info for context
    const { rows: bizRows } = await query(
      "SELECT name, category FROM businesses WHERE id = $1",
      [businessId]
    );
    const biz = bizRows[0] || {};

    // Get existing products for gap detection
    const { rows: products } = await query(`
      SELECT name FROM store_products WHERE business_id = $1
      UNION
      SELECT name FROM business_services WHERE business_id = $1 AND is_active = TRUE
    `, [businessId]);
    const productNames = products.map(p => p.name).join(", ");

    // Run analysis in batches of 50
    const BATCH = 50;
    const allResults = {
      product_demand: {},
      lost_reasons:   {},
      demand_gaps:    {},
      peak_hours:     Array(24).fill(0),
      total:          conversations.length,
      converted:      0,
      leads:          0,
    };

    for (let i = 0; i < conversations.length; i += BATCH) {
      const batch = conversations.slice(i, i + BATCH);
      const result = await analyzeBatch(batch, biz, productNames);
      mergeBatchResult(allResults, result);
      console.log(`✅ Analyzed batch ${Math.floor(i/BATCH)+1}/${Math.ceil(conversations.length/BATCH)}`);
    }

    // Generate AI summary
    const summary = await generateSummary(allResults, biz);

    // Save all insights
    await saveInsights(businessId, runId, allResults, summary);

    // Update run status
    await query(`
      UPDATE insight_runs
      SET status = 'completed',
          conversations_analyzed = $1,
          completed_at = NOW()
      WHERE id = $2
    `, [conversations.length, runId]);

    console.log(`✅ Insights complete: ${conversations.length} conversations analyzed`);

  } catch (err) {
    console.error("❌ Analysis error:", err.message);
    await query(
      "UPDATE insight_runs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2",
      [err.message, runId]
    ).catch(() => {});
    throw err;
  }
}

// ── Analyze a batch of conversations ─────────────────────────
async function analyzeBatch(conversations, biz, knownProducts) {
  const summaries = conversations.map(c => {
    const msgs     = c.messages || [];
    const customer = msgs.filter(m => m.role === "customer").map(m => m.text).join(" | ");
    const agent    = msgs.filter(m => m.role === "agent").map(m => m.text).join(" | ");
    return {
      converted:    c.lead_status === "converted",
      is_lead:      !!c.lead_status,
      details:      c.collected_details || {},
      customer_msg: customer.slice(0, 400),
      agent_msg:    agent.slice(0, 200),
      hour:         new Date(c.created_at).getUTCHours() + 5, // approximate IST
    };
  });

  const prompt = `You are analyzing WhatsApp sales conversations for a ${biz.category || "business"} called "${biz.name || "Business"}".

Known products/services: ${knownProducts || "not specified"}

Analyze these ${summaries.length} conversations and extract insights. Return ONLY valid JSON, no other text.

Conversations:
${JSON.stringify(summaries, null, 1)}

Return this exact JSON structure:
{
  "product_demand": [
    {"name": "product name", "mentions": 3, "converted": 1}
  ],
  "lost_reasons": [
    {"reason": "price_too_high|out_of_stock|product_unavailable|went_silent|competitor|other", "count": 5, "examples": ["brief example"]}
  ],
  "demand_gaps": [
    {"product": "product name customer asked for but we don't have", "count": 2}
  ],
  "peak_hours": [0,0,0,0,0,1,2,5,8,10,7,4,6,8,9,7,5,4,3,2,1,1,0,0],
  "converted_count": 5,
  "lead_count": 12
}

Rules:
- product_demand: only real product/service names mentioned by customers
- lost_reasons: why leads did NOT convert
- demand_gaps: products customers asked for that agent said we don't have
- peak_hours: array of 24 numbers (hour 0-23) showing conversation frequency
- Be specific, no generic terms`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages:   [{ role: "user", content: prompt }],
  });

  const text    = response.content[0]?.text?.trim() || "{}";
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn("Failed to parse batch result:", text.slice(0, 100));
    return { product_demand: [], lost_reasons: [], demand_gaps: [], peak_hours: Array(24).fill(0), converted_count: 0, lead_count: 0 };
  }
}

// ── Merge batch results ───────────────────────────────────────
function mergeBatchResult(all, batch) {
  // Merge product demand
  for (const p of (batch.product_demand || [])) {
    const key = p.name?.toLowerCase();
    if (!key) continue;
    if (!all.product_demand[key]) {
      all.product_demand[key] = { name: p.name, mentions: 0, converted: 0 };
    }
    all.product_demand[key].mentions  += p.mentions || 1;
    all.product_demand[key].converted += p.converted || 0;
  }

  // Merge lost reasons
  for (const r of (batch.lost_reasons || [])) {
    const key = r.reason;
    if (!all.lost_reasons[key]) {
      all.lost_reasons[key] = { reason: key, count: 0, examples: [] };
    }
    all.lost_reasons[key].count += r.count || 1;
    if (r.examples?.length) all.lost_reasons[key].examples.push(...r.examples.slice(0, 1));
  }

  // Merge demand gaps
  for (const g of (batch.demand_gaps || [])) {
    const key = g.product?.toLowerCase();
    if (!key) continue;
    if (!all.demand_gaps[key]) {
      all.demand_gaps[key] = { product: g.product, count: 0 };
    }
    all.demand_gaps[key].count += g.count || 1;
  }

  // Merge peak hours
  const hours = batch.peak_hours || Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    all.peak_hours[h] += hours[h] || 0;
  }

  all.converted += batch.converted_count || 0;
  all.leads     += batch.lead_count      || 0;
}

// ── Generate AI summary paragraph ────────────────────────────
async function generateSummary(results, biz) {
  const topProducts = Object.values(results.product_demand)
    .sort((a, b) => b.mentions - a.mentions).slice(0, 3);
  const topLostReason = Object.values(results.lost_reasons)
    .sort((a, b) => b.count - a.count)[0];
  const topGap = Object.values(results.demand_gaps)
    .sort((a, b) => b.count - a.count)[0];

  const prompt = `Write a 3-4 sentence business insight summary for ${biz.name || "a business"} in simple English. Be specific and actionable.

Data:
- Total conversations: ${results.total}
- Leads generated: ${results.leads}
- Conversions: ${results.converted}
- Top products asked: ${topProducts.map(p => `${p.name} (${p.mentions}x)`).join(", ") || "none"}
- Main reason for lost sales: ${topLostReason?.reason || "unknown"} (${topLostReason?.count || 0} cases)
- Most requested unavailable product: ${topGap?.product || "none"} (${topGap?.count || 0} requests)

Write in a helpful, friendly tone. Mention specific actions the owner can take.
Do not use bullet points. Write as a single paragraph.`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages:   [{ role: "user", content: prompt }],
  });

  return response.content[0]?.text?.trim() || "";
}

// ── Save insights to DB ───────────────────────────────────────
async function saveInsights(businessId, runId, results, summary) {
  const types = [
    {
      type: "product_demand",
      data: Object.values(results.product_demand)
        .sort((a, b) => b.mentions - a.mentions).slice(0, 10),
    },
    {
      type: "lost_reasons",
      data: Object.values(results.lost_reasons)
        .sort((a, b) => b.count - a.count),
    },
    {
      type: "demand_gaps",
      data: Object.values(results.demand_gaps)
        .sort((a, b) => b.count - a.count).slice(0, 10),
    },
    {
      type: "peak_hours",
      data: { hours: results.peak_hours },
    },
    {
      type: "conversion",
      data: {
        total:     results.total,
        leads:     results.leads,
        converted: results.converted,
        lead_rate:     results.total > 0 ? Math.round((results.leads / results.total) * 100) : 0,
        convert_rate:  results.leads > 0 ? Math.round((results.converted / results.leads) * 100) : 0,
      },
    },
    {
      type: "ai_summary",
      data: { text: summary },
    },
  ];

  for (const insight of types) {
    await query(`
      INSERT INTO insights (business_id, run_id, type, data)
      VALUES ($1, $2, $3, $4)
    `, [businessId, runId, insight.type, JSON.stringify(insight.data)]);
  }
}