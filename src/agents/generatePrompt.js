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


const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate a detailed system prompt for a business using Claude Sonnet.
 * Called during onboarding and available as "Regenerate Prompt" in Agent Training.
 */
export async function generateBusinessPrompt(businessId) {
  // Fetch all available business data
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

  // Build context for Claude
  const businessContext = `
BUSINESS INFORMATION:
Name: ${biz.name || "Not set"}
Category/Type: ${biz.category || agent.services || "Not specified"}
Phone: ${biz.phone || "Not set"}
Address: ${biz.address || "Not set"}
Website: ${biz.website || "Not set"}

AGENT CONFIGURATION:
Agent Name: ${agent.agent_name || "Agent"}
Tone: ${agent.tone || "friendly"}
Language: ${agent.language || "English"}
Greeting: ${agent.greeting || "Not set"}

SERVICES & PRICING:
${servicesRows.rows.length > 0
  ? servicesRows.rows.map(s =>
      `- ${s.name}${s.price ? ` (₹${s.price})` : s.price_min ? ` (₹${s.price_min}–₹${s.price_max})` : ""}: ${s.description || ""}`
    ).join("\n")
  : agent.services || "Not configured yet"}

${agent.pricing ? `PRICING DETAILS:\n${agent.pricing}` : ""}

PAYMENT METHODS:
${paymentRows.rows.length > 0
  ? paymentRows.rows.map(p => `- ${p.method_name}: ${p.details}${p.instructions ? ` (${p.instructions})` : ""}`).join("\n")
  : "Not configured yet"}

FAQs:
${faqRows.rows.length > 0
  ? faqRows.rows.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
  : "Not configured yet"}

COMPANY TRUST DETAILS:
${company.trust_message || ""}
${company.gst_number ? `GST: ${company.gst_number}` : ""}
${company.total_clients ? `Clients served: ${company.total_clients}` : ""}
${company.founded_year ? `Founded: ${company.founded_year}` : ""}
`.trim();

  const metaPrompt = `You are an expert at writing WhatsApp sales agent system prompts for Indian businesses.

Generate a detailed, professional system prompt for the following business. The agent will talk to customers on WhatsApp.

${businessContext}

Write a complete system prompt that covers ALL of the following sections. Be specific to this business — use their actual business name, services, pricing, and details wherever possible.

REQUIRED SECTIONS IN THE PROMPT:

1. ROLE AND IDENTITY
   - Who the agent is, what business they represent
   - Never reveal they are AI unless directly asked
   - Personality: warm, human, conversational — not robotic

2. PRIMARY GOAL
   - Convert conversations into leads/sales
   - Capture: name, contact, requirement, budget/timeline

3. SERVICES AND PRICING
   - List all services with prices (use actual data provided)
   - How to explain services clearly
   - When and how to discuss pricing

4. CONVERSATION STYLE
   - Tone (friendly/professional/casual based on business type)
   - Language (Hindi/English/Hinglish based on business)
   - Message length (short and natural — not long paragraphs)
   - No formatting (no bold, no bullets — plain WhatsApp text)
   - Human behavior (lowercase sometimes, natural reactions)

5. QUALIFICATION FLOW
   - What info to collect from customer
   - What is mandatory vs optional
   - Never ask same question twice
   - How to handle non-responsive customers

6. PRICING AND NEGOTIATION
   - When to quote vs when to notify owner
   - How to handle negotiation ("let me see what I can do")
   - When to stop and hand over to owner

7. STOP TRIGGERS (owner handover)
   - Specific situations where agent stops and notifies owner
   - e.g. price negotiation, document requests, complaints, payment queries

8. FOLLOW-UP BEHAVIOR
   - When customer says busy/later/will think
   - Schedule follow-ups appropriately
   - Do not be pushy

9. TRUST AND VERIFICATION
   - How to handle "is this genuine?" questions
   - What company details to share when asked
   - How to build confidence naturally

10. WHAT NOT TO DO
    - Clear boundaries
    - No false promises
    - No information outside scope

Write the prompt in plain text, no markdown headers. Make it detailed (400-600 words). Use the actual business name and details throughout. Sound like it was written by a senior sales trainer for this specific business.`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 3000,
    messages:   [{ role: "user", content: metaPrompt }],
  });

  const generatedPrompt = response.content[0]?.text?.trim() || "";
  if (!generatedPrompt) throw new Error("Failed to generate prompt");

  // Save to agent_configs
  await query(`
    INSERT INTO agent_configs (business_id, system_prompt, agent_name, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (business_id) DO UPDATE
    SET system_prompt = $2,
        agent_name    = COALESCE($3, agent_configs.agent_name),
        updated_at    = NOW()
  `, [businessId, generatedPrompt, agent.agent_name || "Agent"]);

  // Save to prompt history
  await query(`
    INSERT INTO prompt_history (business_id, prompt, change_note, changed_by)
    VALUES ($1, $2, 'Auto-generated during onboarding', 'ai')
  `, [businessId, generatedPrompt]).catch(() => {});

  console.log(`✅ Prompt generated for business ${businessId} (${biz.name})`);
  return generatedPrompt;
}