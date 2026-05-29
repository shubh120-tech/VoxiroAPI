import Anthropic from "@anthropic-ai/sdk";
import { query }  from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateBusinessPrompt(businessId) {
  const [bizRows, agentRows, servicesRows, faqRows, paymentRows, companyRows] = await Promise.all([
    query("SELECT * FROM businesses WHERE id = $1", [businessId]),
    query("SELECT * FROM agent_configs WHERE business_id = $1", [businessId]),
    query("SELECT * FROM business_services WHERE business_id = $1 AND is_active = TRUE LIMIT 20", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_faqs WHERE business_id = $1 LIMIT 20", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_payment_methods WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
    query("SELECT * FROM business_company_details WHERE business_id = $1", [businessId]).catch(() => ({ rows: [] })),
  ]);

  const biz     = bizRows.rows[0]     || {};
  const agent   = agentRows.rows[0]   || {};
  const company = companyRows.rows[0] || {};

  const businessContext = `
BUSINESS: ${biz.name || "Not set"} | Type: ${biz.category || agent.services || "Not specified"}
AGENT NAME: ${agent.agent_name || "Agent"} | TONE: ${agent.tone || "friendly"} | LANGUAGE: ${agent.language || "English"}
GREETING: ${agent.greeting || "Not set"}

SERVICES:
${servicesRows.rows.length > 0
  ? servicesRows.rows.map(s => `- ${s.name}${s.price ? ` (₹${s.price})` : s.price_min ? ` (₹${s.price_min}–₹${s.price_max})` : ""}: ${s.description || ""}`).join("\n")
  : agent.services || "Not configured"}

PRICING INFO: ${agent.pricing || "Not set"}

PAYMENT:
${paymentRows.rows.length > 0
  ? paymentRows.rows.map(p => `- ${p.method_name}: ${p.details}`).join("\n")
  : "Not configured"}

FAQs:
${faqRows.rows.length > 0
  ? faqRows.rows.map(f => `Q: ${f.question} A: ${f.answer}`).join("\n")
  : "Not configured"}

TRUST: ${company.trust_message || ""} ${company.total_clients ? `| ${company.total_clients} clients` : ""} ${company.founded_year ? `| Since ${company.founded_year}` : ""}
`.trim();

  const metaPrompt = `Write a WhatsApp sales agent system prompt for this Indian business. Be specific — use actual business name, services, prices throughout.

${businessContext}

Write the prompt covering these sections (plain text, no markdown headers, 400-500 words):

1. ROLE: Who the agent is, what business, never reveal AI unless asked directly, warm and human personality

2. GOAL: Convert chats to leads/orders. Collect: name, requirement, budget, timeline

3. SERVICES & PRICING: List actual services with prices. How to explain and quote

4. CONVERSATION STYLE: Short natural messages, no formatting/bullets/bold, lowercase sometimes, react naturally, don't repeat what customer said

5. QUALIFICATION: What info to collect, mandatory vs optional, never ask same thing twice

6. NEGOTIATION: When to quote directly vs ask owner, handle "can you do cheaper" naturally

7. STOP TRIGGERS: When to stop and notify owner (complaints, payment issues, custom requests, documents needed)

8. FOLLOW-UP: When customer says busy/later — schedule politely, don't push

9. TRUST: How to handle "is this genuine?" — share company details naturally

10. DONT DO: No false promises, no info outside scope, no long paragraphs

Write it now:`;

  const response = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 1500,
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
    VALUES ($1, $2, 'Auto-generated', 'ai')
  `, [businessId, generatedPrompt]).catch(() => {});

  console.log(`✅ Prompt generated for ${biz.name || businessId}`);
  return generatedPrompt;
}