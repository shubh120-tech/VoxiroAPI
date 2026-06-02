// src/routes/agentBehavior.js
// Add to server.js:
//   import agentBehaviorRouter from "./routes/agentBehavior.js";
//   app.use("/api", agentBehaviorRouter);

import express from "express";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);
const bId = (req) => req.user.business_id;

// ── GET /agent/behavior — load settings ───────────────────────
router.get("/agent/behavior", async (req, res) => {
  try {
    const [behaviorRes, teamRes] = await Promise.all([
      query(
        "SELECT * FROM agent_behavior WHERE business_id = $1",
        [bId(req)]
      ),
      query(
        "SELECT id, name, role, notify_for FROM team_members WHERE business_id = $1 AND status = 'active' ORDER BY role, name",
        [bId(req)]
      ).catch(() => ({ rows: [] })),
    ]);

    // Return defaults if no row yet
    const behavior = behaviorRes.rows[0] || {
      working_hours_mode:    "24x7",
      working_days:          ["mon","tue","wed","thu","fri","sat"],
      working_start:         "10:00",
      working_end:           "22:00",
      outside_hours_action:  "reply_closed",
      outside_hours_msg:     "We are currently closed. We will get back to you during business hours. Thank you for your patience! 🙏",
      notify_roles:          ["owner"],
      notify_phones:         [],
      notify_on_keywords:    ["refund","cancel","fraud","complaint","legal"],
      max_auto_replies:      0,
      reactivate_after_mins: 15,
      reactivate_msg:        "Hi! Our team is currently busy. Let me help you in the meantime. How can I assist you?",
      ping_owner_after_mins: 30,
      ping_owner_msg:        "Sales team has not replied in {mins} minutes. Customer {phone} is waiting. Please check.",
      daily_summary:         false,
      daily_summary_time:    "21:00",
      daily_summary_phone:   null,
    };

    res.json({ behavior, teamMembers: teamRes.rows });
  } catch (err) {
    console.error("Load behavior error:", err.message);
    res.status(500).json({ message: "Failed to load agent behavior: " + err.message });
  }
});

// ── PUT /agent/behavior — save settings ───────────────────────
router.put("/agent/behavior", async (req, res) => {
  try {
    const {
      working_hours_mode,
      working_days,
      working_start,
      working_end,
      outside_hours_action,
      outside_hours_msg,
      notify_roles,
      notify_phones,
      notify_on_keywords,
      max_auto_replies,
      reactivate_after_mins,
      reactivate_msg,
      ping_owner_after_mins,
      ping_owner_msg,
      daily_summary,
      daily_summary_time,
      daily_summary_phone,
    } = req.body;

    await query(`
      INSERT INTO agent_behavior (
        business_id, working_hours_mode, working_days, working_start, working_end,
        outside_hours_action, outside_hours_msg, notify_roles, notify_phones,
        notify_on_keywords, max_auto_replies, reactivate_after_mins, reactivate_msg,
        ping_owner_after_mins, ping_owner_msg, daily_summary, daily_summary_time,
        daily_summary_phone, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
      ON CONFLICT (business_id) DO UPDATE SET
        working_hours_mode    = $2,
        working_days          = $3,
        working_start         = $4,
        working_end           = $5,
        outside_hours_action  = $6,
        outside_hours_msg     = $7,
        notify_roles          = $8,
        notify_phones         = $9,
        notify_on_keywords    = $10,
        max_auto_replies      = $11,
        reactivate_after_mins = $12,
        reactivate_msg        = $13,
        ping_owner_after_mins = $14,
        ping_owner_msg        = $15,
        daily_summary         = $16,
        daily_summary_time    = $17,
        daily_summary_phone   = $18,
        updated_at            = NOW()
    `, [
      bId(req),
      working_hours_mode    || "24x7",
      JSON.stringify(working_days    || ["mon","tue","wed","thu","fri","sat"]),
      working_start         || "10:00",
      working_end           || "22:00",
      outside_hours_action  || "reply_closed",
      outside_hours_msg     || "",
      JSON.stringify(notify_roles    || ["owner"]),
      JSON.stringify(notify_phones   || []),
      JSON.stringify(notify_on_keywords || []),
      max_auto_replies      ?? 0,
      reactivate_after_mins ?? 15,
      reactivate_msg        || "",
      ping_owner_after_mins ?? 30,
      ping_owner_msg        || "",
      daily_summary         ?? false,
      daily_summary_time    || "21:00",
      daily_summary_phone   || null,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("Save behavior error:", err.message);
    res.status(500).json({ message: "Failed to save: " + err.message });
  }
});

// ── PUT /team/:id/notify — update team member notify_for ──────
router.put("/team/:id/notify", async (req, res) => {
  try {
    const { notify_for } = req.body;
    await query(`
      UPDATE team_members SET notify_for = $1, updated_at = NOW()
      WHERE id = $2 AND business_id = $3
    `, [JSON.stringify(notify_for || []), req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update notify settings" });
  }
});

export default router;