import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt }                        from "./systemPrompt.js";
import { saveLeadTool,          executeSaveLead          } from "./tools/saveLead.js";
import { confirmOrderTool,      executeConfirmOrder       } from "./tools/confirmOrder.js";
import { bookAppointmentTool,   executeBookAppointment    } from "./tools/bookAppointment.js";
import { checkAvailabilityTool, executeCheckAvailability  } from "./tools/checkAvailability.js";
import { notifyOwnerTool,       executeNotifyOwner        } from "./tools/notifyOwner.js";
import { scheduleFollowupTool,  executeScheduleFollowup   } from "./tools/scheduleFollowup.js";
import { sendWhatsAppMessages,  splitIntoMessages          } from "../whatsapp/sender.js";
import { fetchRelevantContext } from "./knowledgeFetcher.js";
import { query } from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS = [
  saveLeadTool,
  confirmOrderTool,
  bookAppointmentTool,
  checkAvailabilityTool,
  notifyOwnerTool,
  scheduleFollowupTool,
];

// ── Processing lock — prevents double replies ─────────────────
const processingLock = new Set();

// ── Prompt cache (5 min TTL) ──────────────────────────────────
const promptCache = new Map();

async function getCachedPrompt(businessId) {
  const key    = `prompt_${businessId}`;
  const cached = promptCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.prompt;
  const prompt = await buildSystemPrompt(businessId);
  promptCache.set(key, { prompt, expiry: Date.now() + 5 * 60 * 1000 });
  return prompt;
}

// ── Simple reply detection — skip Claude for one-word replies ─
const SIMPLE_REPLIES = new Set([
  "ok", "okay", "k", "fine", "sure", "yes", "no", "thanks",
  "thank you", "thankyou", "ty", "hi", "hello", "hey",
  "haan", "nahi", "na", "ha", "theek hai", "theek", "done",
  "got it", "noted", "👍", "👌", "🙏", "✅",
]);

function isSimpleReply(message) {
  return SIMPLE_REPLIES.has(message.toLowerCase().trim());
}

// ── Dynamic history length based on conversation size ─────────
function getMaxHistory(conversationLength) {
  if (conversationLength > 30) return 16;
  if (conversationLength > 15) return 16;
  return 20;
}

/**
 * Main entry point — called when WhatsApp message arrives.
 */
export async function handleIncomingMessage({
  businessId,
  conversationId,
  customerPhone,
  customerName,
  message,
  phoneNumberId,
  accessToken,
  waMessageId = null,  // for read receipt + typing simulation
}) {
  // ── Prevent double processing ─────────────────────────────
  const lockKey = `${conversationId}_${message.slice(0, 50)}`;
  if (processingLock.has(lockKey)) {
    console.log("⚠️  Duplicate message — skipping");
    return null;
  }
  processingLock.add(lockKey);
  setTimeout(() => processingLock.delete(lockKey), 30000);

  try {
    // ── Check manual mode ───────────────────────────────────
    const { rows: convRows } = await query(
      "SELECT status FROM conversations WHERE id = $1",
      [conversationId]
    );
    if (convRows[0]?.status === "manual") return null;

    // ── Customer message already saved in webhook (savePendingMessage) ──
    // Only update last_message timestamp — don't insert duplicate
    await query(`
      UPDATE conversations
      SET last_message = $1, last_message_at = NOW(), updated_at = NOW()
      WHERE id = $2
    `, [message, conversationId]);

    // ── Handle simple one-word replies without Claude ───────
    if (isSimpleReply(message)) {
      const holding = getHoldingReply(message);
      if (holding) {
        if (phoneNumberId && accessToken) {
          await sendWhatsAppMessages({
            phoneNumberId, accessToken,
            to: customerPhone,
            messages: [holding],
          });
        }
        await saveMessage({ conversationId, businessId, role: "agent", content: holding });
        return [holding];
      }
    }

    // ── Get system prompt (cached) ──────────────────────────
    const systemPrompt = await getCachedPrompt(businessId);

    // ── Fetch already collected details for this conversation ─
    const { rows: detailRows } = await query(`
      SELECT collected_details, customer_name, customer_phone FROM conversations WHERE id = $1
    `, [conversationId]).catch(() => ({ rows: [] }));

    const savedDetails     = detailRows[0]?.collected_details || {};
    const savedName        = detailRows[0]?.customer_name || customerName;
    const savedPhone       = detailRows[0]?.customer_phone || customerPhone;

    // Auto-populate from conversation — agent always knows these
    const collectedDetails = {
      ...savedDetails,
      // Always inject what we already know from conversation
      ...(savedName  && !savedDetails.name  ? { name: savedName }   : {}),
      ...(savedPhone && !savedDetails.phone ? { phone: savedPhone } : {}),
    };
    const hasDetails = Object.keys(collectedDetails).length > 0;

    // ── Two-step reply for complex questions ─────────────────
    // Send "hmm" / "let me check" first, then actual reply
    // Makes agent feel like a human thinking before answering
    if (phoneNumberId && accessToken && isComplexQuestion(message)) {
      const thinkingMsg = getThinkingMessage(message);
      await sendWhatsAppMessages({
        phoneNumberId, accessToken,
        to: customerPhone,
        messages: [thinkingMsg],
      });
      await saveMessage({ conversationId, businessId, role: "agent", content: thinkingMsg });
      // Extra pause — human is "checking"
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }

    // ── Load history: first 6 msgs + last 14 msgs ──────────
    // Agent never forgets customer name/details (in first msgs)
    // While still having recent context (last msgs)
    const history = await loadConversationHistory(conversationId, 20);

    // Build context — inject everything we already know
    // This is appended to every message so agent NEVER asks for known info
    const knownParts = [];
    knownParts.push(`WhatsApp/Contact Number: ${customerPhone} — NEVER ask for this`);
    if (collectedDetails.name || customerName)
      knownParts.push(`Name: ${collectedDetails.name || customerName} — do NOT ask again`);
    if (collectedDetails.domain)
      knownParts.push(`Domain/Subject: ${collectedDetails.domain}`);
    if (collectedDetails.service)
      knownParts.push(`Service: ${collectedDetails.service}`);

    // Optional fields — show if collected OR if already skipped
    if (collectedDetails.word_count)
      knownParts.push(collectedDetails.word_count === "SKIPPED"
        ? `Word count: client did not provide — DO NOT ASK AGAIN`
        : `Word count: ${collectedDetails.word_count}`);
    if (collectedDetails.deadline)
      knownParts.push(collectedDetails.deadline === "SKIPPED"
        ? `Deadline: client did not provide — DO NOT ASK AGAIN`
        : `Deadline: ${collectedDetails.deadline}`);
    if (collectedDetails.email)
      knownParts.push(collectedDetails.email === "SKIPPED"
        ? `Email: client did not provide — DO NOT ASK AGAIN`
        : `Email: ${collectedDetails.email}`);
    if (collectedDetails.costing)
      knownParts.push(`Quoted price: ${collectedDetails.costing}`);

    const contextNote = `

[ALREADY KNOWN — SKIP EVERYTHING LISTED HERE:
${knownParts.join("")}
RULE: Never ask for anything listed above. Move forward with what you have.]`;

    const messages = [
      ...history,
      {
        role:    "user",
        content: message + contextNote,
      },
    ];

    // ── Call Claude with prompt caching ─────────────────────
    const reply = await callClaudeWithCache({
      systemPrompt,
      messages,
      businessId,
      conversationId,
      customerPhone,
      customerName,
    });

    if (!reply) return null;

    // ── Split into human-like parts ─────────────────────────
    const parts = splitIntoMessages(reply);

    // ── Send messages + save to DB ──────────────────────────
    if (phoneNumberId && accessToken) {
      const results = await sendWhatsAppMessages({
        phoneNumberId, accessToken,
        to:           customerPhone,
        messages:     parts,
        waMessageId,  // mark as read + show typing
      });

      for (let i = 0; i < parts.length; i++) {
        const waId = results[i]?.messages?.[0]?.id || null;
        await saveMessage({ conversationId, businessId, role: "agent", content: parts[i], waMessageId: waId });
      }
    } else {
      await saveMessage({ conversationId, businessId, role: "agent", content: parts.join("\n\n") });
    }

    return parts;

  } finally {
    // Always release lock
    processingLock.delete(lockKey);
  }
}

// ── Holding replies for simple messages ──────────────────────
function getHoldingReply(message) {
  const msg = message.toLowerCase().trim();
  if (["thanks", "thank you", "thankyou", "ty", "🙏"].includes(msg)) {
    return "You're welcome! Is there anything else I can help you with?";
  }
  if (["hi", "hello", "hey"].includes(msg)) {
    return null; // Let Claude handle greetings
  }
  if (["ok", "okay", "k", "done", "noted", "got it", "👍", "👌", "✅"].includes(msg)) {
    return null; // Let Claude handle confirmations — context matters
  }
  return null;
}

// ── Detect complex question ─────────────────────────────────
// ── Two-step reply ONLY for: negotiation, very tight deadline, trust concern ──
// NOT for regular questions, service info, domain/subject, word count etc.
function isComplexQuestion(message) {
  const msg = message.toLowerCase();
  // Price negotiation only — NOT just asking price
  if (/discount|negotiate|kam karo|thoda kam|best price|cheaper|reduce price|less price/.test(msg)) return true;
  // Very tight deadline — 1, 2, 3 days only
  if (/\b1 day\b|\b2 day\b|\b3 day\b|tomorrow deadline|aaj chahiye|kal chahiye|tonight|emergency/.test(msg)) return true;
  // Trust or refund concern
  if (/refund|scam|fake|fraud|trust|verify|genuine|proof/.test(msg)) return true;
  return false;
  // NOTE: Do NOT add price/cost/fee here — asking price is normal, not complex
  // NOTE: Do NOT add service/thesis/domain — those are normal questions
}

// ── Thinking message — used only in above cases ───────────────
function getThinkingMessage(message) {
  const msg = message.toLowerCase();
  if (/discount|negotiate|kam karo|best price|cheaper/.test(msg)) {
    const options = ["hmm", "let me see what's possible", "one sec"];
    return options[Math.floor(Math.random() * options.length)];
  }
  if (/1 day|2 day|3 day|aaj|kal|tonight|emergency/.test(msg)) {
    const options = ["hmm that's tight", "let me check"];
    return options[Math.floor(Math.random() * options.length)];
  }
  return "hmm";
}

// ── Load conversation history ─────────────────────────────────
// Always keeps FIRST 6 messages (customer details) + LAST N messages (recent context)
// This way agent never forgets name, domain, deadline etc.
async function loadConversationHistory(conversationId, limit = 20) {
  // Get total message count
  const { rows: countRows } = await query(
    "SELECT COUNT(*) FROM messages WHERE conversation_id = $1",
    [conversationId]
  );
  const total = parseInt(countRows[0].count) || 0;

  // If total fits in limit — just return all
  if (total <= limit) {
    const { rows } = await query(`
      SELECT role, content FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `, [conversationId]);
    return rows.map(toMessage);
  }

  // Otherwise: first 6 messages + last (limit - 6) messages
  const firstCount = 6;
  const lastCount  = limit - firstCount;

  const { rows: firstRows } = await query(`
    SELECT role, content FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
    LIMIT $2
  `, [conversationId, firstCount]);

  const { rows: lastRows } = await query(`
    SELECT role, content FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [conversationId, lastCount]);

  // Reverse lastRows to get chronological order
  lastRows.reverse();

  // Combine: first messages + separator + recent messages
  const combined = [
    ...firstRows,
    // Add a system note so Claude knows there's a gap
    { role: "assistant", content: "[Earlier conversation context omitted — customer details above are still valid]" },
    ...lastRows,
  ];

  return combined.map(toMessage);
}

function toMessage(row) {
  return {
    role:    row.role === "customer" ? "user" : "assistant",
    content: row.content,
  };
}

// ── Call Claude with prompt caching ──────────────────────────
async function callClaudeWithCache({
  systemPrompt, dynamicContext, messages, businessId, conversationId, customerPhone, customerName,
}) {
  try {
    let response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }, // ← cached — paid once per 5 min
        },
      ],
      tools:    TOOLS,
      // Inject dynamic context as last user message context
      messages: dynamicContext
        ? [
            ...messages.slice(0, -1),
            {
              role: "user",
              content: messages[messages.length - 1].content +
                "[RELEVANT BUSINESS DATA FOR THIS MESSAGE:" + dynamicContext + "]",
            },
          ]
        : messages,
    });

    // Log cache usage for monitoring
    const usage = response.usage;
    if (usage?.cache_read_input_tokens > 0) {
      console.log(`💰 Cache hit: ${usage.cache_read_input_tokens} tokens cached (saved $${((usage.cache_read_input_tokens * 0.9) / 1000000).toFixed(6)})`);
    }

    // Handle tool calls
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults   = [];

      for (const tool of toolUseBlocks) {
        const result = await executeTool({
          toolName: tool.name, input: tool.input,
          businessId, conversationId, customerPhone, customerName,
        });
        toolResults.push({
          type:        "tool_result",
          tool_use_id: tool.id,
          content:     JSON.stringify(result),
        });
      }

      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user",      content: toolResults },
      ];

      response = await anthropic.messages.create({
        model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools:    TOOLS,
        messages,
      });
    }

    const textReply = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")
      .trim();

    return textReply || null;

  } catch (err) {
    console.error("Claude API error:", err.message);
    return "Sorry, I'm having a technical issue. I'll get back to you shortly.";
  }
}

// ── Execute tool ──────────────────────────────────────────────
async function executeTool({ toolName, input, businessId, conversationId, customerPhone, customerName }) {
  const ctx = { businessId, conversationId, customerPhone, customerName, input };
  switch (toolName) {
    case "save_lead":          return executeSaveLead(ctx);
    case "confirm_order":      return executeConfirmOrder(ctx);
    case "book_appointment":   return executeBookAppointment(ctx);
    case "check_availability": return executeCheckAvailability(ctx);
    case "notify_owner":       return executeNotifyOwner(ctx);
    case "schedule_followup":  return executeScheduleFollowup(ctx);
    default:                   return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Save message to DB ────────────────────────────────────────
async function saveMessage({ conversationId, businessId, role, content, waMessageId = null }) {
  await query(`
    INSERT INTO messages (conversation_id, business_id, role, content, wa_message_id, status)
    VALUES ($1, $2, $3, $4, $5, 'sent')
  `, [conversationId, businessId, role, content, waMessageId]);
}