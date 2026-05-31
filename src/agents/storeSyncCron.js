import { query } from "../db/postgres.js";
import { syncShopifyProducts, syncWooCommerceProducts } from "../routes/storeIntegration.js";

/**
 * Sync all connected store integrations.
 * Runs every 6 hours.
 */
export async function processStoreSyncs() {
  try {
    // Get all connected integrations not synced in last 6 hours
    const { rows } = await query(`
      SELECT * FROM store_integrations
      WHERE status = 'connected'
        AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '6 hours')
      ORDER BY last_synced_at ASC NULLS FIRST
      LIMIT 10
    `);

    if (!rows.length) return;

    console.log(`🔄 Store sync: ${rows.length} integration(s) due for sync`);

    for (const integration of rows) {
      if (integration.platform === "shopify") {
        await syncShopifyProducts(
          integration.id, integration.business_id,
          integration.store_url, integration.api_key, integration.api_secret,
          integration.access_token  // OAuth token
        );
      } else if (integration.platform === "woocommerce") {
        await syncWooCommerceProducts(
          integration.id, integration.business_id,
          integration.store_url, integration.api_key, integration.api_secret
        );
      }
    }
  } catch (err) {
    console.error("Store sync cron error:", err.message);
  }
}