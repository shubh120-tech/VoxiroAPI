import cron        from "node-cron";
import { query }   from "../db/postgres.js";
import { analyzeConversations } from "../agents/insightsAgent.js";
import { runReEngagement }      from "../agents/reEngagementAgent.js";

// ── Insights analysis — runs daily at 2 AM IST (8:30 PM UTC) ─
cron.schedule("30 20 * * *", async () => {
  console.log("🧠 Starting daily insights analysis...");
  try {
    // Get all active premium businesses
    const { rows: businesses } = await query(`
      SELECT id FROM businesses
      WHERE is_active = TRUE
      LIMIT 100
    `);

    for (const biz of businesses) {
      try {
        // Skip if analysis ran in last 20 hours
        const { rows: recent } = await query(`
          SELECT id FROM insight_runs
          WHERE business_id = $1
            AND status = 'completed'
            AND completed_at > NOW() - INTERVAL '20 hours'
        `, [biz.id]);

        if (recent.length) continue;

        const { rows: runRows } = await query(`
          INSERT INTO insight_runs (business_id, status)
          VALUES ($1, 'running') RETURNING id
        `, [biz.id]);

        await analyzeConversations(biz.id, runRows[0].id);
        console.log(`✅ Insights complete: ${biz.id}`);
      } catch (err) {
        console.error(`❌ Insights failed for ${biz.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Insights cron error:", err.message);
  }
});

// ── Re-engagement — runs daily at 10 AM IST (4:30 AM UTC) ────
cron.schedule("30 4 * * *", async () => {
  console.log("🔄 Starting re-engagement cron...");
  try {
    const { rows: businesses } = await query(`
      SELECT b.id FROM businesses b
      JOIN re_engagement_settings r ON r.business_id = b.id
      WHERE b.is_active = TRUE AND r.enabled = TRUE
    `);

    for (const biz of businesses) {
      try {
        await runReEngagement(biz.id);
      } catch (err) {
        console.error(`Re-engagement failed for ${biz.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Re-engagement cron error:", err.message);
  }
});

console.log("✅ Insights + Re-engagement crons registered");