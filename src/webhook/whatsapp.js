import express from "express";
import crypto  from "crypto";
import axios   from "axios";
import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "../agents/agentManager.js";
import { sendWhatsAppMessage, notifyOwnerWhatsApp } from "../whatsapp/sender.js";

const router = express.Router();

const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
const META_VERSION = process.env.META_API_VERSION || "v19.0";

// ── Webhook Verification ──────────────────────────────────────
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming Messages ─────────────────────────────────────────
router.post("/", async (req, res) => {
  res.sendStatus(200);
  try {
    if (!verifySignature(req)) return;
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value    = change.value;
        const metadata = value.metadata;

        // ── Handle messages ───────────────────────────────────
        for (const msg of value.messages || []) {
          await processMessage({
            phoneNumberId: metadata.phone_number_id,
            customerPhone: msg.from,
            customerName:  value.contacts?.[0]?.profile?.name || null,
            message:       msg,
          });
        }

        // ── Handle status updates ─────────────────────────────
        for (const status of value.statuses || []) {
          await processStatusUpdate({
            waMessageId:   status.id,
            status:        status.status,
            phoneNumberId: metadata.phone_number_id,
            recipientPhone: status.recipient_id,
          });
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ── Process Any Message Type ──────────────────────────────────
async function processMessage({ phoneNumberId, customerPhone, customerName, message }) {
  // Find business
  const { rows: bizRows } = await query(`
    SELECT b.id AS business_id, wc.access_token
    FROM whatsapp_configs wc
    JOIN businesses b ON b.id = wc.business_id
    WHERE wc.phone_number_id = $1 AND b.is_active = TRUE
    ORDER BY wc.updated_at DESC LIMIT 1
  `, [phoneNumberId]);

  if (!bizRows.length) return;
  const { business_id, access_token } = bizRows[0];

  // Get or create conversation
  const conversation = await getOrCreateConversation({ businessId: business_id, customerPhone, customerName });

  // Update last seen
  await query("UPDATE conversations SET customer_last_seen = NOW() WHERE id = $1", [conversation.id]);

  // Check if manual mode — agent stays silent
  if (conversation.status === "manual") {
    // Still save the message so owner can see it
    await saveMessage({ conversationId: conversation.id, businessId: business_id, role: "customer", content: getMessageText(message) || "[Media]" });
    await query("UPDATE conversations SET last_message = $1, last_message_at = NOW() WHERE id = $2",
      [getMessageText(message) || "[Media received]", conversation.id]);
    return;
  }

  // ── Handle different message types ───────────────────────────
  const msgType = message.type;

  if (msgType === "text") {
    // Normal text message
    await processTextMessage({ business_id, conversation, phoneNumberId, access_token, customerPhone, customerName, message });

  } else if (["image", "document", "video", "audio"].includes(msgType)) {
    // Media message — payment screenshot, document etc.
    await processMediaMessage({ business_id, conversation, phoneNumberId, access_token, customerPhone, customerName, message, msgType });

  } else if (msgType === "interactive") {
    // Button reply
    const text = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "";
    await processTextMessage({ business_id, conversation, phoneNumberId, access_token, customerPhone, customerName, message: { ...message, text: { body: text } } });

  } else {
    // Unsupported type — acknowledge
    await sendWhatsAppMessage({
      phoneNumberId, accessToken: access_token, to: customerPhone,
      message: "Thank you for your message. Our team will get back to you shortly.",
    });
  }
}

// ── Process Text Message ──────────────────────────────────────
async function processTextMessage({ business_id, conversation, phoneNumberId, access_token, customerPhone, customerName, message }) {
  const text = message.text?.body || "";
  if (!text.trim()) return;

  // Check message limit
  if (!await checkMessageLimit(business_id)) {
    await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: "We are currently unavailable. Please contact us directly. Sorry for the inconvenience." });
    return;
  }

  // Increment usage
  await query("UPDATE subscriptions SET messages_used = messages_used + 1 WHERE business_id = $1", [business_id]);

  // Run agent
  const reply = await handleIncomingMessage({
    businessId:     business_id,
    conversationId: conversation.id,
    customerPhone,
    customerName,
    message:        text,
  });

  // Send reply + track message ID
  if (reply) {
    const result = await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: reply });
    if (result?.messages?.[0]?.id) {
      await query(`
        UPDATE messages SET wa_message_id = $1
        WHERE conversation_id = $2 AND role = 'agent' AND wa_message_id IS NULL
        ORDER BY created_at DESC LIMIT 1
      `, [result.messages[0].id, conversation.id]);
    }
  }
}

// ── Process Media Message ─────────────────────────────────────
async function processMediaMessage({ business_id, conversation, phoneNumberId, access_token, customerPhone, customerName, message, msgType }) {

  // Determine what kind of media this is
  const mediaLabels = {
    image:    "image",
    document: "document",
    video:    "video",
    audio:    "voice message",
  };

  const mediaLabel   = mediaLabels[msgType] || "file";
  const caption      = message[msgType]?.caption || "";
  const filename     = message[msgType]?.filename || "";

  // Detect if this looks like a payment
  const isPaymentRelated = detectPaymentMedia({ caption, filename, conversation });

  // Save media message to DB
  const msgContent = isPaymentRelated
    ? `[Payment ${mediaLabel} received${caption ? `: ${caption}` : ""}]`
    : `[${mediaLabel.charAt(0).toUpperCase() + mediaLabel.slice(1)} received${caption ? `: ${caption}` : ""}${filename ? ` (${filename})` : ""}]`;

  await saveMessage({ conversationId: conversation.id, businessId: business_id, role: "customer", content: msgContent });
  await query("UPDATE conversations SET last_message = $1, last_message_at = NOW() WHERE id = $2",
    [msgContent, conversation.id]);

  if (isPaymentRelated) {
    // ── Payment screenshot detected ───────────────────────────

    // 1. Send acknowledgement to customer
    const ackMessage = getPaymentAcknowledgement(customerName);
    await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: ackMessage });
    await saveMessage({ conversationId: conversation.id, businessId: business_id, role: "agent", content: ackMessage });

    // 2. Switch conversation to manual — agent stops replying
    await query(`UPDATE conversations SET status = 'manual', takeover_at = NOW() WHERE id = $1`, [conversation.id]);

    // 3. Notify owner on WhatsApp
    const ownerMsg = `💰 Payment received from ${customerName || customerPhone}!\n\nPlease verify and confirm the payment to proceed.\n\nConversation: ${customerPhone}`;
    await notifyOwnerWhatsApp(business_id, ownerMsg);

    // 4. Log activity
    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color)
      VALUES ($1, 'payment', $2, '💰', '#f0fdf4')
    `, [business_id, `Payment screenshot received from ${customerName || customerPhone}`]);

    console.log(`💰 Payment screenshot from ${customerPhone} — owner notified, agent paused`);

  } else {
    // ── Regular media (not payment) ───────────────────────────

    // Send acknowledgement
    const ackMessage = getMediaAcknowledgement(mediaLabel, customerName);
    await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: ackMessage });
    await saveMessage({ conversationId: conversation.id, businessId: business_id, role: "agent", content: ackMessage });

    // Switch to manual and notify owner
    await query(`UPDATE conversations SET status = 'manual', takeover_at = NOW() WHERE id = $1`, [conversation.id]);

    const ownerMsg = `📎 ${customerName || customerPhone} sent a ${mediaLabel}${caption ? `\nCaption: "${caption}"` : ""}${filename ? `\nFile: ${filename}` : ""}\n\nPlease review and respond.`;
    await notifyOwnerWhatsApp(business_id, ownerMsg);

    console.log(`📎 Media (${mediaLabel}) from ${customerPhone} — owner notified`);
  }
}

// ── Detect Payment Media ──────────────────────────────────────
function detectPaymentMedia({ caption, filename, conversation }) {
  const paymentKeywords = [
    "payment", "paid", "transfer", "upi", "gpay", "phonepe", "paytm",
    "neft", "imps", "rtgs", "receipt", "transaction", "txn", "screenshot",
    "payment done", "paid done", "advance", "deposit", "भुगतान", "पेमेंट",
  ];

  const text = `${caption} ${filename}`.toLowerCase();

  // Check caption/filename for payment keywords
  if (paymentKeywords.some(k => text.includes(k))) return true;

  // Check recent conversation context — if payment was being discussed
  return false;
}

// ── Acknowledgement Messages ──────────────────────────────────
function getPaymentAcknowledgement(customerName) {
  const name = customerName ? customerName.split(" ")[0] : "";
  return `Thank you${name ? ` ${name}` : ""}! I have received your payment confirmation and shared it with our team for verification. We will confirm and proceed shortly.`;
}

function getMediaAcknowledgement(mediaLabel, customerName) {
  const name = customerName ? customerName.split(" ")[0] : "";
  return `Thank you${name ? ` ${name}` : ""}! I have received your ${mediaLabel} and forwarded it to our team. They will review it and get back to you shortly.`;
}

function getMessageText(message) {
  if (message.type === "text") return message.text?.body;
  if (message.type === "image") return `[Image${message.image?.caption ? `: ${message.image.caption}` : ""}]`;
  if (message.type === "document") return `[Document: ${message.document?.filename || "file"}]`;
  if (message.type === "audio") return `[Voice message]`;
  if (message.type === "video") return `[Video]`;
  return `[${message.type}]`;
}

// ── Export for display name fetch ─────────────────────────────
export async function fetchAndSaveDisplayName(businessId, phoneNumberId, accessToken) {
  try {
    const response = await axios.get(`${META_BASE}/${META_VERSION}/${phoneNumberId}`, {
      params:  { fields: "display_phone_number,verified_name" },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const displayName = response.data?.verified_name || response.data?.display_phone_number;
    if (displayName) {
      await query("UPDATE whatsapp_configs SET display_name = $1 WHERE business_id = $2", [displayName, businessId]);
    }
    return displayName;
  } catch (err) {
    console.error("Display name fetch error:", err.message);
    return null;
  }
}

// ── Status Updates ────────────────────────────────────────────
async function processStatusUpdate({ waMessageId, status, recipientPhone }) {
  try {
    await query("UPDATE messages SET status = $1 WHERE wa_message_id = $2", [status, waMessageId]);
    if (status === "read") {
      await query("UPDATE conversations SET unread_count = 0 WHERE customer_phone = $1", [recipientPhone]);
    }
  } catch (err) {
    console.error("Status update error:", err.message);
  }
}

// ── Get or Create Conversation ────────────────────────────────
async function getOrCreateConversation({ businessId, customerPhone, customerName }) {
  const { rows } = await query(`
    SELECT id, status FROM conversations
    WHERE business_id = $1 AND customer_phone = $2 AND status != 'closed'
    ORDER BY created_at DESC LIMIT 1
  `, [businessId, customerPhone]);

  if (rows.length > 0) {
    if (customerName) {
      await query("UPDATE conversations SET customer_name = $1 WHERE id = $2", [customerName, rows[0].id]);
    }
    return rows[0];
  }

  const { rows: newRows } = await query(`
    INSERT INTO conversations (business_id, customer_name, customer_phone, status, unread_count)
    VALUES ($1, $2, $3, 'agent', 1) RETURNING id, status
  `, [businessId, customerName, customerPhone]);

  return newRows[0];
}

// ── Check Message Limit ───────────────────────────────────────
async function checkMessageLimit(businessId) {
  const { rows } = await query(`
    SELECT s.messages_used, p.message_limit
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.business_id = $1
  `, [businessId]);
  if (!rows.length) return false;
  return rows[0].messages_used < rows[0].message_limit;
}

// ── Save Message ──────────────────────────────────────────────
async function saveMessage({ conversationId, businessId, role, content }) {
  await query(`
    INSERT INTO messages (conversation_id, business_id, role, content)
    VALUES ($1, $2, $3, $4)
  `, [conversationId, businessId, role, content]);
}

// ── Verify Signature ──────────────────────────────────────────
function verifySignature(req) {
  return true;
}

export default router;