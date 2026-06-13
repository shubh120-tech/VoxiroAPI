import { query }               from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const registerComplaintTool = {
  name: "register_complaint",
  description: `Register a customer complaint and provide a ticket number.

WHEN TO CALL:
- Customer says they have a problem or issue
- Customer wants to raise a complaint
- Customer received wrong/damaged/missing item
- Customer unhappy with service

BEFORE CALLING — collect these naturally in conversation:
1. What is the issue? (category + description)
2. Order number or invoice if they have it
3. When did they purchase?
4. Photo/video of issue (ask them to share)
5. What resolution they want (refund/replacement/repair)

Do NOT block on order number — register even without it.
After registering ALWAYS tell the customer their ticket number and how to check status.`,

  input_schema: {
    type: "object",
    properties: {
      customer_name:        { type:"string", description:"Customer name" },
      customer_phone:       { type:"string", description:"Customer WhatsApp number" },
      category:             { type:"string", description:"Complaint category: defective_product, wrong_item, late_delivery, missing_items, quality_issue, billing_error, service_issue, other" },
      subject:              { type:"string", description:"One-line summary e.g. 'Received damaged laptop bag'" },
      description:          { type:"string", description:"Full description as explained by customer" },
      order_reference:      { type:"string", description:"Order/invoice number if provided, else 'Not provided'" },
      purchase_date:        { type:"string", description:"When they purchased — date or 'last week', '2 days ago' etc." },
      preferred_resolution: { type:"string", description:"What customer wants: refund, replacement, repair, exchange" },
      priority:             { type:"string", description:"high for safety/legal/repeat complaints, medium for defective/wrong items, low for minor issues", enum:["low","medium","high","urgent"] },
      attachments:          { type:"array", items:{ type:"string" }, description:"Media URLs shared by customer (photos/videos from WhatsApp messages)" },
    },
    required: ["customer_phone","category","subject","description"],
  },
};

export async function executeRegisterComplaint({ businessId, conversationId, customerPhone, input }) {
  const {
    customer_name, customer_phone, category, subject, description,
    order_reference, purchase_date, preferred_resolution,
    priority, attachments,
  } = input;

  const phone = customer_phone || customerPhone;

  try {
    // Check for duplicate (same customer + category within 24h)
    const { rows: existing } = await query(`
      SELECT id, ticket_number FROM customer_complaints
      WHERE business_id = $1 AND customer_phone = $2
        AND category = $3 AND status = 'open'
        AND created_at >= NOW() - INTERVAL '24 hours'
      LIMIT 1
    `, [businessId, phone, category]);

    if (existing.length > 0) {
      // Update existing instead of duplicate
      await query(`
        UPDATE customer_complaints SET
          description = description || E'\n\n--- Customer Update ---\n' || $1,
          attachments = COALESCE(attachments, '[]'::jsonb) || $2::jsonb,
          updated_at  = NOW()
        WHERE id = $3
      `, [description, JSON.stringify(attachments||[]), existing[0].id]);

      console.log(`🎫 Complaint UPDATED (prevented duplicate): ${existing[0].ticket_number}`);
      return {
        success:      true,
        ticketNumber: existing[0].ticket_number,
        isUpdate:     true,
        message:      `Your complaint ${existing[0].ticket_number} has been updated with the new details.`,
      };
    }

    // Generate ticket number using business prefix
    const { rows: ticketRows } = await query(
      "SELECT generate_ticket_number($1) AS ticket_number",
      [businessId]
    );
    const ticketNumber = ticketRows[0].ticket_number;

    // Create complaint
    const { rows } = await query(`
      INSERT INTO customer_complaints
        (business_id, conversation_id, ticket_number, customer_name, customer_phone,
         category, subject, description, order_reference, purchase_date,
         preferred_resolution, priority, attachments, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
      RETURNING id, ticket_number
    `, [
      businessId, conversationId||null,
      ticketNumber, customer_name||null, phone,
      category||"other", subject, description,
      order_reference||null, purchase_date||null,
      preferred_resolution||null, priority||"medium",
      JSON.stringify(attachments||[]),
    ]);

    // Log activity
    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
      VALUES ($1,'complaint',$2,'🎫','#fef2f2',$3,'complaint')
    `, [businessId, `Complaint ${ticketNumber}: ${customer_name||phone} — ${subject}`, rows[0].id]).catch(()=>{});

    // Notify owner
    const parts = [`🎫 *New Complaint*`];
    parts.push(`Ticket: ${ticketNumber}`);
    parts.push(`Customer: ${customer_name||phone}`);
    parts.push(`Issue: ${subject}`);
    if (order_reference && order_reference!=="Not provided") parts.push(`Order: ${order_reference}`);
    if (preferred_resolution) parts.push(`Wants: ${preferred_resolution}`);
    if (priority==="high"||priority==="urgent") parts.push(`⚠️ Priority: ${priority.toUpperCase()}`);
    await notifyOwnerWhatsApp(businessId, parts.join("\n"));

    console.log(`🎫 Complaint registered: ${ticketNumber} — ${phone}`);

    return {
      success:      true,
      ticketNumber,
      complaintId:  rows[0].id,
      isUpdate:     false,
      message:      `Complaint registered. Ticket: ${ticketNumber}`,
    };

  } catch (err) {
    console.error("Register complaint error:", err.message);
    return { success:false, error:err.message };
  }
}