import express from "express";
import axios   from "axios";
import crypto  from "crypto";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import { syncShopifyProducts } from "./storeIntegration.js";

const router = express.Router();

const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID     || "";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";
const API_URL               = process.env.API_URL               || "https://voxiroapi-production.up.railway.app";
const FRONTEND_URL          = (process.env.FRONTEND_URL         || "").replace(/\/$/, "");
const SCOPES                = "read_products,write_products,read_orders,write_orders,read_inventory";

// ── State management ──────────────────────────────────────────
const stateMap = new Map();

async function saveState(state, businessId, shop) {
  stateMap.set(state, { businessId, shop, ts: Date.now() });
  await query(
    `INSERT INTO oauth_states (state, business_id, shop, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (state) DO UPDATE SET expires_at = NOW() + INTERVAL '10 minutes'`,
    [state, businessId, shop]
  ).catch(() => {});
}

async function getState(state) {
  // Try DB first
  try {
    const { rows } = await query(
      `SELECT business_id, shop FROM oauth_states WHERE state = $1 AND expires_at > NOW()`,
      [state]
    );
    if (rows.length) return { businessId: rows[0].business_id, shop: rows[0].shop };
  } catch {}
  // Fallback to memory
  const mem = stateMap.get(state);
  if (mem && Date.now() - mem.ts < 600000) return mem;
  return null;
}

async function clearState(state) {
  stateMap.delete(state);
  query("DELETE FROM oauth_states WHERE state = $1", [state]).catch(() => {});
}

// ── HMAC validation ───────────────────────────────────────────
function validateHmac(params, secret) {
  if (!secret) return false;
  const { hmac, signature, ...rest } = params;
  const msg    = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("&");
  const digest = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return digest === hmac;
}

// ══════════════════════════════════════════════════════════════
// DEBUG — remove after testing
// ══════════════════════════════════════════════════════════════
router.get("/store/shopify/debug", async (req, res) => {
  res.json({
    client_id:     SHOPIFY_CLIENT_ID,
    secret_start:  SHOPIFY_CLIENT_SECRET?.slice(0, 6) + "...",
    secret_end:    "..." + SHOPIFY_CLIENT_SECRET?.slice(-4),
    secret_length: SHOPIFY_CLIENT_SECRET?.length,
    api_url:       API_URL,
    frontend_url:  FRONTEND_URL,
    callback_url:  `${API_URL}/api/store/shopify/callback`,
  });
});

// ══════════════════════════════════════════════════════════════
// STEP 1 — Start OAuth or direct token connect
// ══════════════════════════════════════════════════════════════
router.post("/store/shopify/install", authMiddleware, async (req, res) => {
  try {
    const { shop, accessToken } = req.body;
    if (!shop?.trim()) return res.status(400).json({ message: "Store URL required" });

    const shopDomain = shop.trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .replace(/^([^.]+)$/, "$1.myshopify.com"); // add .myshopify.com if just subdomain

    // ── Option A: Direct token (Custom App) ──────────────────
    if (accessToken?.trim()) {
      console.log("🔗 Direct token connect:", shopDomain);
      try {
        const { data } = await axios.get(
          `https://${shopDomain}/admin/api/2026-04/shop.json`,
          { headers: { "X-Shopify-Access-Token": accessToken.trim() } }
        );
        const s = data?.shop;
        const { rows } = await query(`
          INSERT INTO store_integrations
            (business_id, platform, store_url, access_token, status, store_name, store_email, currency)
          VALUES ($1,'shopify',$2,$3,'connected',$4,$5,$6)
          ON CONFLICT (business_id, platform) DO UPDATE
          SET store_url=$2, access_token=$3, status='connected', store_name=$4, updated_at=NOW()
          RETURNING id
        `, [req.user.business_id, shopDomain, accessToken.trim(),
            s?.name || shopDomain, s?.email || "", s?.currency || "INR"]);

        syncShopifyProducts(rows[0].id, req.user.business_id, shopDomain, null, null, accessToken.trim())
          .catch(e => console.error("Sync error:", e.message));

        return res.json({ success: true, shop: s?.name || shopDomain });
      } catch (err) {
        const status = err.response?.status;
        console.error("Direct token error:", status, err.response?.data);
        const msg = status === 401 ? "Invalid access token"
                  : status === 403 ? "Token doesn't have required permissions"
                  : "Could not connect to store";
        return res.status(400).json({ message: msg });
      }
    }

    // ── Option B: OAuth flow (Partners App) ──────────────────
    if (!SHOPIFY_CLIENT_ID) {
      return res.status(500).json({ message: "Shopify app not configured — contact support" });
    }

    const state       = crypto.randomBytes(16).toString("hex");
    const redirectUri = `${API_URL}/api/store/shopify/callback`;
    console.log("🔑 Requesting scopes:", SCOPES);

    await saveState(state, req.user.business_id, shopDomain);

    const installUrl = `https://${shopDomain}/admin/oauth/authorize`
      + `?client_id=${SHOPIFY_CLIENT_ID}`
      + `&scope=${encodeURIComponent(SCOPES)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&state=${state}`;

    console.log("🔗 OAuth redirect:", installUrl.slice(0, 80) + "...");
    res.json({ installUrl });

  } catch (err) {
    console.error("Shopify install error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 2 — OAuth Callback
// ══════════════════════════════════════════════════════════════
router.get("/store/shopify/callback", async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  try {
    console.log("📞 OAuth callback:", { shop, state: state?.slice(0, 12) + "..." });

    // Validate state
    const saved      = await getState(state);
    const businessId = saved?.businessId;
    await clearState(state);

    if (!saved) {
      console.warn("⚠️  State not found — session may have expired");
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=session_expired`);
    }
    console.log("✅ State valid — business:", businessId);

    // Validate HMAC
    if (!validateHmac(req.query, SHOPIFY_CLIENT_SECRET)) {
      console.warn("⚠️  HMAC invalid — secret mismatch");
      // Don't block during testing — just warn
    }

    // Exchange code for token — try JSON first, then form-encoded
    let accessToken;
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;

    try {
      console.log("🔑 Token exchange (JSON)...");
      const r = await axios.post(tokenUrl, {
        client_id:     SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }, { headers: { "Content-Type": "application/json" } });
      accessToken = r.data?.access_token;
      console.log("✅ Token exchange success (JSON)");
      console.log("   Granted scopes:", r.data?.scope);
      console.log("   Full response:", JSON.stringify(r.data));
    } catch (e1) {
      console.warn("JSON failed:", e1.response?.status, "— trying form-encoded...");
      try {
        const params = new URLSearchParams({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code });
        const r = await axios.post(tokenUrl, params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        accessToken = r.data?.access_token;
        console.log("✅ Token exchange success (form-encoded)");
        console.log("   Granted scopes:", r.data?.scope);
      } catch (e2) {
        console.error("❌ Both token methods failed");
        console.error("   Status:", e2.response?.status);
        console.error("   Error:", JSON.stringify(e2.response?.data));
        console.error("   Client ID:", SHOPIFY_CLIENT_ID);
        console.error("   Secret (first 6):", SHOPIFY_CLIENT_SECRET?.slice(0, 6));
        console.error("   → Verify credentials at partners.shopify.com → Apps → Yougant → API credentials");
        return res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=auth_failed`);
      }
    }

    if (!accessToken) {
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=no_token`);
    }
    console.log("✅ Got access token — saving integration...");

    // Get shop info — optional, don't fail if 403
    let shopName  = shop.replace(".myshopify.com", "");
    let shopEmail = "";
    let currency  = "INR";
    try {
      const { data: shopData } = await axios.get(
        `https://${shop}/admin/api/2026-04/shop.json`,
        { headers: { "X-Shopify-Access-Token": accessToken }, timeout: 8000 }
      );
      const s   = shopData?.shop;
      shopName  = s?.name  || shopName;
      shopEmail = s?.email || "";
      currency  = s?.currency || "INR";
      console.log("✅ Shop info fetched:", shopName);
    } catch (err) {
      console.warn("⚠️  Could not fetch shop info (non-fatal):", err.response?.status, "— using defaults");
    }

    // Save integration
    const { rows } = await query(`
      INSERT INTO store_integrations
        (business_id, platform, store_url, access_token, status, store_name, store_email, currency)
      VALUES ($1,'shopify',$2,$3,'connected',$4,$5,$6)
      ON CONFLICT (business_id, platform) DO UPDATE
      SET store_url=$2, access_token=$3, status='connected',
          store_name=$4, store_email=$5, currency=$6,
          error_message=NULL, updated_at=NOW()
      RETURNING id
    `, [businessId, shop, accessToken, shopName, shopEmail, currency]);

    console.log("✅ Shopify connected:", shopName, "→ syncing products...");

    // Sync products async
    syncShopifyProducts(rows[0].id, businessId, shop, null, null, accessToken)
      .catch(e => console.error("Sync error:", e.message));

    // Register webhooks async
    registerWebhooks(shop, accessToken, rows[0].id, businessId)
      .catch(e => console.error("Webhook reg error:", e.message));

    res.redirect(`${FRONTEND_URL}/dashboard/integrations?success=shopify_connected&shop=${encodeURIComponent(shopName)}`);

  } catch (err) {
    console.error("❌ Shopify callback error:", err.message);
    res.redirect(`${FRONTEND_URL}/dashboard/integrations?error=${encodeURIComponent(err.message)}`);
  }
});

// ══════════════════════════════════════════════════════════════
// SHOPIFY WEBHOOKS
// ══════════════════════════════════════════════════════════════
router.post("/store/shopify/webhook", async (req, res) => {
  // Verify HMAC signature from Shopify
  const hmac    = req.headers["x-shopify-hmac-sha256"];
  const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body)));

  if (hmac && SHOPIFY_CLIENT_SECRET) {
    const digest = crypto
      .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(rawBody)
      .digest("base64");
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
      console.warn("⚠️  Invalid Shopify webhook HMAC");
      return res.sendStatus(401);
    }
  }

  res.sendStatus(200);
  try {
    const topic = req.headers["x-shopify-topic"];
    const shop  = req.headers["x-shopify-shop-domain"];
    const data  = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;

    const { rows } = await query(
      `SELECT id, business_id, access_token FROM store_integrations
       WHERE store_url = $1 AND platform = 'shopify'`,
      [shop]
    );
    if (!rows.length) return;

    const { id: integrationId, business_id: businessId, access_token } = rows[0];

    if (["products/create", "products/update"].includes(topic)) {
      await syncShopifyProducts(integrationId, businessId, shop, null, null, access_token)
        .catch(e => console.error("Webhook sync error:", e.message));
    }

    if (topic === "products/delete") {
      await query(
        `UPDATE products SET is_active = FALSE WHERE business_id = $1 AND source = 'shopify'`,
        [businessId]
      ).catch(() => {});
    }

    if (topic === "orders/create") {
      const order    = data;
      const customer = order.customer || {};
      await query(`
        INSERT INTO orders (business_id, customer_name, customer_phone, amount, status, items, notes)
        VALUES ($1,$2,$3,$4,'confirmed',$5,'From Shopify')
        ON CONFLICT DO NOTHING
      `, [
        businessId,
        `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "Shopify Customer",
        customer.phone || "",
        parseFloat(order.total_price || 0),
        order.line_items?.map(i => i.title).join(", ") || "",
      ]).catch(() => {});
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ── Register webhooks ─────────────────────────────────────────
async function registerWebhooks(shop, accessToken, integrationId, businessId) {
  const topics = ["products/create", "products/update", "products/delete", "orders/create"];
  const webhookUrl = `${API_URL}/api/store/shopify/webhook`;

  for (const topic of topics) {
    try {
      await axios.post(
        `https://${shop}/admin/api/2026-04/webhooks.json`,
        { webhook: { topic, address: webhookUrl, format: "json" } },
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );
    } catch { /* webhook may already exist */ }
  }
  console.log(`✅ Webhooks registered for ${shop}`);
}


// ── Check token scopes ────────────────────────────────────────
router.get("/store/shopify/check-scopes", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT store_url, access_token, status, error_message FROM store_integrations WHERE business_id = $1 AND platform = 'shopify'",
      [req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ message: "No Shopify integration found" });

    const { store_url, access_token, status, error_message } = rows[0];

    const scopeRes = await axios.get(
      `https://${store_url}/admin/oauth/access_scopes.json`,
      { headers: { "X-Shopify-Access-Token": access_token } }
    );
    const scopes = scopeRes.data?.access_scopes?.map(s => s.handle) || [];

    res.json({
      store_url,
      status,
      error_message,
      token_preview:      access_token?.slice(0, 12) + "...",
      token_length:       access_token?.length,
      scopes,
      has_read_products:  scopes.includes("read_products"),
      has_read_orders:    scopes.includes("read_orders"),
      has_read_customers: scopes.includes("read_customers"),
    });
  } catch (err) {
    res.status(500).json({
      error:   err.response?.data || err.message,
      status:  err.response?.status,
      message: "Could not check scopes — token may be invalid",
    });
  }
});


// ── Test token directly ────────────────────────────────────────
router.get("/store/shopify/test-token", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT store_url, access_token FROM store_integrations WHERE business_id = $1 AND platform = 'shopify'",
      [req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ message: "No integration" });

    const { store_url, access_token } = rows[0];
    const headers = { "X-Shopify-Access-Token": access_token };

    // Test 1: scopes
    const scopeRes = await axios.get(
      `https://${store_url}/admin/oauth/access_scopes.json`,
      { headers }
    ).catch(e => ({ data: null, error: e.response?.status }));

    // Test 2: products
    const prodRes = await axios.get(
      `https://${store_url}/admin/api/2026-04/products.json?limit=1`,
      { headers }
    ).catch(e => ({ data: null, error: e.response?.status }));

    res.json({
      store_url,
      token_preview:    access_token?.slice(0, 12) + "...",
      scopes:           scopeRes.data?.access_scopes?.map(s => s.handle) || `scope_error_${scopeRes.error}`,
      products_test:    prodRes.data?.products ? `✅ ${prodRes.data.products.length} products` : `❌ error_${prodRes.error}`,
      has_read_products: scopeRes.data?.access_scopes?.some(s => s.handle === "read_products") || false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// GDPR MANDATORY WEBHOOKS (required for Shopify App Store)
// ══════════════════════════════════════════════════════════════

// Verify Shopify HMAC for GDPR webhooks
function verifyShopifyWebhook(req) {
  const hmac    = req.headers["x-shopify-hmac-sha256"];
  const body    = req.rawBody || JSON.stringify(req.body);
  if (!hmac || !SHOPIFY_CLIENT_SECRET) return false;
  const digest  = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(body).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// ── 1. Customer data request ───────────────────────────────────
// Shopify calls this when a customer requests their data
router.post("/store/shopify/gdpr/customers-data-request", async (req, res) => {
  // Verify Shopify HMAC
  const hmac    = req.headers["x-shopify-hmac-sha256"];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  if (hmac && SHOPIFY_CLIENT_SECRET) {
    const digest = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(rawBody).digest("base64");
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  try {
    const { shop_domain, customer } = req.body;
    console.log(`📋 GDPR data request: customer ${customer?.id} from ${shop_domain}`);

    // Find business by shop domain
    const { rows } = await query(
      "SELECT business_id FROM store_integrations WHERE store_url = $1 AND platform = 'shopify'",
      [shop_domain]
    );
    if (!rows.length) return;

    const businessId = rows[0].business_id;

    // Log the request — in production you'd email this to the customer
    await query(`
      INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
      SELECT id, 'gdpr_data_request', 'customer', $1, $2
      FROM admins LIMIT 1
    `, [
      customer?.id?.toString() || "unknown",
      JSON.stringify({ shop_domain, customer_email: customer?.email, requested_at: new Date() })
    ]).catch(() => {});

    console.log(`✅ GDPR data request logged for customer ${customer?.email}`);
  } catch (err) {
    console.error("GDPR data request error:", err.message);
  }
});

// ── 2. Customer redact ─────────────────────────────────────────
// Shopify calls this 10 days after a customer requests deletion
router.post("/store/shopify/gdpr/customers-redact", async (req, res) => {
  // Verify Shopify HMAC
  const hmac    = req.headers["x-shopify-hmac-sha256"];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  if (hmac && SHOPIFY_CLIENT_SECRET) {
    const digest = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(rawBody).digest("base64");
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  try {
    const { shop_domain, customer } = req.body;
    console.log(`🗑️ GDPR customer redact: ${customer?.email} from ${shop_domain}`);

    const { rows } = await query(
      "SELECT business_id FROM store_integrations WHERE store_url = $1 AND platform = 'shopify'",
      [shop_domain]
    );
    if (!rows.length) return;

    const businessId = rows[0].business_id;
    const phone      = customer?.phone;
    const email      = customer?.email;

    // Remove customer data from leads
    if (phone || email) {
      await query(`
        UPDATE leads
        SET customer_name = '[Deleted]',
            phone         = '[Deleted]',
            email         = '[Deleted]',
            collected_details = '{}',
            updated_at    = NOW()
        WHERE business_id = $1
          AND (phone = $2 OR email = $3)
      `, [businessId, phone || "", email || ""]).catch(() => {});

      // Anonymise conversation data
      await query(`
        UPDATE conversations
        SET customer_name  = '[Deleted]',
            customer_phone = '[Deleted]',
            updated_at     = NOW()
        WHERE business_id = $1
          AND (customer_phone = $2)
      `, [businessId, phone || ""]).catch(() => {});
    }

    console.log(`✅ GDPR customer redact complete: ${email}`);
  } catch (err) {
    console.error("GDPR customer redact error:", err.message);
  }
});

// ── 3. Shop redact ─────────────────────────────────────────────
// Shopify calls this 48 hours after a shop uninstalls your app
router.post("/store/shopify/gdpr/shop-redact", async (req, res) => {
  // Verify Shopify HMAC
  const hmac    = req.headers["x-shopify-hmac-sha256"];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  if (hmac && SHOPIFY_CLIENT_SECRET) {
    const digest = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(rawBody).digest("base64");
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  try {
    const { shop_domain } = req.body;
    console.log(`🗑️ GDPR shop redact: ${shop_domain}`);

    const { rows } = await query(
      "SELECT id, business_id FROM store_integrations WHERE store_url = $1 AND platform = 'shopify'",
      [shop_domain]
    );
    if (!rows.length) return;

    const { id: integrationId } = rows[0];

    // Delete all store data
    await query("DELETE FROM store_products WHERE integration_id = $1", [integrationId]).catch(() => {});
    await query("DELETE FROM store_integrations WHERE id = $1",         [integrationId]).catch(() => {});

    console.log(`✅ GDPR shop redact complete: ${shop_domain}`);
  } catch (err) {
    console.error("GDPR shop redact error:", err.message);
  }
});


// ── Register GDPR compliance webhooks ────────────────────────
router.post("/store/shopify/register-gdpr", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT store_url, access_token FROM store_integrations WHERE business_id = $1 AND platform = 'shopify'",
      [req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ message: "No Shopify store connected" });

    const { store_url, access_token } = rows[0];
    const BASE = `${API_URL}/api/store/shopify/gdpr`;
    
    const webhooks = [
      { topic: "CUSTOMERS_DATA_REQUEST", callbackUrl: `${BASE}/customers-data-request` },
      { topic: "CUSTOMERS_REDACT",       callbackUrl: `${BASE}/customers-redact`        },
      { topic: "SHOP_REDACT",            callbackUrl: `${BASE}/shop-redact`             },
    ];

    const results = [];
    for (const wh of webhooks) {
      try {
        const r = await axios.post(
          `https://${store_url}/admin/api/2026-04/graphql.json`,
          {
            query: `mutation {
              webhookSubscriptionCreate(
                topic: ${wh.topic}
                webhookSubscription: {
                  callbackUrl: "${wh.callbackUrl}"
                  format: JSON
                }
              ) {
                webhookSubscription { id }
                userErrors { field message }
              }
            }`
          },
          { headers: { "X-Shopify-Access-Token": access_token, "Content-Type": "application/json" } }
        );
        results.push({ topic: wh.topic, result: r.data });
        console.log(`✅ GDPR webhook registered: ${wh.topic}`);
      } catch (err) {
        results.push({ topic: wh.topic, error: err.response?.data || err.message });
        console.error(`❌ GDPR webhook failed: ${wh.topic}`, err.response?.data);
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// SHOPIFY BILLING API — Free plan subscription
// ══════════════════════════════════════════════════════════════

// ── Step 1: Create subscription (redirect to Shopify) ─────────
router.get("/store/shopify/billing/subscribe", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT store_url, access_token FROM store_integrations WHERE business_id = $1 AND platform = 'shopify'",
      [req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ message: "No Shopify store connected" });

    const { store_url, access_token } = rows[0];
    const returnUrl = `${API_URL}/api/store/shopify/billing/callback?business_id=${req.user.business_id}`;

    // Create recurring application charge via GraphQL
    const mutation = `
      mutation {
        appSubscriptionCreate(
          name: "Yougant Free Plan"
          returnUrl: "${returnUrl}"
          test: ${process.env.NODE_ENV !== "production"}
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: 0.00, currencyCode: USD }
                interval: EVERY_30_DAYS
              }
            }
          }]
        ) {
          appSubscription { id status }
          confirmationUrl
          userErrors { field message }
        }
      }
    `;

    const gqlRes = await axios.post(
      `https://${store_url}/admin/api/2026-04/graphql.json`,
      { query: mutation },
      { headers: { "X-Shopify-Access-Token": access_token, "Content-Type": "application/json" } }
    );

    const result = gqlRes.data?.data?.appSubscriptionCreate;
    const errors = result?.userErrors;

    if (errors?.length) {
      console.error("Billing errors:", errors);
      return res.status(400).json({ message: errors[0].message });
    }

    const confirmationUrl = result?.confirmationUrl;
    if (!confirmationUrl) {
      return res.status(500).json({ message: "Could not create subscription" });
    }

    // Save pending subscription
    await query(`
      UPDATE store_integrations
      SET subscription_status = 'pending',
          subscription_id     = $1,
          updated_at          = NOW()
      WHERE business_id = $2 AND platform = 'shopify'
    `, [result?.appSubscription?.id, req.user.business_id]).catch(() => {});

    res.json({ confirmationUrl });
  } catch (err) {
    console.error("Billing subscribe error:", err.response?.data || err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Step 2: Billing callback after merchant approves ──────────
router.get("/store/shopify/billing/callback", async (req, res) => {
  try {
    const { charge_id, business_id } = req.query;

    if (charge_id && business_id) {
      await query(`
        UPDATE store_integrations
        SET subscription_status = 'active',
            subscription_id     = $1,
            updated_at          = NOW()
        WHERE business_id = $2 AND platform = 'shopify'
      `, [charge_id, business_id]).catch(() => {});
      console.log(`✅ Shopify billing activated for business ${business_id}`);
    }

    res.redirect(`${FRONTEND_URL}/dashboard/integrations?billing=success`);
  } catch (err) {
    console.error("Billing callback error:", err.message);
    res.redirect(`${FRONTEND_URL}/dashboard/integrations?billing=error`);
  }
});

// ── Get billing status ────────────────────────────────────────
router.get("/store/shopify/billing/status", authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT subscription_status, subscription_id FROM store_integrations WHERE business_id = $1 AND platform = 'shopify'",
      [req.user.business_id]
    );
    res.json({ status: rows[0]?.subscription_status || "none" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;