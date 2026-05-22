import express  from "express";
import bcrypt   from "bcryptjs";
import jwt      from "jsonwebtoken";
import crypto   from "crypto";
import nodemailer from "nodemailer";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

const bId = (req) => req.user.business_id;

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — No auth required
// ══════════════════════════════════════════════════════════════

// Validate invite token
router.get("/invite/:token", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT tm.id, tm.name, tm.email, tm.role, tm.invite_expires_at,
             b.name AS business_name
      FROM team_members tm
      JOIN businesses b ON b.id = tm.business_id
      WHERE tm.invite_token = $1
        AND tm.status = 'pending'
    `, [req.params.token]);

    if (!rows.length) return res.status(404).json({ message: "Invalid or expired invite link" });

    const member = rows[0];
    if (new Date(member.invite_expires_at) < new Date()) {
      return res.status(400).json({ message: "Invite link has expired. Ask the owner to resend." });
    }

    res.json({
      name:         member.name,
      email:        member.email,
      role:         member.role,
      businessName: member.business_name,
      valid:        true,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to validate invite" });
  }
});

// Accept invite — set password
router.post("/invite/:token/accept", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const { rows } = await query(`
      SELECT tm.*, b.id AS bid, b.name AS business_name
      FROM team_members tm
      JOIN businesses b ON b.id = tm.business_id
      WHERE tm.invite_token = $1 AND tm.status = 'pending'
    `, [req.params.token]);

    if (!rows.length) return res.status(404).json({ message: "Invalid or expired invite" });

    const member = rows[0];
    if (new Date(member.invite_expires_at) < new Date()) {
      return res.status(400).json({ message: "Invite expired. Ask the owner to resend." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await query(`
      UPDATE team_members
      SET password_hash = $1, status = 'active', invite_token = NULL, updated_at = NOW()
      WHERE id = $2
    `, [passwordHash, member.id]);

    const token = jwt.sign(
      {
        id:          member.id,
        business_id: member.business_id,
        email:       member.email,
        role:        member.role,
        permissions: member.permissions,
        type:        "team_member",
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      success:      true,
      token,
      name:         member.name,
      role:         member.role,
      businessName: member.business_name,
      permissions:  member.permissions,
    });

  } catch (err) {
    console.error("Accept invite error:", err.message);
    res.status(500).json({ message: "Failed to accept invite" });
  }
});

// Team member login
router.post("/team/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const { rows } = await query(`
      SELECT tm.*, b.name AS business_name
      FROM team_members tm
      JOIN businesses b ON b.id = tm.business_id
      WHERE tm.email = $1 AND tm.status = 'active'
      LIMIT 1
    `, [email]);

    if (!rows.length) return res.status(401).json({ message: "Invalid credentials" });

    const member = rows[0];
    const valid  = await bcrypt.compare(password, member.password_hash || "");
    if (!valid) return res.status(401).json({ message: "Invalid credentials" });

    await query("UPDATE team_members SET last_login_at = NOW() WHERE id = $1", [member.id]);

    const token = jwt.sign(
      {
        id:          member.id,
        business_id: member.business_id,
        email:       member.email,
        role:        member.role,
        permissions: member.permissions,
        type:        "team_member",
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, name: member.name, email: member.email, role: member.role, permissions: member.permissions, businessName: member.business_name });

  } catch (err) {
    res.status(500).json({ message: "Login failed" });
  }
});

// ── Default permissions per role ──────────────────────────────
export const ROLE_PERMISSIONS = {
  owner: {
    conversations: ["view", "reply", "delete", "assign"],
    leads:         ["view", "edit", "delete", "export"],
    orders:        ["view", "edit", "delete"],
    settings:      ["view", "edit"],
    broadcast:     ["view", "create", "send", "delete"],
    knowledge:     ["view", "edit", "delete"],
    team:          ["view", "add", "edit", "remove"],
    analytics:     ["view", "export"],
  },
  manager: {
    conversations: ["view", "reply", "delete", "assign"],
    leads:         ["view", "edit", "delete", "export"],
    orders:        ["view", "edit"],
    settings:      ["view"],
    broadcast:     ["view", "create", "send"],
    knowledge:     ["view", "edit"],
    team:          ["view"],
    analytics:     ["view"],
  },
  agent: {
    conversations: ["view", "reply"],
    leads:         ["view", "edit"],
    orders:        ["view"],
    settings:      [],
    broadcast:     [],
    knowledge:     ["view"],
    team:          [],
    analytics:     [],
  },
  viewer: {
    conversations: ["view"],
    leads:         ["view"],
    orders:        ["view"],
    settings:      [],
    broadcast:     ["view"],
    knowledge:     ["view"],
    team:          [],
    analytics:     ["view"],
  },
};

// ── Send invite email ─────────────────────────────────────────
async function sendInviteEmail({ name, email, businessName, inviteToken, inviterName }) {
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const inviteLink  = `${frontendUrl}/accept-invite/${inviteToken}`;

  // Use nodemailer with SMTP settings
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || "smtp.gmail.com",
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from:    `"${businessName} via Voxiro" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `You've been invited to join ${businessName} on Voxiro`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <h2 style="color: #0d9488;">You're invited to join ${businessName}</h2>
        <p>Hi ${name},</p>
        <p>${inviterName} has invited you to join <strong>${businessName}</strong> on Voxiro — the AI WhatsApp agent platform.</p>
        <p>Click the button below to accept the invitation and set your password:</p>
        <a href="${inviteLink}" style="display: inline-block; background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 16px 0;">
          Accept Invitation
        </a>
        <p style="color: #6b7280; font-size: 13px;">This link expires in 48 hours. If you didn't expect this invite, you can ignore this email.</p>
      </div>
    `,
  });
}

// ══════════════════════════════════════════════════════════════
//  TEAM ROUTES (protected)
// ══════════════════════════════════════════════════════════════
router.use("/team", authMiddleware);

// Get all team members
router.get("/team", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, name, email, role, permissions, status,
             last_login_at, created_at, invite_expires_at
      FROM team_members
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [bId(req)]);
    res.json({ members: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load team" });
  }
});

// Invite team member
router.post("/team/invite", async (req, res) => {
  try {
    const { name, email, role, permissions, conversation_access } = req.body;

    console.log("Invite request:", { name, email, role, businessId: bId(req) });

    if (!name || !email) return res.status(400).json({ message: "Name and email required" });
    if (!role) return res.status(400).json({ message: "Role is required" });
    if (!["manager", "agent", "viewer", "custom"].includes(role)) {
      return res.status(400).json({ message: `Invalid role: ${role}. Must be manager, agent, viewer, or custom` });
    }

    // Check if already exists
    const { rows: existing } = await query(
      "SELECT id FROM team_members WHERE business_id = $1 AND email = $2",
      [bId(req), email]
    );
    if (existing.length) return res.status(400).json({ message: "Team member with this email already exists" });

    // Build permissions — use role defaults or custom
    const finalPermissions = role === "custom"
      ? (permissions || {})
      : ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.agent;

    // Generate invite token
    const inviteToken   = crypto.randomBytes(32).toString("hex");
    const inviteExpires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    const { rows } = await query(`
      INSERT INTO team_members
        (business_id, name, email, role, permissions, status,
         invite_token, invite_expires_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
      RETURNING id, name, email, role, status, created_at
    `, [
      bId(req), name, email, role,
      JSON.stringify(finalPermissions),
      inviteToken, inviteExpires,
    ]);

    // Get business + inviter details for email
    const { rows: bizRows } = await query(
      "SELECT name FROM businesses WHERE id = $1",
      [bId(req)]
    );
    const { rows: inviterRows } = await query(
      "SELECT name FROM team_members WHERE id = $1 UNION SELECT name FROM businesses WHERE id = $1",
      [req.user.id]
    );

    const businessName = bizRows[0]?.name || "the business";
    const inviterName  = inviterRows[0]?.name || "The owner";

    // Send invite email
    try {
      await sendInviteEmail({ name, email, businessName, inviteToken, inviterName });
      console.log(`✅ Invite sent to ${email}`);
    } catch (emailErr) {
      console.error("Email send error:", emailErr.message);
      // Don't fail the request — still save the member
    }

    res.status(201).json({
      ...rows[0],
      inviteLink: `${process.env.FRONTEND_URL}/accept-invite/${inviteToken}`,
      message: `Invitation sent to ${email}`,
    });

  } catch (err) {
    console.error("Invite error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Update team member role/permissions
router.put("/team/:id", async (req, res) => {
  try {
    const { role, permissions, status } = req.body;

    const finalPermissions = role === "custom"
      ? (permissions || {})
      : ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.agent;

    const { rows } = await query(`
      UPDATE team_members
      SET role        = COALESCE($1, role),
          permissions = COALESCE($2, permissions),
          status      = COALESCE($3, status),
          updated_at  = NOW()
      WHERE id = $4 AND business_id = $5
      RETURNING id, name, email, role, permissions, status
    `, [role, JSON.stringify(finalPermissions), status, req.params.id, bId(req)]);

    if (!rows.length) return res.status(404).json({ message: "Member not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to update member" });
  }
});

// Revoke access (suspend)
router.patch("/team/:id/revoke", async (req, res) => {
  try {
    await query(
      "UPDATE team_members SET status = 'suspended', updated_at = NOW() WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to revoke access" });
  }
});

// Restore access
router.patch("/team/:id/restore", async (req, res) => {
  try {
    await query(
      "UPDATE team_members SET status = 'active', updated_at = NOW() WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to restore access" });
  }
});

// Resend invite
router.post("/team/:id/resend-invite", async (req, res) => {
  try {
    const inviteToken   = crypto.randomBytes(32).toString("hex");
    const inviteExpires = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const { rows } = await query(`
      UPDATE team_members
      SET invite_token = $1, invite_expires_at = $2, status = 'pending', updated_at = NOW()
      WHERE id = $3 AND business_id = $4
      RETURNING name, email
    `, [inviteToken, inviteExpires, req.params.id, bId(req)]);

    if (!rows.length) return res.status(404).json({ message: "Member not found" });

    const { rows: bizRows } = await query("SELECT name FROM businesses WHERE id = $1", [bId(req)]);
    const businessName = bizRows[0]?.name || "the business";

    try {
      await sendInviteEmail({ name: rows[0].name, email: rows[0].email, businessName, inviteToken, inviterName: "The owner" });
    } catch (emailErr) {
      console.error("Resend email error:", emailErr.message);
    }

    res.json({
      success: true,
      inviteLink: `${process.env.FRONTEND_URL}/accept-invite/${inviteToken}`,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to resend invite" });
  }
});

// Remove team member
router.delete("/team/:id", async (req, res) => {
  try {
    await query(
      "DELETE FROM team_members WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove member" });
  }
});



export default router;