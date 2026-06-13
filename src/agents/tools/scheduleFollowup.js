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
- "next week" / "agli baar" → 7 days from now 10am
- "Monday ko" / "Friday ko" → that day 10am

BUSY SIGNALS:
- "busy hoon" / "busy right now" → 4 hours from now
- "meeting mein hoon" → 3 hours from now
- "travelling" / "bahar hoon" → next day 10am

DECISION PENDING:
- "let me think" / "sochta hoon" → 2 days from now 10am
- "discuss with family/boss" → 2 days from now
- "I'll let you know" / "batata hoon" → 1 day from now

FINANCIAL:
- "budget nahi abhi" → 30 days from now
- "salary aayi toh" → 15 days from now

DO NOT schedule follow-up if customer clearly says NO or not interested.
Reference the actual product/service they were interested in — do NOT assume any specific business type.`,

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
        description: `ISO 8601 datetime for follow-up in IST timezone.

Scheduling rules:
- Follow-ups only between 10:00 AM and 10:00 PM IST
- If after 10 PM → next day 10 AM
- If before 10 AM → same day 10 AM
- "after 5 mins" → 30 mins from now (minimum buffer)
- "tomorrow" → next day 10:00 AM IST
- "next week" → 7 days from now 10:00 AM IST`,
      },
      message: {
        type: "string",
        description: `Follow-up message to send. Rules:
- Natural and human sounding
- In SAME language as customer (Hindi/English/Hinglish)
- Reference what they were actually interested in from THIS business
- Short — max 2 sentences
- Soft, not pushy`,
      },
      reason: {
        type: "string",
        description: "Why following up — e.g. 'Customer was busy', 'Needed family approval', 'Checking budget'",
      },
    },
    required: ["customer_phone", "scheduled_at", "message"],
  },
};

const IST_OFFSET        = 5.5 * 60 * 60 * 1000;
const BUSINESS_HOUR_START = 10;
const BUSINESS_HOUR_END   = 22;

function nowIST()       { return new Date(Date.now() + IST_OFFSET); }
function toIST(date)    { return new Date(date.getTime() + IST_OFFSET); }
function getISTHour(d)  { return toIST(d).getUTCHours(); }

function clampToBusinessHours(utcDate) {
  const istHour = getISTHour(utcDate);
  if (istHour >= BUSINESS_HOUR_START && istHour < BUSINESS_HOUR_END) return utcDate;
  const ist = toIST(utcDate);
  const result = new Date(ist);
  if (istHour >= BUSINESS_HOUR_END) result.setUTCDate(result.getUTCDate() + 1);
  result.setUTCHours(4, 30, 0, 0);
  return new Date(result.getTime() - IST_OFFSET);
}

function formatISTTime(utcDate) {
  const ist = toIST(utcDate);
  return ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}

export async function executeScheduleFollowup({ businessId, conversationId, input }) {
  const { customer_phone, customer_name, message, reason } = input;
  let   { scheduled_at } = input;

  try {
    const now           = new Date();
    let   scheduledDate = new Date(scheduled_at);

    // Fix past times
    if (scheduledDate <= now) {
      const diffMins = (now - scheduledDate) / 60000;
      if (diffMins <= 120) {
        scheduledDate = new Date(now.getTime() + 30 * 60 * 1000);
      } else {
        const tomorrow = new Date(now.getTime() + IST_OFFSET);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(4, 30, 0, 0);
        scheduledDate = new Date(tomorrow.getTime() - IST_OFFSET);
      }
    }

    // Clamp to business hours
    scheduledDate = clampToBusinessHours(scheduledDate);

    // Check for duplicate
    const { rows: existing } = await query(`
      SELECT id, scheduled_at FROM follow_ups
      WHERE business_id = $1 AND customer_phone = $2 AND sent = FALSE
      ORDER BY scheduled_at ASC LIMIT 1
    `, [businessId, customer_phone]);

    if (existing.length > 0) {
      const diffHours = Math.abs(new Date(existing[0].scheduled_at) - scheduledDate) / 3600000;
      if (diffHours < 24) {
        // Update existing instead of creating duplicate
        await query(`
          UPDATE follow_ups SET scheduled_at = $1, message = $2, reason = $3,
            customer_name = COALESCE(NULLIF($4, ''), follow_ups.customer_name), updated_at = NOW()
          WHERE id = $5
        `, [scheduledDate.toISOString(), message, reason || null, customer_name || null, existing[0].id]);

        console.log(`✅ Follow-up UPDATED: ${customer_phone} → ${formatISTTime(scheduledDate)}`);
        return { success: true, followUpId: existing[0].id, scheduledFor: scheduledDate.toISOString(), message: `Follow-up updated for ${formatISTTime(scheduledDate)}`, updated: true };
      }
      // Cancel old one
      await query(`UPDATE follow_ups SET sent = TRUE, sent_at = NOW() WHERE id = $1`, [existing[0].id]);
    }

    // Create new follow-up
    const { rows } = await query(`
      INSERT INTO follow_ups (business_id, conversation_id, customer_phone, customer_name, message, reason, scheduled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, scheduled_at
    `, [businessId, conversationId || null, customer_phone, customer_name || null, message, reason || null, scheduledDate.toISOString()]);

    await query(`
      INSERT INTO activity_logs (business_id, type, description, icon, color)
      VALUES ($1, 'followup', $2, '⏰', '#f0fdfa')
    `, [businessId, `Follow-up scheduled for ${customer_name || customer_phone} at ${formatISTTime(scheduledDate)}`]).catch(() => {});

    console.log(`✅ Follow-up scheduled: ${customer_phone} → ${formatISTTime(scheduledDate)}`);
    return { success: true, followUpId: rows[0].id, scheduledFor: rows[0].scheduled_at, message: `Follow-up scheduled for ${formatISTTime(scheduledDate)}` };

  } catch (err) {
    console.error("Follow-up save error:", err.message);
    return { success: false, error: err.message };
  }
}