// src/crons/escalationCron.js
// Add to server.js:
//   import { startEscalationCron } from "./crons/escalationCron.js";
//   startEscalationCron();

import { query } from "../db/postgres.js";
import { notifyOwnerWhatsApp, sendWhatsAppMessage } from "../whatsapp/sender.js";
import { handleIncomingMessage } from "../agents/agentManager.js";

export function startEscalationCron() {
  console.log("⏰ Escalation cron started — checking every 2 minutes");
  setInterval(runEscalationCheck, 2 * 60 * 1000);
  runEscalationCheck(); // run immediately on startup
}

async function runEscalationCheck() {
  try {
    await Promise.all([
      checkReactivation(),
      checkOwnerPing(),
      checkDailySummary(),
    ]);
  } catch (err) {
    console.error("Escalation cron error:", err.message);
  }
}

// ── 1. Auto-reactivate agent if team hasn't replied ───────────
async function checkReactivation() {
  try {
    // Find conversations that are needs-help/manual
    // where escalated_at + reactivate_after_mins has passed
    // and agent hasn't been reactivated yet
    const { rows } = await query(`
      SELECT
        c.id, c.business_id, c.customer_phone, c.customer_name,
        c.escalated_at,
        ab.reactivate_after_mins,
        ab.reactivate_msg,
        wc.phone_number_id,
        wc.access_token
      FROM conversations c
      JOIN agent_behavior ab ON ab.business_id = c.business_id
      JOIN whatsapp_configs wc ON wc.business_id = c.business_id
      WHERE c.status IN ('needs-help', 'manual')
        AND c.escalated_at IS NOT NULL
        AND ab.reactivate_after_mins > 0
        AND c.escalated_at + (ab.reactivate_after_mins || ' minutes')::interval < NOW()
        AND (c.escalation_notified_at IS NULL
             OR c.escalation_notified_at < c.escalated_at)
    `);

    for (const conv of rows) {
      try {
        // Reactivate agent on this conversation
        await query(`
          UPDATE conversations
          SET status = 'agent',
              escalation_notified_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `, [conv.id]);

        // Send reactivation message to customer
        const msg = (conv.reactivate_msg || "Hi! Let me help you while our team is busy.")
          .replace("{name}", conv.customer_name || "there")
          .replace("{phone}", conv.customer_phone);

        await sendWhatsAppMessage({
          phoneNumberId: conv.phone_number_id,
          accessToken:   conv.access_token,
          to:            conv.customer_phone,
          message:       msg,
        });

        // Save reactivation message
        await query(`
          INSERT INTO messages (conversation_id, business_id, role, content)
          VALUES ($1, $2, 'agent', $3)
        `, [conv.id, conv.business_id, msg]);

        console.log(`🔄 Agent reactivated for ${conv.customer_phone} after ${conv.reactivate_after_mins} mins`);
      } catch (err) {
        console.error(`Reactivation error for conv ${conv.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("checkReactivation error:", err.message);
  }
}

// ── 2. Ping owner if team STILL hasn't replied ────────────────
async function checkOwnerPing() {
  try {
    const { rows } = await query(`
      SELECT
        c.id, c.business_id, c.customer_phone, c.customer_name,
        c.escalated_at,
        ab.ping_owner_after_mins,
        ab.ping_owner_msg
      FROM conversations c
      JOIN agent_behavior ab ON ab.business_id = c.business_id
      WHERE c.status IN ('needs-help', 'manual')
        AND c.escalated_at IS NOT NULL
        AND ab.ping_owner_after_mins > 0
        AND c.escalated_at + (ab.ping_owner_after_mins || ' minutes')::interval < NOW()
        AND (c.owner_pinged_at IS NULL
             OR c.owner_pinged_at < c.escalated_at)
    `);

    for (const conv of rows) {
      try {
        const waitMins = conv.ping_owner_after_mins;
        const msg = (conv.ping_owner_msg ||
          "⚠️ Sales team has not replied in {mins} minutes. Customer {phone} is waiting. Please check.")
          .replace("{mins}",  waitMins)
          .replace("{phone}", conv.customer_phone)
          .replace("{name}",  conv.customer_name || conv.customer_phone);

        await notifyOwnerWhatsApp(conv.business_id, msg);

        await query(`
          UPDATE conversations SET owner_pinged_at = NOW() WHERE id = $1
        `, [conv.id]);

        console.log(`📣 Owner pinged for ${conv.customer_phone} — team silent for ${waitMins} mins`);
      } catch (err) {
        console.error(`Owner ping error for conv ${conv.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("checkOwnerPing error:", err.message);
  }
}

// ── 3. Daily summary ─────────────────────────────────────────
async function checkDailySummary() {
  try {
    const nowIST     = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const currentHHMM = `${String(nowIST.getUTCHours()).padStart(2,"0")}:${String(nowIST.getUTCMinutes()).padStart(2,"0")}`;

    // Find businesses with daily summary enabled at this time (±2 min window)
    const { rows } = await query(`
      SELECT ab.business_id, ab.daily_summary_time, ab.daily_summary_phone,
             b.name AS business_name
      FROM agent_behavior ab
      JOIN businesses b ON b.id = ab.business_id
      WHERE ab.daily_summary = TRUE
        AND ab.daily_summary_phone IS NOT NULL
        AND ab.daily_summary_time BETWEEN
          TO_CHAR(NOW() AT TIME ZONE 'Asia/Kolkata' - INTERVAL '2 minutes', 'HH24:MI')
          AND TO_CHAR(NOW() AT TIME ZONE 'Asia/Kolkata' + INTERVAL '2 minutes', 'HH24:MI')
    `);

    for (const biz of rows) {
      try {
        await sendDailySummary(biz);
      } catch (err) {
        console.error(`Daily summary error for ${biz.business_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("checkDailySummary error:", err.message);
  }
}

async function sendDailySummary({ business_id, daily_summary_phone, business_name }) {
  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dateStr = today.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

  const [msgs, leads, orders, escalations] = await Promise.all([
    query(`SELECT COUNT(*) AS cnt FROM messages WHERE business_id = $1 AND role = 'customer' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`, [business_id]),
    query(`SELECT COUNT(*) AS cnt FROM leads WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`, [business_id]),
    query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS rev FROM orders WHERE business_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`, [business_id]),
    query(`SELECT COUNT(*) AS cnt FROM conversations WHERE business_id = $1 AND status IN ('needs-help','manual') AND (escalated_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`, [business_id]),
  ]);

  const summary =
    `📊 *${business_name} — Daily Summary (${dateStr})*\n\n` +
    `💬 Messages received: ${msgs.rows[0]?.cnt || 0}\n` +
    `👥 Leads captured: ${leads.rows[0]?.cnt || 0}\n` +
    `📦 Orders placed: ${orders.rows[0]?.cnt || 0}\n` +
    `💰 Revenue: ₹${parseInt(orders.rows[0]?.rev || 0).toLocaleString("en-IN")}\n` +
    `🚨 Escalations: ${escalations.rows[0]?.cnt || 0}\n\n` +
    `Have a great evening! 🌙`;

  // Get WhatsApp credentials for this business
  const { rows: wc } = await query(
    "SELECT phone_number_id, access_token FROM whatsapp_configs WHERE business_id = $1",
    [business_id]
  );
  if (!wc.length) return;

  await sendWhatsAppMessage({
    phoneNumberId: wc[0].phone_number_id,
    accessToken:   wc[0].access_token,
    to:            daily_summary_phone.startsWith("+") ? daily_summary_phone.replace("+","") : daily_summary_phone,
    message:       summary,
  });

  console.log(`📊 Daily summary sent to ${daily_summary_phone} for ${business_name}`);
}