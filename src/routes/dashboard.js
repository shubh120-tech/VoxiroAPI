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

    const tables = [
      "messages", "conversations", "leads", "orders", "appointments",
      "follow_ups", "pending_messages", "knowledge_docs", "agent_configs",
      "whatsapp_configs", "notification_settings", "activity_logs",
      "business_services", "business_faqs", "business_payment_methods",
      "business_company_details", "broadcast_contacts", "broadcast_lists",
      "broadcast_campaigns", "broadcast_templates", "products",
      "website_crawls", "prompt_history", "oauth_states",
    ];

    for (const table of tables) {
      await query(`DELETE FROM ${table} WHERE business_id = $1`, [businessId])
        .catch(err => console.warn(`Skip delete from ${table}: ${err.message}`));
    }

    await query("DELETE FROM users WHERE business_id = $1 AND id != $2", [businessId, userId]).catch(() => {});
    await query("UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1", [userId]).catch(() => {});
    await query(`UPDATE businesses SET is_active = FALSE, name = CONCAT('[DELETED] ', name), updated_at = NOW() WHERE id = $1`, [businessId]);

    console.log(`✅ Account deleted: business ${businessId}`);
    res.json({ success: true });

  } catch (err) {
    console.error("Account deletion error:", err.message);
    res.status(500).json({ message: "Failed to delete account: " + err.message });
  }
});

export default router;