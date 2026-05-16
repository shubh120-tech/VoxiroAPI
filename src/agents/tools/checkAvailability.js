import { query } from "../../db/postgres.js";

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

  // Get already booked slots for that day
  const { rows } = await query(`
    SELECT scheduled_at, duration_mins, service, customer_name
    FROM appointments
    WHERE business_id = $1
      AND DATE(scheduled_at) = $2
      AND status != 'cancelled'
    ORDER BY scheduled_at ASC
  `, [businessId, date]);

  // Generate standard slots (9am - 6pm, every hour)
  const allSlots = [];
  for (let hour = 9; hour <= 17; hour++) {
    allSlots.push(`${String(hour).padStart(2, "0")}:00`);
  }

  // Find booked times
  const bookedTimes = rows.map(r => {
    const d = new Date(r.scheduled_at);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });

  const available = allSlots.filter(slot => !bookedTimes.includes(slot));
  const booked    = bookedTimes;

  return {
    date,
    available_slots: available,
    booked_slots:    booked,
    message: available.length > 0
      ? `Available slots on ${date}: ${available.join(", ")}`
      : `No slots available on ${date}. Please try another date.`,
  };
}
