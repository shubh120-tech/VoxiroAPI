import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const confirmOrderTool = {
  name: "confirm_order",
  description: "Confirm and save a customer order when they agree to purchase something.",
  input_schema: {
    type: "object",
    properties: {
      customer_name:  { type: "string",  description: "Customer name" },
      customer_phone: { type: "string",  description: "Customer phone number" },
      items:          { type: "string",  description: "What they ordered — description of items" },
      amount:         { type: "number",  description: "Total order amount in numbers only" },
      currency:       { type: "string",  description: "Currency code e.g. USD, INR, AED", default: "USD" },
      notes:          { type: "string",  description: "Any special instructions" },
    },
    required: ["customer_phone", "items", "amount"],
  },
};

export async function executeConfirmOrder({ businessId, conversationId, input }) {
  const { customer_name, customer_phone, items, amount, currency = "USD", notes } = input;

  const { rows } = await query(`
    INSERT INTO orders (business_id, conversation_id, customer_name, customer_phone, items, amount, currency, status, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8)
    RETURNING id
  `, [businessId, conversationId, customer_name, customer_phone, items, amount, currency, notes]);

  await query(`
    INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
    VALUES ($1, 'order', $2, '📦', '#f0fdf4', $3, 'order')
  `, [businessId, `Order confirmed: ${customer_name || customer_phone} — ${currency} ${amount}`, rows[0].id]);

  await notifyOwnerWhatsApp(businessId,
    `📦 *Order Confirmed*\nCustomer: ${customer_name || customer_phone}\nItems: ${items}\nAmount: ${currency} ${amount}`
  );

  return { success: true, orderId: rows[0].id };
}
