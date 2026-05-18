import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";

export const notifyOwnerTool = {
  name: "notify_owner",
  description: `Notify the business owner when:
- Customer needs human assistance
- Customer sends payment screenshot or proof
- Customer asks for a call or human
- Negotiation goes beyond your authority
- Customer is upset or complaining
- Complex scope that needs expert review
- Customer hasn't responded to 2+ questions
Always notify owner AND tell customer "I've notified our team, they'll reach out shortly."`,
  input_schema: {
    type: "object",
    properties: {
      reason:         { type: "string", description: "Why does this customer need human help?" },
      customer_phone: { type: "string", description: "Customer phone number" },
      customer_name:  { type: "string", description: "Customer name if known" },
      urgency:        { type: "string", enum: ["low", "medium", "high"], description: "How urgent is this?" },
    },
    required: ["reason", "customer_phone"],
  },
};

export async function executeNotifyOwner({ businessId, conversationId, input }) {
  const { reason, customer_phone, customer_name, urgency = "medium" } = input;

  // Create magic link token
  const token = jwt.sign(
    { businessId, conversationId, type: "takeover" },
    process.env.JWT_SECRET,
    { expiresIn: "30m" }
  );

  // Save magic link to DB
  await query(`
    INSERT INTO magic_links (business_id, conversation_id, token, expires_at)
    VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
  `, [businessId, conversationId, token]);

  // Mark conversation as needs-help
  await query(`
    UPDATE conversations
    SET status = 'needs-help', updated_at = NOW()
    WHERE id = $1
  `, [conversationId]);

  // Create support ticket
  await query(`
    INSERT INTO support_tickets (business_id, conversation_id, customer_name, customer_phone, reason, status)
    VALUES ($1, $2, $3, $4, $5, 'open')
  `, [businessId, conversationId, customer_name, customer_phone, reason]);

  // Build magic link URL
  const magicLink = `${process.env.FRONTEND_URL}/join/${token}`;

  // Notify owner on WhatsApp
  const urgencyEmoji = { low: "ℹ️", medium: "⚠️", high: "🚨" }[urgency];
  await notifyOwnerWhatsApp(businessId,
    `${urgencyEmoji} *Customer Needs Help*\n` +
    `Customer: ${customer_name || customer_phone}\n` +
    `Reason: ${reason}\n\n` +
    `👆 Tap to join the chat:\n${magicLink}\n\n` +
    `_Link expires in 30 minutes_`
  );

  return {
    success: true,
    message: "Owner has been notified and will join shortly.",
  };
}
