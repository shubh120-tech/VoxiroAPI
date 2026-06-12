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
console.log("✅ Admin routes v2 loaded — help_tickets");
router.use(adminAuthMiddleware);

// ── Analytics ─────────────────────────────────────────────────
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
      query(`SELECT COALESCE(SUM(COALESCE(p.amount_inr, p.price_inr)), 0) AS monthly_revenue
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
    const offset  = (page - 1) * limit;
    const sortCol = ["usage_pct","messages_used","plan_name","created_at"].includes(sort) ? sort : "usage_pct";
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

router.get("/analytics/ai-usage", async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM admin_ai_usage_summary ORDER BY total_cost_usd DESC`);
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
        SUM(total_tokens) AS total_tokens, SUM(cost_usd) AS cost_usd,
        COUNT(*) AS total_calls,
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
        SELECT DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
               SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
        FROM ai_usage_logs
        WHERE business_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
        ORDER BY date DESC
      `, [req.params.id]),
      query(`
        SELECT feature, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost_usd,
               COUNT(*) AS calls, ROUND(AVG(total_tokens)) AS avg_tokens_per_call
        FROM ai_usage_logs WHERE business_id = $1
        GROUP BY feature ORDER BY cost_usd DESC
      `, [req.params.id]),
    ]);
    res.json({ summary: summary.rows[0] || {}, daily: daily.rows, byFeature: byFeature.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load business AI usage" });
  }
});

// ── Businesses ────────────────────────────────────────────────
router.get("/businesses", async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const offset = (page - 1) * limit;
    let sql = `SELECT * FROM admin_business_usage WHERE 1=1`;
    const params = [];
    if (search) { params.push(`%${search}%`); sql += ` AND business_name ILIKE $${params.length}`; }
    if (status === "active")   sql += ` AND is_active = TRUE`;
    if (status === "inactive") sql += ` AND is_active = FALSE`;
    const countSql = sql.replace("SELECT *", "SELECT COUNT(*)");
    sql += ` ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0,-2))]);
    res.json({ businesses: data.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load businesses" });
  }
});

router.get("/businesses/:id", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT bv.*, u.owner_name, u.email,
             ac.tone, ac.language, ac.agent_name, b.phone,
             wc.whatsapp_number, wc.is_verified AS whatsapp_verified
      FROM admin_business_usage bv
      JOIN users u ON u.business_id = bv.business_id AND u.role = 'owner'
      LEFT JOIN agent_configs ac ON ac.business_id = bv.business_id
	    LEFT JOIN Businesses b ON b.id = bv.business_id
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
    await query("UPDATE businesses SET is_active = $1 WHERE id = $2", [req.body.isActive, req.params.id]);
    await query(`INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
                 VALUES ($1, $2, 'business', $3, $4)`,
      [req.admin.id, req.body.isActive ? "activate_business" : "deactivate_business",
       req.params.id, JSON.stringify({ isActive: req.body.isActive })]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle business" });
  }
});

router.get("/businesses/:id/conversations", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { rows } = await query(`
      SELECT * FROM conversations WHERE business_id = $1
      ORDER BY last_message_at DESC NULLS LAST LIMIT $2
    `, [req.params.id, limit]);
    res.json({ conversations: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

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
             LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const [convRows, countRow] = await Promise.all([
      query(sql, params),
      query(`SELECT COUNT(*) FROM conversations WHERE business_id = $1`, [req.params.id]),
    ]);
    res.json({ conversations: convRows.rows, total: parseInt(countRow.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

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
    const { rows: cur } = await query(
      "SELECT system_prompt FROM agent_configs WHERE business_id = $1", [req.params.id]
    );
    if (cur[0]?.system_prompt) {
      await query(
        "INSERT INTO prompt_history (business_id, prompt, change_note, changed_by) VALUES ($1,$2,$3,'admin')",
        [req.params.id, cur[0].system_prompt, "Admin override"]
      ).catch(() => {});
    }
    await query(`UPDATE agent_configs SET system_prompt=$1, agent_name=COALESCE($2,agent_name), updated_at=NOW() WHERE business_id=$3`,
      [system_prompt, agent_name, req.params.id]);
    await query(`INSERT INTO admin_audit_logs (admin_id,action,target_type,target_id,details) VALUES ($1,'edit_prompt','business',$2,$3)`,
      [req.admin.id, req.params.id, JSON.stringify({ agent_name })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update prompt" });
  }
});

router.patch("/businesses/:id/plan", async (req, res) => {
  try {
    const { planId, reason } = req.body;
    if (!planId) return res.status(400).json({ message: "Plan ID required" });
    const { rows: plan } = await query("SELECT * FROM plans WHERE id = $1", [planId]);
    if (!plan.length) return res.status(404).json({ message: "Plan not found" });
    await query("UPDATE businesses SET plan_id = $1, updated_at = NOW() WHERE id = $2", [planId, req.params.id]);
    await query("UPDATE agent_configs SET message_limit = $1 WHERE business_id = $2",
      [plan[0].message_limit, req.params.id]).catch(() => {});
    await query(`INSERT INTO admin_audit_logs (admin_id,action,target_type,target_id,details) VALUES ($1,'assign_plan','business',$2,$3)`,
      [req.admin.id, req.params.id, JSON.stringify({ planId, planName: plan[0].name, reason })]).catch(() => {});
    res.json({ success: true, plan: plan[0] });
  } catch (err) {
    res.status(500).json({ message: "Failed to assign plan" });
  }
});

router.post("/businesses/:id/reset-password", async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    const { rows: users } = await query(
      "SELECT id FROM users WHERE business_id = $1 AND role = 'owner'", [req.params.id]
    );
    if (!users.length) return res.status(404).json({ message: "Business owner not found" });
    const hash = await bcrypt.hash(newPassword, 12);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, users[0].id]);
    await query(`INSERT INTO admin_audit_logs (admin_id,action,target_type,target_id,details) VALUES ($1,'reset_password','business',$2,$3)`,
      [req.admin.id, req.params.id, JSON.stringify({ userId: users[0].id })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reset password" });
  }
});

router.patch("/businesses/:id/suspend", async (req, res) => {
  try {
    const { suspend, reason } = req.body;
    await query("UPDATE businesses SET is_active = $1, updated_at = NOW() WHERE id = $2", [!suspend, req.params.id]);
    await query(`INSERT INTO admin_audit_logs (admin_id,action,target_type,target_id,details) VALUES ($1,$2,'business',$3,$4)`,
      [req.admin.id, suspend ? "suspend_business" : "activate_business", req.params.id, JSON.stringify({ reason })]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update business status" });
  }
});

router.get("/businesses/:id/audit", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT al.*, a.name AS admin_name FROM admin_audit_logs al
      JOIN admins a ON a.id = al.admin_id
      WHERE al.target_id = $1 ORDER BY al.created_at DESC LIMIT 30
    `, [req.params.id]);
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load audit log" });
  }
});

router.get("/businesses/:id/billing", async (req, res) => {
  try {
    const [sub, payments] = await Promise.all([
      query(`
        SELECT s.*, p.name AS plan_name, p.display_name AS plan_display_name,
               COALESCE(p.amount_inr, p.price_inr) AS amount_inr, p.message_limit
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1
      `, [req.params.id]),
      query(`SELECT * FROM payments WHERE business_id = $1 ORDER BY created_at DESC LIMIT 24`,
        [req.params.id]).catch(() => ({ rows: [] })),
    ]);
    res.json({ subscription: sub.rows[0] || null, payments: payments.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load billing: " + err.message });
  }
});

// ── Conversations ─────────────────────────────────────────────
router.get("/conversations", async (req, res) => {
  try {
    const { page = 1, limit = 30, businessId } = req.query;
    const offset = (page - 1) * limit;
    let sql = `SELECT c.*, b.name AS business_name FROM conversations c
               JOIN businesses b ON b.id = c.business_id WHERE 1=1`;
    const params = [];
    if (businessId) { params.push(businessId); sql += ` AND c.business_id = $${params.length}`; }
    sql += ` ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length+1} OFFSET $${params.length+2}`;
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
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [req.params.id]
    );
    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load messages" });
  }
});

// ── Support ─────────────────────────────────────────────────────
// ── Admin Support Routes — paste into src/routes/admin.js before export default ──

// ── GET /admin/support ────────────────────────────────────────────
router.get("/support", async (req, res) => {
  try {
    const { page = 1, limit = 30, status, priority, search } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = "WHERE 1=1";
    if (status)   { params.push(status);        where += ` AND t.status   = $${params.length}`; }
    if (priority) { params.push(priority);       where += ` AND t.priority = $${params.length}`; }
    if (search)   { params.push(`%${search}%`); where += ` AND (t.subject ILIKE $${params.length} OR b.name ILIKE $${params.length})`; }

    const base = `
      FROM help_tickets t
      JOIN businesses b ON b.id = t.business_id
      LEFT JOIN users u  ON u.id = t.created_by AND u.role = 'owner'
      LEFT JOIN admins a ON a.id = t.assigned_to
      ${where}
    `;

    const countResult = await query(`SELECT COUNT(*) ${base}`, params);
    const total = parseInt(countResult.rows[0].count);

    params.push(limit, offset);
    const { rows } = await query(`
      SELECT
        t.*,
        b.name       AS business_name,
        u.owner_name AS created_by_name,
        u.email      AS owner_email,
        a.name       AS assigned_to_name,
        (SELECT COUNT(*) FROM help_ticket_comments   c   WHERE c.ticket_id   = t.id)::int AS comment_count,
        (SELECT COUNT(*) FROM help_ticket_attachments att WHERE att.ticket_id = t.id)::int AS attachment_count
      ${base}
      ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
               t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ tickets: rows, total });
  } catch (err) {
    res.status(500).json({ message: "Failed to load tickets: " + err.message });
  }
});

// ── GET /admin/support/:id ────────────────────────────────────────
router.get("/support/:id", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT t.*, b.name AS business_name, u.owner_name AS created_by_name, u.email AS owner_email, a.name AS assigned_to_name
      FROM help_tickets t
      JOIN businesses b ON b.id = t.business_id
      LEFT JOIN users u  ON u.id = t.created_by
      LEFT JOIN admins a ON a.id = t.assigned_to
      WHERE t.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Ticket not found" });

    const [comments, attachments, statusLog] = await Promise.all([
      query(`SELECT * FROM help_ticket_comments WHERE ticket_id=$1 ORDER BY created_at ASC`, [req.params.id]),
      query(`SELECT * FROM help_ticket_attachments WHERE ticket_id=$1 ORDER BY created_at ASC`, [req.params.id]),
      query(`SELECT * FROM help_ticket_status_log WHERE ticket_id=$1 ORDER BY created_at ASC`, [req.params.id]),
    ]);

    res.json({ ticket: rows[0], comments: comments.rows, attachments: attachments.rows, statusLog: statusLog.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load ticket: " + err.message });
  }
});

// ── PATCH /admin/support/:id/status ──────────────────────────────
router.patch("/support/:id/status", async (req, res) => {
  try {
    const { status, note } = req.body;
    const VALID = ["open", "in_progress", "waiting", "resolved", "closed"];
    if (!VALID.includes(status)) return res.status(400).json({ message: "Invalid status" });

    const { rows: t } = await query("SELECT status FROM help_tickets WHERE id=$1", [req.params.id]);
    if (!t.length) return res.status(404).json({ message: "Ticket not found" });

    const updates = { status, updated_at: "NOW()" };
    if (status === "resolved") {
      await query(`UPDATE help_tickets SET status=$1, resolved_by=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$3`,
        [status, req.admin.id, req.params.id]);
    } else {
      await query(`UPDATE help_tickets SET status=$1, updated_at=NOW() WHERE id=$2`, [status, req.params.id]);
    }

    await query(`
      INSERT INTO help_ticket_status_log (ticket_id, changed_by, changer_type, changer_name, old_status, new_status, note)
      VALUES ($1,$2,'admin',$3,$4,$5,$6)
    `, [req.params.id, req.admin.id, req.admin.name || "Admin", t[0].status, status, note || null]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update status: " + err.message });
  }
});

// ── POST /admin/support/:id/comments ─────────────────────────────
router.post("/support/:id/comments", async (req, res) => {
  try {
    const { message, is_internal = false, attachments = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message required" });

    const { rows } = await query(`
      INSERT INTO help_ticket_comments (ticket_id, author_id, author_type, author_name, message, is_internal)
      VALUES ($1,$2,'admin',$3,$4,$5) RETURNING id
    `, [req.params.id, req.admin.id, req.admin.name || "Support Team", message.trim(), is_internal]);

    for (const att of attachments) {
      await query(`
        INSERT INTO help_ticket_attachments (ticket_id, comment_id, uploaded_by, uploader_type, file_name, file_url, file_size, mime_type)
        VALUES ($1,$2,$3,'admin',$4,$5,$6,$7)
      `, [req.params.id, rows[0].id, req.admin.id, att.file_name, att.file_url, att.file_size || 0, att.mime_type || "application/octet-stream"]);
    }

    await query("UPDATE help_tickets SET updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ message: "Failed to add comment: " + err.message });
  }
});

// ── PATCH /admin/support/:id/assign ──────────────────────────────
router.patch("/support/:id/assign", async (req, res) => {
  try {
    const { admin_id } = req.body;
    await query("UPDATE help_tickets SET assigned_to=$1, updated_at=NOW() WHERE id=$2", [admin_id || null, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to assign ticket: " + err.message });
  }
});


// ── Plans CRUD ────────────────────────────────────────────────
router.get("/plans", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        id::text, name::text, display_name, is_active,
        price_inr,
        COALESCE(amount_inr, price_inr)  AS amount_inr,
        COALESCE(discount_pct, 0)            AS discount_pct,
        COALESCE(offer_text, '')             AS offer_text,
        COALESCE(token_limit, 0)             AS token_limit,
        COALESCE(message_limit, 0)           AS message_limit,
        COALESCE(doc_limit, 5)               AS doc_limit,
        COALESCE(trial_days, 0)              AS trial_days,
        created_at
      FROM plans
      ORDER BY COALESCE(amount_inr, price_inr) ASC
    `);
    res.json({ plans: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load plans: " + err.message });
  }
});

router.post("/plans", async (req, res) => {
  try {
    const { name, display_name, amount_inr=0, discount_pct=0, offer_text="",
            token_limit=0, message_limit=0, doc_limit=10, trial_days=0, is_active=true } = req.body;
    if (!name || !display_name) return res.status(400).json({ message: "name and display_name are required" });
    const amt = parseInt(amount_inr) || 0;
    const { rows } = await query(`
      INSERT INTO plans (name, display_name, price_inr, amount_inr, discount_pct, offer_text,
                         token_limit, message_limit, doc_limit, trial_days, is_active, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING id::text
    `, [name, display_name, amt, amt,
        Math.min(100, Math.max(0, parseInt(discount_pct)||0)),
        offer_text||"", parseInt(token_limit)||0, parseInt(message_limit)||0,
        parseInt(doc_limit)||5, parseInt(trial_days)||0, is_active??true]);
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ message: "Failed to create plan: " + err.message });
  }
});

router.put("/plans/:id", async (req, res) => {
  try {
    const b        = req.body;
    const amtInr   = parseInt(b.amount_inr)   || 0;
    const discPct  = Math.min(100, Math.max(0, parseInt(b.discount_pct) || 0));
    const finalAmt = discPct > 0 ? Math.round(amtInr * (1 - discPct/100)) : amtInr;

    const result = await query(`
      UPDATE plans SET
        display_name  = $1,
        amount_inr    = $2,
        price_inr = $3,
        discount_pct  = $4,
        offer_text    = $5,
        token_limit   = $6,
        message_limit = $7,
        doc_limit     = $8,
        trial_days    = $9,
        is_active     = $10
      WHERE id = $11::uuid
      RETURNING id
    `, [
      String(b.display_name || ""),
      amtInr,
      finalAmt,
      discPct,
      String(b.offer_text  || ""),
      parseInt(b.token_limit)   || 0,
      parseInt(b.message_limit) || 0,
      parseInt(b.doc_limit)     || 5,
      parseInt(b.trial_days)    || 0,
      b.is_active ?? true,
      req.params.id,
    ]);

    if (!result.rows.length) return res.status(404).json({ message: "Plan not found" });
    res.json({ success: true, final_amount_inr: finalAmt });
  } catch (err) {
    console.error("Update plan error:", err.message);
    res.status(500).json({ message: "Failed to update plan: " + err.message });
  }
});

router.delete("/plans/:id", async (req, res) => {
  try {
    const { rows: subs } = await query(
      "SELECT COUNT(*) AS cnt FROM subscriptions WHERE plan_id = $1::uuid AND is_active = TRUE",
      [req.params.id]
    );
    if (parseInt(subs[0]?.cnt) > 0) {
      return res.status(400).json({ message: `Cannot delete — ${subs[0].cnt} active subscription(s) use this plan.` });
    }
    await query("UPDATE businesses   SET plan_id  = NULL WHERE plan_id  = $1::uuid", [req.params.id]).catch(()=>{});
    await query("UPDATE subscriptions SET plan_id = NULL WHERE plan_id  = $1::uuid", [req.params.id]).catch(()=>{});
    await query("DELETE FROM plans WHERE id = $1::uuid", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete plan: " + err.message });
  }
});

// ── Admin Team Management ────────────────────────────────────
router.get("/team", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, name, email, role, is_active, last_login_at, created_at,
             COALESCE(permissions, '[]'::jsonb) AS permissions
      FROM admins
      ORDER BY created_at DESC
    `);
    res.json({ admins: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load admin team: " + err.message });
  }
});

router.post("/team", async (req, res) => {
  try {
    const { name, email, password, role = "support", permissions = [] } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "Name, email and password required" });
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    const bcrypt = await import("bcrypt");
    const hash   = await bcrypt.default.hash(password, 10);

    const { rows } = await query(`
      INSERT INTO admins (name, email, password_hash, role, is_active, permissions, created_at)
      VALUES ($1, $2, $3, $4, TRUE, $5::jsonb, NOW())
      RETURNING id
    `, [name, email, hash, role, JSON.stringify(permissions)]);

    await query(`INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,'create_admin','admin',$2,$3)`,
      [req.admin.id, rows[0].id, JSON.stringify({ name, email, role })]).catch(() => {});

    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ message: "Email already exists" });
    res.status(500).json({ message: "Failed to create admin: " + err.message });
  }
});

router.put("/team/:id", async (req, res) => {
  try {
    const { role, permissions, is_active } = req.body;
    await query(`
      UPDATE admins SET role=$1, permissions=$2::jsonb, is_active=$3, updated_at=NOW()
      WHERE id=$4
    `, [role, JSON.stringify(permissions || []), is_active ?? true, req.params.id]);

    await query(`INSERT INTO admin_audit_logs (admin_id,action,target_type,target_id,details) VALUES ($1,'update_admin','admin',$2,$3)`,
      [req.admin.id, req.params.id, JSON.stringify({ role, is_active })]).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update admin: " + err.message });
  }
});

router.patch("/team/:id/toggle", async (req, res) => {
  try {
    const { is_active } = req.body;
    await query("UPDATE admins SET is_active=$1, updated_at=NOW() WHERE id=$2", [is_active, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle admin: " + err.message });
  }
});

export default router;