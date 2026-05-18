import { query } from "../db/postgres.js";

/**
 * Detect what type of context is needed based on customer message.
 * Returns only relevant data — keeps prompt small.
 */
export async function fetchRelevantContext(businessId, message) {
  const msg = message.toLowerCase();

  const needs = {
    services:  needsServiceInfo(msg),
    pricing:   needsPricingInfo(msg),
    payment:   needsPaymentInfo(msg),
    trust:     needsTrustInfo(msg),
    faq:       needsFaqInfo(msg),
    company:   needsCompanyInfo(msg),
  };

  const [services, faqs, payment, company] = await Promise.all([
    needs.services || needs.pricing ? fetchServices(businessId) : null,
    needs.faq ? fetchRelevantFaqs(businessId, message) : null,
    needs.payment ? fetchPaymentDetails(businessId) : null,
    needs.trust || needs.company ? fetchCompanyDetails(businessId) : null,
  ]);

  return buildContextBlock({ services, faqs, payment, company, needs });
}

// ── Detection Functions ───────────────────────────────────────

function needsServiceInfo(msg) {
  return /service|offer|provide|work|help|do you|what kind|kya karte|kya milega|available/.test(msg);
}

function needsPricingInfo(msg) {
  return /price|cost|fee|charge|rate|amount|kitna|rupee|₹|rs\.?|budget|expensive|cheap|discount|offer|quote|quotation/.test(msg);
}

function needsPaymentInfo(msg) {
  return /pay|payment|upi|gpay|phonepe|paytm|bank|transfer|account|send money|advance|deposit|bhejun|bhejo/.test(msg);
}

function needsTrustInfo(msg) {
  return /trust|verify|real|genuine|legit|proof|review|sample|experience|safe|sure|guarantee|gst|registration|company details|details bhejo/.test(msg);
}

function needsFaqInfo(msg) {
  return /how|when|what|why|process|time|delivery|quality|revision|change|refund|cancel|kaise|kab|kyun/.test(msg);
}

function needsCompanyInfo(msg) {
  return /about|company|who are|contact|address|location|office|gst|registered|website/.test(msg);
}

// ── Fetch Functions ───────────────────────────────────────────

async function fetchServices(businessId) {
  const { rows } = await query(`
    SELECT name, description, price, price_min, price_max, price_unit, duration
    FROM business_services
    WHERE business_id = $1 AND is_active = TRUE
    ORDER BY sort_order ASC, name ASC
  `, [businessId]);
  return rows;
}

async function fetchRelevantFaqs(businessId, message) {
  // Get all active FAQs
  const { rows } = await query(`
    SELECT question, answer, category
    FROM business_faqs
    WHERE business_id = $1 AND is_active = TRUE
    ORDER BY sort_order ASC
    LIMIT 20
  `, [businessId]);

  if (!rows.length) return [];

  // Simple keyword matching to find relevant FAQs
  const msg    = message.toLowerCase();
  const words  = msg.split(/\s+/).filter(w => w.length > 3);

  const scored = rows.map(faq => {
    const text  = `${faq.question} ${faq.answer}`.toLowerCase();
    const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    return { ...faq, score };
  });

  // Return top 5 most relevant
  return scored
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function fetchPaymentDetails(businessId) {
  const { rows } = await query(`
    SELECT method_name, details, instructions, is_primary
    FROM business_payment_details
    WHERE business_id = $1 AND is_active = TRUE
    ORDER BY is_primary DESC, created_at ASC
  `, [businessId]);
  return rows;
}

async function fetchCompanyDetails(businessId) {
  const { rows } = await query(`
    SELECT gst_number, registration_no, founded_year, team_size,
           total_clients, certifications, social_links, trust_message
    FROM business_company_details
    WHERE business_id = $1
  `, [businessId]);
  return rows[0] || null;
}

// ── Build Context Block ───────────────────────────────────────

function buildContextBlock({ services, faqs, payment, company, needs }) {
  let context = "";

  // Services & Pricing
  if (services?.length > 0) {
    context += "\n\nSERVICES & PRICING:\n";
    context += services.map(s => {
      let price = "";
      if (s.price)                price = `₹${s.price}`;
      else if (s.price_min && s.price_max) price = `₹${s.price_min}–₹${s.price_max}`;
      else if (s.price_min)       price = `From ₹${s.price_min}`;
      const duration = s.duration ? ` | ${s.duration}` : "";
      const desc     = s.description ? ` — ${s.description}` : "";
      return `• ${s.name}${desc}: ${price}${duration}`;
    }).join("\n");
  }

  // Payment Details
  if (payment?.length > 0) {
    context += "\n\nPAYMENT DETAILS:\n";
    context += payment.map(p => {
      let line = `${p.method_name}: ${p.details}`;
      if (p.instructions) line += `\nNote: ${p.instructions}`;
      return line;
    }).join("\n\n");
    context += "\n\nSend as ONE message. Ask customer to share screenshot after payment.";
  }

  // Relevant FAQs
  if (faqs?.length > 0) {
    context += "\n\nRELEVANT ANSWERS:\n";
    context += faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
  }

  // Company/Trust Details
  if (company) {
    const parts = [];
    if (company.gst_number)      parts.push(`GST: ${company.gst_number}`);
    if (company.registration_no) parts.push(`Reg No: ${company.registration_no}`);
    if (company.founded_year)    parts.push(`Since: ${company.founded_year}`);
    if (company.total_clients)   parts.push(`Clients served: ${company.total_clients}`);
    if (company.certifications)  parts.push(`Certifications: ${company.certifications}`);

    if (parts.length > 0 || company.trust_message) {
      context += "\n\nCOMPANY VERIFICATION DETAILS (share as ONE message when asked):\n";
      if (company.trust_message) context += `${company.trust_message}\n`;
      if (parts.length > 0)      context += parts.join("\n");

      // Social links
      const links = company.social_links || {};
      if (links.website)   context += `\nWebsite: ${links.website}`;
      if (links.instagram) context += `\nInstagram: ${links.instagram}`;
      if (links.linkedin)  context += `\nLinkedIn: ${links.linkedin}`;
    }
  }

  return context;
}