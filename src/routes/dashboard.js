import express      from "express";
import { query }    from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

// ── Analytics / Home ──────────────────────────────────────────
router.get("/analytics/home", async (req, res) => {
  try {
    const bId = req.user.business_id;
    const [stats, agent, usage] = await Promise.all([
      query(`SELECT * FROM today_stats WHERE business_id = $1`, [bId]),
      query(`SELECT agent_name, is_active FROM agent_configs WHERE business_id = $1`, [bId]),
      query(`SELECT s.messages_used, p.message_limit FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.business_id = $1`, [bId]),
    ]);
    res.json({
      messagesToday:      stats.rows[0]?.messages_today      || 0,
      leadsToday:         stats.rows[0]?.leads_today         || 0,
      ordersToday:        stats.rows[0]?.orders_today        || 0,
      appointmentsToday:  stats.rows[0]?.appointments_today  || 0,
      agentName:          agent.rows[0]?.agent_name          || "Aria",
      agentActive:        agent.rows[0]?.is_active           || false,
      messagesUsed:       usage.rows[0]?.messages_used       || 0,
      messageLimit:       usage.rows[0]?.message_limit       || 0,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load stats" });
  }
});

router.get("/analytics/usage", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT s.messages_used AS used, p.message_limit AS limit, s.billing_cycle_end
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.business_id = $1
    `, [req.user.business_id]);
    res.json(rows[0] || { used: 0, limit: 0 });
  } catch (err) {
    res.status(500).json({ message: "Failed to load usage" });
  }
});

router.get("/analytics/activity", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { rows } = await query(`
      SELECT * FROM activity_logs
      WHERE business_id = $1
      ORDER BY created_at DESC LIMIT $2
    `, [req.user.business_id, limit]);
    res.json({ activities: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load activity" });
  }
});

// ── Leads ─────────────────────────────────────────────────────
router.get("/leads", async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (page - 1) * limit;
    let sql    = `SELECT * FROM leads WHERE business_id = $1`;
    const params = [req.user.business_id];
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (customer_name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
    const countSql = sql.replace("SELECT *", "SELECT COUNT(*)");
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0, -2))]);
    res.json({ leads: data.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load leads" });
  }
});

router.patch("/leads/:id/status", async (req, res) => {
  try {
    await query(`UPDATE leads SET status = $1 WHERE id = $2 AND business_id = $3`,
      [req.body.status, req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update lead" });
  }
});

router.delete("/leads/:id", async (req, res) => {
  try {
    await query("DELETE FROM leads WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete lead" });
  }
});

// ── Orders ────────────────────────────────────────────────────
router.get("/orders", async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (page - 1) * limit;
    let sql    = `SELECT * FROM orders WHERE business_id = $1`;
    const params = [req.user.business_id];
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length})`; }
    const countSql = sql.replace("SELECT *", "SELECT COUNT(*)");
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0, -2))]);
    res.json({ orders: data.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load orders" });
  }
});

router.patch("/orders/:id/status", async (req, res) => {
  try {
    await query("UPDATE orders SET status = $1 WHERE id = $2 AND business_id = $3",
      [req.body.status, req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update order" });
  }
});

// ── Appointments ──────────────────────────────────────────────
router.get("/appointments", async (req, res) => {
  try {
    const { page = 1, limit = 20, status, date } = req.query;
    const offset = (page - 1) * limit;
    let sql    = `SELECT * FROM appointments WHERE business_id = $1`;
    const params = [req.user.business_id];
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (date)   { params.push(date);   sql += ` AND DATE(scheduled_at) = $${params.length}`; }
    const countSql = sql.replace("SELECT *", "SELECT COUNT(*)");
    sql += ` ORDER BY scheduled_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0, -2))]);
    res.json({ appointments: data.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load appointments" });
  }
});

router.patch("/appointments/:id/status", async (req, res) => {
  try {
    await query("UPDATE appointments SET status = $1 WHERE id = $2 AND business_id = $3",
      [req.body.status, req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update appointment" });
  }
});

// ── Agent ─────────────────────────────────────────────────────
router.get("/agent/status", async (req, res) => {
  try {
    const [agent, sub, convs, unread] = await Promise.all([
      query("SELECT agent_name, is_active FROM agent_configs WHERE business_id = $1", [req.user.business_id]),
      query("SELECT s.messages_used, p.message_limit FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.business_id = $1", [req.user.business_id]),
      query("SELECT COUNT(*) FROM conversations WHERE business_id = $1 AND status != 'closed'", [req.user.business_id]),
      query("SELECT COUNT(*) FROM conversations WHERE business_id = $1 AND status = 'needs-help'", [req.user.business_id]),
    ]);
    res.json({
      agentName:           agent.rows[0]?.agent_name || "Aria",
      active:              agent.rows[0]?.is_active   || false,
      used:                sub.rows[0]?.messages_used || 0,
      limit:               sub.rows[0]?.message_limit || 0,
      activeConversations: parseInt(convs.rows[0]?.count)  || 0,
      unreadCount:         parseInt(unread.rows[0]?.count) || 0,
      notifCount:          parseInt(unread.rows[0]?.count) || 0,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load agent status" });
  }
});

router.get("/agent/config", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM agent_configs WHERE business_id = $1", [req.user.business_id]);
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ message: "Failed to load agent config" });
  }
});

router.put("/agent/config", async (req, res) => {
  try {
    const { agentName, tone, language, greeting, services, pricing } = req.body;
    await query(`
      UPDATE agent_configs
      SET agent_name = $1, tone = $2, language = $3,
          greeting = $4, services = $5, pricing = $6, updated_at = NOW()
      WHERE business_id = $7
    `, [agentName, tone, language, greeting, services, pricing, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update agent config" });
  }
});

router.patch("/agent/toggle", async (req, res) => {
  try {
    await query("UPDATE agent_configs SET is_active = $1 WHERE business_id = $2",
      [req.body.active, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle agent" });
  }
});

// ── Conversations ─────────────────────────────────────────────
router.get("/agent/conversations", async (req, res) => {
  try {
    const { page = 1, limit = 30, status } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT
        c.*,
        wc.display_name AS whatsapp_display_name
      FROM conversations c
      LEFT JOIN whatsapp_configs wc ON wc.business_id = c.business_id
      WHERE c.business_id = $1
    `;
    const params = [req.user.business_id];

    if (status) {
      params.push(status);
      sql += ` AND c.status = $${params.length}`;
    }

    sql += ` ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await query(sql, params);
    res.json({ conversations: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

router.get("/agent/conversations/:id/messages", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        id, conversation_id, business_id,
        role, content, status,
        wa_message_id, is_read,
        created_at
      FROM messages
      WHERE conversation_id = $1
        AND business_id     = $2
      ORDER BY created_at ASC
    `, [req.params.id, req.user.business_id]);
    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load messages" });
  }
});

router.post("/agent/conversations/:id/takeover", async (req, res) => {
  try {
    await query(`UPDATE conversations SET status = 'manual', takeover_at = NOW() WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to take over" });
  }
});

router.post("/agent/conversations/:id/resume", async (req, res) => {
  try {
    await query(`UPDATE conversations SET status = 'agent', updated_at = NOW() WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to resume agent" });
  }
});

router.post("/agent/conversations/:id/send", async (req, res) => {
  try {
    const { message, replyToMessageId } = req.body;  // replyToMessageId for quoted replies
    const { rows: conv } = await query(
      "SELECT * FROM conversations WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );
    if (!conv.length) return res.status(404).json({ message: "Conversation not found" });

    // Save owner message with status sent
    await query(`
      INSERT INTO messages (conversation_id, business_id, role, content, status)
      VALUES ($1, $2, 'owner', $3, 'sent')
    `, [req.params.id, req.user.business_id, message]);

    // Send via WhatsApp
    const { rows: wc } = await query(
      "SELECT phone_number_id, access_token FROM whatsapp_configs WHERE business_id = $1",
      [req.user.business_id]
    );

    if (wc.length) {
      const { sendWhatsAppMessage } = await import("../whatsapp/sender.js");
      const result = await sendWhatsAppMessage({
        phoneNumberId: wc[0].phone_number_id,
        accessToken:   wc[0].access_token,
        to:            conv[0].customer_phone,
        message,
      });

      // Save wa_message_id for status tracking
      if (result?.messages?.[0]?.id) {
        await query(`
          UPDATE messages SET wa_message_id = $1
          WHERE id = (
            SELECT id FROM messages
            WHERE conversation_id = $2 AND role = 'owner'
            ORDER BY created_at DESC LIMIT 1
          )
        `, [result.messages[0].id, req.params.id]);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to send message" });
  }
});

// ── Settings ──────────────────────────────────────────────────
router.get("/settings", async (req, res) => {
  try {
    const bId = req.user.business_id;
    const [biz, agent, wc, notif, sub] = await Promise.all([
      query("SELECT * FROM businesses WHERE id = $1", [bId]),
      query("SELECT * FROM agent_configs WHERE business_id = $1", [bId]),
      query("SELECT phone_number_id, whatsapp_number, is_verified, display_name FROM whatsapp_configs WHERE business_id = $1", [bId]),
      query("SELECT * FROM notification_settings WHERE business_id = $1", [bId]),
      query("SELECT s.*, p.name AS plan_name, p.price_monthly, p.message_limit FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.business_id = $1", [bId]),
    ]);

    const b = biz.rows[0]   || {};
    const a = agent.rows[0] || {};

    res.json({
      profile: {
        businessName: b.name              || "",
        ownerName:    req.user.owner_name || "",
        email:        req.user.email      || "",
        phone:        b.phone             || "",
        address:      b.address           || "",
        website:      b.website           || "",
      },
      agent: {
        agentName: a.agent_name || "Aria",
        tone:      a.tone       || "friendly",
        language:  a.language   || "English",
        greeting:  a.greeting   || "",
        services:  a.services   || "",
        pricing:   a.pricing    || "",
      },
      whatsapp:      wc.rows[0]    || {},
      notifications: notif.rows[0] || {},
      billing:       sub.rows[0]   || {},
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load settings" });
  }
});

router.put("/settings/profile", async (req, res) => {
  try {
    const { businessName, ownerName, phone, address, website } = req.body;
    await Promise.all([
      query("UPDATE businesses SET name = $1, phone = $2, address = $3, website = $4 WHERE id = $5",
        [businessName, phone, address, website, req.user.business_id]),
      query("UPDATE users SET owner_name = $1 WHERE id = $2",
        [ownerName, req.user.id]),
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile" });
  }
});

router.put("/settings/whatsapp", async (req, res) => {
  try {
    const { phoneNumberId, accessToken, webhookSecret } = req.body;

    if (!phoneNumberId) {
      return res.status(400).json({ message: "Phone Number ID is required" });
    }

    // Check if this phone_number_id belongs to another business
    const { rows: existing } = await query(`
      SELECT business_id FROM whatsapp_configs
      WHERE phone_number_id = $1
        AND business_id != $2
    `, [phoneNumberId, req.user.business_id]);

    if (existing.length > 0) {
      return res.status(409).json({
        message: "This WhatsApp number is already connected to another Voxiro account. Each WhatsApp number can only be connected to one business.",
      });
    }

    await query(`
      INSERT INTO whatsapp_configs
        (business_id, phone_number_id, access_token, webhook_secret)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (business_id) DO UPDATE
      SET phone_number_id = $2,
          access_token    = CASE WHEN $3 IS NOT NULL AND $3 != ''
                            THEN $3 ELSE whatsapp_configs.access_token END,
          webhook_secret  = CASE WHEN $4 IS NOT NULL AND $4 != ''
                            THEN $4 ELSE whatsapp_configs.webhook_secret END,
          updated_at      = NOW()
    `, [req.user.business_id, phoneNumberId, accessToken || null, webhookSecret || null]);

    // Try to fetch display name from Meta
    try {
      const { fetchAndSaveDisplayName } = await import("../webhook/whatsapp.js");
      const { rows: wc } = await query(
        "SELECT access_token FROM whatsapp_configs WHERE business_id = $1",
        [req.user.business_id]
      );
      if (wc[0]?.access_token) {
        await fetchAndSaveDisplayName(req.user.business_id, phoneNumberId, wc[0].access_token);
      }
    } catch {
      // Non-critical
    }

    res.json({ success: true });
  } catch (err) {
    console.error("WhatsApp config error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

router.put("/settings/notifications", async (req, res) => {
  try {
    const { whatsappAlerts, emailAlerts, needsHelpAlert, ownerNotifyNumber } = req.body;
    await query(`
      UPDATE notification_settings
      SET whatsapp_alerts = $1, email_alerts = $2, needs_help_alert = $3,
          owner_notify_number = $4, updated_at = NOW()
      WHERE business_id = $5
    `, [whatsappAlerts, emailAlerts, needsHelpAlert, ownerNotifyNumber, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update notifications" });
  }
});

router.put("/settings/password", async (req, res) => {
  try {
    const bcrypt = (await import("bcrypt")).default;
    const { currentPassword, newPassword } = req.body;
    const { rows } = await query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(400).json({ message: "Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update password" });
  }
});

// ── Knowledge Base ────────────────────────────────────────────
router.get("/knowledge", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM knowledge_docs WHERE business_id = $1 ORDER BY created_at DESC",
      [req.user.business_id]
    );
    res.json({ documents: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load documents" });
  }
});

router.delete("/knowledge/:id", async (req, res) => {
  try {
    await query("DELETE FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete document" });
  }
});

export default router;