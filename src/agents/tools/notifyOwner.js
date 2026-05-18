import { query }               from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";
import jwt                     from "jsonwebtoken";

export const notifyOwnerTool = {
  name: "notify_owner",
  description: `Notify the business owner when human help is needed. Use when:
- Customer needs human assistance
- Customer sends payment screenshot or proof
- Customer asks for a call or human
- Negotiation goes beyond your authority
- Customer is upset or complaining
- Complex scope that needs expert review
Always notify owner AND tell customer "I've notified our team, they will reach out shortly."`,
  input_schema: {
    type: "object",
    properties: {
      reason:         { type: "string", description: "Why does this customer need human help?" },
      customer_phone: { type: "string", description: "Customer phone number" },
      customer_name:  { type: "string", description: "Customer name if known" },
      urgency:        { type: "string", enum: ["low", "medium", "high"], description: "How urgent?" },
    },
    required: ["reason", "customer_phone"],
  },
};

export async function executeNotifyOwner({ businessId, conversationId, input }) {
  const { reason, customer_phone, customer_name, urgency = "medium" } = input;

  try {
    // Create magic link token (valid 2 hours)
    const token = jwt.sign(
      { businessId, conversationId, type: "takeover" },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    // Save magic link to DB
    await query(`
      INSERT INTO magic_links (business_id, conversation_id, token, expires_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '2 hours')
      ON CONFLICT DO NOTHING
    `, [businessId, conversationId, token]);

    // Mark conversation as needs-help
    await query(`
      UPDATE conversations
      SET status = 'needs-help', updated_at = NOW()
      WHERE id = $1
    `, [conversationId]);

    // Create support ticket
    try {
      await query(`
        INSERT INTO support_tickets
          (business_id, conversation_id, customer_name, customer_phone, reason, status)
        VALUES ($1, $2, $3, $4, $5, 'open')
      `, [businessId, conversationId, customer_name, customer_phone, reason]);
    } catch { /* table may not exist — non-critical */ }

    // Build correct frontend URL
    // Magic link → owner opens dashboard directly to this conversation
    const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
    const magicLink   = `${frontendUrl}/join/${token}`;

    // Urgency indicator
    const urgencyIcon = { low: "ℹ️", medium: "⚠️", high: "🚨" }[urgency] || "⚠️";

    // Clean message — no markdown, no stars, no underscores
    // WhatsApp API rejects messages with certain markdown formatting
    const name    = customer_name || customer_phone;
    const message = `${urgencyIcon} Customer needs your attention\n\nCustomer: ${name}\nReason: ${reason}\n\nTap to open chat:\n${magicLink}\n\n(Link expires in 2 hours)`;

    await notifyOwnerWhatsApp(businessId, message);

    console.log(`✅ Owner notified for customer: ${name}`);

    return {
      success: true,
      message: "Owner has been notified and will join shortly.",
    };

  } catch (err) {
    console.error("Notify owner error:", err.message);
    return {
      success: false,
      error:   err.message,
    };
  }
}