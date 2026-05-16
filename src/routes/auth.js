import express   from "express";
import bcrypt    from "bcrypt";
import jwt       from "jsonwebtoken";
import { query } from "../db/postgres.js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// ── Signup ────────────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { businessName, ownerName, email, password } = req.body;
    if (!businessName || !ownerName || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Check email not already used
    const { rows: existing } = await query(
      "SELECT id FROM users WHERE email = $1", [email]
    );
    if (existing.length) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Transaction — create business + user + defaults
    const client = await (await import("../db/postgres.js")).getClient();
    try {
      await client.query("BEGIN");

      // 1. Create business
      const { rows: bizRows } = await client.query(`
        INSERT INTO businesses (name) VALUES ($1) RETURNING id
      `, [businessName]);
      const businessId = bizRows[0].id;

      // 2. Create user
      const { rows: userRows } = await client.query(`
        INSERT INTO users (business_id, owner_name, email, password_hash)
        VALUES ($1, $2, $3, $4) RETURNING id
      `, [businessId, ownerName, email, passwordHash]);
      const userId = userRows[0].id;

      // 3. Seed starter plan subscription
      const { rows: planRows } = await client.query(
        "SELECT id FROM plans WHERE name = 'starter'"
      );
      await client.query(`
        INSERT INTO subscriptions (business_id, plan_id)
        VALUES ($1, $2)
      `, [businessId, planRows[0].id]);

      // 4. Seed default agent config
      await client.query(`
        INSERT INTO agent_configs (business_id, agent_name) VALUES ($1, 'Aria')
      `, [businessId]);

      // 5. Seed default notification settings
      await client.query(`
        INSERT INTO notification_settings (business_id) VALUES ($1)
      `, [businessId]);

      await client.query("COMMIT");

      const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });

      res.status(201).json({
        token,
        user: { id: userId, businessId, businessName, ownerName, email, onboarded: false },
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
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const { rows } = await query(`
      SELECT u.id, u.password_hash, u.owner_name, u.business_id, u.is_active,
             b.name AS business_name, b.onboarded
      FROM users u JOIN businesses b ON b.id = u.business_id
      WHERE u.email = $1
    `, [email]);

    if (!rows.length) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = rows[0];
    if (!user.is_active) {
      return res.status(403).json({ message: "Account deactivated" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Update last login
    await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({
      token,
      user: {
        id:           user.id,
        businessId:   user.business_id,
        businessName: user.business_name,
        ownerName:    user.owner_name,
        email,
        onboarded:    user.onboarded,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
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

export default router;
