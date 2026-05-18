import express from "express";
import crypto  from "crypto";
import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "../agents/agentManager.js";
import { sendWhatsAppMessage, getWhatsAppCredentials } from "../whatsapp/sender.js";

const router = express.Router();

/**
 * Webhook verification — Meta sends a GET request to verify.
 */
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

/**
 * Incoming messages — Meta sends a POST for every message.
 */
router.post("/", async (req, res) => {
  // Always respond 200 immediately — Meta will retry if you don't
  res.sendStatus(200);

  try {
    // Verify webhook signature
    if (!verifySignature(req)) {
      console.warn("⚠️  Invalid webhook signature");
      return;
    }

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value    = change.value;
        const messages = value.messages || [];
        const metadata = value.metadata;

        for (const msg of messages) {
          // Only handle text messages for now
          if (msg.type !== "text") continue;

          await processIncomingMessage({
            phoneNumberId:  metadata.phone_number_id,
            customerPhone:  msg.from,
            customerName:   value.contacts?.[0]?.profile?.name || null,
            messageText:    msg.text.body,
            waMessageId:    msg.id,
          });
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

/**
 * Process a single incoming message end to end.
 */
async function processIncomingMessage({
  phoneNumberId,
  customerPhone,
  customerName,
  messageText,
  waMessageId,
}) {
  // 1. Find which business owns this WhatsApp number
  const { rows: bizRows } = await query(`
    SELECT b.id AS business_id, wc.access_token
    FROM whatsapp_configs wc
    JOIN businesses b ON b.id = wc.business_id
    WHERE wc.phone_number_id = $1
      AND b.is_active = TRUE
  `, [phoneNumberId]);

  if (!bizRows.length) {
    console.warn(`No business found for phoneNumberId: ${phoneNumberId}`);
    return;
  }

  const { business_id, access_token } = bizRows[0];

  // 2. Get or create conversation for this customer
  const conversation = await getOrCreateConversation({
    businessId:    business_id,
    customerPhone,
    customerName,
  });

  // 3. Check if subscription allows more messages
  const allowed = await checkMessageLimit(business_id);
  if (!allowed) {
    await sendWhatsAppMessage({
      phoneNumberId,
      accessToken: access_token,
      to:          customerPhone,
      message:     "We're currently unavailable. Please contact us directly. Sorry for the inconvenience! 🙏",
    });
    return;
  }

  // 4. Increment message usage counter
  await query(`
    UPDATE subscriptions
    SET messages_used = messages_used + 1
    WHERE business_id = $1
  `, [business_id]);

  // 5. Run agent — sends multi-part messages with typing indicators
  await handleIncomingMessage({
    businessId:     business_id,
    conversationId: conversation.id,
    customerPhone,
    customerName,
    message:        messageText,
    phoneNumberId,
    accessToken:    access_token,
    waMessageId:    msg.id,  // for marking as read + typing simulation
  });
}

/**
 * Get existing conversation or create new one.
 */
async function getOrCreateConversation({ businessId, customerPhone, customerName }) {
  // Look for existing open conversation
  const { rows } = await query(`
    SELECT id, status FROM conversations
    WHERE business_id    = $1
      AND customer_phone = $2
      AND status != 'closed'
    ORDER BY created_at DESC
    LIMIT 1
  `, [businessId, customerPhone]);

  if (rows.length > 0) {
    // Update customer name if we now have it
    if (customerName) {
      await query(
        "UPDATE conversations SET customer_name = $1 WHERE id = $2",
        [customerName, rows[0].id]
      );
    }
    return rows[0];
  }

  // Create new conversation
  const { rows: newRows } = await query(`
    INSERT INTO conversations
      (business_id, customer_name, customer_phone, status, unread_count)
    VALUES ($1, $2, $3, 'agent', 1)
    RETURNING id, status
  `, [businessId, customerName, customerPhone]);

  return newRows[0];
}

/**
 * Check if business has messages remaining in their plan.
 */
async function checkMessageLimit(businessId) {
  const { rows } = await query(`
    SELECT s.messages_used, p.message_limit
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.business_id = $1
  `, [businessId]);

  if (!rows.length) return false;
  return rows[0].messages_used < rows[0].message_limit;
}

/**
 * Verify Meta webhook signature.
 */
function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.META_APP_SECRET || "")
    .update(JSON.stringify(req.body))
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

export default router;