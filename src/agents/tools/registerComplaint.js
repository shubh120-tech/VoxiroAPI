import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const registerComplaintTool = {
  name: "register_complaint",
  description: `Register a customer complaint and provide a ticket number.

WHEN TO CALL:
- Customer says they have a problem/issue with a product or service
- Customer wants to file a complaint
- Customer received wrong/defective item
- Customer unhappy with service quality

BEFORE CALLING — collect these details naturally in conversation:
1. What is the issue? (category + description)
2. Order number or invoice (if applicable)
3. When did they purchase?
4. Photo/video of the issue (ask customer to share)
5. What resolution they want (refund/replacement/repair)

If customer doesn't have order number, still register — don't block on it.
If customer shares photos, store the media URLs in attachments.

After registering, ALWAYS share the ticket number with the customer and tell them the resolution timeline.`,

  input_schema: {
    type: "object",
    properties: {
      customer_name: {
        type: "string",
        description: "Customer name",
      },
      customer_phone: {
        type: "string",
        description: "Customer WhatsApp number",
      },
      category: {
        type: "string",
        description: "Complaint category. Use categories from business training. Common: defective_product, wrong_item, late_delivery, missing_items, quality_issue, billing_error, service_issue, other",
      },
      subject: {
        type: "string",
        description: "One-line summary of the complaint. E.g. 'Received damaged laptop bag', 'Wrong color delivered'",
      },
      description: {
        type: "string",
        description: "Detailed description of the issue as explained by the customer",
      },
      order_reference: {
        type: "string",
        description: "Order number, invoice number, or any reference the customer provides. If not available, put 'Not provided'",
      },
      purchase_date: {
        type: "string",
        description: "When the customer purchased — date or approximate time like 'last week', '2 days ago'",
      },
      preferred_resolution: {
        type: "string",
        description: "What the customer wants: refund, replacement, repair, exchange, credit. Ask them.",
      },
      priority: {
        type: "string",
        description: "Priority based on severity. 'high' for safety/legal/repeat complaints. 'medium' for defective/wrong items. 'low' for minor issues.",
        enum: ["low", "medium", "high", "urgent"],
      },
      attachments: {
        type: "array",
        items: { type: "string" },
        description: "Array of media URLs (photos/videos shared by customer in WhatsApp). Pass the media_url from the message.",
      },
    },
    required: ["customer_phone", "category", "subject", "description"],
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
    // Generate readable ticket number: YG-00001
    const { rows: seqRows } = await query("SELECT nextval('complaint_ticket_seq') AS num");
    const ticketNumber = `YG-${String(seqRows[0].num).padStart(5, "0")}`;

    // Check for existing open complaint from same customer about same issue (prevent duplicate)
    const { rows: existing } = await query(`
      SELECT id, ticket_number FROM customer_complaints
      WHERE business_id = $1 AND customer_phone = $2 AND status = 'open'
        AND category = $3 AND created_at >= NOW() - INTERVAL '24 hours'
      LIMIT 1
    `, [businessId, phone, category]);

    if (existing.length > 0) {
      // Update existing complaint instead of creating duplicate
      await query(`
        UPDATE customer_complaints SET
          description = description || E'\n\n--- Update ---\n' || $1,
          attachments = COALESCE(attachments, '[]'::jsonb) || $2::jsonb,
          preferred_resolution = COALESCE(NULLIF($3, ''), preferred_resolution),
          updated_at = NOW()
        WHERE id = $4
      `, [
        description,
        JSON.stringify(attachments || []),
        preferred_resolution || null,
        existing[0].id,
      ]);

      console.log(`🎫 Complaint UPDATED (prevented duplicate): ${existing[0].ticket_number} for ${phone}`);

      return {
        success: true,
        ticketNumber: existing[0].ticket_number,
        isUpdate: true,
        message: `Your complaint ${existing[0].ticket_number} has been updated with the new details.`,
      };
    }

    // Create new complaint
    const { rows } = await query(`
      INSERT INTO customer_complaints
        (business_id, conversation_id, ticket_number, customer_name, customer_phone,
         category, subject, description, order_reference, purchase_date,
         preferred_resolution, priority, attachments, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open')
      RETURNING id, ticket_number
    `, [
      businessId, conversationId || null,
      ticketNumber, customer_name || null, phone,
      category || "other", subject, description,
      order_reference || null, purchase_date || null,
      preferred_resolution || null, priority || "medium",
      JSON.stringify(attachments || []),
    ]);

    // Log activity
    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
      VALUES ($1, 'complaint', $2, '🎫', '#fef2f2', $3, 'complaint')
    `, [
      businessId,
      `Complaint ${ticketNumber}: ${customer_name || phone} — ${subject}`,
      rows[0].id,
    ]).catch(() => {});

    // Notify owner immediately
    const parts = [`🎫 *New Customer Complaint*`];
    parts.push(`Ticket: ${ticketNumber}`);
    parts.push(`Customer: ${customer_name || phone}`);
    parts.push(`Category: ${category}`);
    parts.push(`Issue: ${subject}`);
    if (order_reference && order_reference !== "Not provided") parts.push(`Order Ref: ${order_reference}`);
    if (preferred_resolution) parts.push(`Wants: ${preferred_resolution}`);
    if (priority === "high" || priority === "urgent") parts.push(`⚠️ Priority: ${priority.toUpperCase()}`);

    await notifyOwnerWhatsApp(businessId, parts.join("\n"));

    console.log(`🎫 Complaint registered: ${ticketNumber} — ${phone} — ${subject}`);

    return {
      success: true,
      ticketNumber,
      complaintId: rows[0].id,
      isUpdate: false,
      message: `Complaint registered successfully. Ticket number: ${ticketNumber}`,
    };

  } catch (err) {
    console.error("Register complaint error:", err.message);
    return { success: false, error: err.message };
  }
}