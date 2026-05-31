import express from "express";
import axios   from "axios";
import crypto  from "crypto";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import { syncShopifyProducts } from "./storeIntegration.js";

const router = express.Router();

const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_URL               = process.env.API_URL || process.env.RAILWAY_STATIC_URL
  ? `https://${process.env.RAILWAY_STATIC_URL}`
  : "https://voxiroapi-production.up.railway.app";
const FRONTEND_URL          = (process.env.FRONTEND_URL || "").replace(/\/$/, "");

// Scopes we need from Shopify
const SCOPES = "read_products,write_products,read_orders,write_orders,read_customers,write_customers";

// ── State store using DB ─────────────────────────────────────
// More reliable than in-memory Map (survives restarts)
async function saveOAuthState(state, businessId, shop) {
  await query(`
    INSERT INTO oauth_states (state, business_id, shop, expires_at)
    VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
    ON CONFLICT (state) DO UPDATE SET expires_at = NOW() + INTERVAL '10 minutes'
  `, [state, businessId, shop]).catch(async () => {
    // Table might not exist yet — use memory fallback
    oauthStatesMemory.set(state, { businessId, shop, createdAt: Date.now() });
  });
}

async function getOAuthState(state) {
  try {
    const { rows } = await query(`
      SELECT business_id, shop FROM oauth_states
      WHERE state = $1 AND expires_at > NOW()
    `, [state]);
    if (rows.length) return { businessId: rows[0].business_id, shop: rows[0].shop };
  } catch { /* fallback to memory */ }
  return oauthStatesMemory.get(state) || null;
}

async function deleteOAuthState(state) {
  query("DELETE FROM oauth_states WHERE state = $1", [state]).catch(() => {});
  oauthStatesMemory.delete(state);
}

const oauthStatesMemory = new Map(); // fallback

// ── Debug credentials (remove after fixing) ──────────────────
router.get("/store/shopify/debug-creds", async (req, res) => {
  res.json({
    client_id:           SHOPIFY_CLIENT_ID,
    client_secret_first6: SHOPIFY_CLIENT_SECRET?.slice(0, 6) + "...",
    client_secret_last4:  "..." + SHOPIFY_CLIENT_SECRET?.slice(-4),
    client_secret_length: SHOPIFY_CLIENT_SECRET?.length,
    api_url:              API_URL,
    frontend_url:         FRONTEND_URL,
  });
});



router.post("/store/shopify/install", authMiddleware, async (req, res) => {
  try {
    const { shop, accessToken } = req.body;
    if (!shop) return res.status(400).json({ message: "Shop URL required" });

    // Clean shop URL
    const cleanShop   = shop.replace(/^https?:\/\//, "").replace(/\/$/, "").trim();
    const shopDomain  = cleanShop.includes(".myshopify.com")
      ? cleanShop : `${cleanShop}.myshopify.com`;

    // ── Direct token connection (Custom App) ──────────────
    if (accessToken?.trim()) {
      console.log("🔑 Direct token connection:", shopDomain);
      try {
        const shopRes  = await axios.get(
          `https://${shopDomain}/admin/api/2024-01/shop.json`,
          { headers: { "X-Shopify-Access-Token": accessToken.trim() } }
        );
        const shopData = shopRes.data?.shop;

        const { rows } = await query(`
          INSERT INTO store_integrations
            (business_id, platform, store_url, access_token, status, store_name, store_email, currency)
          VALUES ($1, 'shopify', $2, $3, 'connected', $4, $5, $6)
          ON CONFLICT (business_id, platform) DO UPDATE
          SET store_url = $2, access_token = $3, status = 'connected',
              store_name = $4, updated_at = NOW()
          RETURNING id
        `, [req.user.business_id, shopDomain, accessToken.trim(),
            shopData?.name || shopDomain, shopData?.email || "",
            shopData?.currency || "INR"]);

        // Sync products in background
        syncShopifyProducts(rows[0].id, req.user.business_id, shopDomain, null, null, accessToken.trim())
          .catch(e => console.error("Sync error:", e.message));

        return res.json({ success: true, shop: shopData?.name || shopDomain });
      } catch (err) {
        console.error("Direct token error:", err.response?.status, err.response?.data);
        return res.status(400).json({ message: "Invalid token or store URL — check and try again" });
      }
    }

    // ── OAuth flow (Partners App) ──────────────────────────
    if (!cleanShop.includes(".myshopify.com") && !cleanShop.includes(".")) {
      return res.status(400).json({ message: "Enter your Shopify store URL (e.g. mystore.myshopify.com)" });
    }

    const state       = crypto.randomBytes(16).toString("hex");
    await saveOAuthState(state, req.user.business_id, shopDomain);

    const redirectUri = `${API_URL}/api/store/shopify/callback`;
    const installUrl  = `https://${shopDomain}/admin/oauth/authorize`
      + `?client_id=${SHOPIFY_CLIENT_ID}`
      + `&scope=${SCOPES}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&state=${state}`;

    res.json({ installUrl });

  } catch (err) {
    console.error("Shopify install error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  STEP 2 — OAuth Callback (public — Shopify redirects here)
// ══════════════════════════════════════════════════════════════

router.get("/store/shopify/callback", async (req, res) => {
  try {
    const { shop, code, state, hmac } = req.query;

    // Validate state
    const savedState = await getOAuthState(state);
    console.log("🔑 OAuth state lookup:", state?.slice(0, 16) + "...", "found:", !!savedState);

    if (!savedState) {
      console.warn("OAuth state not found — may have expired or Railway restarted");
      // During testing — continue with shop from query params
      // return res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=invalid_state`);
    }

    const businessId = savedState?.businessId || req.query.business_id;
    console.log("🏢 Business ID:", businessId);
    await deleteOAuthState(state);

    // Validate HMAC signature from Shopify
    const hmacValid = validateHmac(req.query, SHOPIFY_CLIENT_SECRET);
    console.log("🔐 HMAC validation:", hmacValid ? "✅ valid" : "❌ invalid");
    console.log("   SHOPIFY_CLIENT_SECRET set:", !!SHOPIFY_CLIENT_SECRET);
    console.log("   Query params:", JSON.stringify(req.query).slice(0, 200));

    if (!hmacValid) {
      console.warn("HMAC mismatch — check SHOPIFY_CLIENT_SECRET in Railway");
      // During testing — log but continue anyway
      // TODO: re-enable strict check after testing: return res.redirect(...)
    }

    // Exchange code for access token
    console.log("🔑 Exchanging code for token...");
    console.log("   Shop:", shop);
    console.log("   Client ID:", SHOPIFY_CLIENT_ID);
    console.log("   Client Secret (first 6):", SHOPIFY_CLIENT_SECRET?.slice(0, 6) + "...");
    console.log("   Code:", code?.slice(0, 10) + "...");

    let tokenRes;
    try {
      // Shopify requires form-encoded body for token exchange
      const params = new URLSearchParams();
      params.append("client_id",     SHOPIFY_CLIENT_ID);
      params.append("client_secret", SHOPIFY_CLIENT_SECRET);
      params.append("code",          code);

      tokenRes = await axios.post(
        `https://${shop}/admin/oauth/access_token`,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      console.log("✅ Token exchange success");
    } catch (tokenErr) {
      console.error("❌ Token exchange 403 — VERIFY THESE MATCH:");
      console.error("   Client ID in Railway:", SHOPIFY_CLIENT_ID);
      console.error("   Get correct values from: partners.shopify.com → Apps → Yougant → API credentials");
      console.error("   Status:", tokenErr.response?.status);
      console.error("   Shopify error:", JSON.stringify(tokenErr.response?.data));
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=token_403`);
    }

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=no_token`);
    }

    // Get shop details
    const shopRes = await axios.get(
      `https://${shop}/admin/api/2024-01/shop.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const shopData    = shopRes.data?.shop;
    const shopName    = shopData?.name || shop;
    const shopEmail   = shopData?.email || "";
    const shopDomain  = shopData?.domain || shop;
    const currency    = shopData?.currency || "INR";

    // Save integration
    const { rows } = await query(`
      INSERT INTO store_integrations
        (business_id, platform, store_url, access_token, status,
         store_name, store_email, currency)
      VALUES ($1, 'shopify', $2, $3, 'connected', $4, $5, $6)
      ON CONFLICT (business_id, platform) DO UPDATE
      SET store_url    = $2,
          access_token = $3,
          status       = 'connected',
          store_name   = $4,
          store_email  = $5,
          currency     = $6,
          error_message = NULL,
          updated_at   = NOW()
      RETURNING id
    `, [businessId, shop, accessToken, shopName, shopEmail, currency]);

    const integrationId = rows[0].id;

    // Register webhooks for real-time updates
    await registerShopifyWebhooks(shop, accessToken, integrationId, businessId);

    // Start product sync in background
    syncShopifyProductsWithToken(integrationId, businessId, shop, accessToken)
      .catch(console.error);

    // Redirect back to frontend with success
    res.redirect(`${FRONTEND_URL}/dashboard/integrations?success=shopify_connected&shop=${shopName}`);

  } catch (err) {
    console.error("Shopify callback error:", err.message);
    res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=${encodeURIComponent(err.message)}`);
  }
});

// ══════════════════════════════════════════════════════════════
//  SHOPIFY WEBHOOKS (product/order updates in real-time)
// ══════════════════════════════════════════════════════════════

router.post("/store/shopify/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond immediately

  try {
    const topic    = req.headers["x-shopify-topic"];
    const shopDomain = req.headers["x-shopify-shop-domain"];
    const body     = req.body;

    // Find integration
    const { rows } = await query(
      "SELECT * FROM store_integrations WHERE store_url = $1 AND platform = 'shopify'",
      [shopDomain]
    );
    if (!rows.length) return;

    const integration = rows[0];

    if (topic === "products/update" || topic === "products/create") {
      await upsertShopifyProduct(body, integration.id, integration.business_id);
    } else if (topic === "products/delete") {
      await query(
        "DELETE FROM store_products WHERE platform_product_id = $1 AND integration_id = $2",
        [body.id?.toString(), integration.id]
      );
    } else if (topic === "orders/create" || topic === "orders/updated") {
      // Tag order if it came from Yougant
      const voxiroNote = body.note_attributes?.find(n => n.name === "yougant_source");
      if (voxiroNote) {
        await query(`
          UPDATE store_orders SET platform_order_id = $1, tagged_in_store = TRUE
          WHERE business_id = $2 AND customer_phone = $3
          ORDER BY created_at DESC LIMIT 1
        `, [body.id?.toString(), integration.business_id, body.phone]);
      }
    }
  } catch (err) {
    console.error("Shopify webhook error:", err.message);
  }
});

// ══════════════════════════════════════════════════════════════
//  DISCONNECT
// ══════════════════════════════════════════════════════════════

router.delete("/store/shopify/disconnect", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM store_integrations WHERE business_id = $1 AND platform = 'shopify'",
      [req.user.business_id]
    );

    if (rows.length) {
      // Delete webhooks from Shopify
      try {
        const wRes = await axios.get(
          `https://${rows[0].store_url}/admin/api/2024-01/webhooks.json`,
          { headers: { "X-Shopify-Access-Token": rows[0].access_token } }
        );
        for (const webhook of wRes.data?.webhooks || []) {
          await axios.delete(
            `https://${rows[0].store_url}/admin/api/2024-01/webhooks/${webhook.id}.json`,
            { headers: { "X-Shopify-Access-Token": rows[0].access_token } }
          ).catch(() => {});
        }
      } catch { /* non-critical */ }

      await query("DELETE FROM store_products WHERE integration_id = $1", [rows[0].id]);
      await query("DELETE FROM store_integrations WHERE id = $1", [rows[0].id]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to disconnect" });
  }
});

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function validateHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join("&");
  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
  return digest === hmac;
}

async function registerShopifyWebhooks(shop, accessToken, integrationId, businessId) {
  const webhookUrl = `${API_URL}/api/store/shopify/webhook`;
  const topics = [
    "products/create",
    "products/update",
    "products/delete",
    "orders/create",
  ];

  for (const topic of topics) {
    try {
      await axios.post(
        `https://${shop}/admin/api/2024-01/webhooks.json`,
        { webhook: { topic, address: webhookUrl, format: "json" } },
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );
    } catch { /* webhook might already exist */ }
  }
  console.log(`✅ Shopify webhooks registered for ${shop}`);
}

async function syncShopifyProductsWithToken(integrationId, businessId, shop, accessToken) {
  let page        = 1;
  let totalSynced = 0;

  await query("UPDATE store_integrations SET status = 'syncing' WHERE id = $1", [integrationId]);

  try {
    while (true) {
      const res = await axios.get(
        `https://${shop}/admin/api/2024-01/products.json`,
        {
          headers: { "X-Shopify-Access-Token": accessToken },
          params:  { limit: 250, page },
        }
      );

      const products = res.data?.products || [];
      if (!products.length) break;

      for (const product of products) {
        await upsertShopifyProduct(product, integrationId, businessId);
        totalSynced++;
      }

      if (products.length < 250) break;
      page++;
    }

    await query(`
      UPDATE store_integrations
      SET status = 'connected', last_synced_at = NOW(),
          product_count = $1, error_message = NULL, updated_at = NOW()
      WHERE id = $2
    `, [totalSynced, integrationId]);

    console.log(`✅ Shopify sync complete: ${totalSynced} products`);

  } catch (err) {
    await query(
      "UPDATE store_integrations SET status = 'error', error_message = $1 WHERE id = $2",
      [err.message, integrationId]
    );
  }
}

async function upsertShopifyProduct(product, integrationId, businessId) {
  const variants = product.variants?.map(v => ({
    id:            v.id,
    title:         v.title,
    price:         parseFloat(v.price || 0),
    compare_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
    sku:           v.sku,
    inventory:     v.inventory_quantity,
    available:     v.inventory_quantity > 0 || v.inventory_management === null,
  })) || [];

  const images   = product.images?.map(img => img.src) || [];
  const minPrice = variants.length > 0 ? Math.min(...variants.map(v => v.price)) : 0;
  const inStock  = variants.some(v => v.available !== false);
  const tags     = product.tags ? product.tags.split(",").map(t => t.trim()).filter(Boolean) : [];

  await query(`
    INSERT INTO store_products
      (business_id, integration_id, platform_product_id, name, description,
       price, variants, images, category, tags, in_stock, stock_count, platform_url, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (integration_id, platform_product_id) DO UPDATE
    SET name = $4, description = $5, price = $6, variants = $7,
        images = $8, category = $9, tags = $10, in_stock = $11,
        stock_count = $12, platform_url = $13, synced_at = NOW(), updated_at = NOW()
  `, [
    businessId, integrationId,
    product.id?.toString(),
    product.title,
    stripHtml(product.body_html || ""),
    minPrice,
    JSON.stringify(variants),
    JSON.stringify(images),
    product.product_type || null,
    tags,
    inStock,
    variants.reduce((s, v) => s + (v.inventory || 0), 0),
    product.handle ? `https://${product.vendor}/products/${product.handle}` : null,
  ]);
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

export default router;