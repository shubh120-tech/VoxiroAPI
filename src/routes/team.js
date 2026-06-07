import express  from "express";
import bcrypt   from "bcryptjs";
import jwt      from "jsonwebtoken";
import crypto   from "crypto";
import axios    from "axios";
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
      SELECT tm.id, tm.name, tm.email, tm.role, tm.invite_expires_at, tm.status,
             b.name AS business_name
      FROM team_members tm
      JOIN businesses b ON b.id = tm.business_id
      WHERE tm.invite_token = $1
    `, [req.params.token]);

    if (!rows.length) {
      return res.status(200).json({ valid: false, message: "Invalid invite link. Please ask the owner to resend your invitation." });
    }
    if (rows[0].status !== "pending") {
      return res.status(200).json({ valid: false, message: `Invite already used or account is ${rows[0].status}. Try logging in instead.` });
    }

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

    // Parse permissions if string
    let permissions = member.permissions || {};
    if (typeof permissions === "string") {
      try { permissions = JSON.parse(permissions); } catch { permissions = {}; }
    }

    const token = jwt.sign(
      {
        id:          member.id,
        business_id: member.business_id,
        email:       member.email,
        role:        member.role,
        permissions,
        type:        "team_member",
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      token,
      user: {
        id:           member.id,
        email:        member.email,
        name:         member.name,
        businessId:   member.business_id,
        businessName: member.business_name,
        role:         member.role,
        permissions,
        type:         "team_member",
      },
    });

  } catch (err) {
    res.status(500).json({ message: "Login failed" });
  }
});

// ── Default permissions per role ──────────────────────────────
export const ROLE_PERMISSIONS = {
  owner: {
    conversations:    ["view", "reply", "delete", "assign"],
    leads:            ["view", "edit", "delete", "export"],
    orders:           ["view", "edit", "delete"],
    settings:         ["view", "edit"],
    broadcast:        ["view", "create", "send", "delete"],
    knowledge:        ["view", "edit", "delete"],
    knowledge_upload: ["view", "upload", "delete"],
    agent_training:   ["view", "edit"],
    products:         ["view", "edit", "delete"],
    integrations:     ["view", "edit"],
    team:             ["view", "add", "edit", "remove"],
    analytics:        ["view", "export"],
  },
  manager: {
    conversations:    ["view", "reply", "delete", "assign"],
    leads:            ["view", "edit", "delete", "export"],
    orders:           ["view", "edit"],
    settings:         ["view"],
    broadcast:        ["view", "create", "send"],
    knowledge:        ["view", "edit"],
    knowledge_upload: [],
    agent_training:   [],
    products:         ["view"],
    integrations:     [],
    team:             ["view"],
    analytics:        ["view"],
  },
  agent: {
    conversations:    ["view", "reply"],
    leads:            ["view", "edit"],
    orders:           ["view"],
    settings:         [],
    broadcast:        [],
    knowledge:        [],
    knowledge_upload: [],
    agent_training:   [],
    products:         [],
    integrations:     [],
    team:             [],
    analytics:        [],
  },
  viewer: {
    conversations:    ["view"],
    leads:            ["view"],
    orders:           ["view"],
    settings:         [],
    broadcast:        ["view"],
    knowledge:        ["view"],
    knowledge_upload: [],
    agent_training:   [],
    products:         ["view"],
    integrations:     [],
    team:             [],
    analytics:        ["view"],
  },
};

// ── Send invite email via Resend HTTP API ─────────────────────
async function sendInviteEmail({ name, email, businessName, inviteToken, inviterName }) {
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const inviteLink  = `${frontendUrl}/accept-invite/${inviteToken}`;
  const apiKey      = process.env.RESEND_API_KEY;
  const fromEmail   = process.env.FROM_EMAIL || "onboarding@resend.dev";

  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const finalFromEmail = fromEmail.includes("resend.dev") ? fromEmail :
    (process.env.RESEND_DOMAIN_VERIFIED === "true" ? fromEmail : "onboarding@resend.dev");

  await axios.post(
    "https://api.resend.com/emails",
    {
      from:    `${businessName} via Yougant <${finalFromEmail}>`,
      to:      [email],
      subject: `You've been invited to join ${businessName} on Yougant`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #0d9488; font-size: 28px; margin: 0;">🤖 Yougant</h1>
          </div>
          <h2 style="color: #1a1a1a;">You're invited to join ${businessName}</h2>
          <p style="color: #374151;">Hi ${name},</p>
          <p style="color: #374151;">${inviterName} has invited you to join <strong>${businessName}</strong> on Yougant — the AI WhatsApp agent platform.</p>
          <p style="color: #374151;">Click the button below to accept the invitation and set your password:</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${inviteLink}" style="display: inline-block; background: #0d9488; color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 16px;">
              Accept Invitation →
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
            This link expires in 48 hours. If you didn't expect this invite, you can ignore this email.
          </p>
          <p style="color: #9ca3af; font-size: 12px;">Or copy this link: ${inviteLink}</p>
        </div>
      `,
    },
    {
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  console.log(`✅ Invite email sent via Resend to ${email}`);
}

// ══════════════════════════════════════════════════════════════
//  TEAM ROUTES (protected)
// ══════════════════════════════════════════════════════════════
router.use("/team", authMiddleware);

// Get all team members
router.get("/team", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, name, email, role, permissions, conversation_access,
             whatsapp_number, status, last_login_at, created_at, invite_expires_at
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
    const { name, email, role, permissions, conversation_access, whatsapp_number } = req.body;

    if (!name || !email) return res.status(400).json({ message: "Name and email required" });
    if (!role)           return res.status(400).json({ message: "Role is required" });
    if (!["manager", "agent", "viewer", "custom"].includes(role)) {
      return res.status(400).json({ message: `Invalid role: ${role}` });
    }

    const { rows: existing } = await query(
      "SELECT id FROM team_members WHERE business_id = $1 AND email = $2",
      [bId(req), email]
    );
    if (existing.length) return res.status(400).json({ message: "Team member with this email already exists" });

    const finalPermissions = role === "custom"
      ? (permissions || {})
      : ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.agent;

    const inviteToken   = crypto.randomBytes(32).toString("hex");
    const inviteExpires = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const { rows } = await query(`
      INSERT INTO team_members
        (business_id, name, email, role, permissions, conversation_access,
         whatsapp_number, status, invite_token, invite_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
      RETURNING id, name, email, role, status, created_at
    `, [
      bId(req), name, email, role,
      JSON.stringify(finalPermissions),
      conversation_access || "all",
      whatsapp_number     || null,
      inviteToken,
      inviteExpires,
    ]);

    // Get business + inviter details for email
    const { rows: bizRows } = await query("SELECT name FROM businesses WHERE id = $1", [bId(req)]);
    const { rows: inviterRows } = await query(
      "SELECT owner_name AS name FROM users WHERE id = $1",
      [req.user.id]
    ).catch(() => ({ rows: [] }));

    const businessName = bizRows[0]?.name    || "the business";
    const inviterName  = inviterRows[0]?.name || "The owner";

    try {
      await sendInviteEmail({ name, email, businessName, inviteToken, inviterName });
    } catch (emailErr) {
      console.error("Email send error:", emailErr.message);
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

// Update team member role/permissions/whatsapp
router.put("/team/:id", async (req, res) => {
  try {
    const { role, permissions, status, conversation_access, whatsapp_number } = req.body;

    // Always save permissions exactly as sent — don't override with role defaults
    const finalPermissions = permissions || {};

    const { rows } = await query(`
      UPDATE team_members
      SET role                = COALESCE($1, role),
          permissions         = $2,
          conversation_access = COALESCE($3, conversation_access),
          whatsapp_number     = $4,
          status              = COALESCE($5, status),
          updated_at          = NOW()
      WHERE id = $6 AND business_id = $7
      RETURNING id, name, email, role, permissions, conversation_access, whatsapp_number, status
    `, [
      role                || null,
      JSON.stringify(finalPermissions),
      conversation_access || null,
      whatsapp_number     !== undefined ? (whatsapp_number || null) : undefined,
      status              || null,
      req.params.id,
      bId(req),
    ]);

    if (!rows.length) return res.status(404).json({ message: "Member not found" });

    console.log(`✅ Updated ${rows[0].name}: role=${rows[0].role}, wa=${rows[0].whatsapp_number}`);
    res.json({ success: true, member: rows[0] });
  } catch (err) {
    console.error("Update team member error:", err.message);
    res.status(500).json({ message: "Failed to update member: " + err.message });
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