import axios from "axios";
import { query } from "../db/postgres.js";

const META_BASE = process.env.META_BASE_URL    || "https://graph.facebook.com";
const VERSION   = process.env.META_API_VERSION || "v19.0";

/**
 * Send a WhatsApp message and return the response (includes message ID).
 */
export async function sendWhatsAppMessage({ phoneNumberId, accessToken, to, message }) {
  try {
    // Typing delay for human feel
    const typingDelay = Math.min(1000 + message.length * 15, 4000);
    await sleep(typingDelay);

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

    return response.data; // contains messages[0].id for status tracking

  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Notify business owner on their WhatsApp number.
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
    console.error("Owner notification error:", err.message);
  }
}

/**
 * Get WhatsApp credentials for a business.
 */
export async function getWhatsAppCredentials(businessId) {
  const { rows } = await query(`
    SELECT phone_number_id, access_token, display_name
    FROM whatsapp_configs
    WHERE business_id = $1
  `, [businessId]);
  return rows[0] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));