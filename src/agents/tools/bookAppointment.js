import { query } from "../../db/postgres.js";
import { notifyOwnerWhatsApp } from "../../whatsapp/sender.js";

export const bookAppointmentTool = {
  name: "book_appointment",
  description: "Book an appointment for a customer when they want to schedule a service.",
  input_schema: {
    type: "object",
    properties: {
      customer_name:  { type: "string",  description: "Customer name" },
      customer_phone: { type: "string",  description: "Customer phone number" },
      service:        { type: "string",  description: "Service they want to book" },
      scheduled_at:   { type: "string",  description: "Date and time in ISO 8601 format e.g. 2026-05-17T14:00:00" },
      duration_mins:  { type: "number",  description: "Duration in minutes", default: 60 },
      notes:          { type: "string",  description: "Any special requests" },
    },
    required: ["customer_phone", "service", "scheduled_at"],
  },
};

export async function executeBookAppointment({ businessId, conversationId, input }) {
  const { customer_name, customer_phone, service, scheduled_at, duration_mins = 60, notes } = input;

  const { rows } = await query(`
    INSERT INTO appointments (business_id, conversation_id, customer_name, customer_phone, service, scheduled_at, duration_mins, status, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8)
    RETURNING id
  `, [businessId, conversationId, customer_name, customer_phone, service, scheduled_at, duration_mins, notes]);

  await query(`
    INSERT INTO activity_logs (business_id, type, description, icon, color, ref_id, ref_type)
    VALUES ($1, 'appointment', $2, '📅', '#f0fdfa', $3, 'appointment')
  `, [businessId, `Appointment booked: ${customer_name || customer_phone} — ${service} at ${scheduled_at}`, rows[0].id]);

  await notifyOwnerWhatsApp(businessId,
    `📅 *Appointment Booked*\nCustomer: ${customer_name || customer_phone}\nService: ${service}\nWhen: ${new Date(scheduled_at).toLocaleString()}`
  );

  return { success: true, appointmentId: rows[0].id };
}
