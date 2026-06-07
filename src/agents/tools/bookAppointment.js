import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const bookAppointmentTool = {
  name: "book_appointment",
  description: "Book an appointment for a customer when they want to schedule a service.",
  input_schema: {
    type: "object",
    properties: {
      customer_name:  { type: "string", description: "Customer name" },
      customer_phone: { type: "string", description: "Customer phone number" },
      service:        { type: "string", description: "Service they want to book" },
      scheduled_at:   { type: "string", description: "Date and time — if customer says '1 PM tomorrow', convert to full datetime like 2026-06-10T13:00:00. Always treat as IST (India Standard Time, UTC+5:30)." },
      duration_mins:  { type: "number", description: "Duration in minutes", default: 60 },
      notes:          { type: "string", description: "Any special requests" },
    },
    required: ["customer_phone", "service", "scheduled_at"],
  },
};

// ── Convert agent-provided datetime to UTC for DB storage ─────
// Agent provides time as IST (customer's local time in India)
// PostgreSQL stores in UTC — so we must convert IST → UTC before saving
function parseISTtoUTC(dateTimeStr) {
  if (!dateTimeStr) return null;

  // Already has timezone info — parse as-is
  if (dateTimeStr.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dateTimeStr)) {
    return new Date(dateTimeStr).toISOString();
  }

  // No timezone — agent gave us IST time, append +05:30 and convert
  // e.g. "2026-06-10T13:00:00" → treat as IST → store as "2026-06-10T07:30:00.000Z"
  try {
    const istDate = new Date(dateTimeStr + "+05:30");
    if (!isNaN(istDate.getTime())) return istDate.toISOString();
  } catch {}

  // Fallback — parse as-is (better than null)
  const date = new Date(dateTimeStr);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

// ── Format UTC timestamp as IST string for notifications ──────
function toISTString(isoStr) {
  return new Date(isoStr).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day:      "numeric",
    month:    "short",
    year:     "numeric",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   true,
  });
}

export async function executeBookAppointment({ businessId, conversationId, input }) {
  const {
    customer_name,
    customer_phone,
    service,
    scheduled_at,
    duration_mins = 60,
    notes,
  } = input;

  // Convert IST → UTC before saving
  const scheduledAtUTC = parseISTtoUTC(scheduled_at);

  if (!scheduledAtUTC) {
    console.error(`❌ Invalid scheduled_at: ${scheduled_at}`);
    return { success: false, error: "Invalid date/time format" };
  }

  const { rows } = await query(`
    INSERT INTO appointments
      (business_id, conversation_id, customer_name, customer_phone,
       service, scheduled_at, duration_mins, status, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8)
    RETURNING id
  `, [
    businessId, conversationId,
    customer_name, customer_phone,
    service, scheduledAtUTC, duration_mins, notes,
  ]);

  const displayTime = toISTString(scheduledAtUTC);

  await query(`
    INSERT INTO activity_logs
      (business_id, type, description, icon, color, ref_id, ref_type)
    VALUES ($1, 'appointment', $2, '📅', '#f0fdfa', $3, 'appointment')
  `, [
    businessId,
    `Appointment booked: ${customer_name || customer_phone} — ${service} at ${displayTime}`,
    rows[0].id,
  ]);

  await notifyOwnerWhatsApp(businessId,
    `📅 *Appointment Booked*\nCustomer: ${customer_name || customer_phone}\nService: ${service}\nWhen: ${displayTime} IST`
  );

  console.log(`📅 Appointment saved: ${scheduled_at} IST → ${scheduledAtUTC} UTC`);

  return { success: true, appointmentId: rows[0].id };
}