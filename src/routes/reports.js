import express        from "express";
import { query }      from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import { analyzeConversations } from "../agents/insightsAgent.js";

const router = express.Router();
router.use(authMiddleware);

const bId = req => req.user.business_id;

// ── Check premium access ──────────────────────────────────────
async function isPremium(businessId) {
  const { rows } = await query(
    "SELECT plan_id FROM businesses WHERE id = $1",
    [businessId]
  );
  // For now allow all — gate later when billing is set up
  return true;
}

// ── GET /reports/insights — latest insights ───────────────────
router.get("/reports/insights", async (req, res) => {
  try {
    const premium = await isPremium(bId(req));
    if (!premium) {
      return res.json({ premium: false });
    }

    // Get latest run
    const { rows: runs } = await query(`
      SELECT * FROM insight_runs
      WHERE business_id = $1
      ORDER BY created_at DESC LIMIT 1
    `, [bId(req)]);

    // Get latest insights by type
    const { rows: insights } = await query(`
      SELECT DISTINCT ON (type) type, data, created_at
      FROM insights
      WHERE business_id = $1
      ORDER BY type, created_at DESC
    `, [bId(req)]);

    // Get basic stats (always available)
    const { rows: stats } = await query(`
      SELECT
        COUNT(DISTINCT c.id)                                    AS total_conversations,
        COUNT(DISTINCT l.id)                                    AS total_leads,
        COUNT(DISTINCT CASE WHEN l.status='converted' THEN l.id END) AS converted_leads,
        COUNT(DISTINCT o.id)                                    AS total_orders
      FROM conversations c
      LEFT JOIN leads l ON l.business_id = c.business_id
      LEFT JOIN orders o ON o.business_id = c.business_id
      WHERE c.business_id = $1
    `, [bId(req)]);

    // Get re-engagement stats
    const { rows: reStats } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE re_engagement_status = 'sent')      AS sent,
        COUNT(*) FILTER (WHERE re_engagement_status = 'replied')   AS replied,
        COUNT(*) FILTER (WHERE re_engagement_status = 'converted') AS converted
      FROM leads WHERE business_id = $1
    `, [bId(req)]);

    const insightMap = {};
    insights.forEach(i => { insightMap[i.type] = i.data; });

    res.json({
      premium:        true,
      last_run:       runs[0] || null,
      insights:       insightMap,
      stats:          stats[0],
      re_engagement:  reStats[0],
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /reports/analyze — trigger fresh analysis ────────────
router.post("/reports/analyze", async (req, res) => {
  try {
    const businessId = bId(req);
    const premium    = await isPremium(businessId);
    if (!premium) return res.status(403).json({ message: "Premium required" });

    // Check if analysis already running
    const { rows: running } = await query(`
      SELECT id FROM insight_runs
      WHERE business_id = $1 AND status = 'running'
      AND started_at > NOW() - INTERVAL '10 minutes'
    `, [businessId]);

    if (running.length) {
      return res.json({ message: "Analysis already running", running: true });
    }

    // Create run record
    const { rows: runRows } = await query(`
      INSERT INTO insight_runs (business_id, status)
      VALUES ($1, 'running') RETURNING id
    `, [businessId]);

    const runId = runRows[0].id;

    // Run analysis async — don't await
    analyzeConversations(businessId, runId)
      .catch(err => {
        console.error("Insights analysis failed:", err.message);
        query(
          "UPDATE insight_runs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2",
          [err.message, runId]
        ).catch(() => {});
      });

    res.json({ message: "Analysis started", run_id: runId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /reports/re-engagement/settings ──────────────────────
router.get("/reports/re-engagement/settings", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM re_engagement_settings WHERE business_id = $1",
      [bId(req)]
    );
    res.json({
      settings: rows[0] || {
        enabled: true, delay_days: 3, max_attempts: 2, message_tone: "friendly"
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PUT /reports/re-engagement/settings ──────────────────────
router.put("/reports/re-engagement/settings", async (req, res) => {
  try {
    const { enabled, delay_days, max_attempts, message_tone } = req.body;
    await query(`
      INSERT INTO re_engagement_settings
        (business_id, enabled, delay_days, max_attempts, message_tone)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (business_id) DO UPDATE
      SET enabled=$2, delay_days=$3, max_attempts=$4,
          message_tone=$5, updated_at=NOW()
    `, [bId(req), enabled, delay_days, max_attempts, message_tone]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /reports/re-engagement/leads — cold leads list ───────
router.get("/reports/re-engagement/leads", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT l.id, l.customer_name, l.phone, l.status,
             l.re_engagement_count, l.last_re_engaged_at,
             l.re_engagement_status, l.collected_details,
             l.created_at
      FROM leads l
      WHERE l.business_id = $1
        AND l.status NOT IN ('converted','closed')
        AND l.re_engagement_status != 'opted_out'
      ORDER BY l.created_at DESC
      LIMIT 50
    `, [bId(req)]);
    res.json({ leads: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;