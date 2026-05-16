import express from "express";
import jwt     from "jsonwebtoken";
import { query } from "../db/postgres.js";

const router = express.Router();

/**
 * Owner clicks magic link from WhatsApp notification.
 * Validates token and returns conversation + auth info.
 */
router.get("/join/:token", async (req, res) => {
  try {
    const { token } = req.params;

    // Validate token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== "takeover") {
      return res.status(400).json({ message: "Invalid link" });
    }

    // Check magic link in DB
    const { rows } = await query(`
      SELECT ml.*, c.customer_name, c.customer_phone, c.status AS conv_status
      FROM magic_links ml
      JOIN conversations c ON c.id = ml.conversation_id
      WHERE ml.token = $1
        AND ml.used = FALSE
        AND ml.expires_at > NOW()
    `, [token]);

    if (!rows.length) {
      return res.status(400).json({ message: "This link has expired or already been used" });
    }

    const link = rows[0];

    // Mark link as used
    await query("UPDATE magic_links SET used = TRUE, used_at = NOW() WHERE id = $1", [link.id]);

    // Auto take over conversation
    await query(`
      UPDATE conversations SET status = 'manual', takeover_at = NOW()
      WHERE id = $1
    `, [link.conversation_id]);

    // Generate a short-lived dashboard token for this session
    const dashToken = jwt.sign(
      { businessId: link.business_id, conversationId: link.conversation_id, type: "magic_join" },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    // Redirect to dashboard with conversation open
    const redirectUrl = `${process.env.FRONTEND_URL}?conv=${link.conversation_id}&token=${dashToken}`;
    res.redirect(redirectUrl);

  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(400).json({ message: "This link has expired" });
    }
    console.error("Magic link error:", err);
    res.status(500).json({ message: "Could not process link" });
  }
});

export default router;
