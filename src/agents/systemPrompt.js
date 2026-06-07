import { query } from "../db/postgres.js";

// ── Prompt cache (5 min TTL) ──────────────────────────────────
const promptCache = new Map();

export async function buildSystemPrompt(businessId) {
  const key    = `prompt_${businessId}`;
  const cached = promptCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.prompt;

  // ── Pull everything from DB in parallel ───────────────────
  const [
    configResult,
    servicesResult,
    faqResult,
    paymentResult,
    companyResult,
    productResult,
    knowledgeResult,
    qaResult,
  ] = await Promise.all([

    // Core business + agent config
    query(`
      SELECT
        b.name           AS business_name,
        b.category,
        b.phone          AS business_phone,
        b.address,
        b.website,
        ac.agent_name,
        ac.tone,
        ac.language,
        ac.greeting,
        ac.services      AS fallback_services,
        ac.pricing       AS fallback_pricing
      FROM businesses b
      JOIN agent_configs ac ON ac.business_id = b.id
      WHERE b.id = $1
    `, [businessId]),

    // Services & pricing
    query(`
      SELECT name, description, price, price_min, price_max,
             price_unit, duration, is_active
      FROM business_services
      WHERE business_id = $1 AND is_active = TRUE
      ORDER BY sort_order ASC NULLS LAST, name ASC
      LIMIT 30
    `, [businessId]).catch(() => ({ rows: [] })),

    // FAQs
    query(`
      SELECT question, answer, category
      FROM business_faqs
      WHERE business_id = $1
      ORDER BY sort_order ASC NULLS LAST
      LIMIT 30
    `, [businessId]).catch(() => ({ rows: [] })),

    // Payment methods
    query(`
      SELECT method_name, details, instructions, is_primary
      FROM business_payment_methods
      WHERE business_id = $1
      ORDER BY is_primary DESC, created_at ASC
    `, [businessId]).catch(() => ({ rows: [] })),

    // Company / trust details
    query(`
      SELECT gst_number, registration_no, founded_year, team_size,
             total_clients, certifications, social_links, trust_message
      FROM business_company_details
      WHERE business_id = $1
    `, [businessId]).catch(() => ({ rows: [] })),

    // Products catalog
    query(`
      SELECT name, description, price, category, in_stock
      FROM products
      WHERE business_id = $1
      ORDER BY name ASC
      LIMIT 30
    `, [businessId]).catch(() => ({ rows: [] })),

    // Uploaded knowledge documents
    query(`
      SELECT file_name, extracted_text
      FROM knowledge_docs
      WHERE business_id = $1
        AND status = 'processed'
        AND extracted_text IS NOT NULL
        AND extracted_text != ''
      ORDER BY created_at DESC
      LIMIT 5
    `, [businessId]).catch(() => ({ rows: [] })),

    // Q&A training answers
    query(`
      SELECT question, answer, category
      FROM training_qa
      WHERE business_id = $1
        AND answer IS NOT NULL
        AND answer != ''
      ORDER BY category, question_id
    `, [businessId]).catch(() => ({ rows: [] })),
  ]);

  if (!configResult.rows.length) throw new Error("Business not found");

  const biz     = configResult.rows[0];
  const company = companyResult.rows[0] || {};
  const tone    = TONE_MAP[biz.tone] || TONE_MAP.friendly;

  // ── Build services section ────────────────────────────────
  const servicesSection = (() => {
    if (servicesResult.rows.length === 0 && productResult.rows.length === 0) {
      return biz.fallback_services
        ? `Services: ${biz.fallback_services}\n${biz.fallback_pricing ? `Pricing: ${biz.fallback_pricing}` : ""}`
        : "Services not configured";
    }

    const lines = [];

    if (servicesResult.rows.length > 0) {
      lines.push("SERVICES:");
      servicesResult.rows.forEach(s => {
        const price = s.price
          ? `₹${s.price}${s.price_unit && s.price_unit !== "fixed" ? ` per ${s.price_unit}` : ""}`
          : s.price_min && s.price_max
            ? `₹${s.price_min}–₹${s.price_max}`
            : "Price on request";
        const duration = s.duration    ? ` | ${s.duration}` : "";
        const desc     = s.description ? ` — ${s.description}` : "";
        lines.push(`• ${s.name}: ${price}${duration}${desc}`);
      });
    }

    if (productResult.rows.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("PRODUCTS:");
      productResult.rows.forEach(p => {
        const price = p.price ? `₹${p.price}` : "Price on request";
        const stock = p.in_stock === false ? " [Out of stock]" : "";
        const desc  = p.description ? ` — ${p.description}` : "";
        lines.push(`• ${p.name}: ${price}${stock}${desc}`);
      });
    }

    return lines.join("\n");
  })();

  // ── Build payment section ─────────────────────────────────
  const paymentSection = (() => {
    if (paymentResult.rows.length === 0) return "Payment details not configured";
    return paymentResult.rows.map(p => {
      const primary = p.is_primary ? " (Primary)" : "";
      const instr   = p.instructions ? `\n  Note: ${p.instructions}` : "";
      return `• ${p.method_name}${primary}: ${p.details}${instr}`;
    }).join("\n");
  })();

  // ── Build FAQ section ─────────────────────────────────────
  const faqSection = (() => {
    if (faqResult.rows.length === 0) return "";
    return faqResult.rows
      .map(f => `Q: ${f.question}\nA: ${f.answer}`)
      .join("\n\n");
  })();

  // ── Build company/trust block ─────────────────────────────
  const socialLinks   = company.social_links || {};
  const companyBlock  = buildCompanyBlock({ biz, company, socialLinks });

  // ── Build Q&A knowledge block ─────────────────────────────
  const qaBlock = (() => {
    if (qaResult.rows.length === 0) return "";

    const CAT_LABELS = {
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
    qaResult.rows.forEach(qa => {
      const cat = qa.category || "general";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(qa);
    });

    const lines = [];
    for (const [catId, answers] of Object.entries(grouped)) {
      lines.push(`[${CAT_LABELS[catId] || catId.toUpperCase()}]`);
      answers.forEach(qa => {
        lines.push(`Q: ${qa.question}`);
        lines.push(`A: ${qa.answer}`);
      });
      lines.push("");
    }

    return lines.join("\n");
  })();

  // ── Build uploaded docs section ───────────────────────────
  const docsSection = (() => {
    if (knowledgeResult.rows.length === 0) return "";
    return knowledgeResult.rows
      .map(d => `[${d.file_name}]\n${(d.extracted_text || "").slice(0, 2000)}`)
      .join("\n\n");
  })();

  // ── Current time in IST ───────────────────────────────────
  const nowIST         = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const currentTimeIST = nowIST.toISOString().replace("T", " ").slice(0, 16) + " IST";
  const istHour        = nowIST.getUTCHours();
  const timeInstruction = istHour >= 21
    ? "It is late evening (after 9 PM IST). Keep replies shorter and more brief."
    : istHour < 10
      ? "It is early morning (before 10 AM IST). Slightly slower, more casual tone."
      : "Normal business hours. Standard sales behavior.";

  // ══════════════════════════════════════════════════════════
  //  SYSTEM PROMPT — all data embedded
  // ══════════════════════════════════════════════════════════
  const prompt = `
You are ${biz.agent_name || "Agent"}, a sales representative at ${biz.business_name}.
You are a real human — never say you are an AI or bot.
Current date and time: ${currentTimeIST}
${timeInstruction}

━━━ BUSINESS INFO ━━━
Name: ${biz.business_name}
Category: ${biz.category || ""}
Phone: ${biz.business_phone || ""}
Address: ${biz.address || ""}
Website: ${biz.website || ""}

━━━ SERVICES & PRODUCTS ━━━
${servicesSection}

━━━ PAYMENT METHODS ━━━
${paymentSection}
${faqSection ? `\n━━━ FREQUENTLY ASKED QUESTIONS ━━━\n${faqSection}` : ""}
${docsSection ? `\n━━━ BUSINESS DOCUMENTS ━━━\n${docsSection}` : ""}
${qaBlock ? `\n━━━ OWNER TRAINING & INSTRUCTIONS ━━━\n${qaBlock}` : ""}

━━━ COMPANY DETAILS (share as one message when customer asks for verification) ━━━
${companyBlock}

━━━ GREETING ━━━
${biz.greeting || `Hi! Thanks for reaching out to ${biz.business_name}. How can I help you?`}

━━━ PERSONALITY ━━━
${tone}

━━━ HUMAN BEHAVIOR — ALWAYS FOLLOW ━━━

CASUAL LANGUAGE:
Use lowercase sometimes: "ok", "sure", "noted", "yes"
Skip punctuation occasionally — feels natural on WhatsApp
Use "u" instead of "you" sometimes in casual replies
Rotate fillers: "okay", "sure", "got it", "noted", "hmm", "alright", "kk"
Never use same filler twice in a row

EMOTIONAL REACTIONS:
React naturally: "oh okay", "hmm got it", "alright"
Show empathy for tight deadlines: "that's quite tight, let me check"
Match client energy — short reply from client = short reply from you

NATURAL HESITATION:
"mostly yes", "i think possible", "let me confirm once"
Shows you are human, not a database

MEMORY CHECK:
Occasionally confirm context: "the thesis right?" or "5000 words wala?"
Shows attention and human-ness

AVOID ROBOTIC PATTERNS:
Never say "Certainly sir" every message — rotate
Never repeat same phrase twice in conversation
Never sound like a formal letter or call center
Never: "We appreciate your inquiry", "Greetings", "Dear customer"

NEGOTIATION STYLE:
Natural: "let me see best I can do" / "thoda adjust ho sakta hai"
NOT robotic: "Discount applied"

UNDERSTAND BEFORE REPLYING — EVERY TIME:
1. What is customer saying RIGHT NOW?
2. What have they ALREADY told me?
3. What do I STILL need?
4. What is the NEXT step?
Answer these internally, THEN reply.

MESSAGE STYLE — 50/50 RATIO:
50% short single replies: "Sure", "Noted", "Okay", "Got it"
50% slightly longer: 2-3 lines, question with context, or detail
One client message = ONE agent response only
Never send 2 long multi-line replies back to back
Never send 2 one-liner replies back to back

SINGLE MESSAGE RULES (never split):
Quotation → all in ONE message
Company/trust details → all in ONE message
Payment details → all in ONE message

ACKNOWLEDGE RULE:
50% of time: reply DIRECTLY without any filler
50% of time: brief filler first: "Sure.", "Let me check.", "One sec."
NEVER say "Great question!", "Good question!", "Wonderful!", "Amazing!"

NO FORMATTING:
No stars, no bold, no **text**, no *text*
Plain text only — no markdown of any kind

EMOJIS: Maximum 1 per message. Most messages zero.

LANGUAGE:
Always reply in EXACT language customer uses
Hindi → Hindi, English → English, Hinglish → Hinglish
Mirror their style — casual if casual

REPETITION — NEVER:
Never say the same thing twice in a conversation
Never reconfirm details already shared
Never ask a question customer already answered
Once is enough for everything

QUALIFY FIRST — NEVER QUOTE BLINDLY:
Ask only what's missing, 1-2 at a time
Only quote AFTER you have full details
Stick to same price once quoted
Never invent discounts

CONVERSATION RULES:
Ask max 1-2 questions at a time
Answer customer's question FIRST, then ask yours
If all info collected → quote immediately
Never get stuck in loops

FOLLOW-UP SCHEDULING — always call tool, never just say it:
"busy" / "later" / "call tomorrow" → schedule_followup
"batata hoon" / "will let you know" (no date) → schedule_followup next day 10am
"let me think" / "sochta hoon" → schedule_followup 2 days
"discuss with family/boss" → schedule_followup 2 days
"travelling" → schedule_followup 5 days
"budget nahi" → schedule_followup 30 days
After scheduling → acknowledge briefly and stop asking questions

FOLLOW-UP CONFIRMATION:
If client gives date/time for follow-up → say "Sure." or "Okay." ONLY
Do NOT repeat the date/time back, do NOT confirm multiple times

BUSINESS BOUNDARY:
Only discuss ${biz.business_name} related topics
Unrelated questions → "I can only help with ${biz.business_name} queries."

TOOLS:
save_lead: Customer shows interest → save their details
confirm_order: Customer confirms and is ready to pay → save order
book_appointment: Customer wants to schedule a meeting or visit
update_appointment: Customer wants to reschedule existing appointment
cancel_appointment: Customer wants to cancel appointment
update_order: Customer wants to modify existing order
cancel_order: Customer wants to cancel order
update_followup: Customer wants to change follow-up time
cancel_followup: Customer no longer needs a follow-up
notify_owner: Complex issue, negotiation beyond limit, or human needed
schedule_followup: Customer says busy/later/think about it
`.trim();

  promptCache.set(key, { prompt, expiry: Date.now() + 5 * 60 * 1000 });
  return prompt;
}

// ── Clear cache for a business (call after any data update) ───
export function clearPromptCache(businessId) {
  promptCache.delete(`prompt_${businessId}`);
}

// ── Build company details block ───────────────────────────────
function buildCompanyBlock({ biz, company, socialLinks }) {
  if (company.trust_message) return company.trust_message;

  const lines = [];
  if (biz.business_name)       lines.push(biz.business_name);
  if (biz.address)             lines.push(`📍 ${biz.address}`);
  if (biz.business_phone)      lines.push(`📞 ${biz.business_phone}`);
  if (socialLinks.email)       lines.push(`📧 ${socialLinks.email}`);
  if (socialLinks.website || biz.website) lines.push(`🌐 ${socialLinks.website || biz.website}`);
  if (company.gst_number)      lines.push(`GST: ${company.gst_number}`);
  if (company.registration_no) lines.push(`Reg: ${company.registration_no}`);
  if (company.founded_year)    lines.push(`Since: ${company.founded_year}`);
  if (company.total_clients)   lines.push(`Clients: ${company.total_clients}`);
  if (company.certifications)  lines.push(company.certifications);
  if (socialLinks.instagram)   lines.push(`Instagram: ${socialLinks.instagram}`);
  if (socialLinks.linkedin)    lines.push(`LinkedIn: ${socialLinks.linkedin}`);

  return lines.length > 1
    ? lines.filter(Boolean).join("\n") + "\nFeel free to verify our details anytime."
    : "Contact us for verification details.";
}

// ── Tone definitions ──────────────────────────────────────────
const TONE_MAP = {
  friendly: `
Warm, approachable, practical
Sound like a real Indian WhatsApp team member
Not a bot, not a brochure, not a pushy closer
Use mam/sir naturally, not every line
Bridge lines: "Okay", "Sure", "Noted", "Let me check", "One minute"`,

  professional: `
Professional but not stiff
Clear and precise
Respectful
No over-polished language`,

  enthusiastic: `
Positive energy but grounded
Not fake enthusiasm
Genuine interest in helping`,
};