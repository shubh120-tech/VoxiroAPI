import { query }               from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const saveLeadTool = {
  name: "save_lead",
  description: `Save or update customer details. Call this IMMEDIATELY whenever you learn anything new:
- First message mentions a service ("I need research paper") → save service_name = "research paper writing"
- Client gives their name → save it
- Client gives domain/subject → save it
- Client gives deadline, word count, email → save each

ALWAYS call this at the start of conversation with whatever is known.
ALWAYS call after every new piece of info.
This prevents asking for info twice — details saved here are shown back to you automatically.`,

  input_schema: {
    type: "object",
    properties: {
      customer_name:    { type: "string",  description: "Customer name" },
      customer_phone:   { type: "string",  description: "Customer WhatsApp number" },
      customer_email:   { type: "string",  description: "Customer email if provided" },
      service_name:     { type: "string",  description: "Service: thesis/research paper/synopsis etc." },
      domain_subject:   { type: "string",  description: "Domain or subject area" },
      word_count:       { type: "string",  description: "Word count or pages if mentioned" },
      deadline:         { type: "string",  description: "Deadline if mentioned" },
      costing:          { type: "string",  description: "Quoted price if any" },
      notes:            { type: "string",  description: "Any other relevant details" },
    },
    required: ["customer_phone"],
  },
};

export async function executeSaveLead({ businessId, conversationId, customerPhone, input }) {
  const {
    customer_name, customer_phone, customer_email,
    service_name, domain_subject, word_count,
    deadline, costing, notes,
  } = input;

  const phone = customer_phone || customerPhone;

  // Build collected details — store values AND explicit skips
  const newDetails = {};
  if (customer_name)  newDetails.name         = customer_name;
  if (customer_email) newDetails.email         = customer_email;
  if (service_name)   newDetails.service       = service_name;
  if (domain_subject) newDetails.domain        = domain_subject;
  if (word_count)     newDetails.word_count    = word_count === "not_provided" ? "SKIPPED" : word_count;
  if (deadline)       newDetails.deadline      = deadline   === "not_provided" ? "SKIPPED" : deadline;
  if (costing)        newDetails.costing       = costing;
  if (notes)          newDetails.notes         = notes;

  // Build interest summary for leads table
  const interestParts = [];
  if (service_name)   interestParts.push(service_name);
  if (domain_subject) interestParts.push(domain_subject);
  if (word_count)     interestParts.push(word_count + " words");
  if (deadline)       interestParts.push("deadline: " + deadline);
  const interest = interestParts.join(", ") || notes || "Research writing service";

  try {
    // Save to leads table
    const { rows } = await query(`
      INSERT INTO leads
        (business_id, conversation_id, customer_name, phone, email, interest, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')
      ON CONFLICT (business_id, phone) DO UPDATE
      SET customer_name = COALESCE($3, leads.customer_name),
          email         = COALESCE($5, leads.email),
          interest      = $6,
          notes         = COALESCE($7, leads.notes),
          updated_at    = NOW()
      RETURNING id
    `, [businessId, conversationId, customer_name, phone, customer_email, interest, notes]);

    // Store collected details in conversation for agent memory
    if (conversationId && Object.keys(newDetails).length > 0) {
      await query(`
        UPDATE conversations
        SET collected_details = COALESCE(collected_details, '{}') || $1::jsonb,
            updated_at        = NOW()
        WHERE id = $2
      `, [JSON.stringify(newDetails), conversationId]);
    }

    // Log activity
    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
      VALUES ($1, 'lead', $2, '👥', '#eff6ff', $3, 'lead')
    `, [
      businessId,
      `Lead updated: ${customer_name || phone} — ${interest}`,
      rows[0].id,
    ]).catch(() => {});

    console.log(`✅ Lead saved: ${phone} — ${interest}`);
    return { success: true, leadId: rows[0].id, savedDetails: newDetails };

  } catch (err) {
    console.error("Save lead error:", err.message);
    return { success: false, error: err.message };
  }
}