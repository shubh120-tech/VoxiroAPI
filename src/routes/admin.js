import express   from "express";
import bcrypt    from "bcrypt";
import jwt       from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { adminAuthMiddleware } from "../middleware/auth.js";

const router = express.Router();

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await query(
      "SELECT * FROM admins WHERE email = $1 AND is_active = TRUE", [email]
    );
    if (!rows.length) return res.status(401).json({ message: "Invalid credentials" });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid)  return res.status(401).json({ message: "Invalid credentials" });

    await query("UPDATE admins SET last_login_at = NOW() WHERE id = $1", [rows[0].id]);

    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
      console.error("❌ ADMIN_JWT_SECRET is not set in environment variables!");
      return res.status(500).json({ message: "Server misconfiguration — contact support" });
    }

    const token = jwt.sign(
      { adminId: rows[0].id, role: rows[0].role },
      secret,
      { expiresIn: "12h" }
    );

    res.json({ token, admin: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role } });
  } catch (err) {
    res.status(500).json({ message: "Login failed" });
  }
});

// All routes below require admin auth
router.use(adminAuthMiddleware);

// ── Analytics ─────────────────────────────────────────────────
router.get("/analytics/overview", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM admin_platform_overview");
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ message: "Failed to load overview" });
  }
});

router.get("/analytics/daily", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const { rows } = await query(`
      SELECT * FROM platform_stats
      WHERE date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY date DESC
    `);
    res.json({ stats: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load daily stats" });
  }
});

router.get("/analytics/usage", async (req, res) => {
  try {
    const { page = 1, limit = 20, sort = "usage_pct" } = req.query;
    const offset   = (page - 1) * limit;
    const sortCol  = ["usage_pct", "messages_used", "plan_name", "created_at"].includes(sort) ? sort : "usage_pct";
    const { rows } = await query(`
      SELECT * FROM admin_business_usage
      ORDER BY ${sortCol} DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const count = await query("SELECT COUNT(*) FROM admin_business_usage");
    res.json({ businesses: rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load usage" });
  }
});

// ── Businesses ────────────────────────────────────────────────
router.get("/businesses", async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const offset = (page - 1) * limit;
    let sql    = `SELECT * FROM admin_business_usage WHERE 1=1`;
    const params = [];
    if (search) { params.push(`%${search}%`); sql += ` AND business_name ILIKE $${params.length}`; }
    if (status === "active")   sql += ` AND is_active = TRUE`;
    if (status === "inactive") sql += ` AND is_active = FALSE`;
    const countSql = sql.replace("SELECT *", "SELECT COUNT(*)");
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0, -2))]);
    res.json({ businesses: data.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load businesses" });
  }
});

router.get("/businesses/:id", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT bv.*, u.owner_name, u.email,
             ac.tone, ac.language, ac.agent_name AS agent_name,
             wc.whatsapp_number, wc.is_verified AS whatsapp_verified
      FROM admin_business_usage bv
      JOIN users u  ON u.business_id = bv.business_id AND u.role = 'owner'
      LEFT JOIN agent_configs ac ON ac.business_id = bv.business_id
      LEFT JOIN whatsapp_configs wc ON wc.business_id = bv.business_id
      WHERE bv.business_id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Business not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to load business" });
  }
});

router.patch("/businesses/:id/toggle", async (req, res) => {
  try {
    await query("UPDATE businesses SET is_active = $1 WHERE id = $2",
      [req.body.isActive, req.params.id]);

    // Log admin action
    await query(`
      INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
      VALUES ($1, $2, 'business', $3, $4)
    `, [
      req.admin.id,
      req.body.isActive ? "activate_business" : "deactivate_business",
      req.params.id,
      JSON.stringify({ isActive: req.body.isActive }),
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle business" });
  }
});

router.get("/businesses/:id/conversations", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 10, 50);
    const { rows } = await query(`
      SELECT * FROM conversations WHERE business_id = $1
      ORDER BY last_message_at DESC NULLS LAST LIMIT $2
    `, [req.params.id, limit]);
    res.json({ conversations: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

// ── Plans ─────────────────────────────────────────────────────
router.get("/plans", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM plans ORDER BY price_monthly ASC");
    res.json({ plans: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load plans" });
  }
});

router.put("/plans/:id", async (req, res) => {
  try {
    const { price_monthly, message_limit, doc_limit } = req.body;
    await query(`
      UPDATE plans SET price_monthly = $1, message_limit = $2, doc_limit = $3
      WHERE id = $4
    `, [price_monthly, message_limit, doc_limit, req.params.id]);
    await query(`
      INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
      VALUES ($1, 'update_plan', 'plan', $2, $3)
    `, [req.admin.id, req.params.id, JSON.stringify(req.body)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update plan" });
  }
});

// ── Conversations (read-only view) ────────────────────────────
router.get("/conversations", async (req, res) => {
  try {
    const { page = 1, limit = 30, businessId } = req.query;
    const offset = (page - 1) * limit;
    let sql    = `
      SELECT c.*, b.name AS business_name
      FROM conversations c
      JOIN businesses b ON b.id = c.business_id
      WHERE 1=1
    `;
    const params = [];
    if (businessId) { params.push(businessId); sql += ` AND c.business_id = $${params.length}`; }
    sql += ` ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await query(sql, params);
    res.json({ conversations: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load messages" });
  }
});

// ── Support Tickets ───────────────────────────────────────────
router.get("/support", async (req, res) => {
  try {
    const { page = 1, limit = 30, status } = req.query;
    const offset = (page - 1) * limit;
    let sql    = `
      SELECT st.*, b.name AS business_name
      FROM support_tickets st
      JOIN businesses b ON b.id = st.business_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); sql += ` AND st.status = $${params.length}`; }
    sql += ` ORDER BY st.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await query(sql, params);
    res.json({ tickets: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load tickets" });
  }
});

router.patch("/support/:id/resolve", async (req, res) => {
  try {
    await query(`
      UPDATE support_tickets
      SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), notes = $2
      WHERE id = $3
    `, [req.admin.id, req.body.notes, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to resolve ticket" });
  }
});


// ── Edit Agent Prompt ─────────────────────────────────────────
router.get("/businesses/:id/prompt", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT system_prompt, agent_name, tone, language FROM agent_configs WHERE business_id = $1",
      [req.params.id]
    );
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ message: "Failed to load prompt" });
  }
});

router.put("/businesses/:id/prompt", async (req, res) => {
  try {
    const { system_prompt, agent_name } = req.body;
    if (!system_prompt?.trim()) return res.status(400).json({ message: "Prompt cannot be empty" });

    // Save current to history
    const { rows: cur } = await query(
      "SELECT system_prompt FROM agent_configs WHERE business_id = $1", [req.params.id]
    );
    if (cur[0]?.system_prompt) {
      await query(
        "INSERT INTO prompt_history (business_id, prompt, change_note, changed_by) VALUES ($1,$2,$3,'admin')",
        [req.params.id, cur[0].system_prompt, "Admin override"]
      ).catch(() => {});
    }

    await query(`
      UPDATE agent_configs
      SET system_prompt = $1, agent_name = COALESCE($2, agent_name), updated_at = NOW()
      WHERE business_id = $3
    `, [system_prompt, agent_name, req.params.id]);

    await query(
      "INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,'edit_prompt','business',$2,$3)",
      [req.admin.id, req.params.id, JSON.stringify({ agent_name })]
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update prompt" });
  }
});

// ── Assign Plan ───────────────────────────────────────────────
router.get("/plans", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM plans ORDER BY price_monthly ASC");
    res.json({ plans: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load plans" });
  }
});

router.patch("/businesses/:id/plan", async (req, res) => {
  try {
    const { planId, reason } = req.body;
    if (!planId) return res.status(400).json({ message: "Plan ID required" });

    // Get plan details
    const { rows: plan } = await query("SELECT * FROM plans WHERE id = $1", [planId]);
    if (!plan.length) return res.status(404).json({ message: "Plan not found" });

    // Update business plan
    await query(
      "UPDATE businesses SET plan_id = $1, updated_at = NOW() WHERE id = $2",
      [planId, req.params.id]
    );

    // Update message limit in agent_configs
    await query(
      "UPDATE agent_configs SET message_limit = $1 WHERE business_id = $2",
      [plan[0].message_limit, req.params.id]
    ).catch(() => {});

    await query(
      "INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,'assign_plan','business',$2,$3)",
      [req.admin.id, req.params.id, JSON.stringify({ planId, planName: plan[0].name, reason })]
    ).catch(() => {});

    res.json({ success: true, plan: plan[0] });
  } catch (err) {
    res.status(500).json({ message: "Failed to assign plan" });
  }
});

// ── Reset Password ────────────────────────────────────────────
router.post("/businesses/:id/reset-password", async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    // Find owner user for this business
    const { rows: users } = await query(
      "SELECT id FROM users WHERE business_id = $1 AND role = 'owner'",
      [req.params.id]
    );
    if (!users.length) return res.status(404).json({ message: "Business owner not found" });

    const hash = await bcrypt.hash(newPassword, 12);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, users[0].id]);

    await query(
      "INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,'reset_password','business',$2,$3)",
      [req.admin.id, req.params.id, JSON.stringify({ userId: users[0].id })]
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reset password" });
  }
});

// ── View Conversations ─────────────────────────────────────────
router.get("/businesses/:id/conversations/full", async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;
    let sql = `
      SELECT c.id, c.customer_name, c.customer_phone, c.status,
             c.last_message, c.last_message_at, c.unread_count,
             COUNT(m.id) AS message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.business_id = $1
    `;
    const params = [req.params.id];
    if (status) { params.push(status); sql += ` AND c.status = $${params.length}`; }
    sql += ` GROUP BY c.id ORDER BY c.last_message_at DESC NULLS LAST
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const [convRows, countRow] = await Promise.all([
      query(sql, params),
      query(`SELECT COUNT(*) FROM conversations WHERE business_id = $1${status ? ` AND status = '${status}'` : ""}`, [req.params.id]),
    ]);

    res.json({ conversations: convRows.rows, total: parseInt(countRow.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

// ── Suspend / Activate ─────────────────────────────────────────
router.patch("/businesses/:id/suspend", async (req, res) => {
  try {
    const { suspend, reason } = req.body;
    await query(
      "UPDATE businesses SET is_active = $1, updated_at = NOW() WHERE id = $2",
      [!suspend, req.params.id]
    );
    await query(
      "INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,'business',$3,$4)",
      [req.admin.id, suspend ? "suspend_business" : "activate_business", req.params.id, JSON.stringify({ reason })]
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update business status" });
  }
});

// ── Audit Log ──────────────────────────────────────────────────
router.get("/businesses/:id/audit", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT al.*, a.name AS admin_name
      FROM admin_audit_logs al
      JOIN admins a ON a.id = al.admin_id
      WHERE al.target_id = $1
      ORDER BY al.created_at DESC
      LIMIT 30
    `, [req.params.id]);
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load audit log" });
  }
});

// ── Admin stats for dashboard ──────────────────────────────────
router.get("/analytics/overview", async (req, res) => {
  try {
    const [bizRows, msgRows, leadRows, revenueRows] = await Promise.all([
      query(`SELECT
        COUNT(*) AS total_businesses,
        COUNT(*) FILTER (WHERE is_active = TRUE) AS active_businesses,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS new_today
        FROM businesses`),
      query(`SELECT
        COUNT(*) AS total_messages,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS messages_this_month
        FROM messages`),
      query(`SELECT COUNT(*) AS total_leads FROM leads WHERE created_at >= date_trunc('month', NOW())`),
      query(`SELECT COALESCE(SUM(p.price_monthly), 0) AS monthly_revenue
             FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.is_active = TRUE`),
    ]);

    res.json({
      total_businesses:     parseInt(bizRows.rows[0].total_businesses),
      active_businesses:    parseInt(bizRows.rows[0].active_businesses),
      new_today:            parseInt(bizRows.rows[0].new_today),
      total_messages:       parseInt(msgRows.rows[0].total_messages),
      messages_this_month:  parseInt(msgRows.rows[0].messages_this_month),
      total_leads_month:    parseInt(leadRows.rows[0].total_leads),
      monthly_revenue:      parseFloat(revenueRows.rows[0].monthly_revenue),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load overview" });
  }
});

// ── AI Usage Analytics ────────────────────────────────────────

router.get("/analytics/ai-usage", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM admin_ai_usage_summary
      ORDER BY total_cost_usd DESC
    `);
    res.json({ businesses: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load AI usage: " + err.message });
  }
});

router.get("/analytics/ai-usage/daily", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const { rows } = await query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
        SUM(total_tokens)  AS total_tokens,
        SUM(cost_usd)      AS cost_usd,
        COUNT(*)           AS total_calls,
        SUM(total_tokens) FILTER (WHERE feature = 'agent_reply')         AS agent_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'prompt_generation')   AS prompt_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'contact_extraction')  AS extraction_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'template_generation') AS template_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'agent_training')      AS training_tokens
      FROM ai_usage_logs
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
      ORDER BY date DESC
    `, [days]);
    res.json({ daily: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load daily AI usage" });
  }
});

router.get("/analytics/ai-usage/business/:id", async (req, res) => {
  try {
    const [summary, daily, byFeature] = await Promise.all([
      query(`SELECT * FROM admin_ai_usage_summary WHERE business_id = $1`, [req.params.id]),
      query(`
        SELECT
          DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
          SUM(total_tokens) AS tokens,
          SUM(cost_usd)     AS cost_usd,
          COUNT(*)          AS calls
        FROM ai_usage_logs
        WHERE business_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY date DESC
      `, [req.params.id]),
      query(`
        SELECT
          feature,
          SUM(total_tokens) AS tokens,
          SUM(cost_usd)     AS cost_usd,
          COUNT(*)          AS calls,
          ROUND(AVG(total_tokens)) AS avg_tokens_per_call
        FROM ai_usage_logs
        WHERE business_id = $1
        GROUP BY feature
        ORDER BY cost_usd DESC
      `, [req.params.id]),
    ]);
    res.json({ summary: summary.rows[0] || {}, daily: daily.rows, byFeature: byFeature.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load business AI usage" });
  }
});

// ── Billing history per business ──────────────────────────────
router.get("/businesses/:id/billing", async (req, res) => {
  try {
    const [sub, payments] = await Promise.all([
      query(`
        SELECT s.*, p.name AS plan_name, p.display_name AS plan_display_name,
               p.price_monthly, p.message_limit
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1
        ORDER BY s.created_at DESC LIMIT 1
      `, [req.params.id]),
      query(`
        SELECT * FROM payments
        WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 24
      `, [req.params.id]).catch(() => ({ rows: [] })),
    ]);
    res.json({ subscription: sub.rows[0] || null, payments: payments.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load billing: " + err.message });
  }
});

// ── AI Usage Analytics ────────────────────────────────────────

router.get("/analytics/ai-usage", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM admin_ai_usage_summary
      ORDER BY total_cost_usd DESC
    `);
    res.json({ businesses: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load AI usage: " + err.message });
  }
});

router.get("/analytics/ai-usage/daily", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const { rows } = await query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
        SUM(total_tokens)  AS total_tokens,
        SUM(cost_usd)      AS cost_usd,
        COUNT(*)           AS total_calls,
        SUM(total_tokens) FILTER (WHERE feature = 'agent_reply')         AS agent_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'prompt_generation')   AS prompt_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'contact_extraction')  AS extraction_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'template_generation') AS template_tokens,
        SUM(total_tokens) FILTER (WHERE feature = 'agent_training')      AS training_tokens
      FROM ai_usage_logs
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
      ORDER BY date DESC
    `, [days]);
    res.json({ daily: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load daily AI usage" });
  }
});

router.get("/analytics/ai-usage/business/:id", async (req, res) => {
  try {
    const [summary, daily, byFeature] = await Promise.all([
      query(`SELECT * FROM admin_ai_usage_summary WHERE business_id = $1`, [req.params.id]),
      query(`
        SELECT
          DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
          SUM(total_tokens) AS tokens,
          SUM(cost_usd)     AS cost_usd,
          COUNT(*)          AS calls
        FROM ai_usage_logs
        WHERE business_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY date DESC
      `, [req.params.id]),
      query(`
        SELECT
          feature,
          SUM(total_tokens) AS tokens,
          SUM(cost_usd)     AS cost_usd,
          COUNT(*)          AS calls,
          ROUND(AVG(total_tokens)) AS avg_tokens_per_call
        FROM ai_usage_logs
        WHERE business_id = $1
        GROUP BY feature
        ORDER BY cost_usd DESC
      `, [req.params.id]),
    ]);
    res.json({ summary: summary.rows[0] || {}, daily: daily.rows, byFeature: byFeature.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load business AI usage" });
  }
});

// ── Billing history per business ──────────────────────────────
router.get("/businesses/:id/billing", async (req, res) => {
  try {
    const [sub, payments] = await Promise.all([
      query(`
        SELECT s.*, p.name AS plan_name, p.display_name AS plan_display_name,
               p.price_monthly, p.message_limit
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1
        ORDER BY s.created_at DESC LIMIT 1
      `, [req.params.id]),
      query(`
        SELECT * FROM payments
        WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 24
      `, [req.params.id]).catch(() => ({ rows: [] })),
    ]);
    res.json({ subscription: sub.rows[0] || null, payments: payments.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load billing: " + err.message });
  }
});

// ── Admin Plans CRUD ──────────────────────────────────────────

// ── ADD THESE ROUTES TO src/routes/admin.js ──────────────────
// Paste BEFORE the `export default router;` line at the bottom
// These routes are protected by the admin auth middleware already on the router

// ── Admin Plans CRUD ──────────────────────────────────────────

// ── ADD THESE ROUTES TO src/routes/admin.js ──────────────────
// Paste BEFORE the `export default router;` line at the bottom
// These routes are protected by the admin auth middleware already on the router

// ── Admin Plans CRUD ──────────────────────────────────────────

router.get("/plans", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        id::text, name::text, display_name, is_active,
        price_monthly,
        COALESCE(amount_inr, ROUND(price_monthly * 84))  AS amount_inr,
        COALESCE(discount_pct, 0)                         AS discount_pct,
        COALESCE(offer_text, '')                          AS offer_text,
        COALESCE(token_limit, 0)                          AS token_limit,
        COALESCE(message_limit, 0)                        AS message_limit,
        COALESCE(doc_limit, 5)                            AS doc_limit,
        COALESCE(trial_days, 0)                           AS trial_days,
        created_at
      FROM plans
      ORDER BY COALESCE(amount_inr, price_monthly * 84) ASC
    `);
    res.json({ plans: rows });
  } catch (err) {
    console.error("Admin plans fetch error:", err.message);
    res.status(500).json({ message: "Failed to load plans: " + err.message });
  }
});

router.post("/plans", async (req, res) => {
  try {
    const {
      name, display_name, price_monthly = 0,
      amount_inr = 0, discount_pct = 0, offer_text = "",
      token_limit = 0, message_limit = 0, doc_limit = 10,
      trial_days = 0, is_active = true,
    } = req.body;

    if (!name || !display_name) {
      return res.status(400).json({ message: "name and display_name are required" });
    }

    const { rows } = await query(`
      INSERT INTO plans
        (name, display_name, price_monthly, amount_inr, discount_pct, offer_text,
         token_limit, message_limit, doc_limit, trial_days, is_active, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      RETURNING id::text
    `, [name, display_name, price_monthly, amount_inr, discount_pct, offer_text,
        token_limit, message_limit, doc_limit, trial_days, is_active]);

    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error("Create plan error:", err.message);
    res.status(500).json({ message: "Failed to create plan: " + err.message });
  }
});

router.put("/plans/:id", async (req, res) => {
  try {
    const {
      display_name, price_monthly,
      amount_inr, discount_pct, offer_text,
      token_limit, message_limit, doc_limit,
      trial_days, is_active,
    } = req.body;

    await query(`
      UPDATE plans SET
        display_name  = COALESCE($1,  display_name),
        price_monthly = COALESCE($2,  price_monthly),
        amount_inr    = COALESCE($3,  amount_inr),
        discount_pct  = COALESCE($4,  discount_pct),
        offer_text    = COALESCE($5,  offer_text),
        token_limit   = COALESCE($6,  token_limit),
        message_limit = COALESCE($7,  message_limit),
        doc_limit     = COALESCE($8,  doc_limit),
        trial_days    = COALESCE($9,  trial_days),
        is_active     = COALESCE($10, is_active),
        updated_at    = NOW()
      WHERE id = $11::uuid
    `, [display_name, price_monthly, amount_inr, discount_pct, offer_text,
        token_limit, message_limit, doc_limit, trial_days, is_active,
        req.params.id]);

    res.json({ success: true });
  } catch (err) {
    console.error("Update plan error:", err.message);
    res.status(500).json({ message: "Failed to update plan: " + err.message });
  }
});

router.delete("/plans/:id", async (req, res) => {
  try {
    // Check active subscriptions
    const { rows: subs } = await query(
      "SELECT COUNT(*) AS cnt FROM subscriptions WHERE plan_id = $1::uuid AND is_active = TRUE",
      [req.params.id]
    );
    if (parseInt(subs[0]?.cnt) > 0) {
      return res.status(400).json({
        message: `Cannot delete — ${subs[0].cnt} active subscription(s) use this plan. Deactivate it instead.`
      });
    }

    // Null out businesses.plan_id FK before deleting
    await query(
      "UPDATE businesses SET plan_id = NULL WHERE plan_id = $1::uuid",
      [req.params.id]
    ).catch(() => {});

    // Null out subscriptions FK (inactive ones)
    await query(
      "UPDATE subscriptions SET plan_id = NULL WHERE plan_id = $1::uuid",
      [req.params.id]
    ).catch(() => {});

    await query("DELETE FROM plans WHERE id = $1::uuid", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete plan error:", err.message);
    res.status(500).json({ message: "Failed to delete plan: " + err.message });
  }
});

export default router;