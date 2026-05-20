import axios from "axios";
import { query } from "../db/postgres.js";

const META_BASE = process.env.META_BASE_URL    || "https://graph.facebook.com";
const VERSION   = process.env.META_API_VERSION || "v19.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mark message as read AND show typing indicator.
 * Customer sees: blue ticks + "typing..." immediately.
 * Typing indicator auto-dismisses after 25s or when message arrives.
 */
export async function markReadAndShowTyping({ phoneNumberId, accessToken, waMessageId }) {
  if (!waMessageId) return;
  try {
    await axios.post(
      `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status:            "read",
        message_id:        waMessageId,
        typing_indicator:  { type: "text" },
      },
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    // Non-critical — fallback to just marking read
    try {
      await axios.post(
        `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
        { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch {}
  }
}

/**
 * Mark a customer message as read only (no typing indicator).
 */
export async function markMessageAsRead({ phoneNumberId, accessToken, waMessageId }) {
  if (!waMessageId) return;
  try {
    await axios.post(
      `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    console.error("Mark read error:", err.message);
  }
}

/**
 * Calculate human-like sales executive typing delay.
 *
 * A real sales exec behavior:
 * - Reads message first (1-3s)
 * - Thinks about reply (1-5s)
 * - Types at ~40 words/min (human typing speed)
 * - Makes occasional typo pauses
 */
function getSalesExecDelay(message, isFirstMessage = true) {
  const chars = message.length;

  // Reading delay — only for first message in a response
  const readDelay = isFirstMessage ? (300 + Math.random() * 500) : 0; // 0.3-0.8s

  // Thinking delay — quick for simple, slightly longer for complex
  const isQuotation = /quotation|price|fee|amount|₹|payment/i.test(message);
  const isComplex   = chars > 150 || isQuotation;
  const isSimple    = chars < 25;

  let thinkDelay;
  if (isSimple)        thinkDelay = 300 + Math.random() * 500;   // 0.3-0.8s
  else if (isComplex)  thinkDelay = 800 + Math.random() * 1200;  // 0.8-2s
  else                 thinkDelay = 500 + Math.random() * 800;   // 0.5-1.3s

  // Typing speed — ~400 chars/min (fast but human)
  const charsPerMin = 400;
  const typingDelay = (chars / charsPerMin) * 60 * 1000;

  // Small random variation ±10%
  const variation = (Math.random() * 0.2 - 0.1) * typingDelay;

  const total = readDelay + thinkDelay + typingDelay + variation;

  // Clamp: min 0.8s, max 6s — fast enough to feel human, not robotic
  return Math.min(Math.max(total, 800), 6000);
}

/**
 * Send a single WhatsApp message with sales-exec-like delay.
 */
export async function sendWhatsAppMessage({
  phoneNumberId,
  accessToken,
  to,
  message,
  waMessageId      = null,   // incoming message to mark as read
  replyToMessageId = null,   // message to quote in reply
  isFirstMessage   = true,
}) {
  try {
    // 1. Mark as read + show typing indicator immediately
    if (waMessageId) {
      await markReadAndShowTyping({ phoneNumberId, accessToken, waMessageId });
      // Small pause — customer sees "typing..." appear
      await sleep(300 + Math.random() * 400);
    }

    // 2. Sales exec delay — read + think + type
    const delay = getSalesExecDelay(message, isFirstMessage);
    await sleep(delay);

    // 3. Send message (with optional quote context)
    const payload = {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "text",
      text:              { body: message, preview_url: false },
    };

    // Add quote context if replying to a specific message
    if (replyToMessageId) {
      payload.context = { message_id: replyToMessageId };
    }

    const response = await axios.post(
      `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;

  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Send MULTIPLE messages with sales-exec-like delays between each.
 *
 * Simulates a real sales person:
 * - Reads message (only for first)
 * - Thinks
 * - Types each part naturally
 * - Small pause between parts (finishing one thought, starting next)
 */
export async function sendWhatsAppMessages({
  phoneNumberId,
  accessToken,
  to,
  messages,
  waMessageId      = null,  // incoming message — mark as read + quote first reply
  replyToMessageId = null,  // explicit message to quote (overrides waMessageId)
}) {
  const results = [];

  // The message to quote — use explicit or fall back to incoming message
  const quoteId = replyToMessageId || waMessageId;

  for (let i = 0; i < messages.length; i++) {
    const msg     = messages[i];
    const isFirst = i === 0;
    if (!msg?.trim()) continue;

    // First message: mark as read + show typing indicator
    if (isFirst && waMessageId) {
      await markReadAndShowTyping({ phoneNumberId, accessToken, waMessageId });
      // Small pause — customer sees "typing..." appear
      await sleep(300 + Math.random() * 400);
    }

    // Send with appropriate delay
    // Only quote on the FIRST message — subsequent parts are continuation
    const result = await sendWhatsAppMessage({
      phoneNumberId,
      accessToken,
      to,
      message:         msg,
      waMessageId:     null,
      replyToMessageId: isFirst ? quoteId : null, // quote only first part
      isFirstMessage:  isFirst,
    });

    results.push(result);

    if (i < messages.length - 1) {
      // Short pause between parts
      await sleep(400 + Math.random() * 600);

      // Re-trigger typing indicator for next part
      // (typing indicator lasts 25s max — re-send to keep it visible)
      try {
        await axios.post(
          `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
          {
            messaging_product: "whatsapp",
            status:            "read",
            message_id:        waMessageId || "placeholder",
            typing_indicator:  { type: "text" },
          },
          { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
        );
      } catch { /* non-critical */ }
    }
  }

  return results;
}

/**
 * Split agent reply into messages.
 *
 * Rules:
 * - Sections marked with [SINGLE] stay as one message
 * - Double newlines = separate messages
 * - Single newlines in SHORT lines = separate messages
 * - Long paragraphs (quotation/payment/trust) stay together
 */
export function splitIntoMessages(reply) {
  if (!reply) return [];

  // Detect if this is a single-block reply (quotation, payment, trust)
  // These should NOT be split — they look more professional as one message
  const isSingleBlock = (
    /quotation|fees:|payment:|₹.*\n.*₹|installment|gst:|registration/i.test(reply) ||
    reply.split("\n").filter(l => l.trim()).length <= 3
  );

  if (isSingleBlock) {
    return [reply.trim()];
  }

  // Split by double newlines (paragraph breaks)
  const parts = reply
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  if (parts.length > 1) {
    return parts;
  }

  // Single paragraph — check if it has multiple short lines
  const lines = reply
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length > 1 && lines.every(l => l.length < 100)) {
    return lines;
  }

  // Single message
  return [reply.trim()];
}

/**
 * Notify business owner on their WhatsApp.
 */
export async function notifyOwnerWhatsApp(businessId, message) {
  try {
    const { rows } = await query(`
      SELECT
        wc.phone_number_id,
        wc.access_token,
        ns.owner_notify_number
      FROM whatsapp_configs wc
      JOIN notification_settings ns ON ns.business_id = wc.business_id
      WHERE wc.business_id = $1
        AND ns.whatsapp_alerts = TRUE
        AND ns.owner_notify_number IS NOT NULL
        AND ns.owner_notify_number != ''
    `, [businessId]);

    if (!rows.length) {
      console.warn("Owner notify: no number configured");
      return;
    }

    const { phone_number_id, access_token, owner_notify_number } = rows[0];

    // Normalize phone number — ensure + prefix, remove spaces/dashes
    const normalizedNumber = normalizePhone(owner_notify_number);

    // Strip any markdown formatting from message — WhatsApp API rejects some chars
    const cleanMessage = message
      .replace(/\*\*/g, "")   // remove **bold**
      .replace(/_{2}/g, "")   // remove __underline__
      .trim();

    console.log(`📲 Notifying owner: ${normalizedNumber}`);

    const response = await axios.post(
      `${META_BASE}/${VERSION}/${phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type:    "individual",
        to:                normalizedNumber,
        type:              "text",
        text:              { body: cleanMessage, preview_url: false },
      },
      {
        headers: {
          Authorization:  `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ Owner notified successfully`);
    return response.data;

  } catch (err) {
    console.error("Owner notify error:", err.response?.data || err.message);
  }
}

/**
 * Normalize phone number to WhatsApp format.
 * Examples:
 *   "8439120420"    → "+918439120420"  (India default)
 *   "+918439120420" → "+918439120420"  (already correct)
 *   "918439120420"  → "+918439120420"
 *   "+1 234 567 890" → "+1234567890"
 */
function normalizePhone(phone) {
  // Remove all spaces, dashes, parentheses
  let cleaned = phone.replace(/[\s\-().]/g, "");

  // Already has + prefix
  if (cleaned.startsWith("+")) return cleaned;

  // Has country code without + (91XXXXXXXXXX)
  if (cleaned.length === 12 && cleaned.startsWith("91")) {
    return "+" + cleaned;
  }

  // 10 digit Indian number — add +91
  if (cleaned.length === 10) {
    return "+91" + cleaned;
  }

  // Otherwise just add +
  return "+" + cleaned;
}

/**
 * Get WhatsApp credentials for a business.
 */
export async function getWhatsAppCredentials(businessId) {
  const { rows } = await query(`
    SELECT phone_number_id, access_token, display_name
    FROM whatsapp_configs WHERE business_id = $1
  `, [businessId]);
  return rows[0] || null;
}