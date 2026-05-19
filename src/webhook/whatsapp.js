import express from "express";
import crypto  from "crypto";
import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "../agents/agentManager.js";
import { sendWhatsAppMessage, notifyOwnerWhatsApp, getWhatsAppCredentials } from "../whatsapp/sender.js";

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
          const customerPhone = msg.from;
          const customerName  = value.contacts?.[0]?.profile?.name || null;
          const phoneNumberId = metadata.phone_number_id;

          if (msg.type === "text") {
            // Normal text message — process with agent
            await processIncomingMessage({
              phoneNumberId,
              customerPhone,
              customerName,
              messageText: msg.text.body,
              waMessageId: msg.id,
            });

          } else if (["image", "document", "video", "audio", "sticker"].includes(msg.type)) {
            // Any media/document — notify owner immediately
            await processMediaMessage({
              phoneNumberId,
              customerPhone,
              customerName,
              msg,
            });
          }
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

  // 2b. Cancel any pending follow-ups — customer is already here
  await cancelPendingFollowUps(business_id, customerPhone);

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
    waMessageId:    waMessageId,  // for marking as read + typing simulation
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
  return true;
}

// ── Process Media / Document Message ────────────────────────
async function processMediaMessage({ phoneNumberId, customerPhone, customerName, msg }) {
  try {
    const { rows: bizRows } = await query(`
      SELECT b.id AS business_id, wc.access_token
      FROM whatsapp_configs wc
      JOIN businesses b ON b.id = wc.business_id
      WHERE wc.phone_number_id = $1 AND b.is_active = TRUE
      ORDER BY wc.updated_at DESC LIMIT 1
    `, [phoneNumberId]);

    if (!bizRows.length) return;
    const { business_id, access_token } = bizRows[0];

    const conversation = await getOrCreateConversation({ businessId: business_id, customerPhone, customerName });
    await cancelPendingFollowUps(business_id, customerPhone);

    const typeLabels = { image: "image", document: "document", video: "video", audio: "voice message", sticker: "sticker" };
    const typeLabel  = typeLabels[msg.type] || "file";
    const caption    = msg[msg.type]?.caption   || "";
    const filename   = msg[msg.type]?.filename  || "";
    const mediaId    = msg[msg.type]?.id        || null;
    const mimeType   = msg[msg.type]?.mime_type || "";

    const isPayment = /pay|paid|upi|gpay|phonepe|paytm|neft|imps|receipt|transaction|txn|screenshot|advance|deposit|भुगतान|पेमेंट/i
      .test(`${caption} ${filename}`);

    // Download and store media
    let storedUrl = null;
    if (mediaId && process.env.CLOUDFLARE_R2_ACCOUNT_ID) {
      try {
        storedUrl = await downloadAndStoreMedia({ mediaId, accessToken: access_token, businessId: business_id, mimeType, filename });
        console.log(`✅ Media stored: ${storedUrl}`);
      } catch (err) {
        console.error("Media download/store error:", err.message);
      }
    }

    const dbContent = isPayment
      ? `[Payment ${typeLabel}${caption ? `: ${caption}` : ""}]`
      : `[${typeLabel}${caption ? `: ${caption}` : ""}${filename ? ` (${filename})` : ""}]`;

    // Save message with media URL
    await query(`
      INSERT INTO messages (conversation_id, business_id, role, content, media_url, media_type, media_filename)
      VALUES ($1, $2, 'customer', $3, $4, $5, $6)
    `, [conversation.id, business_id, dbContent, storedUrl, msg.type, filename || null]);

    await query(`
      UPDATE conversations SET last_message = $1, last_message_at = NOW(), customer_last_seen = NOW() WHERE id = $2
    `, [dbContent, conversation.id]);

    const ackMsg = isPayment
      ? `Thank you! I have received your payment confirmation and shared it with the team. We will verify and confirm shortly.`
      : `Thank you! I have received your ${typeLabel} and shared it with the team. They will review and get back to you shortly.`;

    await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: ackMsg });
    await query(`INSERT INTO messages (conversation_id, business_id, role, content) VALUES ($1, $2, 'agent', $3)`,
      [conversation.id, business_id, ackMsg]);
    await query(`UPDATE conversations SET status = 'manual', updated_at = NOW() WHERE id = $1`, [conversation.id]);

    const name     = customerName || customerPhone;
    const icon     = isPayment ? "💰" : "📎";
    const subject  = isPayment ? "Payment received" : `${typeLabel} received`;
    const ownerMsg = `${icon} ${subject} from ${name}`
      + (caption  ? `
Caption: "${caption}"` : "")
      + (filename ? `
File: ${filename}`     : "")
      + `
Open dashboard to view and respond.`;

    await notifyOwnerWhatsApp(business_id, ownerMsg);
    console.log(`${icon} Media (${typeLabel}) from ${customerPhone} — stored & owner notified`);

  } catch (err) {
    console.error("Media message error:", err.message);
  }
}

// ── Download Media from Meta + Store in R2 ───────────────────
async function downloadAndStoreMedia({ mediaId, accessToken, businessId, mimeType, filename }) {
  const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
  const META_VERSION = process.env.META_API_VERSION || "v19.0";

  // Get media URL from Meta
  const metaRes = await axios.get(
    `${META_BASE}/${META_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const mediaUrl = metaRes.data?.url;
  if (!mediaUrl) throw new Error("No media URL from Meta");

  // Download file
  const fileRes = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers:      { Authorization: `Bearer ${accessToken}` },
  });
  const buffer = Buffer.from(fileRes.data);

  // Upload to R2
  const AWS = (await import("aws-sdk")).default;
  const r2  = new AWS.S3({
    endpoint:         `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId:      process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey:  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    region:           "auto",
    signatureVersion: "v4",
  });

  const mimeMap = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "application/pdf": "pdf", "audio/ogg": "ogg", "video/mp4": "mp4",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  const ext    = mimeMap[mimeType] || filename?.split(".").pop() || "bin";
  const key    = `media/${businessId}/${Date.now()}.${ext}`;
  const bucket = process.env.CLOUDFLARE_R2_BUCKET || "voxiro-knowledge";

  await r2.putObject({ Bucket: bucket, Key: key, Body: buffer, ContentType: mimeType || "application/octet-stream" }).promise();

  // Generate signed URL (valid 7 days) so dashboard can view it
  const signedUrl = r2.getSignedUrl("getObject", {
    Bucket:  bucket,
    Key:     key,
    Expires: 7 * 24 * 60 * 60, // 7 days
  });

  return signedUrl;
}


// ── Cancel Pending Follow-ups ────────────────────────────────
async function cancelPendingFollowUps(businessId, customerPhone) {
  try {
    const { rowCount } = await query(`
      UPDATE follow_ups
      SET sent          = TRUE,
          sent_at       = NOW(),
          error_message = 'Cancelled — customer messaged before follow-up time'
      WHERE business_id    = $1
        AND customer_phone = $2
        AND sent           = FALSE
        AND scheduled_at   > NOW()
    `, [businessId, customerPhone]);

    if (rowCount > 0) {
      console.log(`✅ Cancelled ${rowCount} pending follow-up(s) for ${customerPhone} — customer messaged first`);
    }
  } catch (err) {
    console.error("Cancel follow-up error:", err.message);
  }
}

export default router;