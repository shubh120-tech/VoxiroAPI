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


// ── Analytics — detailed dashboard ────────────────────────────
router.get("/analytics/dashboard", async (req, res) => {
  try {
    const bId   = req.user.business_id;
    const { range = "7" } = req.query;
    const days  = Math.min(parseInt(range) || 7, 90);

    const [
      todayStats, trendData, funnelData,
      peakHours, agentStats, planUsage, tokenUsage,
    ] = await Promise.all([

      // ── TODAY SNAPSHOT ──────────────────────────────────────
      // FIX: use independent subqueries instead of FULL JOINs
      // FIX: use AT TIME ZONE 'Asia/Kolkata' so "today" is IST, not UTC
      query(`
        SELECT
          (
            SELECT COUNT(*)
            FROM messages
            WHERE business_id = $1
              AND role = 'customer'
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS messages_today,

          (
            SELECT COUNT(DISTINCT conversation_id)
            FROM messages
            WHERE business_id = $1
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS conversations_today,

          (
            SELECT COUNT(*)
            FROM leads
            WHERE business_id = $1
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS leads_today,

          (
            SELECT COUNT(*)
            FROM orders
            WHERE business_id = $1
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS orders_today,

          (
            SELECT COALESCE(SUM(amount), 0)
            FROM orders
            WHERE business_id = $1
              AND status = 'confirmed'
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS revenue_today,

          (
            SELECT COUNT(*)
            FROM appointments
            WHERE business_id = $1
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ) AS appointments_today
      `, [bId]),

      // ── DAILY TREND ─────────────────────────────────────────
      query(`
        SELECT
          d::date                                                                AS date,
          COUNT(DISTINCT c.id)                                                  AS conversations,
          COUNT(DISTINCT l.id)                                                  AS leads,
          COUNT(DISTINCT o.id)                                                  AS orders,
          COALESCE(SUM(CASE WHEN o.status='confirmed' THEN o.amount END), 0)   AS revenue
        FROM generate_series(
          (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ($2 - 1) * INTERVAL '1 day',
          (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
          INTERVAL '1 day'
        ) d
        LEFT JOIN conversations c ON c.business_id = $1
          AND (c.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date
        LEFT JOIN leads         l ON l.business_id = $1
          AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date
        LEFT JOIN orders        o ON o.business_id = $1
          AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date
        GROUP BY d::date ORDER BY d::date ASC
      `, [bId, days]),

      // ── CONVERSION FUNNEL ───────────────────────────────────
      query(`
        SELECT
          COUNT(DISTINCT c.id)                                                   AS total_conversations,
          COUNT(DISTINCT l.id)                                                   AS total_leads,
          COUNT(DISTINCT o.id)                                                   AS total_orders,
          COUNT(DISTINCT CASE WHEN o.status='confirmed' THEN o.id END)          AS confirmed_orders,
          COALESCE(SUM(CASE WHEN o.status='confirmed' THEN o.amount END), 0)    AS total_revenue
        FROM conversations c
        LEFT JOIN leads  l ON l.conversation_id = c.id
        LEFT JOIN orders o ON o.business_id = c.business_id
          AND o.created_at >= NOW() - $2 * INTERVAL '1 day'
        WHERE c.business_id = $1
          AND c.created_at  >= NOW() - $2 * INTERVAL '1 day'
      `, [bId, days]),

      // ── PEAK HOURS (last 30 days, in IST) ───────────────────
      query(`
        SELECT
          EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
          COUNT(*) AS messages
        FROM messages
        WHERE business_id = $1 AND role = 'customer'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `, [bId]),

      // ── AGENT PERFORMANCE ───────────────────────────────────
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'agent')      AS agent_handled,
          COUNT(*) FILTER (WHERE status = 'manual')     AS manual_handled,
          COUNT(*) FILTER (WHERE status = 'needs-help') AS needs_help,
          COUNT(*) AS total_convs
        FROM conversations
        WHERE business_id = $1
          AND created_at >= NOW() - $2 * INTERVAL '1 day'
      `, [bId, days]),

      // ── PLAN USAGE ──────────────────────────────────────────
      query(`
        SELECT messages_used, message_limit
        FROM agent_configs WHERE business_id = $1
      `, [bId]),

      // ── TOKEN USAGE (AI cost estimation) ────────────────────
      query(`
        SELECT
          COUNT(*) AS total_messages,
          COUNT(*) FILTER (WHERE role = 'agent') AS agent_messages,
          SUM(CHAR_LENGTH(content)) FILTER (WHERE role = 'agent') AS agent_chars
        FROM messages
        WHERE business_id = $1
          AND created_at >= NOW() - $2 * INTERVAL '1 day'
      `, [bId, days]),
    ]);

    // Estimate tokens (1 token ≈ 4 chars, Haiku = $0.00025/1k tokens)
    const agentChars  = parseInt(tokenUsage.rows[0]?.agent_chars) || 0;
    const estTokens   = Math.round(agentChars / 4);
    const estCostUSD  = (estTokens / 1000) * 0.00025;
    const estCostINR  = estCostUSD * 84;

    res.json({
      today:   todayStats.rows[0]  || {},
      trend:   trendData.rows      || [],
      funnel:  funnelData.rows[0]  || {},
      peaks:   peakHours.rows      || [],
      agent:   agentStats.rows[0]  || {},
      usage:   planUsage.rows[0]   || {},
      tokens: {
        total:    estTokens,
        messages: parseInt(tokenUsage.rows[0]?.agent_messages) || 0,
        costUSD:  estCostUSD.toFixed(4),
        costINR:  estCostINR.toFixed(2),
      },
    });
  } catch (err) {
    console.error("Analytics error:", err.message);
    res.status(500).json({ message: "Failed to load analytics: " + err.message });
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
    const bId = req.user.business_id;
    const [agent, convs, msgCount] = await Promise.all([
      query("SELECT agent_name, is_active, messages_used, message_limit FROM agent_configs WHERE business_id = $1", [bId]),
      query("SELECT COUNT(*) FROM conversations WHERE business_id = $1 AND status != 'closed'", [bId]),
      query(`
        SELECT COUNT(*) AS cnt FROM messages
        WHERE business_id = $1 AND role = 'agent'
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
      `, [bId]).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    // Try subscriptions -> plans for accurate limit
    let subUsed = null, subLimit = null;
    try {
      const sub = await query(`
        SELECT s.messages_used, p.message_limit
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1
      `, [bId]);
      if (sub.rows[0]) {
        subUsed  = parseInt(sub.rows[0].messages_used);
        subLimit = parseInt(sub.rows[0].message_limit);
      }
    } catch {}

    // Always use actual message count from DB as the source of truth for used
    // (agent_configs.messages_used is never updated, subscriptions may not exist)
    const actualUsed  = parseInt(msgCount.rows[0]?.cnt) || 0;
    const used  = (subUsed  !== null && subUsed  > 0) ? subUsed  : actualUsed;
    const limit = (subLimit !== null && subLimit > 0) ? subLimit
                : (parseInt(agent.rows[0]?.message_limit) || 1000);

    res.json({
      agentName:           agent.rows[0]?.agent_name || "Aria",
      active:              agent.rows[0]?.is_active   || false,
      used,
      limit,
      activeConversations: parseInt(convs.rows[0]?.count) || 0,
      unreadCount:         0,
      notifCount:          0,
    });
  } catch (err) {
    console.error("Agent status error:", err.message);
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
    let sql    = `SELECT * FROM conversations WHERE business_id = $1`;
    const params = [req.user.business_id];
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    sql += ` ORDER BY last_message_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
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
      SELECT * FROM messages
      WHERE conversation_id = $1 AND business_id = $2
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
    const { message } = req.body;
    const { rows: conv } = await query(
      "SELECT * FROM conversations WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );
    if (!conv.length) return res.status(404).json({ message: "Conversation not found" });

    // Save owner message
    await query(`INSERT INTO messages (conversation_id, business_id, role, content) VALUES ($1, $2, 'owner', $3)`,
      [req.params.id, req.user.business_id, message]);

    // Send via WhatsApp
    const { rows: wc } = await query(
      "SELECT phone_number_id, access_token FROM whatsapp_configs WHERE business_id = $1",
      [req.user.business_id]
    );
    if (wc.length) {
      const { sendWhatsAppMessage } = await import("../whatsapp/sender.js");
      await sendWhatsAppMessage({
        phoneNumberId: wc[0].phone_number_id,
        accessToken:   wc[0].access_token,
        to:            conv[0].customer_phone,
        message,
      });
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

    const [biz, agent, wc, notif] = await Promise.all([
      query("SELECT * FROM businesses WHERE id = $1", [bId]),
      query("SELECT agent_name, tone, language, system_prompt, messages_used, message_limit FROM agent_configs WHERE business_id = $1", [bId]),
      query("SELECT phone_number_id, whatsapp_number, is_verified, display_name, waba_id FROM whatsapp_configs WHERE business_id = $1", [bId]),
      query("SELECT * FROM notification_settings WHERE business_id = $1", [bId]).catch(() => ({ rows: [] })),
    ]);

    // Billing — try subscriptions, fall back to plan from businesses
    let billing = {};
    try {
      const sub = await query(`
        SELECT s.*, p.name AS plan_name, p.price_monthly, p.message_limit
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1
        ORDER BY s.created_at DESC LIMIT 1
      `, [bId]);
      billing = sub.rows[0] || {};
    } catch {
      try {
        const plan = await query(`
          SELECT p.name AS plan_name, p.price_monthly, p.message_limit
          FROM businesses b
          JOIN plans p ON p.id = b.plan_id
          WHERE b.id = $1
        `, [bId]);
        billing = plan.rows[0] || {};
      } catch {
        billing = {};
      }
    }

    res.json({
      profile:       { ...biz.rows[0], ownerName: req.user.owner_name, email: req.user.email },
      agent:         agent.rows[0]   || {},
      whatsapp:      wc.rows[0]      || {},
      notifications: notif.rows[0]   || {},
      billing,
    });
  } catch (err) {
    console.error("Settings load error:", err.message);
    res.status(500).json({ message: "Failed to load settings: " + err.message });
  }
});

router.put("/settings/profile", async (req, res) => {
  try {
    const { businessName, ownerName, phone, address, website } = req.body;

    if (!businessName?.trim()) {
      return res.status(400).json({ message: "Business name is required" });
    }

    await Promise.all([
      query(`UPDATE businesses
             SET name = $1, phone = $2, address = $3, website = $4, updated_at = NOW()
             WHERE id = $5`,
        [businessName.trim(), phone || null, address || null, website || null, req.user.business_id]),

      ownerName
        ? query("UPDATE users SET owner_name = $1, updated_at = NOW() WHERE id = $2",
            [ownerName.trim(), req.user.id])
        : Promise.resolve(),
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("Profile update error:", err.message, err.stack);
    res.status(500).json({ message: "Failed to update profile: " + err.message });
  }
});

router.put("/settings/whatsapp", async (req, res) => {
  try {
    const { phoneNumberId, accessToken, webhookSecret } = req.body;

    if (!phoneNumberId?.trim()) {
      return res.status(400).json({ message: "Phone Number ID is required" });
    }

    // Check if row exists first
    const { rows: existing } = await query(
      "SELECT id FROM whatsapp_configs WHERE business_id = $1",
      [req.user.business_id]
    );

    if (existing.length > 0) {
      await query(`
        UPDATE whatsapp_configs
        SET phone_number_id = $1,
            access_token    = CASE WHEN $2::text IS NOT NULL AND $2::text != '' THEN $2 ELSE access_token END,
            webhook_secret  = CASE WHEN $3::text IS NOT NULL AND $3::text != '' THEN $3 ELSE webhook_secret END,
            updated_at      = NOW()
        WHERE business_id = $4
      `, [phoneNumberId.trim(), accessToken || null, webhookSecret || null, req.user.business_id]);
    } else {
      await query(`
        INSERT INTO whatsapp_configs
          (business_id, phone_number_id, access_token, webhook_secret, is_verified)
        VALUES ($1, $2, $3, $4, FALSE)
      `, [req.user.business_id, phoneNumberId.trim(), accessToken || null, webhookSecret || null]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("WhatsApp config error:", err.message, err.stack);
    res.status(500).json({ message: "Failed to update WhatsApp config: " + err.message });
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

// ── Follow-ups ───────────────────────────────────────────────
router.get("/followups", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        f.*,
        COALESCE(c.customer_name, f.customer_name) AS customer_name,
        COALESCE(c.customer_phone, f.customer_phone) AS customer_phone
      FROM follow_ups f
      LEFT JOIN conversations c ON c.id = f.conversation_id
      WHERE f.business_id = $1
      ORDER BY f.scheduled_at DESC
      LIMIT 200
    `, [req.user.business_id]);
    res.json({ followups: rows });
  } catch (err) {
    console.error("Followups error:", err.message);
    res.status(500).json({ message: "Failed to load follow-ups" });
  }
});

router.patch("/followups/:id/cancel", async (req, res) => {
  try {
    await query(`
      UPDATE follow_ups
      SET sent = TRUE, sent_at = NOW(), error_message = 'Cancelled manually', updated_at = NOW()
      WHERE id = $1 AND business_id = $2
    `, [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to cancel" });
  }
});


// ── Data Deletion Callback (Meta requirement) ──────────────────
router.post("/auth/data-deletion", async (req, res) => {
  try {
    const crypto = (await import("crypto")).default;
    const { signed_request } = req.body;

    if (signed_request) {
      const [encodedSig, payload] = signed_request.split(".");
      const data     = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      const userId   = data.user_id;

      console.log(`📨 Data deletion request for Facebook user: ${userId}`);

      const confirmationCode = Buffer.from(`yougant_delete_${userId}_${Date.now()}`).toString("base64");
      return res.json({
        url:           `https://yougant.com/data-deletion?code=${confirmationCode}`,
        confirmation:   confirmationCode,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Data deletion callback error:", err.message);
    res.status(200).json({ success: true });
  }
});

// ── Delete Account ─────────────────────────────────────────────
router.delete("/account", async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const userId     = req.user.id;

    console.log(`🗑️ Account deletion started: business ${businessId}`);

    // ── Delete all user-generated and operational data ──────
    const tables = [
      // Conversations & messages
      "messages",
      "conversations",
      "pending_messages",

      // CRM data
      "leads",
      "orders",
      "appointments",
      "follow_ups",

      // Broadcast
      "contact_list_members",
      "contact_lists",
      "broadcast_recipients",
      "broadcast_campaigns",
      "business_contacts",
      "whatsapp_templates",

      // Knowledge & training
      "knowledge_docs",
      "business_services",
      "business_faqs",
      "business_payment_methods",
      "business_company_details",
      "training_qa",
      "prompt_history",

      // Products & integrations
      "products",
      "website_crawls",
      "store_integrations",

      // Config & settings
      "agent_configs",
      "whatsapp_configs",
      "notification_settings",
      "activity_logs",
      "oauth_states",

      // Subscriptions
      "subscriptions",

      // NOTE: payment_history is NOT deleted — required for 7-year financial audit trail (Indian law)
    ];

    for (const table of tables) {
      await query(`DELETE FROM ${table} WHERE business_id = $1`, [businessId])
        .catch(err => console.warn(`Skip delete from ${table}: ${err.message}`));
    }

    // Anonymize owner user — don't delete (needed for login audit)
    await query(`
      UPDATE users
      SET is_active    = FALSE,
          owner_name   = '[DELETED]',
          email        = CONCAT('deleted_', id, '@deleted.yougant.com'),
          password_hash = 'DELETED',
          updated_at   = NOW()
      WHERE id = $1
    `, [userId]).catch(() => {});

    // Delete team members fully
    await query(
      "DELETE FROM users WHERE business_id = $1 AND id != $2",
      [businessId, userId]
    ).catch(() => {});

    // Anonymize payment_history — keep rows but remove personal identifiers
    await query(`
      UPDATE payment_history
      SET description = 'Account deleted'
      WHERE business_id = $1
    `, [businessId]).catch(() => {});

    console.log(`✅ Account deleted: business ${businessId}`);
    res.json({ success: true });

  } catch (err) {
    console.error("Account deletion error:", err.message);
    res.status(500).json({ message: "Failed to delete account: " + err.message });
  }
});


// ── Conversation Labels ───────────────────────────────────────

// Get labels for a conversation
router.get("/agent/conversations/:id/labels", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM conversation_labels WHERE conversation_id = $1 AND business_id = $2 ORDER BY created_at ASC",
      [req.params.id, req.user.business_id]
    );
    res.json({ labels: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load labels" });
  }
});

// Add label to conversation
router.post("/agent/conversations/:id/labels", async (req, res) => {
  try {
    const { label_key, label_label, label_color, label_icon } = req.body;
    if (!label_key) return res.status(400).json({ message: "label_key required" });

    await query(`
      INSERT INTO conversation_labels
        (conversation_id, business_id, label_key, label_label, label_color, label_icon, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (conversation_id, label_key) DO UPDATE SET
        label_label = $4, label_color = $5, label_icon = $6
    `, [req.params.id, req.user.business_id, label_key, label_label, label_color, label_icon, req.user.id]);

    // Update labels cache on conversation
    const { rows: allLabels } = await query(
      "SELECT label_key, label_label, label_color, label_icon FROM conversation_labels WHERE conversation_id = $1",
      [req.params.id]
    );
    await query(
      "UPDATE conversations SET labels = $1, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(allLabels), req.params.id]
    );

    // Auto-actions based on label
    if (label_key === "follow_up") {
      // Create a follow-up record — scheduled 24h from now by default
      const { rows: conv } = await query(
        "SELECT customer_phone, customer_name FROM conversations WHERE id = $1",
        [req.params.id]
      );
      if (conv.length) {
        await query(`
          INSERT INTO follow_ups
            (business_id, conversation_id, customer_phone, customer_name, scheduled_at, message, sent)
          VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours', 'Following up on your inquiry. How can we help?', FALSE)
          ON CONFLICT DO NOTHING
        `, [req.user.business_id, req.params.id, conv[0].customer_phone, conv[0].customer_name])
        .catch(() => {}); // ignore if follow_ups has unique constraint
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Add label error:", err.message);
    res.status(500).json({ message: "Failed to add label: " + err.message });
  }
});

// Remove label from conversation
router.delete("/agent/conversations/:id/labels/:key", async (req, res) => {
  try {
    await query(
      "DELETE FROM conversation_labels WHERE conversation_id = $1 AND business_id = $2 AND label_key = $3",
      [req.params.id, req.user.business_id, req.params.key]
    );

    // Update labels cache
    const { rows: allLabels } = await query(
      "SELECT label_key, label_label, label_color, label_icon FROM conversation_labels WHERE conversation_id = $1",
      [req.params.id]
    );
    await query(
      "UPDATE conversations SET labels = $1, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(allLabels), req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove label" });
  }
});

// ── Conversation Assignment ───────────────────────────────────
router.post("/agent/conversations/:id/assign", async (req, res) => {
  try {
    const { team_member_id } = req.body;
    const bId = req.user.business_id;

    // Get conversation details
    const { rows: conv } = await query(
      "SELECT customer_name, customer_phone, last_message FROM conversations WHERE id = $1 AND business_id = $2",
      [req.params.id, bId]
    );
    if (!conv.length) return res.status(404).json({ message: "Conversation not found" });

    if (!team_member_id) {
      // Unassign
      await query(
        "UPDATE conversations SET assigned_to = NULL, assigned_name = NULL, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      return res.json({ success: true });
    }

    // Get team member details
    const { rows: member } = await query(
      "SELECT id, name, role FROM team_members WHERE id = $1 AND business_id = $2 AND status = 'active'",
      [team_member_id, bId]
    );
    if (!member.length) return res.status(404).json({ message: "Team member not found" });

    // Update conversation assignment
    await query(
      "UPDATE conversations SET assigned_to = $1, assigned_name = $2, updated_at = NOW() WHERE id = $3",
      [team_member_id, member[0].name, req.params.id]
    );

    // Send WhatsApp notification to assigned member
    try {
      const { rows: memberNotif } = await query(
        "SELECT notify_for FROM team_members WHERE id = $1",
        [team_member_id]
      );

      const { rows: wc } = await query(
        "SELECT phone_number_id, access_token FROM whatsapp_configs WHERE business_id = $1",
        [bId]
      );

      // Get member's phone — from team_members or notification_settings
      const { rows: memberPhone } = await query(`
        SELECT ns.owner_notify_number AS phone
        FROM notification_settings ns
        WHERE ns.business_id = $1
        UNION
        SELECT NULL AS phone
        LIMIT 1
      `, [bId]).catch(() => ({ rows: [] }));

      // Build notification message
      const customerName  = conv[0].customer_name || conv[0].customer_phone;
      const lastMsg       = (conv[0].last_message || "").slice(0, 100);
      const dashboardLink = `${process.env.FRONTEND_URL || "https://yougant.com"}/dashboard?conv=${req.params.id}`;

      const notifMsg =
        `👤 ${member[0].name}, you have been assigned a conversation.

` +
        `Customer: ${customerName}
` +
        `Last message: "${lastMsg}"

` +
        `Open: ${dashboardLink}`;

      // Send to member's registered notify number if available
      if (wc.length && memberPhone[0]?.phone) {
        const { sendWhatsAppMessage } = await import("../whatsapp/sender.js");
        await sendWhatsAppMessage({
          phoneNumberId: wc[0].phone_number_id,
          accessToken:   wc[0].access_token,
          to:            memberPhone[0].phone.replace(/\D/g, ""),
          message:       notifMsg,
        });
      }

      console.log(`✅ Conversation ${req.params.id} assigned to ${member[0].name}`);
    } catch (notifErr) {
      console.error("Assignment notification error:", notifErr.message);
      // Don't fail — assignment already saved
    }

    res.json({ success: true, assigned_to: team_member_id, assigned_name: member[0].name });
  } catch (err) {
    console.error("Assign error:", err.message);
    res.status(500).json({ message: "Failed to assign: " + err.message });
  }
});

// Get team members for assignment dropdown
router.get("/agent/team-members", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, name, role FROM team_members WHERE business_id = $1 AND status = 'active' ORDER BY name ASC",
      [req.user.business_id]
    );
    res.json({ members: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load team members" });
  }
});


// ── Media Proxy — fetch fresh URL from Meta on-demand ─────────
// Handles both R2 stored URLs and meta_media_id: fallback
router.get("/media/:messageId", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT m.media_url, m.media_type, m.media_filename, c.business_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1
    `, [req.params.messageId]);

    if (!rows.length) return res.status(404).json({ message: "Message not found" });
    const msg = rows[0];

    // Direct stored URL (R2) — redirect
    if (msg.media_url && !msg.media_url.startsWith("meta_media_id:")) {
      return res.redirect(msg.media_url);
    }

    // meta_media_id fallback — fetch fresh from Meta
    if (msg.media_url?.startsWith("meta_media_id:")) {
      const metaMediaId = msg.media_url.replace("meta_media_id:", "");

      const { rows: wc } = await query(
        "SELECT access_token FROM whatsapp_configs WHERE business_id = $1",
        [msg.business_id]
      );
      if (!wc.length || !wc[0].access_token) {
        return res.status(503).json({ message: "WhatsApp not configured" });
      }

      const axios = (await import("axios")).default;
      const META_VERSION = process.env.META_API_VERSION || "v19.0";

      // Step 1: Get the download URL from Meta
      const metaRes = await axios.get(
        `https://graph.facebook.com/${META_VERSION}/${metaMediaId}`,
        { headers: { Authorization: `Bearer ${wc[0].access_token}` } }
      );
      const freshUrl = metaRes.data?.url;
      if (!freshUrl) {
        return res.status(410).json({ message: "Media expired or unavailable on Meta" });
      }

      // Step 2: Stream file to client
      const fileRes = await axios.get(freshUrl, {
        responseType: "stream",
        headers: { Authorization: `Bearer ${wc[0].access_token}` },
      });

      const contentType = fileRes.headers["content-type"] || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=300"); // cache 5 min in browser

      if (msg.media_filename) {
        const disposition = contentType.startsWith("image/") ? "inline" : "attachment";
        res.setHeader("Content-Disposition", `${disposition}; filename="${msg.media_filename}"`);
      }

      return fileRes.data.pipe(res);
    }

    res.status(404).json({ message: "No media available for this message" });
  } catch (err) {
    console.error("Media proxy error:", err.message);
    if (err.response?.status === 401) return res.status(401).json({ message: "WhatsApp token expired" });
    res.status(500).json({ message: "Failed to load media" });
  }
});

export default router;