// src/routes/billing.js
// Add to server.js: import billingRouter from "./routes/billing.js";
//                   app.use("/api", billingRouter);
//
// ENV VARS needed in Railway:
//   RAZORPAY_KEY_ID     = rzp_live_XXXX
//   RAZORPAY_KEY_SECRET = XXXX
//   FRONTEND_URL        = https://yougant.com

import express   from "express";
import Razorpay  from "razorpay";
import crypto    from "crypto";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// Razorpay instance (lazy — only if keys present)
const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay keys not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to Railway env vars.");
  }
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

// INR conversion rate (USD → INR)
const USD_TO_INR = 84;

// ── Public: Get all active plans ──────────────────────────────
router.get("/plans/public", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        id::text,
        name::text,
        display_name,
        price_monthly,
        message_limit,
        doc_limit,
        COALESCE(token_limit, 0)                               AS token_limit,
        COALESCE(trial_days, 0)                                AS trial_days,
        COALESCE(amount_inr, ROUND(price_monthly * 84))        AS amount_inr,
        COALESCE(discount_pct, 0)                              AS discount_pct,
        COALESCE(offer_text, '')                               AS offer_text,
        is_active
      FROM plans
      WHERE is_active = TRUE
      ORDER BY COALESCE(amount_inr, price_monthly * 84) ASC
    `);
    res.json({ plans: rows });
  } catch (err) {
    console.error("Plans fetch error:", err.message);
    res.status(500).json({ message: "Failed to load plans: " + err.message });
  }
});

// All routes below require auth
router.use(authMiddleware);

// ── POST /billing/select-free-plan — activate free/trial plan ─
router.post("/billing/select-free-plan", async (req, res) => {
  try {
    const { plan_id } = req.body;
    const bId = req.user.business_id;

    const { rows: planRows } = await query(
      "SELECT * FROM plans WHERE id = $1 AND is_active = TRUE", [plan_id]
    );
    if (!planRows.length) return res.status(404).json({ message: "Plan not found" });

    const plan = planRows[0];

    if (plan.price_monthly > 0 && (plan.trial_days === 0 || !plan.trial_days)) {
      return res.status(400).json({ message: "Paid plans require payment. Use /billing/create-order instead." });
    }

    const now      = new Date();
    const trialEnd = plan.trial_days > 0
      ? new Date(now.getTime() + plan.trial_days * 24 * 60 * 60 * 1000)
      : null;
    const cycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const status   = plan.trial_days > 0 ? "trialing" : "active";

    await query(`
      INSERT INTO subscriptions
        (business_id, plan_id, status, billing_cycle_start, billing_cycle_end,
         trial_ends_at, messages_used, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE)
      ON CONFLICT (business_id) DO UPDATE SET
        plan_id             = $2,
        status              = $3,
        billing_cycle_start = $4,
        billing_cycle_end   = $5,
        trial_ends_at       = $6,
        messages_used       = 0,
        is_active           = TRUE,
        updated_at          = NOW()
    `, [bId, plan.id, status, now, cycleEnd, trialEnd]);

    // Mark onboarding complete
    await query(
      "UPDATE users SET onboarding_completed = TRUE, updated_at = NOW() WHERE id = $1",
      [req.user.id]
    ).catch(() => {});

    console.log(`✅ Free/trial plan activated: ${plan.name} for business ${bId}`);
    res.json({ success: true, status });
  } catch (err) {
    console.error("Free plan activation error:", err.message);
    res.status(500).json({ message: "Failed to activate plan: " + err.message });
  }
});

// ── POST /onboarding/select-plan — alias used by Onboarding.jsx ─
router.post("/onboarding/select-plan", async (req, res) => {
  try {
    const { plan_id } = req.body;
    const bId = req.user.business_id;

    const { rows: planRows } = await query(
      "SELECT * FROM plans WHERE id = $1 AND is_active = TRUE", [plan_id]
    );
    if (!planRows.length) return res.status(404).json({ message: "Plan not found" });

    const plan     = planRows[0];
    const now      = new Date();
    const trialEnd = plan.trial_days > 0
      ? new Date(now.getTime() + plan.trial_days * 24 * 60 * 60 * 1000)
      : null;
    const cycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const status   = plan.price_monthly === 0
      ? "active"
      : plan.trial_days > 0 ? "trialing" : "active";

    await query(`
      INSERT INTO subscriptions
        (business_id, plan_id, status, billing_cycle_start, billing_cycle_end,
         trial_ends_at, messages_used, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE)
      ON CONFLICT (business_id) DO UPDATE SET
        plan_id             = $2,
        status              = $3,
        billing_cycle_start = $4,
        billing_cycle_end   = $5,
        trial_ends_at       = $6,
        messages_used       = 0,
        is_active           = TRUE,
        updated_at          = NOW()
    `, [bId, plan.id, status, now, cycleEnd, trialEnd]);

    await query(
      "UPDATE users SET onboarding_completed = TRUE, updated_at = NOW() WHERE id = $1",
      [req.user.id]
    ).catch(() => {});

    console.log(`✅ Onboarding plan selected: ${plan.name} for business ${bId}`);
    res.json({ success: true, status, plan_name: plan.name });
  } catch (err) {
    console.error("Onboarding plan select error:", err.message);
    res.status(500).json({ message: "Failed to select plan: " + err.message });
  }
});

// ── GET /billing/current — current plan + subscription info ───
router.get("/billing/current", async (req, res) => {
  try {
    const bId = req.user.business_id;

    const { rows: subRows } = await query(`
      SELECT
        s.id,
        s.business_id,
        s.plan_id,
        s.messages_used,
        s.billing_cycle_start,
        s.billing_cycle_end,
        s.trial_ends_at,
        s.is_active,
        CASE WHEN s.trial_ends_at > NOW() THEN 'trialing'
             WHEN s.is_active = TRUE THEN 'active'
             ELSE 'inactive' END AS status,
        p.name::text              AS plan_name,
        p.display_name            AS plan_display_name,
        p.price_monthly,
        p.message_limit,
        p.doc_limit,
        COALESCE(p.token_limit, 0) AS token_limit,
        COALESCE(p.trial_days, 0)  AS trial_days,
        b.name                     AS business_name,
        b.address,
        u.owner_name,
        u.email
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      JOIN businesses b ON b.id = s.business_id
      JOIN users u ON u.business_id = s.business_id AND u.role = 'owner'
      WHERE s.business_id = $1::uuid
      ORDER BY s.created_at DESC LIMIT 1
    `, [bId]);

    if (!subRows.length) {
      // No subscription — return empty state
      return res.json({
        plan_name:         null,
        plan_display_name: "No Plan",
        status:            "none",
        messages_used:     0,
        message_limit:     0,
      });
    }

    const sub = subRows[0];

    // Get actual message usage + token usage this month
    const [usageRows, tokenRows] = await Promise.all([
      query(`
        SELECT COUNT(*) AS cnt FROM messages
        WHERE business_id = $1 AND role = 'agent'
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
      `, [bId]),
      query(`
        SELECT COALESCE(SUM(total_tokens), 0) AS tokens_used
        FROM ai_usage_logs
        WHERE business_id = $1
          AND created_at >= date_trunc('month', NOW())
      `, [bId]).catch(() => ({ rows: [{ tokens_used: 0 }] })),
    ]);

    const actualUsed  = parseInt(usageRows[0]?.cnt)            || 0;
    const tokensUsed  = parseInt(tokenRows[0]?.tokens_used)    || 0;
    const tokenLimit  = parseInt(sub.token_limit)              || 0;
    const tokenPct    = tokenLimit > 0 ? Math.round((tokensUsed / tokenLimit) * 100) : 0;

    res.json({
      ...sub,
      messages_used: actualUsed,
      tokens_used:   tokensUsed,
      token_limit:   tokenLimit,
      token_pct:     tokenPct,
    });
  } catch (err) {
    console.error("Billing current error:", err.message);
    res.status(500).json({ message: "Failed to load billing info" });
  }
});

// ── GET /billing/payments — payment history ───────────────────
router.get("/billing/payments", async (req, res) => {
  try {
    const bId = req.user.business_id;

    const { rows } = await query(`
      SELECT
        ph.*,
        p.name         AS plan_name,
        p.display_name AS plan_display_name,
        p.message_limit
      FROM payment_history ph
      LEFT JOIN plans p ON p.id::text = ph.plan_id::text
      WHERE ph.business_id = $1
      ORDER BY ph.created_at DESC
      LIMIT 50
    `, [bId]);

    res.json({ payments: rows });
  } catch (err) {
    console.error("Payment history error:", err.message);
    res.status(500).json({ message: "Failed to load payment history" });
  }
});

// ── POST /billing/create-order — create Razorpay order ───────
router.post("/billing/create-order", async (req, res) => {
  try {
    const bId         = req.user.business_id;
    const { plan_id } = req.body;

    if (!plan_id) return res.status(400).json({ message: "plan_id required" });

    // Validate plan
    const { rows: planRows } = await query(
      "SELECT id::text, name::text, display_name, price_monthly, message_limit, doc_limit, COALESCE(trial_days,0) AS trial_days FROM plans WHERE id = $1::uuid AND is_active = TRUE",
      [plan_id]
    );
    if (!planRows.length) return res.status(404).json({ message: "Plan not found" });

    const plan      = planRows[0];
    const amountINR = Math.round(plan.price_monthly * USD_TO_INR);

    if (amountINR <= 0) {
      return res.status(400).json({ message: "Cannot create order for free plan" });
    }

    // Get business info for prefill
    const { rows: bizRows } = await query(`
      SELECT b.name, b.address, b.phone, u.owner_name, u.email
      FROM businesses b
      JOIN users u ON u.business_id = b.id AND u.role = 'owner'
      WHERE b.id = $1
    `, [bId]);

    const biz = bizRows[0] || {};

    // Create Razorpay order
    const razorpay = getRazorpay();
    const order    = await razorpay.orders.create({
      amount:   amountINR * 100, // paise
      currency: "INR",
      receipt:  `rcpt_${Date.now().toString().slice(-10)}`,
      notes: {
        business_id: bId,
        plan_id,
        plan_name: plan.name,
      },
    });

    // Save pending payment record
    await query(`
      INSERT INTO payment_history
        (business_id, plan_id, amount, currency, status,
         razorpay_order_id, description, created_at)
      VALUES ($1::uuid, $2::uuid, $3, 'INR', 'pending', $4, $5, NOW())
    `, [
      bId, plan_id, amountINR,
      order.id,
      `${plan.display_name} Plan — Monthly`,
    ]);

    res.json({
      razorpay_order_id: order.id,
      amount:            order.amount,
      currency:          order.currency,
      owner_name:        biz.owner_name || "",
      email:             biz.email      || "",
      phone:             biz.phone      || "",
    });

  } catch (err) {
    // Razorpay errors come as objects with error.description
    const errMsg = err?.error?.description
      || err?.message
      || err?.description
      || JSON.stringify(err)
      || "Failed to create payment order";
    console.error("Create order error:", errMsg, JSON.stringify(err));
    res.status(500).json({ message: errMsg });
  }
});

// ── POST /billing/verify-payment — verify + activate plan ────
router.post("/billing/verify-payment", async (req, res) => {
  try {
    const bId = req.user.business_id;
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan_id,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Missing payment verification fields" });
    }

    // Verify HMAC signature
    const keySecret   = process.env.RAZORPAY_KEY_SECRET;
    const body        = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSig = crypto
      .createHmac("sha256", keySecret)
      .update(body)
      .digest("hex");

    if (expectedSig !== razorpay_signature) {
      console.error(`❌ Payment signature mismatch for order ${razorpay_order_id}`);
      return res.status(400).json({ message: "Payment verification failed — signature mismatch" });
    }

    // Get plan
    const { rows: planRows } = await query("SELECT id::text, name::text, display_name, price_monthly, message_limit FROM plans WHERE id = $1::uuid", [plan_id]);
    if (!planRows.length) return res.status(404).json({ message: "Plan not found" });
    const plan = planRows[0];

    const now             = new Date();
    const billingCycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const invoiceNumber   = `INV-${Date.now().toString().slice(-8)}`;
    const amountINR       = Math.round(plan.price_monthly * USD_TO_INR);

    // Update payment record to paid
    await query(`
      UPDATE payment_history
      SET status              = 'paid',
          razorpay_payment_id = $1,
          razorpay_signature  = $2,
          invoice_number      = $3,
          paid_at             = NOW(),
          period_start        = NOW(),
          period_end          = $4,
          updated_at          = NOW()
      WHERE razorpay_order_id = $5 AND business_id = $6::uuid
    `, [
      razorpay_payment_id,
      razorpay_signature,
      invoiceNumber,
      billingCycleEnd,
      razorpay_order_id,
      bId,
    ]);

    // Activate / upgrade subscription — upsert safely
    const { rows: existingSub } = await query(
      "SELECT id FROM subscriptions WHERE business_id = $1::uuid",
      [bId]
    );

    if (existingSub.length > 0) {
      await query(`
        UPDATE subscriptions
        SET plan_id              = $1::uuid,
            is_active            = TRUE,
            trial_ends_at        = NULL,
            billing_cycle_start  = NOW(),
            billing_cycle_end    = $2,
            messages_used        = 0,
            updated_at           = NOW()
        WHERE business_id = $3::uuid
      `, [plan_id, billingCycleEnd, bId]);
    } else {
      await query(`
        INSERT INTO subscriptions
          (business_id, plan_id, is_active, billing_cycle_start,
           billing_cycle_end, messages_used, created_at, updated_at)
        VALUES ($1::uuid, $2::uuid, TRUE, NOW(), $3, 0, NOW(), NOW())
      `, [bId, plan_id, billingCycleEnd]);
    }

    // Update message_limit in agent_configs for sidebar
    await query(`
      UPDATE agent_configs SET message_limit = $1, updated_at = NOW()
      WHERE business_id = $2::uuid
    `, [plan.message_limit, bId]);

    console.log(`✅ Payment verified & plan activated: business ${bId} → ${plan.name} (${razorpay_payment_id})`);

    res.json({
      success:        true,
      plan:           plan.name,
      invoice_number: invoiceNumber,
      amount:         amountINR,
    });

  } catch (err) {
    const errMsg = err?.message || JSON.stringify(err) || "Unknown error";
    console.error("Verify payment error FULL:", errMsg, JSON.stringify(err));
    res.status(500).json({ message: "Activation failed: " + errMsg });
  }
});

// ── POST /billing/webhook — Razorpay webhooks ─────────────────
// Add to Meta webhook URL in Razorpay dashboard:
// https://voxiroapi-production.up.railway.app/api/billing/webhook
router.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const webhookSecret   = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSig     = req.headers["x-razorpay-signature"];
    const body            = req.body;

    if (webhookSecret) {
      const expectedSig = crypto
        .createHmac("sha256", webhookSecret)
        .update(body)
        .digest("hex");
      if (expectedSig !== receivedSig) {
        console.error("Razorpay webhook signature mismatch");
        return res.status(400).json({ message: "Invalid signature" });
      }
    }

    const event   = JSON.parse(body);
    const payload = event.payload?.payment?.entity;

    if (event.event === "payment.captured" && payload) {
      const orderId   = payload.order_id;
      const paymentId = payload.id;

      // Update payment record
      await query(`
        UPDATE payment_history
        SET status = 'paid', razorpay_payment_id = $1, paid_at = NOW(), updated_at = NOW()
        WHERE razorpay_order_id = $2 AND status = 'pending'
      `, [paymentId, orderId]);

      console.log(`✅ Webhook: payment captured ${paymentId}`);
    }

    if (event.event === "payment.failed" && payload) {
      await query(`
        UPDATE payment_history
        SET status = 'failed', updated_at = NOW()
        WHERE razorpay_order_id = $1
      `, [payload.order_id]);

      console.log(`❌ Webhook: payment failed for order ${payload.order_id}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

export default router;