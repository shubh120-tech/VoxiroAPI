import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt }                        from "./systemPrompt.js";
import { saveLeadTool,          executeSaveLead          } from "./tools/saveLead.js";
import { confirmOrderTool,      executeConfirmOrder       } from "./tools/confirmOrder.js";
import { bookAppointmentTool,   executeBookAppointment    } from "./tools/bookAppointment.js";
import { checkAvailabilityTool, executeCheckAvailability  } from "./tools/checkAvailability.js";
import { notifyOwnerTool,       executeNotifyOwner        } from "./tools/notifyOwner.js";
import { scheduleFollowupTool,  executeScheduleFollowup   } from "./tools/scheduleFollowup.js";
import { sendWhatsAppMessages,  splitIntoMessages          } from "../whatsapp/sender.js";
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
  if (conversationLength > 30) return 8;
  if (conversationLength > 15) return 12;
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

    // ── Save customer message ───────────────────────────────
    await saveMessage({ conversationId, businessId, role: "customer", content: message });
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

    // ── Load conversation history (dynamic length) ──────────
    const { rows: allMsgs } = await query(
      "SELECT COUNT(*) FROM messages WHERE conversation_id = $1",
      [conversationId]
    );
    const totalMsgs  = parseInt(allMsgs[0].count) || 0;
    const maxHistory = getMaxHistory(totalMsgs);
    const history    = await loadConversationHistory(conversationId, maxHistory);

    const messages = [
      ...history,
      { role: "user", content: message },
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
        to: customerPhone,
        messages: parts,
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

// ── Load conversation history ─────────────────────────────────
async function loadConversationHistory(conversationId, limit = 20) {
  const { rows } = await query(`
    SELECT role, content FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
    LIMIT $2
  `, [conversationId, limit]);

  return rows.map(row => ({
    role:    row.role === "customer" ? "user" : "assistant",
    content: row.content,
  }));
}

// ── Call Claude with prompt caching ──────────────────────────
async function callClaudeWithCache({
  systemPrompt, messages, businessId, conversationId, customerPhone, customerName,
}) {
  try {
    let response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 400, // reduced from 1024 — agent replies are short
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }, // ← PROMPT CACHING
        },
      ],
      tools:    TOOLS,
      messages,
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