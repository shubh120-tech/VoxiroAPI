import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const checkAvailabilityTool = {
  name: "check_availability",
  description: "Check available appointment slots for a given date. Call this before booking to confirm the time is free.",
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date to check in YYYY-MM-DD format" },
    },
    required: ["date"],
  },
};

export async function executeCheckAvailability({ businessId, input }) {
  const { date } = input;

  const { rows } = await query(`
    SELECT scheduled_at, duration_mins, service, customer_name
    FROM appointments
    WHERE business_id = $1
      AND DATE(scheduled_at AT TIME ZONE 'Asia/Kolkata') = $2
      AND status != 'cancelled'
    ORDER BY scheduled_at ASC
  `, [businessId, date]);

  const allSlots = [];
  for (let hour = 9; hour <= 17; hour++) {
    allSlots.push(`${String(hour).padStart(2, "0")}:00`);
  }

  const bookedTimes = rows.map(r => {
    const d = new Date(r.scheduled_at);
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  });

  const available = allSlots.filter(slot => !bookedTimes.includes(slot));

  return {
    date,
    available_slots: available,
    booked_slots:    bookedTimes,
    total_booked:    rows.length,
    message: available.length > 0
      ? `Available slots on ${date}: ${available.join(", ")}`
      : `No slots available on ${date}. Please try another date.`,
  };
}

export const bookAppointmentTool = {
  name: "book_appointment",
  description: `Book an appointment for a customer when they want to schedule a service.

IMPORTANT RULES:
1. Use the actual services from this business's catalog — do NOT assume any specific industry
2. This tool checks for existing appointments to prevent duplicates
3. If customer already has an active appointment, it updates instead of creating a new one
4. ALWAYS call check_availability first to confirm the slot is free
5. Collect service name, preferred date/time before booking`,
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

export async function executeBookAppointment({ businessId, conversationId, input }) {
  const {
    customer_name, customer_phone, service,
    scheduled_at, duration_mins = 60, notes,
  } = input;

  const scheduledAtUTC = parseISTtoUTC(scheduled_at);
  if (!scheduledAtUTC) {
    console.error(`❌ Invalid scheduled_at: ${scheduled_at}`);
    return { success: false, error: "Invalid date/time format" };
  }

  try {
    // Check for existing active appointment for this customer
    const { rows: existing } = await query(`
      SELECT id, service, scheduled_at, status FROM appointments
      WHERE business_id = $1
        AND customer_phone = $2
        AND status IN ('confirmed', 'pending')
        AND scheduled_at >= NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC LIMIT 1
    `, [businessId, customer_phone]);

    let appointmentId;
    let isUpdate = false;

    if (existing.length > 0) {
      // Update existing appointment instead of creating duplicate
      appointmentId = existing[0].id;
      isUpdate = true;

      await query(`
        UPDATE appointments SET
          customer_name  = COALESCE(NULLIF($1, ''), appointments.customer_name),
          service        = $2,
          scheduled_at   = $3,
          duration_mins  = $4,
          notes          = COALESCE(NULLIF($5, ''), appointments.notes),
          status         = 'confirmed',
          conversation_id = COALESCE($6, appointments.conversation_id),
          updated_at     = NOW()
        WHERE id = $7
      `, [
        customer_name || null, service, scheduledAtUTC,
        duration_mins, notes || null, conversationId, appointmentId
      ]);

      console.log(`📅 Appointment UPDATED (prevented duplicate): ${customer_phone} → ${toISTString(scheduledAtUTC)}`);
    } else {
      // Check for time slot conflict (another customer at same time)
      const { rows: conflict } = await query(`
        SELECT id, customer_name FROM appointments
        WHERE business_id = $1
          AND scheduled_at = $2
          AND status IN ('confirmed', 'pending')
          AND customer_phone != $3
      `, [businessId, scheduledAtUTC, customer_phone]);

      if (conflict.length > 0) {
        return {
          success: false,
          error: `This time slot is already booked by another customer. Please suggest a different time.`,
        };
      }

      // Create new appointment
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
      appointmentId = rows[0].id;

      console.log(`📅 New appointment: ${customer_phone} — ${service} at ${toISTString(scheduledAtUTC)}`);
    }

    const displayTime = toISTString(scheduledAtUTC);

    // Log activity
    await query(`
      INSERT INTO activity_logs
        (business_id, type, description, icon, color, ref_id, ref_type)
      VALUES ($1, 'appointment', $2, '📅', '#f0fdfa', $3, 'appointment')
    `, [
      businessId,
      `Appointment ${isUpdate ? 'rescheduled' : 'booked'}: ${customer_name || customer_phone} — ${service} at ${displayTime}`,
      appointmentId,
    ]).catch(() => {});

    // Notify owner
    await notifyOwnerWhatsApp(businessId,
      `📅 *Appointment ${isUpdate ? 'Rescheduled' : 'Booked'}*\nCustomer: ${customer_name || customer_phone}\nService: ${service}\nWhen: ${displayTime} IST\nDuration: ${duration_mins} mins`
    );

    return { success: true, appointmentId, isUpdate, displayTime };

  } catch (err) {
    console.error("Book appointment error:", err.message);
    return { success: false, error: err.message };
  }
}