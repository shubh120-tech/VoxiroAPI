import axios from "axios";
import { query } from "../db/postgres.js";

const META_BASE = process.env.META_BASE_URL    || "https://graph.facebook.com";
const VERSION   = process.env.META_API_VERSION || "v19.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mark a customer message as read — shows blue ticks on customer's phone.
 * Call this immediately when message arrives.
 */
export async function markMessageAsRead({ phoneNumberId, accessToken, waMessageId }) {
  if (!waMessageId) return;
  try {
    await axios.post(
      `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status:            "read",
        message_id:        waMessageId,
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    // Non-critical — don't throw
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
  waMessageId    = null,
  isFirstMessage = true,
}) {
  try {
    // 1. Mark as read immediately — blue ticks appear
    if (waMessageId) {
      await markMessageAsRead({ phoneNumberId, accessToken, waMessageId });
      // Small pause after read — exec is "reading"
      await sleep(500 + Math.random() * 800);
    }

    // 2. Sales exec delay — read + think + type
    const delay = getSalesExecDelay(message, isFirstMessage);
    await sleep(delay);

    // 3. Send message
    const response = await axios.post(
      `${META_BASE}/${VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type:    "individual",
        to,
        type:              "text",
        text:              { body: message, preview_url: false },
      },
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
  waMessageId = null,
}) {
  const results = [];

  for (let i = 0; i < messages.length; i++) {
    const msg     = messages[i];
    const isFirst = i === 0;
    if (!msg?.trim()) continue;

    // First message: mark as read immediately
    if (isFirst && waMessageId) {
      await markMessageAsRead({ phoneNumberId, accessToken, waMessageId });
      await sleep(400 + Math.random() * 600); // exec is "reading"
    }

    // Send with appropriate delay
    const result = await sendWhatsAppMessage({
      phoneNumberId,
      accessToken,
      to,
      message:       msg,
      waMessageId:   null, // already marked read above
      isFirstMessage: isFirst,
    });

    results.push(result);

    // Pause between parts — human pauses before typing next thought
    if (i < messages.length - 1) {
      // Short pause: like exec hits send then immediately starts typing next
      const pauseBetween = 600 + Math.random() * 1000; // 0.6-1.6s
      await sleep(pauseBetween);
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

    if (!rows.length) return;
    const { phone_number_id, access_token, owner_notify_number } = rows[0];

    await axios.post(
      `${META_BASE}/${VERSION}/${phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to:                owner_notify_number,
        type:              "text",
        text:              { body: message },
      },
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
  } catch (err) {
    console.error("Owner notify error:", err.message);
  }
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