import { query } from "../../db/postgres.js";

export const scheduleFollowupTool = {
  name: "schedule_followup",
  description: `MANDATORY: Call this tool whenever customer indicates they want to connect later.

You MUST call this tool — do NOT just say "I'll follow up" in text without calling it.
Text promises mean nothing. Only the tool actually schedules the follow-up.

TRIGGER SIGNALS — call immediately when you detect any of these:

EXPLICIT TIME SIGNALS:
- "follow up tomorrow" / "kal baat karte" → tomorrow 10am
- "call me after lunch" → today 2pm
- "evening mein call karo" → today 6pm
- "next week" / "agli baar" → 7 days from now
- "Monday ko" / "Friday ko" → that day 10am
- "after 5 mins" / "thodi der mein" → 30 minutes from now

BUSY SIGNALS:
- "busy hoon" / "busy right now" / "abhi busy" → 4 hours from now
- "meeting mein hoon" → 3 hours from now
- "travelling" / "bahar hoon" → 5 days from now
- "office mein hoon" → today evening 6pm

DECISION PENDING:
- "let me think" / "sochta hoon" / "soch ke batata" → 2 days from now
- "discuss with family/wife/husband/boss" → 2 days from now
- "ghar mein poochna hai" → 2 days from now
- "budget check karna hai" → 3 days from now
- "I'll let you know" / "batata hoon" → 1 day from now

FINANCIAL:
- "budget nahi abhi" / "paisa nahi" → 30 days from now
- "salary aayi toh" → 15 days from now
- "next month" → 30 days from now

IMPLICIT (customer going cold):
- Customer says bye without deciding → 1 day from now
- Customer stops responding mid-conversation → do NOT auto schedule`,

  input_schema: {
    type: "object",
    properties: {
      customer_phone: {
        type: "string",
        description: "Customer WhatsApp number",
      },
      customer_name: {
        type: "string",
        description: "Customer name if known",
      },
      scheduled_at: {
        type: "string",
        description: `ISO 8601 datetime for follow-up. Calculate from what customer said.
Examples:
- "tomorrow" → next day at 10:00 AM local time
- "after 5 mins" → 30 minutes from now (give buffer)
- "evening" → today at 18:00
- "next week" → 7 days from now at 10:00 AM
- "busy now" → 4 hours from now
- "let me think" → 2 days from now at 10:00 AM
Always use future time. Never past.`,
      },
      message: {
        type: "string",
        description: `Follow-up message to send customer. Rules:
- Natural and human sounding
- In SAME language customer used (Hindi/English/Hinglish)
- Reference what they were interested in
- Short — max 2 sentences
- Soft, not pushy
- End with open question

Examples:
English: "Hi! Just checking in — did you get a chance to think about the research paper? Let me know when you're ready."
Hindi: "नमस्ते! क्या आपने सोच लिया research paper के बारे में? जब ready हों बता दीजिए।"
Hinglish: "Hi! Kya aapne soch liya? Jab bhi convenient ho bata dena."`,
      },
      reason: {
        type: "string",
        description: "Why following up — e.g. 'Customer was busy', 'Needed family approval', 'Budget constraints'",
      },
    },
    required: ["customer_phone", "scheduled_at", "message"],
  },
};

export async function executeScheduleFollowup({ businessId, conversationId, input }) {
  const { customer_phone, customer_name, scheduled_at, message, reason } = input;

  try {
    // Validate scheduled_at is in the future
    const scheduledDate = new Date(scheduled_at);
    const now           = new Date();

    if (scheduledDate <= now) {
      // Auto-fix: if in past, schedule for tomorrow 10am
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);
      console.warn(`Follow-up time was in past, rescheduled to: ${tomorrow.toISOString()}`);
      input.scheduled_at = tomorrow.toISOString();
    }

    // Save to DB
    const { rows } = await query(`
      INSERT INTO follow_ups
        (business_id, conversation_id, customer_phone, customer_name, message, reason, scheduled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, scheduled_at
    `, [
      businessId,
      conversationId || null,
      customer_phone,
      customer_name  || null,
      message,
      reason         || null,
      input.scheduled_at,
    ]);

    // Log activity
    try {
      await query(`
        INSERT INTO activity_logs (business_id, type, description, icon, color)
        VALUES ($1, 'followup', $2, '⏰', '#f0fdfa')
      `, [
        businessId,
        `Follow-up scheduled for ${customer_name || customer_phone} on ${new Date(input.scheduled_at).toLocaleDateString()}`,
      ]);
    } catch { /* non-critical */ }

    console.log(`✅ Follow-up scheduled: ${customer_phone} at ${input.scheduled_at}`);

    return {
      success:      true,
      followUpId:   rows[0].id,
      scheduledFor: rows[0].scheduled_at,
      message:      `Follow-up scheduled for ${new Date(input.scheduled_at).toLocaleString()}`,
    };

  } catch (err) {
    console.error("Follow-up save error:", err.message);
    return {
      success: false,
      error:   err.message,
    };
  }
}