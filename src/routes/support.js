// src/routes/support.js  — owner + team member facing support routes
import express from "express";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

const bId = req => req.user.business_id;
const uId = req => req.user.id;
const uName = req => req.user.owner_name || req.user.name || "User";

// ── GET /support/tickets ──────────────────────────────────────────
router.get("/tickets", async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let sql = `
      SELECT
        t.*,
        u.owner_name AS created_by_name,
        a.name       AS assigned_to_name,
        (SELECT COUNT(*) FROM help_ticket_comments c WHERE c.ticket_id = t.id AND c.is_internal = FALSE)::int AS comment_count,
        (SELECT COUNT(*) FROM help_ticket_attachments att WHERE att.ticket_id = t.id)::int AS attachment_count
      FROM help_tickets t
      LEFT JOIN users u  ON u.id = t.created_by
      LEFT JOIN admins a ON a.id = t.assigned_to
      WHERE t.business_id = $1
    `;
    const params = [bId(req)];
    if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await query(sql, params);
    const count = await query(
      `SELECT COUNT(*) FROM help_tickets WHERE business_id = $1${status ? ` AND status = '${status}'` : ""}`,
      [bId(req)]
    );
    res.json({ tickets: rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load tickets: " + err.message });
  }
});

// ── GET /support/tickets/:id ──────────────────────────────────────
router.get("/tickets/:id", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT t.*, u.owner_name AS created_by_name, a.name AS assigned_to_name
      FROM help_tickets t
      LEFT JOIN users u  ON u.id = t.created_by
      LEFT JOIN admins a ON a.id = t.assigned_to
      WHERE t.id = $1 AND t.business_id = $2
    `, [req.params.id, bId(req)]);
    if (!rows.length) return res.status(404).json({ message: "Ticket not found" });

    const [comments, attachments, statusLog] = await Promise.all([
      query(`SELECT * FROM help_ticket_comments WHERE ticket_id = $1 AND is_internal = FALSE ORDER BY created_at ASC`, [req.params.id]),
      query(`SELECT * FROM help_ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC`, [req.params.id]),
      query(`SELECT * FROM help_ticket_status_log WHERE ticket_id = $1 ORDER BY created_at ASC`, [req.params.id]),
    ]);

    res.json({ ticket: rows[0], comments: comments.rows, attachments: attachments.rows, statusLog: statusLog.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load ticket: " + err.message });
  }
});

// ── POST /support/tickets ─────────────────────────────────────────
router.post("/tickets", async (req, res) => {
  try {
    const { subject, description, category = "general", priority = "medium" } = req.body;
    if (!subject?.trim() || !description?.trim())
      return res.status(400).json({ message: "Subject and description are required" });

    const { rows } = await query(`
      INSERT INTO help_tickets (business_id, created_by, subject, description, category, priority, status)
      VALUES ($1,$2,$3,$4,$5,$6,'open') RETURNING id
    `, [bId(req), uId(req), subject.trim(), description.trim(), category, priority]);

    // Log status
    await query(`
      INSERT INTO help_ticket_status_log (ticket_id, changed_by, changer_type, changer_name, old_status, new_status, note)
      VALUES ($1,$2,'user',$3,NULL,'open','Ticket created')
    `, [rows[0].id, uId(req), uName(req)]);

    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ message: "Failed to create ticket: " + err.message });
  }
});

// ── POST /support/tickets/:id/comments ───────────────────────────
router.post("/tickets/:id/comments", async (req, res) => {
  try {
    const { message, attachments = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message is required" });

    // Verify ticket belongs to this business
    const { rows: t } = await query("SELECT id FROM help_tickets WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    if (!t.length) return res.status(404).json({ message: "Ticket not found" });

    const { rows } = await query(`
      INSERT INTO help_ticket_comments (ticket_id, author_id, author_type, author_name, message, is_internal)
      VALUES ($1,$2,'user',$3,$4,FALSE) RETURNING id
    `, [req.params.id, uId(req), uName(req), message.trim()]);

    // Save attachments on this comment
    for (const att of attachments) {
      await query(`
        INSERT INTO help_ticket_attachments (ticket_id, comment_id, uploaded_by, uploader_type, file_name, file_url, file_size, mime_type)
        VALUES ($1,$2,$3,'user',$4,$5,$6,$7)
      `, [req.params.id, rows[0].id, uId(req), att.file_name, att.file_url, att.file_size || 0, att.mime_type || "application/octet-stream"]);
    }

    // Update ticket updated_at
    await query("UPDATE help_tickets SET updated_at=NOW() WHERE id=$1", [req.params.id]);

    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ message: "Failed to add comment: " + err.message });
  }
});

// ── POST /support/tickets/:id/close ──────────────────────────────
router.post("/tickets/:id/close", async (req, res) => {
  try {
    const { rows: t } = await query(
      "SELECT id, status FROM help_tickets WHERE id=$1 AND business_id=$2",
      [req.params.id, bId(req)]
    );
    if (!t.length) return res.status(404).json({ message: "Ticket not found" });

    await query("UPDATE help_tickets SET status='closed', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await query(`
      INSERT INTO help_ticket_status_log (ticket_id, changed_by, changer_type, changer_name, old_status, new_status, note)
      VALUES ($1,$2,'user',$3,$4,'closed','Closed by owner')
    `, [req.params.id, uId(req), uName(req), t[0].status]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to close ticket: " + err.message });
  }
});

export default router;