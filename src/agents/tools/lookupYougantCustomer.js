import { query } from "../../db/postgres.js";

// ── Tool definition for Claude ──────────────────────────────
export const lookupYougantCustomerTool = {
  name: "lookup_yougant_customer",
  description:
    "Check if the person messaging is an EXISTING Yougant customer (business owner who already " +
    "has a Yougant account). Call this ONCE at the start of every new conversation, before " +
    "pitching plans or pricing. Looks up by their WhatsApp phone number. " +
    "If they ARE an existing customer: do NOT pitch plans or pricing — instead treat this as a " +
    "support/account conversation (help with their issue, billing question, renewal, etc). " +
    "If they are NOT an existing customer: treat as a new lead — proceed with normal sales flow.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// ── Execute ───────────────────────────────────────────────────
// ctx.customerPhone is the WhatsApp number of the person messaging Yougant
export async function executeLookupYougantCustomer({ customerPhone }) {
  try {
    const normalized = normalizePhone(customerPhone);
    const variants    = phoneVariants(normalized);

    // Match against businesses.phone OR users.phone (owner's contact number)
    const { rows } = await query(`
      SELECT
        b.id                AS business_id,
        b.name              AS business_name,
        b.phone             AS business_phone,
        b.onboarding_completed,
        b.is_active,
        b.created_at        AS signup_date,
        u.owner_name,
        u.email,
        s.status            AS subscription_status,
        s.trial_ends_at,
        s.billing_cycle_end,
        s.messages_used,
        s.is_active         AS subscription_is_active,
        p.name              AS plan_name,
        p.display_name      AS plan_display_name,
        p.price_inr,
        p.message_limit
      FROM businesses b
      JOIN users u ON u.business_id = b.id AND u.type = 'owner'
      LEFT JOIN subscriptions s ON s.business_id = b.id
      LEFT JOIN plans p ON p.id = s.plan_id
      WHERE u.phone = ANY($1)
         OR b.phone = ANY($1)
      ORDER BY b.created_at DESC
      LIMIT 1
    `, [variants]);

    if (!rows.length) {
      return {
        is_existing_customer: false,
        note: "This person is NOT an existing Yougant customer. Treat as a new lead — proceed with normal sales/pitch flow.",
      };
    }

    const c = rows[0];

    // Determine plan status in plain terms
    let planStatus = "no plan selected";
    let trialInfo  = null;

    if (c.subscription_status) {
      planStatus = c.subscription_status; // active, trialing, cancelled, past_due etc
    } else if (c.subscription_is_active === true) {
      planStatus = "active";
    } else if (c.subscription_is_active === false) {
      planStatus = "inactive";
    }

    if (c.trial_ends_at) {
      const trialEnd = new Date(c.trial_ends_at);
      const now      = new Date();
      trialInfo = trialEnd > now
        ? `Trial active, ends ${trialEnd.toISOString().slice(0,10)}`
        : `Trial ended on ${trialEnd.toISOString().slice(0,10)}`;
    }

    // Recent payment history (last 3)
    const { rows: payments } = await query(`
      SELECT amount, status, description, created_at
      FROM payment_history
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 3
    `, [c.business_id]).catch(() => ({ rows: [] }));

    return {
      is_existing_customer: true,
      business_name:        c.business_name,
      owner_name:           c.owner_name,
      email:                c.email,
      signup_date:          c.signup_date ? new Date(c.signup_date).toISOString().slice(0,10) : null,
      onboarding_completed: c.onboarding_completed,
      account_active:       c.is_active,
      plan_name:            c.plan_display_name || c.plan_name || "No plan selected",
      plan_price_inr:       c.price_inr || null,
      message_limit:        c.message_limit || null,
      messages_used:        c.messages_used || 0,
      subscription_status:  planStatus,
      trial_info:           trialInfo,
      billing_cycle_end:    c.billing_cycle_end ? new Date(c.billing_cycle_end).toISOString().slice(0,10) : null,
      recent_payments:      payments.map(p => ({
        amount: p.amount, status: p.status, date: new Date(p.created_at).toISOString().slice(0,10), description: p.description,
      })),
      note:
        "This is an EXISTING Yougant customer. Do NOT pitch plans, pricing, or discounts. " +
        "Treat this as a support conversation — help with their question, account issue, billing, " +
        "renewal, or feature request. Greet them by name if appropriate. If they have a technical " +
        "issue you can't resolve, use notify_owner or register_complaint as usual " +
        "(Yougant team will follow up).",
    };
  } catch (err) {
    console.error("lookup_yougant_customer error:", err.message);
    return { is_existing_customer: false, error: "Lookup failed — treat as new lead" };
  }
}

// ── Phone normalization helpers ─────────────────────────────
function normalizePhone(phone) {
  let cleaned = (phone || "").replace(/[\s\-().]/g, "");
  if (cleaned.startsWith("+")) cleaned = cleaned.slice(1);
  if (cleaned.length === 10) cleaned = "91" + cleaned; // assume India
  return cleaned;
}

// Generate variants to match different storage formats in DB
// (some rows might have +91XXXXXXXXXX, some 91XXXXXXXXXX, some XXXXXXXXXX)
function phoneVariants(normalized) {
  const variants = new Set();
  variants.add(normalized);            // 919876543210
  variants.add("+" + normalized);      // +919876543210
  if (normalized.startsWith("91") && normalized.length === 12) {
    variants.add(normalized.slice(2)); // 9876543210
  }
  return [...variants];
}