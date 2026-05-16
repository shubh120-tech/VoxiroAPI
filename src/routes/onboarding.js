import express from "express";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

// Complete onboarding — mark business as onboarded
router.post("/onboarding/complete", async (req, res) => {
  try {
    await query("UPDATE businesses SET onboarded = TRUE WHERE id = $1", [req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to complete onboarding" });
  }
});

export default router;
