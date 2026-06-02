import Anthropic from "@anthropic-ai/sdk";
import { query }  from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateBusinessPrompt(businessId) {
  const [bizRows, agentRows, servicesRows, faqRows, paymentRows, companyRows, qaRows] = await Promise.all([
    query("SELECT * FROM businesses WHERE id = $1", [businessId]),
    query("SELECT * FROM agent_configs WHERE business_id = $1", [businessId]),
    query("SELECT * FROM business_services WHERE business_id = $1 AND is_active = TRUE LIMIT 20", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_faqs WHERE business_id = $1 LIMIT 20", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_payment_methods WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_company_details WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
    // Load Q&A training answers
    query("SELECT question_id, question, answer, category FROM training_qa WHERE business_id = $1 AND answer IS NOT NULL AND answer != '' ORDER BY category, question_id", [businessId]).catch(() => ({ rows: [] })),
  ]);

  const biz     = bizRows.rows[0]     || {};
  const agent   = agentRows.rows[0]   || {};
  const company = companyRows.rows[0] || {};
  const qaAnswers = qaRows.rows       || [];

  // ── Build business context ────────────────────────────────
  const businessContext = `
BUSINESS: ${biz.name || "Not set"} | Category: ${biz.category || agent.services || "Not specified"}
AGENT NAME: ${agent.agent_name || "Agent"} | TONE: ${agent.tone || "friendly"} | LANGUAGE: ${agent.language || "English"}
GREETING: ${agent.greeting || "Not set"}
ADDRESS: ${biz.address || "Not set"} | PHONE: ${biz.phone || "Not set"}
WEBSITE: ${biz.website || "Not set"}

SERVICES & PRICING:
${servicesRows.rows.length > 0
  ? servicesRows.rows.map(s => `- ${s.name}${s.price ? ` (₹${s.price})` : s.price_min ? ` (₹${s.price_min}–₹${s.price_max})` : ""}: ${s.description || ""}`).join("\n")
  : agent.services || "Not configured"}

PRICING INFO: ${agent.pricing || "Not set"}

PAYMENT METHODS:
${paymentRows.rows.length > 0
  ? paymentRows.rows.map(p => `- ${p.method_name}: ${p.details}`).join("\n")
  : "Not configured"}

FAQs:
${faqRows.rows.length > 0
  ? faqRows.rows.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n")
  : "Not configured"}

TRUST & COMPANY:
${company.trust_message || ""} ${company.total_clients ? `| ${company.total_clients}+ clients served` : ""} ${company.founded_year ? `| In business since ${company.founded_year}` : ""}
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

SECTIONS TO COVER (plain text, no markdown, 500-700 words):

1. IDENTITY & ROLE
   - Agent name, business name, what it does
   - Never reveal it is an AI unless directly asked
   - Warm, human personality matching the tone setting

2. PRIMARY GOAL
   - Convert every chat to a lead or order
   - What specific info to collect (use owner's exact list from training)
   - Priority order of questions to ask

3. PRODUCTS & SERVICES
   - List actual products/services with real prices
   - How to explain and recommend
   - What NOT to offer (from owner's training answers)
   - Current offers/discounts if any

4. WORKING HOURS & AVAILABILITY
   - Exact days and hours (from owner's answers)
   - What to say outside working hours
   - Whether to take orders after hours

5. ORDER & PAYMENT PROCESS
   - Step by step order process (from owner's answers)
   - Payment methods accepted
   - Delivery areas and charges
   - Refund/return policy (exact words from owner)

6. CONVERSATION STYLE
   - Reply language and style
   - Emoji usage (yes/no/how many per owner's preference)
   - Message length (short/detailed per owner's preference)
   - Never use bullets, bold, or formatting in WhatsApp replies
   - Natural, conversational tone

7. LEAD QUALIFICATION
   - First question to ask every new customer (use owner's exact instruction)
   - Mandatory info to collect (name, phone, requirement, budget, location — per owner)
   - How to ask for budget naturally
   - Never ask the same question twice
   - Minimum budget threshold if set by owner

8. ESCALATION RULES — CRITICAL
   - EXACT trigger phrases that cause immediate human handoff (from owner's list)
   - When to stop replying and alert owner
   - What to say to customer when escalating
   - Whether to alert for every lead or only urgent ones

9. HANDLING OBJECTIONS
   - Discount requests: exact response per owner's instruction
   - "I'll think about it" — how to follow up politely
   - "Speak to manager/owner" — exact action to take
   - Competitor comparisons — how to handle

10. HARD RULES (NEVER DO)
    - Things owner said agent must NEVER say or promise
    - Out of scope topics to avoid
    - False promises protection

Write the complete prompt now. Be specific, use real business details, and incorporate every owner training answer:`;

  // ── Call Claude Sonnet for better quality ─────────────────
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages:   [{ role: "user", content: metaPrompt }],
  });

  const generatedPrompt = response.content[0]?.text?.trim() || "";
  if (!generatedPrompt) throw new Error("Failed to generate prompt");

  // ── Save prompt to DB ─────────────────────────────────────
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

  console.log(`✅ Prompt generated for ${biz.name || businessId} (${qaAnswers.length} Q&A answers used)`);
  return generatedPrompt;
}

// ── Format Q&A answers into readable context ──────────────────
function buildQAContext(qaAnswers) {
  const categories = {
    escalation: "ESCALATION & ALERTS",
    hours:      "WORKING HOURS",
    orders:     "ORDERS & DELIVERY",
    payments:   "PAYMENTS & REFUNDS",
    leads:      "LEAD QUALIFICATION",
    products:   "PRODUCTS & SERVICES",
    faqs:       "COMMON QUESTIONS",
    behaviour:  "AGENT BEHAVIOUR",
    identity:   "BUSINESS IDENTITY",
  };

  // Group by category
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