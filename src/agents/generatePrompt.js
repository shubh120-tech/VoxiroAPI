import Anthropic from "@anthropic-ai/sdk";
import { logAIUsage } from "../utils/aiUsageLogger.js";
import { query }  from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateBusinessPrompt(businessId) {
  const [
    bizRows, agentRows, servicesRows, faqRows, paymentRows,
    companyRows, qaRows, productRows, knowledgeRows,
  ] = await Promise.all([
    query("SELECT * FROM businesses WHERE id = $1", [businessId]),
    query("SELECT * FROM agent_configs WHERE business_id = $1", [businessId]),
    query("SELECT * FROM business_services WHERE business_id = $1 AND is_active = TRUE ORDER BY sort_order ASC NULLS LAST, name ASC LIMIT 30", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_faqs WHERE business_id = $1 ORDER BY sort_order ASC NULLS LAST LIMIT 30", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_payment_methods WHERE business_id = $1 ORDER BY is_primary DESC, created_at ASC", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_company_details WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT question_id, question, answer, category FROM training_qa WHERE business_id = $1 AND answer IS NOT NULL AND answer != '' ORDER BY category, question_id", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT name, description, price, category, in_stock FROM products WHERE business_id = $1 ORDER BY name ASC LIMIT 30", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT file_name, extracted_text FROM knowledge_docs WHERE business_id = $1 AND status = 'processed' AND extracted_text IS NOT NULL ORDER BY created_at DESC LIMIT 5", [businessId]).catch(() => ({ rows: [] })),
  ]);

  const biz       = bizRows.rows[0]     || {};
  const agent     = agentRows.rows[0]   || {};
  const company   = companyRows.rows[0] || {};
  const qaAnswers = qaRows.rows         || [];

  // ── Services ──────────────────────────────────────────────
  const servicesSection = (() => {
    if (servicesRows.rows.length === 0 && productRows.rows.length === 0) {
      return agent.services || "Not configured";
    }
    const lines = [];
    servicesRows.rows.forEach(s => {
      const price = s.price
        ? `₹${s.price}${s.price_unit && s.price_unit !== "fixed" ? ` ${s.price_unit}` : ""}`
        : s.price_min && s.price_max
          ? `₹${s.price_min}–₹${s.price_max}`
          : "Price on request";
      const duration = s.duration    ? ` | Delivery: ${s.duration}` : "";
      const desc     = s.description ? ` — ${s.description}` : "";
      lines.push(`• ${s.name}: ${price}${duration}${desc}`);
    });
    if (productRows.rows.length > 0) {
      if (lines.length > 0) lines.push("");
      productRows.rows.forEach(p => {
        const price = p.price ? `₹${p.price}` : "Price on request";
        const stock = p.in_stock === false ? " [Currently out of stock]" : "";
        const desc  = p.description ? ` — ${p.description}` : "";
        lines.push(`• ${p.name}: ${price}${stock}${desc}`);
      });
    }
    return lines.join("\n");
  })();

  // ── Payment ───────────────────────────────────────────────
  const paymentSection = paymentRows.rows.length > 0
    ? paymentRows.rows.map(p => {
        const primary = p.is_primary ? " (Primary)" : "";
        const instr   = p.instructions ? `\n  Note: ${p.instructions}` : "";
        return `• ${p.method_name}${primary}: ${p.details}${instr}`;
      }).join("\n")
    : "Not configured";

  // ── FAQs ──────────────────────────────────────────────────
  const faqSection = faqRows.rows.length > 0
    ? faqRows.rows.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
    : "Not configured";

  // ── Company ───────────────────────────────────────────────
  const companySection = (() => {
    const parts = [];
    if (company.trust_message)   parts.push(company.trust_message);
    if (company.founded_year)    parts.push(`In business since ${company.founded_year}`);
    if (company.total_clients)   parts.push(`${company.total_clients}+ clients served`);
    if (company.team_size)       parts.push(`Team size: ${company.team_size}`);
    if (company.gst_number)      parts.push(`GST: ${company.gst_number}`);
    if (company.registration_no) parts.push(`Registration: ${company.registration_no}`);
    if (company.certifications)  parts.push(`Certifications: ${company.certifications}`);
    const links = company.social_links || {};
    if (links.website)   parts.push(`Website: ${links.website}`);
    if (links.instagram) parts.push(`Instagram: ${links.instagram}`);
    if (links.linkedin)  parts.push(`LinkedIn: ${links.linkedin}`);
    if (links.facebook)  parts.push(`Facebook: ${links.facebook}`);
    return parts.length > 0 ? parts.join("\n") : "Not configured";
  })();

  // ── Knowledge docs ────────────────────────────────────────
  const docsSection = knowledgeRows.rows.length > 0
    ? knowledgeRows.rows.map(d =>
        `[Document: ${d.file_name}]\n${(d.extracted_text || "").slice(0, 800)}`
      ).join("\n\n")
    : "";

  // ── Q&A training context ──────────────────────────────────
  const qaContext = qaAnswers.length > 0 ? buildQAContext(qaAnswers) : "";

  // ── Full business data block ──────────────────────────────
  const businessData = `
BUSINESS NAME: ${biz.name || "Not set"}
BUSINESS TYPE: ${biz.category || "Not specified"}
AGENT NAME: ${agent.agent_name || "Agent"}
TONE: ${agent.tone || "friendly"}
LANGUAGE: ${agent.language || "English"}
GREETING: ${agent.greeting || "Not set"}
ADDRESS: ${biz.address || "Not set"}
PHONE: ${biz.phone || "Not set"}
WEBSITE: ${biz.website || "Not set"}

━━━ SERVICES & PRODUCTS ━━━
${servicesSection}

━━━ PAYMENT METHODS ━━━
${paymentSection}

━━━ FREQUENTLY ASKED QUESTIONS ━━━
${faqSection}

━━━ COMPANY DETAILS ━━━
${companySection}
${docsSection ? `\n━━━ BUSINESS DOCUMENTS & KNOWLEDGE ━━━\n${docsSection}` : ""}
`.trim();

  // ── Meta prompt ───────────────────────────────────────────
  const metaPrompt = `You are an expert WhatsApp sales agent prompt engineer for Indian businesses.

Write a COMPLETE, SELF-CONTAINED system prompt for a WhatsApp AI agent.
The prompt must embed ALL the business data below so the agent never needs to look anything up — it knows everything from memory.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETE BUSINESS DATA:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${businessData}

${qaContext ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OWNER'S TRAINING INSTRUCTIONS:
(Follow these precisely — the owner wrote these themselves)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${qaContext}` : ""}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO WRITE THE SYSTEM PROMPT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write a complete WhatsApp agent system prompt (700-900 words, plain text only, no markdown).
Embed ALL the actual data — real service names, real prices, real payment details, real FAQs, real policies.
Do NOT say "refer to the knowledge base" or "check the document" — everything must be stated directly.
The agent reading this prompt must be able to answer any customer question without looking anything up.

COVER THESE SECTIONS IN ORDER:

1. WHO YOU ARE
   Use exact agent name and business name.
   Personality: warm, helpful, human-like — not robotic.
   Language to use (from owner's settings).
   Never admit to being an AI unless directly asked.

2. YOUR COMPLETE KNOWLEDGE BASE
   List every service and product with exact prices.
   List all payment methods with exact UPI IDs or account details.
   Answer every FAQ directly as known facts.
   Include company trust details, GST, years in business, client count.
   Include everything from uploaded documents.
   Pricing policy — fixed, quote-based, or variable.
   Current offers or discounts if any.

3. HOW TO HANDLE NEW CUSTOMERS
   Exact first message to send (from owner's training).
   What information to collect and in what order.
   How to ask for budget naturally without being pushy.
   What to do if customer is just browsing vs ready to buy.
   Minimum order or budget threshold if set.

4. ORDER AND APPOINTMENT PROCESS
   Step-by-step order flow from inquiry to confirmation.
   Appointment booking process if applicable.
   Delivery areas, charges, and timeframes.
   Advance payment requirements.
   Cancellation and modification policies.

5. WORKING HOURS AND AFTER-HOURS
   Exact working days and times.
   What to say when customer messages outside hours.
   Holiday handling.

6. AFTER-SALES AND SUPPORT
   Warranty or support coverage details.
   Refund and return policy word for word.
   How to handle complaints.

7. ESCALATION — WHEN TO STOP AND ALERT
   List exact trigger phrases that cause handoff.
   What to say to customer while waiting for human.
   Never argue, never promise what owner hasn't approved.

8. HOW TO TALK
   Reply length — short and crisp or detailed (from owner preference).
   Emoji usage — yes or no, how many.
   Never use WhatsApp formatting like bold or bullets in replies.
   Match customer's language automatically.

9. HANDLING DIFFICULT SITUATIONS
   Discount requests — exact response.
   "Found cheaper elsewhere" — exact response.
   Rude or abusive customer — exact response.
   "Speak to owner" — exact action.
   Unknown question — exact response.

10. ABSOLUTE RULES — NEVER DO
    List everything the owner said the agent must never say or promise.
    Out of scope topics.

Write the complete system prompt now with all real data embedded:`;

  const promptModel = process.env.ANTHROPIC_MODEL_SMART || "claude-sonnet-4-5";
  const response = await anthropic.messages.create({
    model:      promptModel,
    max_tokens: 3000,
    messages:   [{ role: "user", content: metaPrompt }],
  });
  await logAIUsage(businessId, "prompt_generation", promptModel, response.usage);

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
    VALUES ($1, $2, 'Full data prompt — all business details embedded', 'ai')
  `, [businessId, generatedPrompt]).catch(() => {});

  console.log(`✅ Prompt generated for ${biz.name || businessId} — services: ${servicesRows.rows.length}, products: ${productRows.rows.length}, faqs: ${faqRows.rows.length}, payment: ${paymentRows.rows.length}, docs: ${knowledgeRows.rows.length}, Q&A: ${qaAnswers.length}`);
  return generatedPrompt;
}

// ── Format Q&A answers into readable context ──────────────────
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