import axios from "axios";
import { query } from "../db/postgres.js";

const META_BASE = process.env.META_BASE_URL    || "https://graph.facebook.com";
const VERSION   = process.env.META_API_VERSION || "v19.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a single WhatsApp message.
 * Returns response data including message ID for status tracking.
 */
export async function sendWhatsAppMessage({ phoneNumberId, accessToken, to, message }) {
  try {
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
 * Send multiple WhatsApp messages with human-like delays.
 * Splits agent reply into multiple short messages.
 * Each part sent separately with typing delay between them.
 */
export async function sendWhatsAppMessages({ phoneNumberId, accessToken, to, messages }) {
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.trim()) continue;

    // Typing delay based on message length (feels human)
    const typingDelay = Math.min(600 + msg.length * 30, 3000);
    await sleep(typingDelay);

    const result = await sendWhatsAppMessage({ phoneNumberId, accessToken, to, message: msg });
    results.push(result);

    // Small pause between messages
    if (i < messages.length - 1) {
      await sleep(400 + Math.random() * 600);
    }
  }
  return results;
}

/**
 * Parse agent reply into multiple short messages.
 * Splits on newlines, keeping each part concise.
 */
export function splitIntoMessages(reply) {
  if (!reply) return [];

  // Split by double newlines first (paragraphs)
  const parts = reply
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // If only one part, check if it needs splitting by single newlines
  if (parts.length === 1) {
    const lines = reply
      .split(/\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    // If multiple short lines → send as separate messages
    if (lines.length > 1 && lines.every(l => l.length < 100)) {
      return lines;
    }
  }

  // Flatten any part that's too long (>200 chars) into sub-parts
  const final = [];
  for (const part of parts) {
    if (part.length <= 200) {
      final.push(part);
    } else {
      // Split long parts by sentence
      const sentences = part.match(/[^.!?]+[.!?]+/g) || [part];
      let current = "";
      for (const sentence of sentences) {
        if ((current + sentence).length > 200 && current) {
          final.push(current.trim());
          current = sentence;
        } else {
          current += sentence;
        }
      }
      if (current.trim()) final.push(current.trim());
    }
  }

  return final.length > 0 ? final : [reply];
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

    await sendWhatsAppMessage({
      phoneNumberId: phone_number_id,
      accessToken:   access_token,
      to:            owner_notify_number,
      message,
    });
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