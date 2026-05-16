import { query }              from "../db/postgres.js";
import { sendWhatsAppMessage } from "../whatsapp/sender.js";

/**
 * Check and send all due follow-ups.
 * Called every 15 minutes from server.js
 */
export async function processFollowUps() {
  try {
    // Get all due follow-ups that haven't been sent
    const { rows } = await query(`
      SELECT
        f.id,
        f.business_id,
        f.conversation_id,
        f.customer_phone,
        f.customer_name,
        f.message,
        f.reason,
        f.scheduled_at,
        wc.phone_number_id,
        wc.access_token
      FROM follow_ups f
      JOIN whatsapp_configs wc ON wc.business_id = f.business_id
      WHERE f.sent = FALSE
        AND f.scheduled_at <= NOW()
        AND wc.phone_number_id IS NOT NULL
        AND wc.access_token IS NOT NULL
      ORDER BY f.scheduled_at ASC
      LIMIT 50
    `);

    if (rows.length === 0) return;

    console.log(`⏰ Processing ${rows.length} due follow-up(s)...`);

    for (const followup of rows) {
      try {
        // Send WhatsApp message
        await sendWhatsAppMessage({
          phoneNumberId: followup.phone_number_id,
          accessToken:   followup.access_token,
          to:            followup.customer_phone,
          message:       followup.message,
        });

        // Mark as sent
        await query(`
          UPDATE follow_ups
          SET sent = TRUE, sent_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [followup.id]);

        // Save message to conversation if it exists
        if (followup.conversation_id) {
          await query(`
            INSERT INTO messages (conversation_id, business_id, role, content)
            VALUES ($1, $2, 'agent', $3)
          `, [followup.conversation_id, followup.business_id, followup.message]);

          // Update conversation last message
          await query(`
            UPDATE conversations
            SET last_message = $1, last_message_at = NOW()
            WHERE id = $2
          `, [followup.message, followup.conversation_id]);
        }

        console.log(`✅ Follow-up sent to ${followup.customer_phone}`);

      } catch (err) {
        console.error(`❌ Follow-up failed for ${followup.customer_phone}:`, err.message);

        // Save error but don't block other follow-ups
        await query(`
          UPDATE follow_ups
          SET error_message = $1, updated_at = NOW()
          WHERE id = $2
        `, [err.message, followup.id]);
      }
    }

  } catch (err) {
    console.error("Follow-up cron error:", err.message);
  }
}