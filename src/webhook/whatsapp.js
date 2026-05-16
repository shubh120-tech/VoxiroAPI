import express from "express";
import crypto  from "crypto";
import axios   from "axios";
import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "../agents/agentManager.js";
import { sendWhatsAppMessage, getWhatsAppCredentials } from "../whatsapp/sender.js";

const router = express.Router();

const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
const META_VERSION = process.env.META_API_VERSION || "v19.0";

// ── Webhook Verification ──────────────────────────────────────
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Webhook verify attempt:", { mode, token });

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verification failed");
  res.sendStatus(403);
});

// ── Incoming Messages + Status Updates ───────────────────────
router.post("/", async (req, res) => {
  // Always respond 200 immediately
  res.sendStatus(200);

  try {
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
        const metadata = value.metadata;

        // ── Handle incoming messages ──────────────────────────
        for (const msg of value.messages || []) {
          if (msg.type === "text") {
            await processIncomingMessage({
              phoneNumberId:  metadata.phone_number_id,
              customerPhone:  msg.from,
              customerName:   value.contacts?.[0]?.profile?.name || null,
              messageText:    msg.text.body,
              waMessageId:    msg.id,
            });
          }
        }

        // ── Handle message status updates ─────────────────────
        for (const status of value.statuses || []) {
          await processStatusUpdate({
            waMessageId: status.id,
            status:      status.status,      // sent | delivered | read | failed
            timestamp:   status.timestamp,
            phoneNumberId: metadata.phone_number_id,
            recipientPhone: status.recipient_id,
          });
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ── Process Incoming Message ──────────────────────────────────
async function processIncomingMessage({
  phoneNumberId, customerPhone, customerName, messageText, waMessageId,
}) {
  // Find business by phone number ID
  const { rows: bizRows } = await query(`
    SELECT b.id AS business_id, wc.access_token
    FROM whatsapp_configs wc
    JOIN businesses b ON b.id = wc.business_id
    WHERE wc.phone_number_id = $1
      AND b.is_active = TRUE
    ORDER BY wc.updated_at DESC
    LIMIT 1
  `, [phoneNumberId]);

  if (!bizRows.length) {
    console.warn(`No business found for phoneNumberId: ${phoneNumberId}`);
    return;
  }

  const { business_id, access_token } = bizRows[0];

  // Get or create conversation
  const conversation = await getOrCreateConversation({
    businessId:    business_id,
    customerPhone,
    customerName,
  });

  // Update customer last seen
  await query(`
    UPDATE conversations
    SET customer_last_seen = NOW()
    WHERE id = $1
  `, [conversation.id]);

  // Check message limit
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

  // Increment usage
  await query(`
    UPDATE subscriptions
    SET messages_used = messages_used + 1
    WHERE business_id = $1
  `, [business_id]);

  // Run agent
  const reply = await handleIncomingMessage({
    businessId:     business_id,
    conversationId: conversation.id,
    customerPhone,
    customerName,
    message:        messageText,
  });

  // Send reply + track wa_message_id
  if (reply) {
    const result = await sendWhatsAppMessage({
      phoneNumberId,
      accessToken: access_token,
      to:          customerPhone,
      message:     reply,
    });

    // Save wa_message_id for status tracking
    if (result?.messages?.[0]?.id) {
      await query(`
        UPDATE messages
        SET wa_message_id = $1
        WHERE conversation_id = $2
          AND role = 'agent'
          AND wa_message_id IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `, [result.messages[0].id, conversation.id]);
    }
  }
}

// ── Process Status Update ─────────────────────────────────────
async function processStatusUpdate({ waMessageId, status, phoneNumberId, recipientPhone }) {
  try {
    // Map Meta status to our status
    const statusMap = {
      sent:      "sent",
      delivered: "delivered",
      read:      "read",
      failed:    "failed",
    };

    const mappedStatus = statusMap[status] || status;

    // Update message status in DB
    const { rowCount } = await query(`
      UPDATE messages
      SET status = $1
      WHERE wa_message_id = $2
    `, [mappedStatus, waMessageId]);

    if (rowCount > 0) {
      console.log(`✅ Message ${waMessageId} status: ${mappedStatus}`);
    }

    // If read — update conversation unread count
    if (status === "read") {
      await query(`
        UPDATE conversations
        SET unread_count = 0
        WHERE customer_phone = $1
      `, [recipientPhone]);
    }

  } catch (err) {
    console.error("Status update error:", err.message);
  }
}

// ── Get WhatsApp Display Name from Meta API ───────────────────
export async function fetchAndSaveDisplayName(businessId, phoneNumberId, accessToken) {
  try {
    const response = await axios.get(
      `${META_BASE}/${META_VERSION}/${phoneNumberId}`,
      {
        params:  { fields: "display_phone_number,verified_name,quality_rating" },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const displayName = response.data?.verified_name || response.data?.display_phone_number;

    if (displayName) {
      await query(`
        UPDATE whatsapp_configs
        SET display_name = $1, updated_at = NOW()
        WHERE business_id = $2
      `, [displayName, businessId]);
    }

    return displayName;
  } catch (err) {
    console.error("Fetch display name error:", err.message);
    return null;
  }
}

// ── Get or Create Conversation ────────────────────────────────
async function getOrCreateConversation({ businessId, customerPhone, customerName }) {
  const { rows } = await query(`
    SELECT id, status FROM conversations
    WHERE business_id    = $1
      AND customer_phone = $2
      AND status != 'closed'
    ORDER BY created_at DESC
    LIMIT 1
  `, [businessId, customerPhone]);

  if (rows.length > 0) {
    if (customerName) {
      await query(
        "UPDATE conversations SET customer_name = $1 WHERE id = $2",
        [customerName, rows[0].id]
      );
    }
    return rows[0];
  }

  const { rows: newRows } = await query(`
    INSERT INTO conversations
      (business_id, customer_name, customer_phone, status, unread_count)
    VALUES ($1, $2, $3, 'agent', 1)
    RETURNING id, status
  `, [businessId, customerName, customerPhone]);

  return newRows[0];
}

// ── Check Message Limit ───────────────────────────────────────
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

// ── Verify Webhook Signature ──────────────────────────────────
function verifySignature(req) {
  // if (process.env.NODE_ENV === "development") return true; // skip in dev
  // const signature = req.headers["x-hub-signature-256"];
  // if (!signature) return true; // allow if no secret set
  // try {
  //   const expected = "sha256=" + crypto
  //     .createHmac("sha256", process.env.META_APP_SECRET || "")
  //     .update(JSON.stringify(req.body))
  //     .digest("hex");
  //   return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  // } catch {
  //   return true;
  // }
  return true;
}

export default router;