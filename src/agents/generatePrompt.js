import Anthropic from "@anthropic-ai/sdk";
import { query }  from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateBusinessPrompt(businessId) {
  const [
    bizRows, agentRows, servicesRows, faqRows, paymentRows,
    companyRows, qaRows, productRows, knowledgeRows,
  ] = await Promise.all([
    query("SELECT * FROM businesses WHERE id = $1", [businessId]),
    query("SELECT * FROM agent_configs WHERE business_id = $1", [businessId]),
    query("SELECT * FROM business_services WHERE business_id = $1 AND is_active = TRUE LIMIT 20", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_faqs WHERE business_id = $1 LIMIT 20", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_payment_methods WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_company_details WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT question_id, question, answer, category FROM training_qa WHERE business_id = $1 AND answer IS NOT NULL AND answer != '' ORDER BY category, question_id", [businessId]).catch(() => ({ rows: [] })),
    // FIX 3: Pull from products table too
    query("SELECT name, description, price, category, in_stock FROM products WHERE business_id = $1 ORDER BY name ASC LIMIT 30", [businessId]).catch(() => ({ rows: [] })),
    // FIX 2: Pull processed knowledge documents
    query("SELECT file_name, extracted_text FROM knowledge_docs WHERE business_id = $1 AND status = 'processed' AND extracted_text IS NOT NULL ORDER BY created_at DESC LIMIT 5", [businessId]).catch(() => ({ rows: [] })),
  ]);

  const biz       = bizRows.rows[0]     || {};
  const agent     = agentRows.rows[0]   || {};
  const company   = companyRows.rows[0] || {};
  const qaAnswers = qaRows.rows         || [];
  const products  = productRows.rows    || [];
  const knowledgeDocs = knowledgeRows.rows || [];

  // ── Services — merge business_services + products ─────────
  const servicesText = (() => {
    const lines = [];
    if (servicesRows.rows.length > 0) {
      servicesRows.rows.forEach(s => {
        const price = s.price ? `₹${s.price}` : s.price_min ? `₹${s.price_min}–₹${s.price_max}` : "Price on request";
        lines.push(`- ${s.name} (${price})${s.description ? `: ${s.description}` : ""}${s.duration ? ` | ${s.duration}` : ""}`);
      });
    } else if (agent.services) {
      lines.push(agent.services);
    }
    // Add products if any and not already covered by services
    if (products.length > 0) {
      lines.push("\nPRODUCTS:");
      products.forEach(p => {
        const price = p.price ? `₹${p.price}` : "Price on request";
        const stock = p.in_stock === false ? " [Out of stock]" : "";
        lines.push(`- ${p.name} (${price})${stock}${p.description ? `: ${p.description}` : ""}`);
      });
    }
    return lines.length > 0 ? lines.join("\n") : "Not configured";
  })();

  // ── Payment methods ───────────────────────────────────────
  const paymentText = paymentRows.rows.length > 0
    ? paymentRows.rows.map(p => `- ${p.method_name}: ${p.details}${p.instructions ? ` (${p.instructions})` : ""}`).join("\n")
    : "Not configured";

  // ── FAQs ──────────────────────────────────────────────────
  const faqText = faqRows.rows.length > 0
    ? faqRows.rows.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n")
    : "Not configured";

  // ── Company trust ─────────────────────────────────────────
  const companyText = [
    company.trust_message,
    company.total_clients   ? `${company.total_clients}+ clients served` : null,
    company.founded_year    ? `In business since ${company.founded_year}` : null,
    company.gst_number      ? `GST: ${company.gst_number}` : null,
    company.certifications  ? `Certifications: ${company.certifications}` : null,
  ].filter(Boolean).join(" | ") || "Not configured";

  // ── Knowledge docs summary ────────────────────────────────
  const knowledgeText = knowledgeDocs.length > 0
    ? knowledgeDocs.map(d => `[From ${d.file_name}]:\n${(d.extracted_text || "").slice(0, 600)}`).join("\n\n")
    : "";

  // ── Build business context ────────────────────────────────
  const businessContext = `
BUSINESS: ${biz.name || "Not set"} | Category: ${biz.category || agent.services || "Not specified"}
AGENT NAME: ${agent.agent_name || "Agent"} | TONE: ${agent.tone || "friendly"} | LANGUAGE: ${agent.language || "English"}
GREETING: ${agent.greeting || "Not set"}
ADDRESS: ${biz.address || "Not set"} | PHONE: ${biz.phone || "Not set"}
WEBSITE: ${biz.website || "Not set"}

SERVICES & PRODUCTS:
${servicesText}

PRICING INFO: ${agent.pricing || "Not set"}

PAYMENT METHODS:
${paymentText}

FAQs:
${faqText}

TRUST & COMPANY:
${companyText}
${knowledgeText ? `\nBUSINESS DOCUMENTS (use this knowledge to answer customer questions accurately):\n${knowledgeText}` : ""}
`.trim();

  // ── Build Q&A training context ────────────────────────────
  const qaContext = qaAnswers.length > 0 ? buildQAContext(qaAnswers) : "";

  // ── Build the meta prompt ─────────────────────────────────
  const metaPrompt = `You are an expert WhatsApp sales agent prompt engineer for Indian businesses.

Your job is to write a HIGHLY SPECIFIC, ACTIONABLE WhatsApp agent system prompt for this business.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUSINESS INFORMATION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${businessContext}

${qaContext ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OWNER'S TRAINING ANSWERS:
(These are the owner's exact instructions — follow them precisely)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${qaContext}` : ""}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS FOR WRITING THE PROMPT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write a WhatsApp agent system prompt that covers ALL of these sections.
Use the EXACT business name, prices, services, and owner instructions throughout.
The prompt should be written IN ENGLISH but the agent should reply in the language specified by the owner.
If the owner answered questions in Hindi or Hinglish, translate their intent to English for the prompt.

SECTIONS TO COVER (plain text, no markdown, 600-800 words):

1. IDENTITY & ROLE
   - Agent name, business name, what it does
   - Never reveal it is an AI unless directly asked
   - Warm, human personality matching the tone setting

2. PRIMARY GOAL
   - Convert every chat to a lead, order, or appointment
   - What specific info to collect (use owner's exact list from training)
   - Priority order of questions to ask

3. PRODUCTS & SERVICES
   - List actual products/services with real prices from the data above
   - How to explain and recommend
   - What NOT to offer (from owner's training answers)
   - Current offers/discounts if any
   - Stock availability handling if applicable

4. WORKING HOURS & AVAILABILITY
   - Exact days and hours (from owner's answers)
   - What to say outside working hours
   - Holiday and peak season handling

5. APPOINTMENTS & BOOKINGS
   - Whether appointments are needed (from owner's answers)
   - What info to collect for booking
   - Cancellation and rescheduling policy

6. ORDER & PAYMENT PROCESS
   - Step by step order process (from owner's answers)
   - Payment methods accepted with exact details
   - Advance payment requirements
   - Delivery areas and charges
   - Refund/return policy (exact words from owner)

7. AFTER-SALES & SUPPORT
   - Warranty/support coverage
   - How to handle support requests
   - What to escalate vs handle directly

8. CONVERSATION STYLE
   - Reply language and style
   - Emoji usage per owner preference
   - Message length per owner preference
   - Never use bullets, bold, or formatting in WhatsApp replies
   - Natural, conversational tone

9. LEAD QUALIFICATION
   - First question to ask every new customer (use owner's exact instruction)
   - Mandatory info to collect per owner
   - How to ask for budget naturally
   - Serious vs browsing customer signals
   - Minimum budget threshold if set

10. ESCALATION RULES — CRITICAL
    - EXACT trigger phrases that cause immediate human handoff (from owner's list)
    - When to stop replying and alert owner
    - Holding message to send customer when escalating
    - Whether to alert for every lead or only urgent ones

11. HANDLING OBJECTIONS
    - Discount requests: exact response per owner's instruction
    - "I'll think about it" — how to follow up politely
    - "Speak to manager/owner" — exact action to take
    - Competitor comparisons — how to handle
    - Rude or abusive customers — how to respond

12. HARD RULES (NEVER DO)
    - Things owner said agent must NEVER say or promise
    - Out of scope topics to avoid
    - False promises protection

Write the complete prompt now. Be specific, use real business details, and incorporate every owner training answer:`;

  const response = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_MODEL_SMART || "claude-sonnet-4-5",
    max_tokens: 2500,
    messages:   [{ role: "user", content: metaPrompt }],
  });

  const generatedPrompt = response.content[0]?.text?.trim() || "";
  if (!generatedPrompt) throw new Error("Failed to generate prompt");

  await query(`
    INSERT INTO agent_configs (business_id, system_prompt, agent_name, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (business_id) DO UPDATE
    SET system_prompt = $2,
        agent_name    = COALESCE($3, agent_configs.agent_name),
        updated_at    = NOW()
  `, [businessId, generatedPrompt, agent.agent_name || "Agent"]);

  await query(`
    INSERT INTO prompt_history (business_id, prompt, change_note, changed_by)
    VALUES ($1, $2, 'Auto-generated from business data + training Q&A', 'ai')
  `, [businessId, generatedPrompt]).catch(() => {});

  console.log(`✅ Prompt generated for ${biz.name || businessId} — Q&A: ${qaAnswers.length}, products: ${products.length}, docs: ${knowledgeDocs.length}`);
  return generatedPrompt;
}

// ── Format Q&A answers into readable context ──────────────────
// FIX 1: Added all 12 new categories
function buildQAContext(qaAnswers) {
  const categories = {
    identity:     "BUSINESS IDENTITY",
    products:     "PRODUCTS & SERVICES",
    leads:        "LEAD QUALIFICATION",
    orders:       "ORDERS & DELIVERY",
    payments:     "PAYMENTS & REFUNDS",
    appointments: "APPOINTMENTS & SCHEDULING",
    support:      "AFTER-SALES & SUPPORT",
    hours:        "WORKING HOURS",
    escalation:   "ESCALATION & ALERTS",
    behaviour:    "AGENT BEHAVIOUR",
    faqs:         "COMMON QUESTIONS",
    objections:   "OBJECTIONS & COMPETITION",
  };

  const grouped = {};
  for (const qa of qaAnswers) {
    const cat = qa.category || "general";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(qa);
  }

  const lines = [];
  for (const [catId, answers] of Object.entries(grouped)) {
    const catLabel = categories[catId] || catId.toUpperCase();
    lines.push(`\n[${catLabel}]`);
    for (const qa of answers) {
      lines.push(`Q: ${qa.question}`);
      lines.push(`A: ${qa.answer}`);
    }
  }

  return lines.join("\n");
}