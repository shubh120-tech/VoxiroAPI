import express   from "express";
import bcrypt    from "bcrypt";
import jwt       from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// ── Signup ────────────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { ownerName, email, password } = req.body;

    if (!ownerName || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // ✅ AUTO GENERATE BUSINESS NAME (FIX)
    const finalBusinessName = ownerName
      ? `${ownerName.split(" ")[0]}'s Business`
      : "My Business";

    // Check email not already used
    const { rows: existing } = await query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existing.length) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const client = await (await import("../db/postgres.js")).getClient();

    try {
      await client.query("BEGIN");

      // 1. Create business (FIX APPLIED HERE)
      const { rows: bizRows } = await client.query(
        `INSERT INTO businesses (name) VALUES ($1) RETURNING id`,
        [finalBusinessName]
      );

      const businessId = bizRows[0].id;

      // 2. Create user
      const { rows: userRows } = await client.query(
        `INSERT INTO users (business_id, owner_name, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [businessId, ownerName, email, passwordHash]
      );

      const userId = userRows[0].id;

      // 3. Seed starter plan
      const { rows: planRows } = await client.query(
        "SELECT id FROM plans WHERE name = 'starter'"
      );

      await client.query(
        `INSERT INTO subscriptions (business_id, plan_id)
         VALUES ($1, $2)`,
        [businessId, planRows[0].id]
      );

      // 4. Agent config
      await client.query(
        `INSERT INTO agent_configs (business_id, agent_name)
         VALUES ($1, 'Aria')`,
        [businessId]
      );

      // 5. Notification settings
      await client.query(
        `INSERT INTO notification_settings (business_id)
         VALUES ($1)`,
        [businessId]
      );

      await client.query("COMMIT");

      const token = jwt.sign(
        { userId },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      // ✅ FIX: RETURN BUSINESS NAME PROPERLY
      res.status(201).json({
        token,
        user: {
          id: userId,
          businessId,
          businessName: finalBusinessName,
          ownerName,
          email,
          onboarded: false,
        },
      });

    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ message: "Could not create account" });
  }
});
// ── Login ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
//  PATCH FOR src/routes/auth.js
//  Find your existing POST /login route and REPLACE it with this
// ═══════════════════════════════════════════════════════════

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // ── Step 1: Check owners table (users) ───────────────────
    const { rows: ownerRows } = await query(
      "SELECT * FROM users WHERE email = $1 AND is_active = TRUE LIMIT 1",
      [email]
    );

    if (ownerRows.length) {
      const owner = ownerRows[0];
      const valid = await bcrypt.compare(password, owner.password_hash);
      if (!valid) return res.status(401).json({ message: "Invalid email or password" });

      await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [owner.id]);

      const token = jwt.sign(
        {
          id:          owner.id,
          business_id: owner.business_id,
          email:       owner.email,
          owner_name:  owner.owner_name,
          role:        "owner",
          type:        "owner",
        },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );

      return res.json({
        token,
        user: {
          id:           owner.id,
          email:        owner.email,
          name:         owner.owner_name,
          businessId:   owner.business_id,
          role:         "owner",
          type:         "owner",
        },
      });
    }

    // ── Step 2: Not an owner — check team_members ────────────
    const { rows: memberRows } = await query(`
      SELECT tm.*, b.name AS business_name
      FROM team_members tm
      JOIN businesses b ON b.id = tm.business_id
      WHERE tm.email = $1
        AND tm.status = 'active'
      LIMIT 1
    `, [email]);

    if (!memberRows.length) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const member = memberRows[0];
    const valid  = await bcrypt.compare(password, member.password_hash);
    if (!valid) return res.status(401).json({ message: "Invalid email or password" });

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

    // Parse permissions if stored as JSON string in DB
    let permissions = member.permissions || {};
    if (typeof permissions === "string") {
      try { permissions = JSON.parse(permissions); } catch { permissions = {}; }
    }

    return res.json({
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
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Login failed" });
  }
});

// ── Forgot Password ───────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });

    const { rows } = await query("SELECT id FROM users WHERE email = $1", [email]);
    // Always return 200 — don't reveal if email exists
    if (!rows.length) return res.json({ message: "If this email exists, a reset link has been sent" });

    const token = uuidv4();
    await query(`
      INSERT INTO password_reset_tokens (user_id, token)
      VALUES ($1, $2)
    `, [rows[0].id, token]);

    // TODO: Send email with reset link
    // await sendResetEmail(email, token);
    console.log(`Password reset token for ${email}: ${token}`);

    res.json({ message: "If this email exists, a reset link has been sent" });
  } catch (err) {
    res.status(500).json({ message: "Could not process request" });
  }
});

// ── Reset Password ────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ message: "Token and password required" });

    const { rows } = await query(`
      SELECT user_id FROM password_reset_tokens
      WHERE token = $1 AND used = FALSE AND expires_at > NOW()
    `, [token]);

    if (!rows.length) return res.status(400).json({ message: "Invalid or expired reset link" });

    const hash = await bcrypt.hash(password, 10);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, rows[0].user_id]);
    await query("UPDATE password_reset_tokens SET used = TRUE WHERE token = $1", [token]);

    res.json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ message: "Could not reset password" });
  }
});

router.post("/auth/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });
 
    // Check user exists
    const { rows } = await query(
      "SELECT id, owner_name FROM users WHERE email = $1 AND is_active = TRUE LIMIT 1",
      [email]
    );
    if (!rows.length) return res.status(404).json({ message: "Account not found" });
 
    const user = rows[0];
 
    // Generate 6-digit OTP
    const otp     = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
 
    // Save OTP to DB
    await query(`
      INSERT INTO email_otps (user_id, email, otp, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET
        otp        = $3,
        expires_at = $4,
        attempts   = 0,
        used       = FALSE,
        created_at = NOW()
    `, [user.id, email, otp, expires]);
 
    // Send email via Resend
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("RESEND_API_KEY not set — OTP not sent, here it is for dev:", otp);
      // In dev: return OTP in response so you can test
      if (process.env.NODE_ENV !== "production") {
        return res.json({ success: true, dev_otp: otp, message: "OTP logged (dev mode)" });
      }
      return res.status(503).json({ message: "Email service not configured" });
    }
 
    const axios = (await import("axios")).default;
    await axios.post(
      "https://api.resend.com/emails",
      {
        from:    `Yougant <onboarding@resend.dev>`,
        to:      [email],
        subject: `${otp} — Your Yougant verification code`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #f8fafc; border-radius: 16px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #0d9488; font-size: 24px; margin: 0;">Yougant</h1>
              <p style="color: #6b7280; font-size: 13px; margin-top: 4px;">AI WhatsApp Agent Platform</p>
            </div>
            <div style="background: white; border-radius: 12px; padding: 28px; border: 1px solid #e5e7eb;">
              <p style="color: #374151; font-size: 15px; margin: 0 0 20px;">Hi ${user.owner_name || "there"},</p>
              <p style="color: #374151; font-size: 14px; margin: 0 0 24px;">Use this code to verify your email address:</p>
              <div style="text-align: center; margin: 24px 0;">
                <div style="display: inline-block; background: #f0fdfa; border: 2px solid #0d9488; border-radius: 12px; padding: 16px 32px;">
                  <span style="font-size: 36px; font-weight: 900; color: #0d9488; letter-spacing: 8px;">${otp}</span>
                </div>
              </div>
              <p style="color: #6b7280; font-size: 13px; text-align: center; margin: 0;">This code expires in <strong>10 minutes</strong></p>
            </div>
            <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 20px;">
              If you didn't create a Yougant account, you can ignore this email.
            </p>
          </div>
        `,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
 
    console.log(`📧 OTP sent to ${email}`);
    res.json({ success: true, message: "OTP sent to your email" });
 
  } catch (err) {
    console.error("Send OTP error:", err.message);
    res.status(500).json({ message: "Failed to send OTP: " + err.message });
  }
});
 
 
// ── Verify Email OTP ──────────────────────────────────────────
// Called from VerifyEmail.jsx with the 6-digit code
router.post("/auth/verify-email", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP required" });
 
    // Get OTP record
    const { rows } = await query(
      "SELECT * FROM email_otps WHERE email = $1 AND used = FALSE ORDER BY created_at DESC LIMIT 1",
      [email]
    );
 
    if (!rows.length) {
      return res.status(400).json({ message: "OTP not found. Please request a new one." });
    }
 
    const record = rows[0];
 
    // Check expiry
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }
 
    // Check attempts (max 5)
    if (record.attempts >= 5) {
      return res.status(400).json({ message: "Too many attempts. Please request a new OTP." });
    }
 
    // Check OTP match
    if (record.otp !== otp.toString()) {
      await query(
        "UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1",
        [record.id]
      );
      const left = 4 - record.attempts;
      return res.status(400).json({ message: `Incorrect OTP. ${left} attempt${left !== 1 ? "s" : ""} remaining.` });
    }
 
    // ✅ OTP correct — mark used and verify user
    await query("UPDATE email_otps SET used = TRUE WHERE id = $1", [record.id]);
    await query(
      "UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1",
      [record.user_id]
    );
 
    // Return a fresh JWT so user is logged in right after verification
    const { rows: userRows } = await query(`
      SELECT u.*, b.name AS business_name
      FROM users u
      JOIN businesses b ON b.id = u.business_id
      WHERE u.id = $1
    `, [record.user_id]);
 
    const user = userRows[0];
 
    const jwt   = (await import("jsonwebtoken")).default;
    const token = jwt.sign(
      {
        id:          user.id,
        business_id: user.business_id,
        email:       user.email,
        role:        "owner",
        type:        "owner",
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
 
    console.log(`✅ Email verified for ${email}`);
    res.json({
      success: true,
      token,
      user: {
        id:           user.id,
        email:        user.email,
        name:         user.owner_name,
        businessId:   user.business_id,
        businessName: user.business_name,
        role:         "owner",
        type:         "owner",
      },
    });
 
  } catch (err) {
    console.error("Verify OTP error:", err.message);
    res.status(500).json({ message: "Verification failed: " + err.message });
  }
});
 

export default router;
