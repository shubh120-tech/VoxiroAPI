import jwt from "jsonwebtoken";
import { query } from "../db/postgres.js";

/**
 * Protect business owner routes.
 */
export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token   = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Load user + business from DB
    const { rows } = await query(`
      SELECT u.id, u.owner_name, u.email, u.role, u.business_id,
             b.name AS business_name, b.is_active
      FROM users u
      JOIN businesses b ON b.id = u.business_id
      WHERE u.id = $1 AND u.is_active = TRUE
    `, [decoded.userId]);

    if (!rows.length) {
      return res.status(401).json({ message: "User not found" });
    }

    if (!rows[0].is_active) {
      return res.status(403).json({ message: "Account deactivated" });
    }

    req.user = rows[0];
    next();
  } catch (err) {
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

    const token   = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

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
