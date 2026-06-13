import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const confirmOrderTool = {
  name: "confirm_order",
  description: `Confirm and save a customer order when they agree to purchase.

IMPORTANT RULES:
1. Before confirming, ALWAYS collect: items, quantity, amount
2. ASK for payment_method if customer hasn't mentioned it (COD, UPI, Card, etc.)
3. ASK for delivery_address if this business delivers physical products
4. If customer already has a pending order (within 24h), this updates it instead of creating a duplicate
5. Use the actual product names from this business's catalog — do NOT assume any specific industry

Only call this when customer CLEARLY confirms they want to buy/order.`,

  input_schema: {
    type: "object",
    properties: {
      customer_name:    { type: "string", description: "Customer name" },
      customer_phone:   { type: "string", description: "Customer phone number" },
      items:            { type: "string", description: "What they ordered — use actual product/service names from this business. Include quantity if multiple." },
      amount:           { type: "number", description: "Total order amount in numbers only" },
      currency:         { type: "string", description: "Currency code. Default INR for Indian businesses.", default: "INR" },
      payment_method:   { type: "string", description: "How customer will pay. MUST ask customer if not mentioned. Options: COD (Cash on Delivery), UPI (GPay/PhonePe/Paytm), Card, Net Banking, Prepaid", enum: ["COD", "UPI", "Card", "Net Banking", "Prepaid", "Other"] },
      delivery_address: { type: "string", description: "Delivery address — MUST ask if this business ships/delivers products. Not needed for services like salons, restaurants (dine-in), consultations." },
      notes:            { type: "string", description: "Special instructions — size, color, customization, delivery time preference, etc." },
    },
    required: ["customer_phone", "items", "amount"],
  },
};

export async function executeConfirmOrder({ businessId, conversationId, input }) {
  const {
    customer_name, customer_phone, items, amount,
    currency = "INR", payment_method, delivery_address, notes
  } = input;

  try {
    // Check for existing pending/confirmed order (within 24h) to prevent duplicates
    const { rows: existing } = await query(`
      SELECT id, items, amount, status FROM orders
      WHERE business_id = $1
        AND customer_phone = $2
        AND status IN ('pending', 'confirmed')
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `, [businessId, customer_phone]);

    let orderId;
    let isUpdate = false;

    if (existing.length > 0) {
      // Update existing order
      orderId = existing[0].id;
      isUpdate = true;

      await query(`
        UPDATE orders SET
          customer_name    = COALESCE(NULLIF($1, ''), orders.customer_name),
          items            = $2,
          amount           = $3,
          currency         = $4,
          payment_method   = COALESCE(NULLIF($5, ''), orders.payment_method),
          delivery_address = COALESCE(NULLIF($6, ''), orders.delivery_address),
          notes            = COALESCE(NULLIF($7, ''), orders.notes),
          status           = 'confirmed',
          conversation_id  = COALESCE($8, orders.conversation_id),
          updated_at       = NOW()
        WHERE id = $9
      `, [
        customer_name || null, items, amount, currency,
        payment_method || null, delivery_address || null, notes || null,
        conversationId, orderId
      ]);

      console.log(`📦 Order UPDATED (prevented duplicate): ${customer_phone} — ${currency} ${amount}`);
    } else {
      // Create new order
      const { rows } = await query(`
        INSERT INTO orders
          (business_id, conversation_id, customer_name, customer_phone,
           items, amount, currency, payment_method, delivery_address, status, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', $10)
        RETURNING id
      `, [
        businessId, conversationId, customer_name, customer_phone,
        items, amount, currency,
        payment_method || null, delivery_address || null, notes || null
      ]);
      orderId = rows[0].id;

      console.log(`📦 New order: ${customer_phone} — ${currency} ${amount}`);
    }

    // Log activity
    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
      VALUES ($1, 'order', $2, '📦', '#f0fdf4', $3, 'order')
    `, [
      businessId,
      `Order ${isUpdate ? 'updated' : 'confirmed'}: ${customer_name || customer_phone} — ${currency} ${amount}${payment_method ? ' (' + payment_method + ')' : ''}`,
      orderId
    ]).catch(() => {});

    // Notify owner
    const parts = [`📦 *Order ${isUpdate ? 'Updated' : 'Confirmed'}*`];
    parts.push(`Customer: ${customer_name || customer_phone}`);
    parts.push(`Items: ${items}`);
    parts.push(`Amount: ${currency} ${amount}`);
    if (payment_method)   parts.push(`Payment: ${payment_method}`);
    if (delivery_address) parts.push(`Address: ${delivery_address}`);
    if (notes)            parts.push(`Notes: ${notes}`);

    await notifyOwnerWhatsApp(businessId, parts.join("\n"));

    return { success: true, orderId, isUpdate };

  } catch (err) {
    console.error("Confirm order error:", err.message);
    return { success: false, error: err.message };
  }
}