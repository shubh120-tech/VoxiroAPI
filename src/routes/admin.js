import express   from "express";
import bcrypt    from "bcrypt";
import jwt       from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { adminAuthMiddleware } from "../middleware/auth.js";

const router = express.Router();

// ── Admin Login ───────────────────────────────────────────────
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

    const token = jwt.sign(
      { adminId: rows[0].id, role: rows[0].role },
      process.env.ADMIN_JWT_SECRET,
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

export default router;
