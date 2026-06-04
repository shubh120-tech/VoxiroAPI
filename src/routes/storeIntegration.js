import express from "express";
import axios   from "axios";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

const bId = (req) => req.user.business_id;

// ══════════════════════════════════════════════════════════════
//  INTEGRATIONS CRUD
// ══════════════════════════════════════════════════════════════

// Get all integrations for business
router.get("/store/integrations", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, platform, store_url, status, last_synced_at,
             product_count, error_message, created_at,
             subscription_status, subscription_id
      FROM store_integrations
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [bId(req)]);
    res.json({ integrations: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load integrations" });
  }
});

// Connect Shopify
router.post("/store/connect/shopify", async (req, res) => {
  try {
    const { store_url, api_key, api_secret } = req.body;
    if (!store_url || !api_key || !api_secret) {
      return res.status(400).json({ message: "Store URL, API key and secret required" });
    }

    // Clean store URL
    const cleanUrl = store_url.replace(/^https?:\/\//, "").replace(/\/$/, "").trim();

    // Test connection
    try {
      const testRes = await axios.get(
        `https://${api_key}:${api_secret}@${cleanUrl}/admin/api/2026-04/shop.json`
      );
      if (!testRes.data?.shop) throw new Error("Invalid response");
    } catch (err) {
      return res.status(400).json({ message: `Could not connect to Shopify store. Check your credentials. Error: ${err.response?.data?.errors || err.message}` });
    }

    // Save integration
    const { rows } = await query(`
      INSERT INTO store_integrations
        (business_id, platform, store_url, api_key, api_secret, status)
      VALUES ($1, 'shopify', $2, $3, $4, 'connected')
      ON CONFLICT (business_id, platform) DO UPDATE
      SET store_url = $2, api_key = $3, api_secret = $4,
          status = 'connected', error_message = NULL, updated_at = NOW()
      RETURNING id, platform, store_url, status
    `, [bId(req), cleanUrl, api_key, api_secret]);

    // Sync products async
    syncShopifyProducts(rows[0].id, bId(req), cleanUrl, api_key, api_secret)
      .catch(console.error);

    res.json({ success: true, integration: rows[0], message: "Shopify connected! Syncing products..." });

  } catch (err) {
    console.error("Shopify connect error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Connect WooCommerce
router.post("/store/connect/woocommerce", async (req, res) => {
  try {
    const { store_url, api_key, api_secret } = req.body;
    if (!store_url || !api_key || !api_secret) {
      return res.status(400).json({ message: "Store URL, Consumer Key and Secret required" });
    }

    const cleanUrl = store_url.replace(/\/$/, "").trim();

    // Test connection
    try {
      const testRes = await axios.get(
        `${cleanUrl}/wp-json/wc/v3/system_status`,
        { auth: { username: api_key, password: api_secret } }
      );
      if (!testRes.data) throw new Error("Invalid response");
    } catch (err) {
      return res.status(400).json({ message: `Could not connect to WooCommerce. Check your credentials. Error: ${err.response?.data?.message || err.message}` });
    }

    const { rows } = await query(`
      INSERT INTO store_integrations
        (business_id, platform, store_url, api_key, api_secret, status)
      VALUES ($1, 'woocommerce', $2, $3, $4, 'connected')
      ON CONFLICT (business_id, platform) DO UPDATE
      SET store_url = $2, api_key = $3, api_secret = $4,
          status = 'connected', error_message = NULL, updated_at = NOW()
      RETURNING id, platform, store_url, status
    `, [bId(req), cleanUrl, api_key, api_secret]);

    // Sync products async
    syncWooCommerceProducts(rows[0].id, bId(req), cleanUrl, api_key, api_secret)
      .catch(console.error);

    res.json({ success: true, integration: rows[0], message: "WooCommerce connected! Syncing products..." });

  } catch (err) {
    console.error("WooCommerce connect error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Manual sync
router.post("/store/integrations/:id/sync", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM store_integrations WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    if (!rows.length) return res.status(404).json({ message: "Integration not found" });

    const integration = rows[0];
    await query("UPDATE store_integrations SET status = 'syncing' WHERE id = $1", [req.params.id]);

    if (integration.platform === "shopify") {
      syncShopifyProducts(
        integration.id, bId(req), integration.store_url,
        integration.api_key, integration.api_secret,
        integration.access_token  // ← pass OAuth token
      ).catch(console.error);
    } else {
      syncWooCommerceProducts(
        integration.id, bId(req), integration.store_url,
        integration.api_key, integration.api_secret
      ).catch(console.error);
    }

    res.json({ success: true, message: "Sync started..." });
  } catch (err) {
    res.status(500).json({ message: "Failed to start sync" });
  }
});

// Disconnect integration
router.delete("/store/integrations/:id", async (req, res) => {
  try {
    await query("DELETE FROM store_integrations WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    await query("DELETE FROM store_products WHERE integration_id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to disconnect" });
  }
});

// ══════════════════════════════════════════════════════════════
//  PRODUCTS
// ══════════════════════════════════════════════════════════════

router.get("/store/products", async (req, res) => {
  try {
    const { search, in_stock, page = 1 } = req.query;
    const limit  = 50;
    const offset = (page - 1) * limit;

    let sql    = `SELECT * FROM store_products WHERE business_id = $1`;
    const params = [bId(req)];

    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }
    if (in_stock === "true") sql += ` AND in_stock = TRUE`;

    sql += ` ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`;

    const { rows } = await query(sql, params);
    const { rows: countRows } = await query(
      "SELECT COUNT(*) FROM store_products WHERE business_id = $1",
      [bId(req)]
    );

    res.json({ products: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    res.status(500).json({ message: "Failed to load products" });
  }
});

// Update product agent description
router.put("/store/products/:id", async (req, res) => {
  try {
    const { agent_description } = req.body;
    await query(`
      UPDATE store_products SET agent_description = $1, updated_at = NOW()
      WHERE id = $2 AND business_id = $3
    `, [agent_description, req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update product" });
  }
});


// ── Debug sync status ─────────────────────────────────────────
router.get("/store/debug", authMiddleware, async (req, res) => {
  try {
    const bId = req.user.business_id;
    const { rows: integrations } = await query(
      "SELECT id, platform, store_url, status, product_count, error_message, subscription_status FROM store_integrations WHERE business_id = $1",
      [bId]
    );
    const { rows: products } = await query(
      "SELECT id, name, price, in_stock FROM store_products WHERE business_id = $1 LIMIT 5",
      [bId]
    );

    const results = [];
    for (const i of integrations) {
      if (i.platform === "shopify") {
        const { rows: tkRows } = await query(
          "SELECT access_token FROM store_integrations WHERE id = $1", [i.id]
        );
        const token = tkRows[0]?.access_token;
        let apiTest = null;
        if (token) {
          try {
            const r = await axios.get(
              `https://${i.store_url}/admin/api/2026-04/products.json?limit=1`,
              { headers: { "X-Shopify-Access-Token": token } }
            );
            apiTest = { ok: true, count: r.data?.products?.length };
          } catch (err) {
            apiTest = { ok: false, status: err.response?.status, error: JSON.stringify(err.response?.data) };
          }
        }
        results.push({ ...i, api_test: apiTest });
      }
    }
    res.json({ integrations: results, sample_products: products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  SYNC FUNCTIONS
// ══════════════════════════════════════════════════════════════

export async function syncShopifyProducts(integrationId, businessId, storeUrl, apiKey, apiSecret, accessToken) {
  let totalSynced = 0;
  const API_VERSION = "2026-04";

  console.log(`🔄 Syncing Shopify products for ${storeUrl}...`);

  try {
    await query("UPDATE store_integrations SET status = 'syncing', error_message = NULL WHERE id = $1", [integrationId]);

    // Get access token from DB if not provided
    if (!accessToken) {
      const { rows } = await query(
        "SELECT access_token FROM store_integrations WHERE id = $1",
        [integrationId]
      );
      accessToken = rows[0]?.access_token;
    }

    if (!accessToken) throw new Error("No access token available for Shopify sync");

    console.log("🔑 Sync using token:", accessToken?.slice(0, 10) + "...", "length:", accessToken?.length);
    const headers = { "X-Shopify-Access-Token": accessToken };
    let pageInfo   = null;
    let hasMore    = true;

    while (hasMore) {
      const params = { limit: 250 };
      if (pageInfo) params.page_info = pageInfo;

      console.log(`📦 Fetching products from ${storeUrl} (API ${API_VERSION})...`);
      const res = await axios.get(
        `https://${storeUrl}/admin/api/${API_VERSION}/products.json`,
        { headers, params }
      );
      console.log(`✅ Got ${res.data?.products?.length || 0} products`);

      const products = res.data?.products || [];
      if (!products.length) break;

      for (const product of products) {
        const variants = product.variants?.map(v => ({
          id:            v.id,
          title:         v.title,
          price:         parseFloat(v.price),
          compare_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
          sku:           v.sku,
          inventory:     v.inventory_quantity,
          available:     v.inventory_quantity > 0 || v.inventory_management === null,
        })) || [];

        const images   = product.images?.map(img => img.src) || [];
        const minPrice = variants.length > 0 ? Math.min(...variants.map(v => v.price || 0)) : 0;
        const inStock  = variants.some(v => v.available);
        const totalStock = variants.reduce((sum, v) => sum + (v.inventory || 0), 0);

        await query(`
          INSERT INTO store_products
            (business_id, integration_id, platform_product_id, name, description,
             price, variants, images, category, tags, in_stock, stock_count,
             platform_url, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
          ON CONFLICT (integration_id, platform_product_id) DO UPDATE
          SET name=$4, description=$5, price=$6, variants=$7,
              images=$8, category=$9, tags=$10, in_stock=$11,
              stock_count=$12, platform_url=$13, synced_at=NOW(), updated_at=NOW()
        `, [
          businessId, integrationId,
          product.id.toString(),
          product.title,
          stripHtml(product.body_html || ""),
          minPrice,
          JSON.stringify(variants),
          JSON.stringify(images),
          product.product_type || null,
          product.tags ? product.tags.split(",").map(t => t.trim()) : [],
          inStock,
          totalStock,
          `https://${storeUrl}/products/${product.handle}`,
        ]);
        totalSynced++;
      }

      // Shopify cursor-based pagination
      const linkHeader = res.headers?.link || "";
      const nextMatch  = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      } else {
        hasMore = false;
      }
    }

    await query(`
      UPDATE store_integrations
      SET status = 'connected', last_synced_at = NOW(),
          product_count = $1, error_message = NULL, updated_at = NOW()
      WHERE id = $2
    `, [totalSynced, integrationId]);

    // Update agent knowledge with products
    await updateAgentProductKnowledge(businessId);

    console.log(`✅ Shopify sync complete: ${totalSynced} products`);

  } catch (err) {
    console.error("Shopify sync error:", err.message);
    await query(`
      UPDATE store_integrations
      SET status = 'error', error_message = $1, updated_at = NOW()
      WHERE id = $2
    `, [err.message, integrationId]);
  }
}

export async function syncWooCommerceProducts(integrationId, businessId, storeUrl, apiKey, apiSecret) {
  let page = 1;
  let totalSynced = 0;

  console.log(`🔄 Syncing WooCommerce products for ${storeUrl}...`);

  try {
    await query("UPDATE store_integrations SET status = 'syncing' WHERE id = $1", [integrationId]);

    while (true) {
      const res = await axios.get(`${storeUrl}/wp-json/wc/v3/products`, {
        auth:   { username: apiKey, password: apiSecret },
        params: { per_page: 100, page, status: "publish" },
      });

      const products = res.data || [];
      if (!products.length) break;

      for (const product of products) {
        // Fetch variations if variable product
        let variants = [];
        if (product.type === "variable" && product.variations?.length > 0) {
          try {
            const varRes = await axios.get(
              `${storeUrl}/wp-json/wc/v3/products/${product.id}/variations`,
              { auth: { username: apiKey, password: apiSecret }, params: { per_page: 100 } }
            );
            variants = varRes.data?.map(v => ({
              id:        v.id,
              title:     v.attributes?.map(a => a.option).join(" / ") || v.sku,
              price:     parseFloat(v.price || 0),
              compare_price: v.regular_price ? parseFloat(v.regular_price) : null,
              sku:       v.sku,
              inventory: v.stock_quantity,
              available: v.in_stock,
            })) || [];
          } catch { /* skip variations on error */ }
        } else {
          variants = [{
            id:        product.id,
            title:     "Default",
            price:     parseFloat(product.price || 0),
            compare_price: product.regular_price ? parseFloat(product.regular_price) : null,
            sku:       product.sku,
            inventory: product.stock_quantity,
            available: product.in_stock,
          }];
        }

        const images   = product.images?.map(img => img.src) || [];
        const price    = parseFloat(product.price || 0);
        const inStock  = product.in_stock;
        const tags     = product.tags?.map(t => t.name) || [];
        const category = product.categories?.[0]?.name || null;

        await query(`
          INSERT INTO store_products
            (business_id, integration_id, platform_product_id, name, description,
             price, variants, images, category, tags, in_stock, stock_count,
             platform_url, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
          ON CONFLICT (integration_id, platform_product_id) DO UPDATE
          SET name = $4, description = $5, price = $6, variants = $7,
              images = $8, category = $9, tags = $10, in_stock = $11,
              stock_count = $12, platform_url = $13, synced_at = NOW(), updated_at = NOW()
        `, [
          businessId, integrationId,
          product.id.toString(),
          product.name,
          stripHtml(product.description || product.short_description || ""),
          price,
          JSON.stringify(variants),
          JSON.stringify(images),
          category,
          tags,
          inStock,
          product.stock_quantity || 0,
          product.permalink || null,
        ]);
        totalSynced++;
      }

      if (products.length < 100) break;
      page++;
    }

    await query(`
      UPDATE store_integrations
      SET status = 'connected', last_synced_at = NOW(),
          product_count = $1, error_message = NULL, updated_at = NOW()
      WHERE id = $2
    `, [totalSynced, integrationId]);

    await updateAgentProductKnowledge(businessId);
    console.log(`✅ WooCommerce sync complete: ${totalSynced} products`);

  } catch (err) {
    console.error("WooCommerce sync error:", err.message);
    await query(`
      UPDATE store_integrations
      SET status = 'error', error_message = $1, updated_at = NOW()
      WHERE id = $2
    `, [err.message, integrationId]);
  }
}

// ══════════════════════════════════════════════════════════════
//  TAG ORDER IN STORE
// ══════════════════════════════════════════════════════════════

export async function tagOrderInStore(businessId, platformOrderId, platform) {
  try {
    const { rows } = await query(
      "SELECT * FROM store_integrations WHERE business_id = $1 AND platform = $2 AND status = 'connected'",
      [businessId, platform]
    );
    if (!rows.length) return;

    const integration = rows[0];
    const tag         = "Yougant | WhatsApp Order";
    const note        = `Order placed via Yougant WhatsApp AI Agent on ${new Date().toLocaleDateString("en-IN")}`;

    if (platform === "shopify") {
      await axios.put(
        `https://${integration.api_key}:${integration.api_secret}@${integration.store_url}/admin/api/2026-04/orders/${platformOrderId}.json`,
        { order: { tags: tag, note } }
      );
    } else if (platform === "woocommerce") {
      await axios.put(
        `${integration.store_url}/wp-json/wc/v3/orders/${platformOrderId}`,
        { customer_note: note, meta_data: [{ key: "voxiro_source", value: "WhatsApp AI Agent" }] },
        { auth: { username: integration.api_key, password: integration.api_secret } }
      );
    }

    await query(`
      UPDATE store_orders SET tagged_in_store = TRUE, tagged_at = NOW()
      WHERE platform_order_id = $1 AND business_id = $2
    `, [platformOrderId, businessId]);

    console.log(`✅ Order ${platformOrderId} tagged in ${platform}`);
  } catch (err) {
    console.error("Tag order error:", err.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  UPDATE AGENT KNOWLEDGE WITH PRODUCTS
// ══════════════════════════════════════════════════════════════

async function updateAgentProductKnowledge(businessId) {
  try {
    const { rows } = await query(`
      SELECT name, description, agent_description, price, variants, in_stock, category
      FROM store_products
      WHERE business_id = $1 AND in_stock = TRUE
      ORDER BY name ASC
      LIMIT 200
    `, [businessId]);

    if (!rows.length) return;

    // Build compact product knowledge for agent
    const productLines = rows.map(p => {
      const desc    = p.agent_description || p.description || "";
      const shortDesc = desc.slice(0, 100);
      const variants = p.variants || [];

      let priceStr = `₹${p.price}`;
      if (variants.length > 1) {
        const prices  = variants.map(v => v.price).filter(Boolean);
        const minP    = Math.min(...prices);
        const maxP    = Math.max(...prices);
        priceStr      = minP === maxP ? `₹${minP}` : `₹${minP}–₹${maxP}`;
      }

      const variantStr = variants.length > 1
        ? ` | Variants: ${variants.map(v => v.title).join(", ")}`
        : "";

      return `• ${p.name}: ${priceStr}${shortDesc ? ` — ${shortDesc}` : ""}${variantStr}`;
    });

    const knowledge = `\n\nPRODUCT CATALOG (always use exact prices from this list):\n${productLines.join("\n")}`;

    // Save to a separate field or append to agent config
    await query(`
      UPDATE agent_configs
      SET product_knowledge = $1, updated_at = NOW()
      WHERE business_id = $2
    `, [knowledge.trim(), businessId]);

    // Check if column exists, if not use system_prompt fallback
    console.log(`✅ Agent product knowledge updated: ${rows.length} products`);
  } catch (err) {
    console.error("Update product knowledge error:", err.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  SEARCH PRODUCTS (for agent/knowledgeFetcher)
// ══════════════════════════════════════════════════════════════

export async function searchProducts(businessId, query_text, limit = 5) {
  try {
    const { rows } = await query(`
      SELECT name, description, agent_description, price, variants,
             in_stock, stock_count, category, images
      FROM store_products
      WHERE business_id = $1
        AND (
          name        ILIKE $2 OR
          description ILIKE $2 OR
          category    ILIKE $2 OR
          $3 = ANY(tags)
        )
      ORDER BY in_stock DESC, name ASC
      LIMIT $4
    `, [businessId, `%${query_text}%`, query_text.toLowerCase(), limit]);

    return rows;
  } catch (err) {
    console.error("Product search error:", err.message);
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export default router;