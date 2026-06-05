import Anthropic from "@anthropic-ai/sdk";
import axios     from "axios";
import { query } from "../db/postgres.js";

const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const META_VERSION = process.env.META_API_VERSION || "v19.0";

// ── Generic re-engagement templates ──────────────────────────
// These are pre-approved Meta templates — one per scenario
const TEMPLATES = {
  alternative_product: {
    name:   "yougant_reengagement_alternative",
    text:   "Hi {{1}}, we noticed you were looking for {{2}}. We have some great alternatives that might interest you — {{3}}. Would you like to know more?",
    params: (lead, alternatives) => [
      lead.customer_name || "there",
      lead.collected_details?.service || "a product",
      alternatives,
    ],
  },
  discount_offer: {
    name:   "yougant_reengagement_offer",
    text:   "Hi {{1}}, we have a special offer on {{2}} that you might like! {{3}}. Interested to know more?",
    params: (lead, product, offer) => [
      lead.customer_name || "there",
      product,
      offer,
    ],
  },
  general_followup: {
    name:   "yougant_reengagement_followup",
    text:   "Hi {{1}}, we wanted to check if you're still looking for {{2}}. We'd love to help you find the perfect option. Can we assist you?",
    params: (lead, product) => [
      lead.customer_name || "there",
      product || "what you need",
    ],
  },
};

// ── Main re-engagement function ───────────────────────────────
export async function runReEngagement(businessId) {
  console.log(`🔄 Running re-engagement for business ${businessId}`);

  try {
    // Get re-engagement settings
    const { rows: settingsRows } = await query(
      "SELECT * FROM re_engagement_settings WHERE business_id = $1",
      [businessId]
    );
    const settings = settingsRows[0] || { enabled: true, delay_days: 3, max_attempts: 2 };

    if (!settings.enabled) {
      console.log("Re-engagement disabled for this business");
      return;
    }

    // Get WhatsApp config
    const { rows: waRows } = await query(
      "SELECT access_token, phone_number_id FROM whatsapp_configs WHERE business_id = $1",
      [businessId]
    );
    if (!waRows.length || !waRows[0].access_token) return;

    const { access_token, phone_number_id } = waRows[0];

    // Get cold leads
    const { rows: coldLeads } = await query(`
      SELECT l.*, b.name AS business_name, b.category AS business_category
      FROM leads l
      JOIN businesses b ON b.id = l.business_id
      WHERE l.business_id      = $1
        AND l.status           NOT IN ('converted', 'closed')
        AND l.re_engagement_status NOT IN ('opted_out')
        AND l.re_engagement_count  < $2
        AND (l.last_re_engaged_at IS NULL 
             OR l.last_re_engaged_at < NOW() - INTERVAL '7 days')
        AND l.created_at < NOW() - INTERVAL '$3 days'
        AND l.phone IS NOT NULL
      ORDER BY l.created_at ASC
      LIMIT 20
    `.replace("'$3 days'", `'${settings.delay_days} days'`),
    [businessId, settings.max_attempts]);

    console.log(`📋 Found ${coldLeads.length} cold leads to re-engage`);

    // Get latest insights for smart suggestions
    const { rows: insightRows } = await query(`
      SELECT data FROM insights
      WHERE business_id = $1 AND type = 'product_demand'
      ORDER BY created_at DESC LIMIT 1
    `, [businessId]);
    const topProducts = insightRows[0]?.data?.slice(0, 5) || [];

    let engaged = 0;
    for (const lead of coldLeads) {
      try {
        await reEngageLead(lead, topProducts, access_token, phone_number_id, settings.message_tone);
        engaged++;
        // Small delay between messages
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error(`Failed to re-engage lead ${lead.id}:`, err.message);
      }
    }

    console.log(`✅ Re-engaged ${engaged}/${coldLeads.length} leads`);
  } catch (err) {
    console.error("Re-engagement error:", err.message);
  }
}

// ── Re-engage a single lead ───────────────────────────────────
async function reEngageLead(lead, topProducts, accessToken, phoneNumberId, tone) {
  // Generate personalized message using Claude
  const { templateType, variables } = await generateReEngagementMessage(lead, topProducts, tone);

  // Send via WhatsApp template
  const template   = TEMPLATES[templateType];
  const params     = template.params(...variables);

  await axios.post(
    `https://graph.facebook.com/${META_VERSION}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to:                lead.phone,
      type:              "template",
      template: {
        name:       template.name,
        language:   { code: "en" },
        components: [{
          type:       "body",
          parameters: params.map(p => ({ type: "text", text: String(p) })),
        }],
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  // Update lead
  await query(`
    UPDATE leads
    SET re_engagement_count   = re_engagement_count + 1,
        last_re_engaged_at    = NOW(),
        re_engagement_status  = 'sent',
        updated_at            = NOW()
    WHERE id = $1
  `, [lead.id]);

  console.log(`✅ Re-engaged: ${lead.customer_name || lead.phone}`);
}

// ── Generate smart re-engagement message ─────────────────────
async function generateReEngagementMessage(lead, topProducts, tone = "friendly") {
  const details    = lead.collected_details || {};
  const topProdStr = topProducts.map(p => p.name).join(", ");

  const prompt = `A customer showed interest in buying from ${lead.business_name} (${lead.business_category || "business"}) but didn't convert.

Customer info:
- Name: ${lead.customer_name || "Unknown"}
- Was interested in: ${details.service || details.domain || "general inquiry"}
- Budget mentioned: ${details.budget || "not mentioned"}
- Our top products right now: ${topProdStr || "various products"}

Choose the BEST re-engagement approach and return JSON only:

{
  "templateType": "alternative_product" or "discount_offer" or "general_followup",
  "variables": [
    array of strings to fill template placeholders
  ],
  "reasoning": "why this approach"
}

Rules:
- "alternative_product": if budget was too low or specific item unavailable → suggest alternatives
- "discount_offer": if price was the issue → mention offer
- "general_followup": if no clear reason or just went silent
- Tone: ${tone}
- Keep suggestions relevant to their interest
- For alternative_product: variables = [lead_name, what_they_wanted, alternatives_str]
- For discount_offer: variables = [lead_name, product, offer_str]
- For general_followup: variables = [lead_name, product]`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages:   [{ role: "user", content: prompt }],
  });

  const text    = response.content[0]?.text?.trim() || "{}";
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    const result = JSON.parse(cleaned);
    console.log(`💡 Re-engagement strategy: ${result.templateType} — ${result.reasoning}`);
    return {
      templateType: result.templateType || "general_followup",
      variables:    result.variables    || [lead.customer_name || "there", details.service || "our products"],
    };
  } catch {
    return {
      templateType: "general_followup",
      variables:    [lead.customer_name || "there", details.service || "our products"],
    };
  }
}