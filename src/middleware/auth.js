import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";

/**
 * Protect business owner + team member routes.
 * Supports both owners (users table) and team members (team_members table).
 */
export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token   = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // FIX 1: JWT is signed with `id` not `userId`
    const userId = decoded.id || decoded.userId;
    const type   = decoded.type || "owner";

    if (type === "team_member") {
      // ── Team member — look up in team_members table ────────
      const { rows } = await query(`
        SELECT tm.id, tm.name AS owner_name, tm.email, tm.role,
               tm.business_id, tm.permissions, tm.status,
               b.name AS business_name, b.is_active
        FROM team_members tm
        JOIN businesses b ON b.id = tm.business_id
        WHERE tm.id = $1 AND tm.status = 'active'
      `, [userId]);

      if (!rows.length) {
        return res.status(401).json({ message: "Team member not found or inactive" });
      }
      if (!rows[0].is_active) {
        return res.status(403).json({ message: "Business account deactivated" });
      }

      req.user = { ...rows[0], type: "team_member" };
      return next();
    }

    // ── Owner — look up in users table ────────────────────────
    const { rows } = await query(`
      SELECT u.id, u.owner_name, u.email, u.role, u.business_id,
             b.name AS business_name, b.is_active
      FROM users u
      JOIN businesses b ON b.id = u.business_id
      WHERE u.id = $1 AND u.is_active = TRUE
    `, [userId]);

    if (!rows.length) {
      return res.status(401).json({ message: "User not found" });
    }
    if (!rows[0].is_active) {
      return res.status(403).json({ message: "Account deactivated" });
    }

    req.user = { ...rows[0], type: "owner" };
    next();

  } catch (err) {
    console.error("Auth middleware error:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

/**
 * Protect admin routes.
 */
export async function adminAuthMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ message: "ADMIN_JWT_SECRET not configured" });
    }

    const token   = header.split(" ")[1];
    const decoded = jwt.verify(token, secret);

    const { rows } = await query(
      "SELECT id, name, email, role FROM admins WHERE id = $1 AND is_active = TRUE",
      [decoded.adminId]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Admin not found" });
    }

    req.admin = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired admin token" });
  }
}