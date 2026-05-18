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
- "after 5 mins" / "thodi der mein" → 30 minutes from now

BUSY SIGNALS:
- "busy hoon" / "busy right now" / "abhi busy" → 4 hours from now
- "meeting mein hoon" → 3 hours from now
- "travelling" / "bahar hoon" → 5 days from now
- "office mein hoon" → today evening 6pm

DECISION PENDING:
- "let me think" / "sochta hoon" → 2 days from now 10am
- "discuss with family/wife/husband/boss" → 2 days from now
- "ghar mein poochna hai" → 2 days from now
- "budget check karna hai" → 3 days from now
- "I'll let you know" / "batata hoon" → 1 day from now

FINANCIAL:
- "budget nahi abhi" / "paisa nahi" → 30 days from now
- "salary aayi toh" → 15 days from now
- "next month" → 30 days from now

DO NOT schedule follow-up if customer clearly says NO or not interested at all.`,

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
The current time is provided at the top of your instructions — use it.

Scheduling rules:
- Follow-ups only allowed between 10:00 AM and 10:00 PM IST
- If calculated time is after 10 PM IST → schedule next day 10 AM IST
- If calculated time is before 10 AM IST → schedule same day 10 AM IST
- "after 5 mins" → 30 mins from now (minimum buffer)
- "tomorrow" → next day 10:00 AM IST
- "next week" → 7 days from now 10:00 AM IST
- "evening" → today 6:00 PM IST (if before 10 PM, else tomorrow 10 AM)`,
      },
      message: {
        type: "string",
        description: `Follow-up message to send. Rules:
- Natural and human sounding
- In SAME language as customer (Hindi/English/Hinglish)
- Reference what they were interested in
- Short — max 2 sentences
- Soft, not pushy

Examples:
English: "Hi! Just checking in — did you get a chance to think about it? Let me know when you're ready."
Hinglish: "Hi! Kya aapne soch liya? Jab bhi convenient ho bata dena."
Hindi: "नमस्ते! क्या आपने सोच लिया? जब ready हों बता दीजिए।"`,
      },
      reason: {
        type: "string",
        description: "Why following up — e.g. 'Customer was busy', 'Needed family approval'",
      },
    },
    required: ["customer_phone", "scheduled_at", "message"],
  },
};

// IST offset in milliseconds (UTC+5:30)
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

// Business hours: 10am - 10pm IST
const BUSINESS_HOUR_START = 10; // 10am
const BUSINESS_HOUR_END   = 22; // 10pm

/**
 * Get current time in IST
 */
function nowIST() {
  return new Date(Date.now() + IST_OFFSET);
}

/**
 * Convert any date to IST Date object
 */
function toIST(date) {
  return new Date(date.getTime() + IST_OFFSET);
}

/**
 * Get IST hour (0-23) from a UTC date
 */
function getISTHour(utcDate) {
  return toIST(utcDate).getUTCHours();
}

/**
 * Clamp a scheduled time to business hours (10am-10pm IST).
 * - Before 10am → push to 10am same day
 * - After 10pm → push to 10am next day
 */
function clampToBusinessHours(utcDate) {
  const istHour = getISTHour(utcDate);
  const ist     = toIST(utcDate);

  if (istHour >= BUSINESS_HOUR_START && istHour < BUSINESS_HOUR_END) {
    return utcDate; // Already within business hours
  }

  // Create a new date in IST at 10am
  const result = new Date(ist);

  if (istHour >= BUSINESS_HOUR_END) {
    // After 10pm → next day 10am
    result.setUTCDate(result.getUTCDate() + 1);
  }
  // Set to 10am IST = 4:30am UTC
  result.setUTCHours(4, 30, 0, 0);

  // Convert back to UTC
  return new Date(result.getTime() - IST_OFFSET);
}

export async function executeScheduleFollowup({ businessId, conversationId, input }) {
  const { customer_phone, customer_name, message, reason } = input;
  let   { scheduled_at } = input;

  try {
    const now           = new Date();
    let   scheduledDate = new Date(scheduled_at);

    // ── 1. Fix past times ─────────────────────────────────────
    if (scheduledDate <= now) {
      const diffMins = (now - scheduledDate) / 60000;

      if (diffMins <= 120) {
        // Within 2 hours in past — schedule 30 mins from now
        scheduledDate = new Date(now.getTime() + 30 * 60 * 1000);
        console.log(`⏰ Follow-up was ${diffMins.toFixed(0)}m in past → rescheduled to 30m from now`);
      } else {
        // More than 2 hours in past — tomorrow 10am IST
        const tomorrow = new Date(now.getTime() + IST_OFFSET);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(4, 30, 0, 0); // 10am IST
        scheduledDate = new Date(tomorrow.getTime() - IST_OFFSET);
        console.log(`⏰ Follow-up was far in past → rescheduled to tomorrow 10am IST`);
      }
    }

    // ── 2. Clamp to business hours (10am-10pm IST) ────────────
    const clamped = clampToBusinessHours(scheduledDate);
    if (clamped.getTime() !== scheduledDate.getTime()) {
      const istHour = getISTHour(scheduledDate);
      console.log(`⏰ Follow-up was at ${istHour}:00 IST → clamped to business hours`);
      scheduledDate = clamped;
    }

    // ── 3. Check for duplicate follow-ups ─────────────────────
    // Don't create another follow-up if one already pending for same customer
    const { rows: existing } = await query(`
      SELECT id, scheduled_at FROM follow_ups
      WHERE business_id   = $1
        AND customer_phone = $2
        AND sent          = FALSE
      ORDER BY scheduled_at ASC
      LIMIT 1
    `, [businessId, customer_phone]);

    if (existing.length > 0) {
      const existingTime = new Date(existing[0].scheduled_at);
      const newTime      = scheduledDate;

      // If existing follow-up is within 1 hour of new one — update instead of create
      const diffHours = Math.abs(existingTime - newTime) / 3600000;

      if (diffHours < 24) {
        // Update existing follow-up with new time and message
        await query(`
          UPDATE follow_ups
          SET scheduled_at = $1, message = $2, reason = $3, updated_at = NOW()
          WHERE id = $4
        `, [scheduledDate.toISOString(), message, reason || null, existing[0].id]);

        console.log(`✅ Follow-up UPDATED (prevented duplicate): ${customer_phone} → ${scheduledDate.toISOString()}`);

        return {
          success:      true,
          followUpId:   existing[0].id,
          scheduledFor: scheduledDate.toISOString(),
          message:      `Follow-up updated for ${formatISTTime(scheduledDate)}`,
          updated:      true,
        };
      }

      // Different day — create new one but cancel old pending
      await query(`
        UPDATE follow_ups SET sent = TRUE, sent_at = NOW()
        WHERE id = $1
      `, [existing[0].id]);

      console.log(`⏰ Cancelled old follow-up, creating new one`);
    }

    // ── 4. Save new follow-up ──────────────────────────────────
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
      scheduledDate.toISOString(),
    ]);

    // Log activity
    try {
      await query(`
        INSERT INTO activity_logs (business_id, type, description, icon, color)
        VALUES ($1, 'followup', $2, '⏰', '#f0fdfa')
      `, [
        businessId,
        `Follow-up scheduled for ${customer_name || customer_phone} at ${formatISTTime(scheduledDate)}`,
      ]);
    } catch { /* non-critical */ }

    console.log(`✅ Follow-up scheduled: ${customer_phone} → ${formatISTTime(scheduledDate)}`);

    return {
      success:      true,
      followUpId:   rows[0].id,
      scheduledFor: rows[0].scheduled_at,
      message:      `Follow-up scheduled for ${formatISTTime(scheduledDate)}`,
    };

  } catch (err) {
    console.error("Follow-up save error:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Format a UTC date as IST time string for logging/display
 */
function formatISTTime(utcDate) {
  const ist = toIST(utcDate);
  return ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}