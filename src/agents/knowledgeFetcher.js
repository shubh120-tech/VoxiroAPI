import { query } from "../db/postgres.js";

/**
 * Fetch relevant context based on customer message.
 * Only loads what's needed — keeps token usage low.
 * Called on every incoming message before Claude reply.
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
    products:  needsProductInfo(msg),
    docs:      needsDocInfo(msg),
  };

  const [services, faqs, payment, company, products, docs] = await Promise.all([
    needs.services || needs.pricing ? fetchServices(businessId) : null,
    needs.faq ? fetchRelevantFaqs(businessId, message) : null,
    needs.payment ? fetchPaymentDetails(businessId) : null,
    needs.trust || needs.company ? fetchCompanyDetails(businessId) : null,
    needs.products || needs.pricing ? fetchStoreProducts(businessId, message) : null,
    needs.docs ? fetchKnowledgeDocs(businessId, message) : null,
  ]);

  return buildContextBlock({ services, faqs, payment, company, products, docs, needs });
}

// ── Detection functions ───────────────────────────────────────

function needsServiceInfo(msg) {
  return /service|offer|provide|work|help|do you|what kind|kya karte|kya milega|available|product|item|sell/.test(msg);
}

function needsPricingInfo(msg) {
  return /price|cost|fee|charge|rate|amount|kitna|rupee|₹|rs\.?|budget|expensive|cheap|discount|offer|quote|quotation/.test(msg);
}

function needsProductInfo(msg) {
  return /product|item|buy|order|stock|available|size|color|colour|variant|catalogue|catalog|collection|shop|store/.test(msg);
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

function needsDocInfo(msg) {
  // Load knowledge docs when customer asks something specific not covered above
  return /menu|catalogue|brochure|details|specification|spec|manual|guide|list|document/.test(msg);
}

// ── Fetch functions ───────────────────────────────────────────

async function fetchServices(businessId) {
  const { rows } = await query(`
    SELECT name, description, price, price_min, price_max, price_unit, duration
    FROM business_services
    WHERE business_id = $1 AND is_active = TRUE
    ORDER BY sort_order ASC NULLS LAST, name ASC
  `, [businessId]);
  return rows;
}

async function fetchRelevantFaqs(businessId, message) {
  const { rows } = await query(`
    SELECT question, answer, category
    FROM business_faqs
    WHERE business_id = $1
    ORDER BY sort_order ASC NULLS LAST
    LIMIT 25
  `, [businessId]);

  if (!rows.length) return [];

  const words = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const scored = rows.map(faq => {
    const text  = `${faq.question} ${faq.answer}`.toLowerCase();
    const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    return { ...faq, score };
  });

  return scored
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function fetchPaymentDetails(businessId) {
  // FIX: correct table name is business_payment_methods
  const { rows } = await query(`
    SELECT method_name, details, instructions, is_primary
    FROM business_payment_methods
    WHERE business_id = $1
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

async function fetchStoreProducts(businessId, message) {
  try {
    const keyword = message.split(" ").slice(0, 3).join("%");
    const { rows } = await query(`
      SELECT name, description, price, in_stock, category
      FROM products
      WHERE business_id = $1
        AND (name ILIKE $2 OR description ILIKE $2 OR category ILIKE $2)
      ORDER BY in_stock DESC, name ASC
      LIMIT 8
    `, [businessId, `%${keyword}%`]);
    return rows;
  } catch {
    return [];
  }
}

async function fetchKnowledgeDocs(businessId, message) {
  try {
    const { rows } = await query(`
      SELECT file_name, extracted_text
      FROM knowledge_docs
      WHERE business_id = $1
        AND status = 'processed'
        AND extracted_text IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 3
    `, [businessId]);

    if (!rows.length) return [];

    // Score docs by keyword relevance
    const words  = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const scored = rows.map(doc => {
      const text  = (doc.extracted_text || "").toLowerCase();
      const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      return { ...doc, score };
    });

    return scored
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(d => ({ ...d, extracted_text: d.extracted_text.slice(0, 500) }));
  } catch {
    return [];
  }
}

// ── Build context block ───────────────────────────────────────

function buildContextBlock({ services, faqs, payment, company, products, docs, needs }) {
  let context = "";

  // Services & Pricing
  if (services?.length > 0) {
    context += "\n\nSERVICES & PRICING:\n";
    context += services.map(s => {
      let price = "";
      if (s.price)                         price = `₹${s.price}`;
      else if (s.price_min && s.price_max) price = `₹${s.price_min}–₹${s.price_max}`;
      else if (s.price_min)                price = `From ₹${s.price_min}`;
      const duration = s.duration    ? ` | ${s.duration}` : "";
      const desc     = s.description ? ` — ${s.description}` : "";
      return `• ${s.name}${desc}: ${price}${duration}`;
    }).join("\n");
  }

  // Store Products
  if (products?.length > 0) {
    context += "\n\nPRODUCTS:\n";
    context += products.map(p => {
      const stock = p.in_stock === false ? " [Out of stock]" : "";
      const price = p.price ? `₹${p.price}` : "Price on request";
      const desc  = p.description ? ` — ${p.description.slice(0, 80)}` : "";
      return `• ${p.name}: ${price}${stock}${desc}`;
    }).join("\n");
  }

  // Payment details
  if (payment?.length > 0) {
    context += "\n\nPAYMENT DETAILS:\n";
    context += payment.map(p => {
      let line = `${p.method_name}: ${p.details}`;
      if (p.instructions) line += ` — ${p.instructions}`;
      return line;
    }).join("\n");
    context += "\n\nAsk customer to share screenshot after payment.";
  }

  // Relevant FAQs
  if (faqs?.length > 0) {
    context += "\n\nRELEVANT ANSWERS:\n";
    context += faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
  }

  // Company / Trust details
  if (company) {
    const parts = [];
    if (company.gst_number)      parts.push(`GST: ${company.gst_number}`);
    if (company.registration_no) parts.push(`Reg No: ${company.registration_no}`);
    if (company.founded_year)    parts.push(`Since: ${company.founded_year}`);
    if (company.total_clients)   parts.push(`Clients served: ${company.total_clients}`);
    if (company.certifications)  parts.push(`Certifications: ${company.certifications}`);

    if (parts.length > 0 || company.trust_message) {
      context += "\n\nCOMPANY DETAILS:\n";
      if (company.trust_message) context += `${company.trust_message}\n`;
      if (parts.length > 0)      context += parts.join("\n");
      const links = company.social_links || {};
      if (links.website)   context += `\nWebsite: ${links.website}`;
      if (links.instagram) context += `\nInstagram: ${links.instagram}`;
      if (links.linkedin)  context += `\nLinkedIn: ${links.linkedin}`;
    }
  }

  // Knowledge docs
  if (docs?.length > 0) {
    context += "\n\nFROM BUSINESS DOCUMENTS:\n";
    context += docs.map(d => `[${d.file_name}]: ${d.extracted_text}`).join("\n\n");
  }

  return context || null;
}