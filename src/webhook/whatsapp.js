import express from "express";
import crypto  from "crypto";
import axios   from "axios";
import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "../agents/agentManager.js";
import { sendWhatsAppMessage, notifyOwnerWhatsApp, getWhatsAppCredentials, markReadAndShowTyping } from "../whatsapp/sender.js";

const router = express.Router();

// ── Get agent behavior settings for a business ───────────────
async function getAgentBehavior(businessId) {
  const { rows } = await query(
    "SELECT * FROM agent_behavior WHERE business_id = $1",
    [businessId]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

// ── Check if current IST time is within working hours ─────────
function isWithinWorkingHours(behavior) {
  if (!behavior || behavior.working_hours_mode === "24x7") return true;
  const now  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day  = ["sun","mon","tue","wed","thu","fri","sat"][now.getUTCDay()];
  const days = behavior.working_days || ["mon","tue","wed","thu","fri","sat"];
  if (!days.includes(day)) return false;
  const hhmm  = `${String(now.getUTCHours()).padStart(2,"0")}:${String(now.getUTCMinutes()).padStart(2,"0")}`;
  const start = behavior.working_start || "10:00";
  const end   = behavior.working_end   || "22:00";
  return hhmm >= start && hhmm < end;
}

// ── Check keyword escalation ──────────────────────────────────
async function checkKeywordEscalation(businessId, messageText, conversationId) {
  try {
    const { rows } = await query(
      "SELECT notify_on_keywords FROM agent_behavior WHERE business_id = $1",
      [businessId]
    ).catch(() => ({ rows: [] }));
    if (!rows.length) return null;
    const keywords  = rows[0].notify_on_keywords || [];
    const lowerMsg  = messageText.toLowerCase();
    const triggered = keywords.find(kw => lowerMsg.includes(kw.toLowerCase()));
    if (triggered) {
      await query(`
        UPDATE conversations
        SET status = 'needs-help', escalated_at = COALESCE(escalated_at, NOW()), updated_at = NOW()
        WHERE id = $1
      `, [conversationId]);
      console.log(`🚨 Keyword escalation triggered: "${triggered}"`);
      return triggered;
    }
    return null;
  } catch (err) {
    console.error("Keyword check error:", err.message);
    return null;
  }
}

// ── Debug endpoint ────────────────────────────────────────────
router.get("/debug", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wc.phone_number_id, wc.is_verified, b.name, b.is_active,
             wc.access_token IS NOT NULL AS has_token
      FROM whatsapp_configs wc JOIN businesses b ON b.id = wc.business_id LIMIT 10
    `);
    const { rows: pending } = await query(
      "SELECT COUNT(*) AS count, MAX(created_at) AS last FROM pending_messages WHERE processed = FALSE"
    );
    res.json({ configs: rows, pending_msgs: pending[0], verify_token: process.env.META_VERIFY_TOKEN, has_app_secret: !!process.env.META_APP_SECRET });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post("/", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log("📨 Webhook POST received:", JSON.stringify(body).slice(0, 300));
    if (!body || body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        console.log("🔄 Change field:", change.field);

        if (change.field === "message_template_status_update") {
          try {
            const { handleTemplateStatusUpdate } = await import("../routes/broadcast.js");
            await handleTemplateStatusUpdate(change.value);
          } catch (err) { console.error("Template status webhook error:", err.message); }
          continue;
        }

        if (change.field === "messages" && change.value?.statuses) {
          for (const status of change.value.statuses || []) await updateBroadcastStatus(status);
        }

        if (change.field !== "messages") continue;

        const value = change.value, messages = value.messages || [], metadata = value.metadata;
        console.log(`📞 Phone Number ID from Meta: ${metadata?.phone_number_id}`);

        const phoneNumberId = metadata.phone_number_id;
        const { rows: bizRows } = await query(`
          SELECT b.id AS business_id, b.name, wc.access_token, wc.phone_number_id AS stored_phone_id
          FROM whatsapp_configs wc JOIN businesses b ON b.id = wc.business_id
          WHERE wc.phone_number_id = $1 AND b.is_active = TRUE
          ORDER BY wc.updated_at DESC LIMIT 1
        `, [phoneNumberId]);

        if (!bizRows.length) {
          const { rows: allConfigs } = await query("SELECT phone_number_id, business_id FROM whatsapp_configs LIMIT 5");
          console.warn(`⚠️  No business for phone_number_id: "${phoneNumberId}"`);
          console.warn(`   Stored IDs in DB:`, allConfigs.map(r => r.phone_number_id));
          continue;
        }

        const { business_id, name, access_token } = bizRows[0];
        console.log(`✅ Business found: ${name} (${business_id})`);

        for (const msg of messages) {
          const customerPhone = msg.from;
          const customerName  = value.contacts?.[0]?.profile?.name || null;
          console.log(`📱 Message from: ${customerPhone} | type: ${msg.type} | text: ${msg.text?.body?.slice(0, 50) || ""}`);

          if (msg.type === "text") {
            await savePendingMessage({ businessId: business_id, customerPhone, customerName, phoneNumberId, accessToken: access_token, messageText: msg.text?.body || "", waMessageId: msg.id });
            console.log("✅ Message saved to pending queue");
          } else if (["image", "document", "video", "audio", "sticker"].includes(msg.type)) {
            await processMediaMessage({ phoneNumberId, customerPhone, customerName, msg, businessId: business_id, accessToken: access_token });
          }
        }
      }
    }
  } catch (err) { console.error("❌ Webhook processing error:", err.message, err.stack); }
});

async function processIncomingMessage({ phoneNumberId, customerPhone, customerName, messageText, waMessageId }) {
  const { rows: bizRows } = await query(`
    SELECT b.id AS business_id, wc.access_token FROM whatsapp_configs wc
    JOIN businesses b ON b.id = wc.business_id
    WHERE wc.phone_number_id = $1 AND b.is_active = TRUE
  `, [phoneNumberId]);
  if (!bizRows.length) { console.warn(`No business found for phoneNumberId: ${phoneNumberId}`); return; }

  const { business_id, access_token } = bizRows[0];
  const conversation = await getOrCreateConversation({ businessId: business_id, customerPhone, customerName });

  await cancelPendingFollowUps(business_id, customerPhone);
  await markBroadcastReplied(business_id, customerPhone);

  const triggeredKeyword = await checkKeywordEscalation(business_id, messageText, conversation.id);
  if (triggeredKeyword) {
    await notifyOwnerWhatsApp(business_id, `🚨 Keyword alert: Customer ${customerName || customerPhone} said "${triggeredKeyword}". Please check immediately.`);
    return;
  }

  const behavior    = await getAgentBehavior(business_id);
  const withinHours = isWithinWorkingHours(behavior);

  if (!withinHours && behavior) {
    const action = behavior.outside_hours_action || "reply_closed";
    if (action === "silent") { console.log(`🌙 Outside hours (silent) for ${customerPhone}`); return; }
    if (action === "reply_closed" || action === "collect_only") {
      const closedMsg = behavior.outside_hours_msg || "We are currently closed. We will get back to you during business hours. Thank you! 🙏";
      await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: closedMsg });
      await query(`INSERT INTO messages (conversation_id, business_id, role, content) VALUES ($1, $2, 'agent', $3)`, [conversation.id, business_id, closedMsg]);
      if (action === "collect_only") {
        await query(`UPDATE conversations SET status = 'needs-help', escalated_at = COALESCE(escalated_at, NOW()), updated_at = NOW() WHERE id = $1`, [conversation.id]);
        await notifyOwnerWhatsApp(business_id, `📋 Outside-hours inquiry from ${customerName || customerPhone}: "${messageText.slice(0, 100)}"`);
      }
      return;
    }
  }

  const allowed = await checkMessageLimit(business_id);
  if (!allowed) {
    await sendWhatsAppMessage({ phoneNumberId, accessToken: access_token, to: customerPhone, message: "We're currently unavailable. Please contact us directly. Sorry for the inconvenience! 🙏" });
    return;
  }

  if (behavior?.max_auto_replies > 0) {
    const { rows: convRows } = await query("SELECT auto_reply_count FROM conversations WHERE id = $1", [conversation.id]);
    const replyCount = parseInt(convRows[0]?.auto_reply_count) || 0;
    if (replyCount >= behavior.max_auto_replies) {
      await query(`UPDATE conversations SET status = 'needs-help', escalated_at = COALESCE(escalated_at, NOW()), updated_at = NOW() WHERE id = $1`, [conversation.id]);
      await notifyOwnerWhatsApp(business_id, `👋 Customer ${customerName || customerPhone} has sent ${replyCount} messages. Please review.`);
      return;
    }
  }

  await query(`UPDATE subscriptions SET messages_used = messages_used + 1 WHERE business_id = $1`, [business_id]);
  await query(`UPDATE conversations SET auto_reply_count = COALESCE(auto_reply_count, 0) + 1 WHERE id = $1`, [conversation.id]);

  await handleIncomingMessage({ businessId: business_id, conversationId: conversation.id, customerPhone, customerName, message: messageText, phoneNumberId, accessToken: access_token, waMessageId });
}

async function getOrCreateConversation({ businessId, customerPhone, customerName }) {
  const { rows } = await query(`
    SELECT id, status FROM conversations
    WHERE business_id = $1 AND customer_phone = $2 AND status NOT IN ('closed', 'manual', 'needs-help')
    ORDER BY created_at DESC LIMIT 1
  `, [businessId, customerPhone]);

  if (rows.length > 0) {
    if (customerName) await query("UPDATE conversations SET customer_name = $1 WHERE id = $2", [customerName, rows[0].id]);
    return rows[0];
  }

  const { rows: newRows } = await query(`
    INSERT INTO conversations (business_id, customer_name, customer_phone, status, unread_count)
    VALUES ($1, $2, $3, 'agent', 1) RETURNING id, status
  `, [businessId, customerName, customerPhone]);
  return newRows[0];
}

async function checkMessageLimit(businessId) {
  const { rows } = await query(`
    SELECT s.messages_used, p.message_limit FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id WHERE s.business_id = $1
  `, [businessId]);
  if (!rows.length) return false;
  return rows[0].messages_used < rows[0].message_limit;
}

function verifySignature(req) { return true; }

// ── Process Media Message ─────────────────────────────────────
async function processMediaMessage({ phoneNumberId, customerPhone, customerName, msg, businessId, accessToken }) {
  try {
    const conversation = await getOrCreateConversation({ businessId, customerPhone, customerName });
    await cancelPendingFollowUps(businessId, customerPhone);

    const typeLabels = { image: "image", document: "document", video: "video", audio: "voice message", sticker: "sticker" };
    const typeLabel  = typeLabels[msg.type] || "file";
    const caption    = msg[msg.type]?.caption   || "";
    const filename   = msg[msg.type]?.filename  || "";
    const mediaId    = msg[msg.type]?.id        || null;
    const mimeType   = msg[msg.type]?.mime_type || "";

    const isPayment = /pay|paid|upi|gpay|phonepe|paytm|neft|imps|receipt|transaction|txn|screenshot|advance|deposit|भुगतान|पेमेंट/i
      .test(`${caption} ${filename}`);

    // ── FIX: Store media URL or fallback to meta_media_id ────
    let storedUrl = null;
    if (mediaId) {
      if (process.env.CLOUDFLARE_R2_ACCOUNT_ID) {
        try {
          storedUrl = await downloadAndStoreMedia({ mediaId, accessToken, businessId, mimeType, filename });
          console.log(`✅ Media stored in R2: ${storedUrl}`);
        } catch (err) {
          console.error("R2 store error — falling back to meta_media_id:", err.message);
          storedUrl = `meta_media_id:${mediaId}`;
        }
      } else {
        // No R2 configured — store the Meta media ID for on-demand fetching
        storedUrl = `meta_media_id:${mediaId}`;
        console.log(`📎 No R2 configured — storing meta_media_id for ${filename || typeLabel}`);
      }
    }

    const dbContent = isPayment
      ? `[Payment ${typeLabel}${caption ? `: ${caption}` : ""}]`
      : `[${typeLabel}${caption ? `: ${caption}` : ""}${filename ? ` (${filename})` : ""}]`;

    await query(`
      INSERT INTO messages (conversation_id, business_id, role, content, media_url, media_type, media_filename)
      VALUES ($1, $2, 'customer', $3, $4, $5, $6)
    `, [conversation.id, businessId, dbContent, storedUrl, msg.type, filename || null]);

    await query(`UPDATE conversations SET last_message = $1, last_message_at = NOW(), customer_last_seen = NOW() WHERE id = $2`, [dbContent, conversation.id]);

    const ackMsg = isPayment
      ? `Thank you! I have received your payment confirmation and shared it with the team. We will verify and confirm shortly.`
      : `Thank you! I have received your ${typeLabel} and shared it with the team. They will review and get back to you shortly.`;

    await sendWhatsAppMessage({ phoneNumberId, accessToken, to: customerPhone, message: ackMsg });
    await query(`INSERT INTO messages (conversation_id, business_id, role, content) VALUES ($1, $2, 'agent', $3)`, [conversation.id, businessId, ackMsg]);
    await query(`UPDATE conversations SET status = 'manual', escalated_at = COALESCE(escalated_at, NOW()), updated_at = NOW() WHERE id = $1`, [conversation.id]);

    const name     = customerName || customerPhone;
    const icon     = isPayment ? "💰" : "📎";
    const subject  = isPayment ? "Payment received" : `${typeLabel} received`;
    const ownerMsg = `${icon} ${subject} from ${name}` + (caption ? `\nCaption: "${caption}"` : "") + (filename ? `\nFile: ${filename}` : "") + `\nOpen dashboard to view and respond.`;

    await notifyOwnerWhatsApp(businessId, ownerMsg);
    console.log(`${icon} Media (${typeLabel}) from ${customerPhone} — stored & owner notified`);
  } catch (err) { console.error("Media message error:", err.message); }
}

// ── Download Media from Meta + Store in R2 ───────────────────
async function downloadAndStoreMedia({ mediaId, accessToken, businessId, mimeType, filename }) {
  const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
  const META_VERSION = process.env.META_API_VERSION || "v19.0";

  const metaRes  = await axios.get(`${META_BASE}/${META_VERSION}/${mediaId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const mediaUrl = metaRes.data?.url;
  if (!mediaUrl) throw new Error("No media URL from Meta");

  const fileRes = await axios.get(mediaUrl, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${accessToken}` } });
  const buffer  = Buffer.from(fileRes.data);

  const AWS = (await import("aws-sdk")).default;
  const r2  = new AWS.S3({
    endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    region: "auto", signatureVersion: "v4",
  });

  const mimeMap = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf", "audio/ogg": "ogg", "video/mp4": "mp4", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx" };
  const ext    = mimeMap[mimeType] || filename?.split(".").pop() || "bin";
  const key    = `media/${businessId}/${Date.now()}.${ext}`;
  const bucket = process.env.CLOUDFLARE_R2_BUCKET || "voxiro-knowledge";

  await r2.putObject({ Bucket: bucket, Key: key, Body: buffer, ContentType: mimeType || "application/octet-stream" }).promise();
  return r2.getSignedUrl("getObject", { Bucket: bucket, Key: key, Expires: 7 * 24 * 60 * 60 });
}

async function markBroadcastReplied(businessId, customerPhone) {
  try {
    const { rows } = await query(`
      SELECT br.id, br.campaign_id FROM broadcast_recipients br
      WHERE br.business_id = $1 AND br.phone = $2 AND br.status IN ('sent','delivered','read') AND br.replied_at IS NULL
      ORDER BY br.sent_at DESC LIMIT 1
    `, [businessId, customerPhone]);
    if (!rows.length) return;
    await query(`UPDATE broadcast_recipients SET status = 'replied', replied_at = NOW() WHERE id = $1`, [rows[0].id]);
    await query(`UPDATE broadcast_campaigns SET replied_count = replied_count + 1 WHERE id = $1`, [rows[0].campaign_id]);
    console.log(`📢 Broadcast reply from ${customerPhone}`);
  } catch (err) { console.error("Mark broadcast replied error:", err.message); }
}

async function updateBroadcastStatus(status) {
  try {
    const { id: waMessageId, status: msgStatus } = status;
    if (!waMessageId) return;
    const { rows } = await query(`SELECT id, campaign_id FROM broadcast_recipients WHERE wa_message_id = $1 LIMIT 1`, [waMessageId]);
    if (!rows.length) return;
    const recipient = rows[0];
    const now = new Date().toISOString();
    const statusMap = { delivered: "delivered", read: "read", failed: "failed" };
    const newStatus = statusMap[msgStatus];
    if (!newStatus) return;
    await query(`UPDATE broadcast_recipients SET status = $1, ${newStatus === "delivered" ? "delivered_at" : newStatus === "read" ? "read_at" : "error_message"} = $2 WHERE id = $3`, [newStatus, now, recipient.id]);
    const counterCol = { delivered: "delivered_count", read: "read_count", failed: "failed_count" }[newStatus];
    if (counterCol) await query(`UPDATE broadcast_campaigns SET ${counterCol} = ${counterCol} + 1 WHERE id = $1`, [recipient.campaign_id]);
  } catch (err) { console.error("Broadcast status update error:", err.message); }
}

async function savePendingMessage({ businessId, customerPhone, customerName, phoneNumberId, accessToken, messageText, waMessageId }) {
  try {
    const conversation = await getOrCreateConversation({ businessId, customerPhone, customerName });
    await cancelPendingFollowUps(businessId, customerPhone);
    if (waMessageId) await markReadAndShowTyping({ phoneNumberId, accessToken, waMessageId });

    await query(`
      INSERT INTO pending_messages (business_id, conversation_id, customer_phone, customer_name, phone_number_id, access_token, message_text, wa_message_id, message_type, received_at, processed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'text', NOW(), FALSE)
    `, [businessId, conversation.id, customerPhone, customerName, phoneNumberId, accessToken, messageText, waMessageId]);

    if (waMessageId) {
      const { rows: existing } = await query("SELECT id FROM messages WHERE wa_message_id = $1 LIMIT 1", [waMessageId]);
      if (!existing.length) await query(`INSERT INTO messages (conversation_id, business_id, role, content, wa_message_id) VALUES ($1, $2, 'customer', $3, $4)`, [conversation.id, businessId, messageText, waMessageId]);
    } else {
      await query(`INSERT INTO messages (conversation_id, business_id, role, content) VALUES ($1, $2, 'customer', $3)`, [conversation.id, businessId, messageText]);
    }

    await query(`UPDATE conversations SET last_message = $1, last_message_at = NOW(), customer_last_seen = NOW() WHERE id = $2`, [messageText, conversation.id]);
    console.log(`⏳ Message batched from ${customerPhone} — waiting 10s`);
  } catch (err) { console.error("Save pending message error:", err.message); }
}

async function cancelPendingFollowUps(businessId, customerPhone) {
  try {
    const { rowCount } = await query(`
      UPDATE follow_ups SET sent = TRUE, sent_at = NOW(), error_message = 'Cancelled — customer messaged before follow-up time'
      WHERE business_id = $1 AND customer_phone = $2 AND sent = FALSE AND scheduled_at > NOW()
    `, [businessId, customerPhone]);
    if (rowCount > 0) console.log(`✅ Cancelled ${rowCount} pending follow-up(s) for ${customerPhone}`);
  } catch (err) { console.error("Cancel follow-up error:", err.message); }
}

export default router;