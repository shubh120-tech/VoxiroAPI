import { query } from "../../db/postgres.js";

export const scheduleFollowupTool = {
  name: "schedule_followup",
  description: `Schedule a follow-up message for a customer who is interested but not ready right now.

DETECT FOLLOW-UP INTENT from these signals — even if customer never says "follow up":

TIME-BASED SIGNALS:
- "I'm busy right now" → follow up in 4 hours
- "Call me after lunch" → follow up at 2pm same day
- "Ask me tomorrow" → follow up next day 10am
- "Check back next week" → follow up in 7 days
- "Remind me on Monday" → follow up coming Monday 10am
- "Call me in the evening" → follow up at 6pm same day
- "Thoda baad mein baat karte hain" → follow up in 4 hours
- "Kal baat karte hain" → follow up next day 10am

DECISION-PENDING SIGNALS:
- "Let me think about it" → follow up in 2 days
- "I need to discuss with family/husband/wife" → follow up in 2 days
- "I'll get back to you" → follow up in 1 day
- "Not sure yet" → follow up in 2 days
- "Maybe later" → follow up in 3 days
- "Sochke batata/batati hoon" → follow up in 2 days
- "Ghar mein poochna hai" → follow up in 2 days
- "Baat karke batata hoon" → follow up in 1 day

SITUATION-BASED SIGNALS:
- "Budget is tight this month" → follow up in 30 days
- "Currently travelling" → follow up in 5 days
- "I'm at work right now" → follow up in 4 hours
- "Not interested right now" → follow up in 7 days
- "We just moved" → follow up in 2 weeks
- "Festival season is going on" → follow up after 1 week
- "Abhi paisa nahi hai" → follow up in 30 days
- "Bahar gaya hua hoon" → follow up in 5 days

IMPLICIT SIGNALS:
- Customer says goodbye without deciding → follow up in 1 day
- Customer asks price then goes quiet → follow up in 1 day with soft message
- Customer shows interest but says busy → follow up in 4 hours

DO NOT follow up if:
- Customer clearly says NO or not interested at all
- Customer says they already booked elsewhere
- Customer is rude or asks not to contact

FOLLOW-UP MESSAGE RULES:
- Never be pushy or salesy
- Reference what customer was interested in specifically
- Keep it very short — max 2 sentences
- End with a soft open question
- Match EXACTLY the language customer used
- Sound natural like a human checking in, not a bot

EXAMPLE MESSAGES:
English:
"Hey! Just checking in 😊 Did you get a chance to think about the appointment?"
"Hi! Hope everything's good 🙏 Shall we go ahead with the booking?"

Hindi:
"नमस्ते! क्या आपने सोच लिया appointment के बारे में? 😊"
"हेलो! अब time है कि appointment book करें? 🙏"

Hinglish:
"Hey! Soch liya kya? 😊 Shall we book kar dein?"
"Hi! Ab convenient hai? Book kar dete hain! 🙏"`,

  input_schema: {
    type: "object",
    properties: {
      customer_phone: {
        type: "string",
        description: "Customer WhatsApp phone number",
      },
      customer_name: {
        type: "string",
        description: "Customer name if known",
      },
      scheduled_at: {
        type: "string",
        description: `When to send follow-up in ISO 8601 format.
Calculate intelligently based on what customer said:
- "busy right now" → 4 hours from now
- "after lunch" → today at 2pm
- "tomorrow" → tomorrow at 10am
- "evening" → today at 6pm
- "next week" → 7 days from now at 10am
- "Monday" → coming Monday at 10am
- "think about it" → 2 days from now at 10am
- "discuss with family" → 2 days from now at 10am
- "travelling" → 5 days from now at 10am
- "budget tight" → 30 days from now at 10am
Always use future datetime. Never schedule in the past.`,
      },
      message: {
        type: "string",
        description: `The follow-up message to send the customer.
Must be:
- Natural and human sounding
- In the SAME language as customer used
- Reference what they were interested in
- Short — max 2 sentences
- End with a soft question
- NOT pushy or salesy`,
      },
      reason: {
        type: "string",
        description: "Why following up — for internal tracking e.g. 'Customer was travelling', 'Needed family approval'",
      },
    },
    required: ["customer_phone", "scheduled_at", "message"],
  },
};

export async function executeScheduleFollowup({ businessId, conversationId, input }) {
  const {
    customer_phone,
    customer_name,
    scheduled_at,
    message,
    reason,
  } = input;

  // Validate scheduled_at is in the future
  const scheduledDate = new Date(scheduled_at);
  if (scheduledDate <= new Date()) {
    return {
      success: false,
      error:   "Follow-up date must be in the future",
    };
  }

  // Save follow-up to DB
  const { rows } = await query(`
    INSERT INTO follow_ups
      (business_id, conversation_id, customer_phone, customer_name, message, reason, scheduled_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, scheduled_at
  `, [
    businessId,
    conversationId  || null,
    customer_phone,
    customer_name   || null,
    message,
    reason          || null,
    scheduled_at,
  ]);

  // Log activity
  await query(`
    INSERT INTO activity_logs
      (business_id, type, description, icon, color, ref_id, ref_type)
    VALUES ($1, 'message', $2, '⏰', '#f0fdfa', $3, 'follow_up')
  `, [
    businessId,
    `Follow-up scheduled for ${customer_name || customer_phone} on ${new Date(scheduled_at).toLocaleDateString()}`,
    rows[0].id,
  ]);

  return {
    success:      true,
    followUpId:   rows[0].id,
    scheduledFor: rows[0].scheduled_at,
    message:      `Follow-up scheduled for ${new Date(scheduled_at).toLocaleString()}`,
  };
}