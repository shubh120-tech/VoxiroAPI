import { query }           from "../db/postgres.js";
import { executeCampaign } from "../routes/broadcast.js";

/**
 * Check and execute scheduled broadcast campaigns.
 * Runs every 5 minutes alongside followUpCron.
 */
export async function processBroadcasts() {
  try {
    const { rows } = await query(`
      SELECT * FROM broadcast_campaigns
      WHERE status    = 'scheduled'
        AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
      LIMIT 10
    `);

    if (!rows.length) return;

    console.log(`📢 Processing ${rows.length} scheduled broadcast(s)...`);

    for (const campaign of rows) {
      // Mark as running
      await query(`
        UPDATE broadcast_campaigns SET status = 'running', updated_at = NOW()
        WHERE id = $1
      `, [campaign.id]);

      // Execute async — don't block cron
      executeCampaign(campaign, campaign.business_id).catch(err => {
        console.error(`Campaign ${campaign.name} failed:`, err.message);
      });
    }

  } catch (err) {
    console.error("Broadcast cron error:", err.message);
  }
}