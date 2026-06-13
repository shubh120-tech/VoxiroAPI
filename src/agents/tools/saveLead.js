import { query }               from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const saveLeadTool = {
  name: "save_lead",
  description: `Save or update customer details. Call this IMMEDIATELY whenever you learn anything new about the customer.

WHEN TO CALL:
- Customer mentions any product or service they want → save as interest
- Customer gives their name, email, budget → save immediately
- Customer shows buying intent → set intent to "hot"
- Customer is just browsing → set intent to "cold"
- Any new detail learned → call again to update

ALWAYS call at the start of conversation with whatever is known.
ALWAYS call after every new piece of info.
This prevents asking for info twice — saved details are shown back to you automatically.

Use the business's actual products/services from your instructions — do NOT assume any specific industry.`,

  input_schema: {
    type: "object",
    properties: {
      customer_name:  { type: "string", description: "Customer name if provided" },
      customer_phone: { type: "string", description: "Customer WhatsApp number" },
      customer_email: { type: "string", description: "Customer email if provided" },
      interest:       { type: "string", description: "What the customer is interested in — use the actual product/service name from this business. E.g. if clothing store: 'Red cotton kurti', if restaurant: 'Party catering for 50', if salon: 'Bridal package'" },
      budget:         { type: "string", description: "Customer's budget if mentioned. E.g. '₹5,000-₹10,000', 'under 2000', '50k'" },
      intent:         { type: "string", description: "Lead intent based on conversation. 'hot' = ready to buy/book now, 'warm' = interested but thinking, 'cold' = just asking/browsing", enum: ["hot", "warm", "cold"] },
      notes:          { type: "string", description: "Any other relevant details — special requests, preferences, sizes, quantities, dates needed, etc." },
    },
    required: ["customer_phone"],
  },
};

export async function executeSaveLead({ businessId, conversationId, customerPhone, input }) {
  const {
    customer_name, customer_phone, customer_email,
    interest, budget, intent, notes,
  } = input;

  const phone = customer_phone || customerPhone;

  // Build collected details for JSON storage
  const newDetails = {};
  if (customer_name)  newDetails.name    = customer_name;
  if (customer_email) newDetails.email   = customer_email;
  if (interest)       newDetails.interest = interest;
  if (budget)         newDetails.budget  = budget;
  if (notes)          newDetails.notes   = notes;

  try {
    // Upsert — update if same business + phone exists
    const { rows } = await query(`
      INSERT INTO leads
        (business_id, conversation_id, customer_name, phone, email,
         interest, budget, intent, notes, collected_details, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new')
      ON CONFLICT (business_id, phone) DO UPDATE
      SET customer_name     = COALESCE(NULLIF($3, ''), leads.customer_name),
          email             = COALESCE(NULLIF($5, ''), leads.email),
          interest          = CASE WHEN LENGTH($6) > LENGTH(COALESCE(leads.interest, '')) THEN $6 ELSE leads.interest END,
          budget            = COALESCE(NULLIF($7, ''), leads.budget),
          intent            = COALESCE(NULLIF($8, ''), leads.intent),
          notes             = COALESCE(NULLIF($9, ''), leads.notes),
          collected_details = COALESCE(leads.collected_details, '{}'::jsonb) || $10::jsonb,
          conversation_id   = COALESCE($2, leads.conversation_id),
          updated_at        = NOW()
      RETURNING id, (xmax = 0) AS is_new
    `, [
      businessId, conversationId,
      customer_name || null, phone, customer_email || null,
      interest || null, budget || null, intent || "warm", notes || null,
      JSON.stringify(newDetails),
    ]);

    const isNew = rows[0]?.is_new;

    // Store in conversation for agent memory
    if (conversationId && Object.keys(newDetails).length > 0) {
      await query(`
        UPDATE conversations
        SET collected_details = COALESCE(collected_details, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
        WHERE id = $2
      `, [JSON.stringify(newDetails), conversationId]);
    }

    // Log activity
    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
      VALUES ($1, 'lead', $2, '👥', '#eff6ff', $3, 'lead')
    `, [
      businessId,
      `Lead ${isNew ? 'captured' : 'updated'}: ${customer_name || phone}${interest ? ' — ' + interest : ''}${intent ? ' [' + intent + ']' : ''}`,
      rows[0].id,
    ]).catch(() => {});

    console.log(`✅ Lead ${isNew ? 'saved' : 'updated'}: ${phone}${interest ? ' — ' + interest : ''}${budget ? ' (budget: ' + budget + ')' : ''}${intent ? ' [' + intent + ']' : ''}`);
    return { success: true, leadId: rows[0].id, isNew, savedDetails: newDetails };

  } catch (err) {
    console.error("Save lead error:", err.message);
    return { success: false, error: err.message };
  }
}