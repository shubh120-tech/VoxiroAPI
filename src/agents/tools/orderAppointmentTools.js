import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

// ── Tool: Update Appointment ──────────────────────────────────
export const updateAppointmentTool = {
  name: "update_appointment",
  description: "Update or reschedule an existing appointment when customer wants to change the time, date, service, or duration. Use actual service names from this business.",
  input_schema: {
    type: "object",
    properties: {
      customer_phone: { type: "string", description: "Customer phone number to find their appointment" },
      scheduled_at:   { type: "string", description: "New date and time in IST e.g. 2026-06-10T14:00:00. Treat as IST (UTC+5:30)." },
      service:        { type: "string", description: "Updated service name if changed" },
      duration_mins:  { type: "number", description: "Updated duration in minutes" },
      notes:          { type: "string", description: "Any updated notes or special requests" },
    },
    required: ["customer_phone"],
  },
};

// ── Tool: Cancel Appointment ──────────────────────────────────
export const cancelAppointmentTool = {
  name: "cancel_appointment",
  description: "Cancel an existing appointment when customer requests cancellation.",
  input_schema: {
    type: "object",
    properties: {
      customer_phone: { type: "string", description: "Customer phone number" },
      reason:         { type: "string", description: "Reason for cancellation if provided" },
    },
    required: ["customer_phone"],
  },
};

// ── Tool: Update Order ────────────────────────────────────────
export const updateOrderTool = {
  name: "update_order",
  description: "Update an existing order when customer wants to change items, quantity, delivery address, payment method, or any other detail. Use actual product names from this business.",
  input_schema: {
    type: "object",
    properties: {
      customer_phone:   { type: "string", description: "Customer phone number" },
      items:            { type: "string", description: "Updated items or changes requested" },
      amount:           { type: "number", description: "Updated total amount if changed" },
      payment_method:   { type: "string", description: "Updated payment method: COD, UPI, Card, Net Banking" },
      delivery_address: { type: "string", description: "Updated delivery address" },
      notes:            { type: "string", description: "Any updated instructions" },
    },
    required: ["customer_phone"],
  },
};

// ── Tool: Cancel Order ────────────────────────────────────────
export const cancelOrderTool = {
  name: "cancel_order",
  description: "Cancel an existing order when customer requests cancellation.",
  input_schema: {
    type: "object",
    properties: {
      customer_phone: { type: "string", description: "Customer phone number" },
      reason:         { type: "string", description: "Reason for cancellation if provided" },
    },
    required: ["customer_phone"],
  },
};

// ── Tool: Update Follow-up ────────────────────────────────────
export const updateFollowupTool = {
  name: "update_followup",
  description: "Update or reschedule an existing follow-up when customer wants to be contacted at a different time.",
  input_schema: {
    type: "object",
    properties: {
      customer_phone: { type: "string", description: "Customer phone number" },
      scheduled_at:   { type: "string", description: "New follow-up date and time in IST e.g. 2026-06-10T14:00:00" },
      message:        { type: "string", description: "Updated follow-up message if changed" },
    },
    required: ["customer_phone"],
  },
};

// ── Tool: Cancel Follow-up ────────────────────────────────────
export const cancelFollowupTool = {
  name: "cancel_followup",
  description: "Cancel a scheduled follow-up when customer says they no longer need a callback or follow-up.",
  input_schema: {
    type: "object",
    properties: {
      customer_phone: { type: "string", description: "Customer phone number" },
      reason:         { type: "string", description: "Reason for cancellation if provided" },
    },
    required: ["customer_phone"],
  },
};

// ── Helpers ───────────────────────────────────────────────────
function parseISTtoUTC(dateTimeStr) {
  if (!dateTimeStr) return null;
  if (dateTimeStr.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dateTimeStr)) {
    return new Date(dateTimeStr).toISOString();
  }
  try {
    const istDate = new Date(dateTimeStr + "+05:30");
    if (!isNaN(istDate.getTime())) return istDate.toISOString();
  } catch {}
  const date = new Date(dateTimeStr);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function toISTString(isoStr) {
  return new Date(isoStr).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

// ── Execute: Update Appointment ───────────────────────────────
export async function executeUpdateAppointment({ businessId, conversationId, customerPhone, input }) {
  const { customer_phone, scheduled_at, service, duration_mins, notes } = input;
  const phone = customer_phone || customerPhone;

  const { rows: existing } = await query(`
    SELECT id, service, scheduled_at FROM appointments
    WHERE business_id = $1 AND customer_phone = $2 AND status IN ('confirmed', 'pending')
    ORDER BY created_at DESC LIMIT 1
  `, [businessId, phone]);

  if (!existing.length) return { success: false, message: "No active appointment found for this customer" };

  const appt = existing[0];
  const sets = []; const params = [];
  let idx = 0;

  if (scheduled_at) {
    const utc = parseISTtoUTC(scheduled_at);
    if (utc) { idx++; sets.push(`scheduled_at = $${idx}`); params.push(utc); }
  }
  if (service)       { idx++; sets.push(`service = $${idx}`);       params.push(service); }
  if (duration_mins) { idx++; sets.push(`duration_mins = $${idx}`); params.push(duration_mins); }
  if (notes)         { idx++; sets.push(`notes = $${idx}`);         params.push(notes); }
  sets.push(`updated_at = NOW()`);

  idx++; params.push(appt.id);
  idx++; params.push(businessId);
  await query(`UPDATE appointments SET ${sets.join(", ")} WHERE id = $${idx-1} AND business_id = $${idx}`, params);

  const newTime = scheduled_at ? toISTString(parseISTtoUTC(scheduled_at)) : toISTString(appt.scheduled_at);

  await notifyOwnerWhatsApp(businessId,
    `📅 *Appointment Updated*\nCustomer: ${phone}\nService: ${service || appt.service}\nNew time: ${newTime} IST`
  );

  return { success: true, message: `Appointment rescheduled to ${newTime} IST` };
}

// ── Execute: Cancel Appointment ───────────────────────────────
export async function executeCancelAppointment({ businessId, conversationId, customerPhone, input }) {
  const { customer_phone, reason } = input;
  const phone = customer_phone || customerPhone;

  const { rows: existing } = await query(`
    SELECT id, service, scheduled_at FROM appointments
    WHERE business_id = $1 AND customer_phone = $2 AND status IN ('confirmed', 'pending')
    ORDER BY created_at DESC LIMIT 1
  `, [businessId, phone]);

  if (!existing.length) return { success: false, message: "No active appointment found for this customer" };

  await query(`UPDATE appointments SET status = 'cancelled', notes = COALESCE(notes || ' | ', '') || $1, updated_at = NOW() WHERE id = $2`,
    [reason ? `Cancelled: ${reason}` : "Cancelled by customer", existing[0].id]);

  const displayTime = toISTString(existing[0].scheduled_at);
  await notifyOwnerWhatsApp(businessId,
    `❌ *Appointment Cancelled*\nCustomer: ${phone}\nService: ${existing[0].service}\nWas: ${displayTime} IST${reason ? `\nReason: ${reason}` : ""}`
  );

  return { success: true, message: "Appointment cancelled successfully" };
}

// ── Execute: Update Order ─────────────────────────────────────
export async function executeUpdateOrder({ businessId, conversationId, customerPhone, input }) {
  const { customer_phone, items, amount, payment_method, delivery_address, notes } = input;
  const phone = customer_phone || customerPhone;

  const { rows: existing } = await query(`
    SELECT id, items, amount FROM orders
    WHERE business_id = $1 AND customer_phone = $2 AND status IN ('pending', 'confirmed')
    ORDER BY created_at DESC LIMIT 1
  `, [businessId, phone]);

  if (!existing.length) return { success: false, message: "No active order found for this customer" };

  const order = existing[0];
  const sets = []; const params = [];
  let idx = 0;

  if (items)            { idx++; sets.push(`items = $${idx}`);            params.push(items); }
  if (amount)           { idx++; sets.push(`amount = $${idx}`);           params.push(amount); }
  if (payment_method)   { idx++; sets.push(`payment_method = $${idx}`);   params.push(payment_method); }
  if (delivery_address) { idx++; sets.push(`delivery_address = $${idx}`); params.push(delivery_address); }
  if (notes)            { idx++; sets.push(`notes = $${idx}`);            params.push(notes); }
  sets.push(`updated_at = NOW()`);

  idx++; params.push(order.id);
  idx++; params.push(businessId);
  await query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $${idx-1} AND business_id = $${idx}`, params);

  const changes = [items, payment_method, delivery_address, notes].filter(Boolean).join(", ") || "details updated";
  await notifyOwnerWhatsApp(businessId,
    `📦 *Order Updated*\nCustomer: ${phone}\nChanges: ${changes}${amount ? `\nNew amount: ${amount}` : ""}`
  );

  return { success: true, message: "Order updated successfully" };
}

// ── Execute: Cancel Order ─────────────────────────────────────
export async function executeCancelOrder({ businessId, conversationId, customerPhone, input }) {
  const { customer_phone, reason } = input;
  const phone = customer_phone || customerPhone;

  const { rows: existing } = await query(`
    SELECT id, items, amount FROM orders
    WHERE business_id = $1 AND customer_phone = $2 AND status IN ('pending', 'confirmed')
    ORDER BY created_at DESC LIMIT 1
  `, [businessId, phone]);

  if (!existing.length) return { success: false, message: "No active order found for this customer" };

  await query(`UPDATE orders SET status = 'cancelled', notes = COALESCE(notes || ' | ', '') || $1, updated_at = NOW() WHERE id = $2`,
    [reason ? `Cancelled: ${reason}` : "Cancelled by customer", existing[0].id]);

  await notifyOwnerWhatsApp(businessId,
    `❌ *Order Cancelled*\nCustomer: ${phone}\nItems: ${existing[0].items || "N/A"}${reason ? `\nReason: ${reason}` : ""}`
  );

  return { success: true, message: "Order cancelled successfully" };
}

// ── Execute: Update Follow-up ─────────────────────────────────
export async function executeUpdateFollowup({ businessId, conversationId, customerPhone, input }) {
  const { customer_phone, scheduled_at, message } = input;
  const phone = customer_phone || customerPhone;

  const { rows: existing } = await query(`
    SELECT id, message, scheduled_at FROM follow_ups
    WHERE business_id = $1 AND customer_phone = $2 AND sent = FALSE AND scheduled_at > NOW()
    ORDER BY scheduled_at ASC LIMIT 1
  `, [businessId, phone]);

  if (!existing.length) return { success: false, message: "No pending follow-up found for this customer" };

  const followup = existing[0];
  const sets = []; const params = [];
  let idx = 0;

  if (scheduled_at) {
    const utc = parseISTtoUTC(scheduled_at);
    if (utc) { idx++; sets.push(`scheduled_at = $${idx}`); params.push(utc); }
  }
  if (message) { idx++; sets.push(`message = $${idx}`); params.push(message); }
  sets.push(`updated_at = NOW()`);

  idx++; params.push(followup.id);
  idx++; params.push(businessId);
  await query(`UPDATE follow_ups SET ${sets.join(", ")} WHERE id = $${idx-1} AND business_id = $${idx}`, params);

  const newTime = scheduled_at ? toISTString(parseISTtoUTC(scheduled_at)) : toISTString(followup.scheduled_at);

  await notifyOwnerWhatsApp(businessId, `⏰ *Follow-up Rescheduled*\nCustomer: ${phone}\nNew time: ${newTime} IST`);

  return { success: true, message: `Follow-up rescheduled to ${newTime} IST` };
}

// ── Execute: Cancel Follow-up ─────────────────────────────────
export async function executeCancelFollowup({ businessId, conversationId, customerPhone, input }) {
  const { customer_phone, reason } = input;
  const phone = customer_phone || customerPhone;

  const { rows: existing } = await query(`
    SELECT id, scheduled_at FROM follow_ups
    WHERE business_id = $1 AND customer_phone = $2 AND sent = FALSE AND scheduled_at > NOW()
    ORDER BY scheduled_at ASC LIMIT 1
  `, [businessId, phone]);

  if (!existing.length) return { success: false, message: "No pending follow-up found for this customer" };

  await query(`
    UPDATE follow_ups SET sent = TRUE, sent_at = NOW(),
      error_message = $1, updated_at = NOW()
    WHERE id = $2
  `, [reason ? `Cancelled by customer: ${reason}` : "Cancelled by customer", existing[0].id]);

  await notifyOwnerWhatsApp(businessId, `⏰ *Follow-up Cancelled*\nCustomer: ${phone}${reason ? `\nReason: ${reason}` : ""}`);

  return { success: true, message: "Follow-up cancelled successfully" };
}