import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const saveLeadTool = {
  name: "save_lead",
  description: "Save a customer as a lead when they show interest in products or services. Call this when a customer expresses buying intent.",
  input_schema: {
    type: "object",
    properties: {
      customer_name:  { type: "string",  description: "Customer's name if known" },
      customer_phone: { type: "string",  description: "Customer's WhatsApp phone number" },
      interest:       { type: "string",  description: "What they are interested in" },
      notes:          { type: "string",  description: "Any additional context" },
    },
    required: ["customer_phone", "interest"],
  },
};

export async function executeSaveLead({ businessId, conversationId, input }) {
  const { customer_name, customer_phone, interest, notes } = input;

  // Upsert lead — don't duplicate if already exists
  const { rows } = await query(`
    INSERT INTO leads (business_id, conversation_id, customer_name, phone, interest, notes, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'new')
    ON CONFLICT (business_id, phone)
    DO UPDATE SET
      interest   = EXCLUDED.interest,
      notes      = EXCLUDED.notes,
      updated_at = NOW()
    RETURNING id
  `, [businessId, conversationId, customer_name, customer_phone, interest, notes]);

  // Log activity
  await query(`
    INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
    VALUES ($1, 'lead', $2, '👥', '#eff6ff', $3, 'lead')
  `, [businessId, `New lead: ${customer_name || customer_phone} — ${interest}`, rows[0].id]);

  // Notify owner on WhatsApp
  await notifyOwnerWhatsApp(businessId, `👥 *New Lead Captured*\nName: ${customer_name || "Unknown"}\nPhone: ${customer_phone}\nInterested in: ${interest}`);

  return { success: true, leadId: rows[0].id };
}
