import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt }                        from "./systemPrompt.js";
import { saveLeadTool,          executeSaveLead          } from "./tools/saveLead.js";
import { confirmOrderTool,      executeConfirmOrder       } from "./tools/confirmOrder.js";
import { bookAppointmentTool,   executeBookAppointment    } from "./tools/bookAppointment.js";
import { checkAvailabilityTool, executeCheckAvailability  } from "./tools/checkAvailability.js";
import { notifyOwnerTool,       executeNotifyOwner        } from "./tools/notifyOwner.js";
import { scheduleFollowupTool,  executeScheduleFollowup   } from "./tools/scheduleFollowup.js";
import {
  updateAppointmentTool, executeUpdateAppointment,
  cancelAppointmentTool, executeCancelAppointment,
  updateOrderTool,       executeUpdateOrder,
  cancelOrderTool,       executeCancelOrder,
  updateFollowupTool,    executeUpdateFollowup,
  cancelFollowupTool,    executeCancelFollowup,
} from "./tools/orderAppointmentTools.js";
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
  updateAppointmentTool,
  cancelAppointmentTool,
  updateOrderTool,
  cancelOrderTool,
  updateFollowupTool,
  cancelFollowupTool,
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
  waMessageId = null,
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
    // ── Check manual mode ─────────────────────────────────────
    const { rows: convRows } = await query(
      "SELECT status FROM conversations WHERE id = $1",
      [conversationId]
    );
    if (["manual", "needs-help"].includes(convRows[0]?.status)) {
      console.log(`⏭️ Skipping agent reply — conversation ${conversationId} is in ${convRows[0]?.status} mode`);
      return null;
    }

    // ── Update last_message timestamp ─────────────────────────
    await query(`
      UPDATE conversations
      SET last_message = $1, last_message_at = NOW(), updated_at = NOW()
      WHERE id = $2
    `, [message, conversationId]);

    // ── Handle simple one-word replies without Claude ─────────
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

    // ── Get system prompt (cached) ────────────────────────────
    const systemPrompt = await getCachedPrompt(businessId);

    // ── Fetch already collected details ───────────────────────
    const { rows: detailRows } = await query(`
      SELECT collected_details, customer_name, customer_phone FROM conversations WHERE id = $1
    `, [conversationId]).catch(() => ({ rows: [] }));

    const savedDetails = detailRows[0]?.collected_details || {};
    const savedName    = detailRows[0]?.customer_name || customerName;
    const savedPhone   = detailRows[0]?.customer_phone || customerPhone;

    const collectedDetails = {
      ...savedDetails,
      ...(savedName  && !savedDetails.name  ? { name: savedName }   : {}),
      ...(savedPhone && !savedDetails.phone ? { phone: savedPhone } : {}),
    };

    // ── Two-step reply for complex questions ──────────────────
    if (phoneNumberId && accessToken && isComplexQuestion(message)) {
      const thinkingMsg = getThinkingMessage(message);
      await sendWhatsAppMessages({
        phoneNumberId, accessToken,
        to: customerPhone,
        messages: [thinkingMsg],
      });
      await saveMessage({ conversationId, businessId, role: "agent", content: thinkingMsg });
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }

    // ── Load history ──────────────────────────────────────────
    const history = await loadConversationHistory(conversationId, 20);

    // ── Build context note ────────────────────────────────────
    const knownParts = [];
    knownParts.push(`WhatsApp/Contact Number: ${customerPhone} — NEVER ask for this`);
    if (collectedDetails.name || customerName)
      knownParts.push(`Name: ${collectedDetails.name || customerName} — do NOT ask again`);
    if (collectedDetails.domain)
      knownParts.push(`Domain/Subject: ${collectedDetails.domain}`);
    if (collectedDetails.service)
      knownParts.push(`Service: ${collectedDetails.service}`);
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

    // ── Fetch dynamic context based on customer message ─────
    // Loads only relevant data (services, products, FAQs, payment)
    // keeping token usage low while keeping answers accurate
    let dynamicContext = null;
    try {
      dynamicContext = await fetchRelevantContext(businessId, message);
    } catch (err) {
      console.warn("Context fetch failed (non-fatal):", err.message);
    }

    // ── Call Claude ───────────────────────────────────────────
    const reply = await callClaudeWithCache({
      systemPrompt,
      dynamicContext,
      messages,
      businessId,
      conversationId,
      customerPhone,
      customerName,
    });

    if (!reply) return null;

    // ── Split + send ──────────────────────────────────────────
    const parts = splitIntoMessages(reply);

    if (phoneNumberId && accessToken) {
      const results = await sendWhatsAppMessages({
        phoneNumberId, accessToken,
        to:           customerPhone,
        messages:     parts,
        waMessageId,
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
    processingLock.delete(lockKey);
  }
}

// ── Holding replies for simple messages ──────────────────────
function getHoldingReply(message) {
  const msg = message.toLowerCase().trim();
  if (["thanks", "thank you", "thankyou", "ty", "🙏"].includes(msg)) {
    return "You're welcome! Is there anything else I can help you with?";
  }
  return null;
}

// ── Detect complex question ───────────────────────────────────
function isComplexQuestion(message) {
  const msg = message.toLowerCase();
  if (/discount|negotiate|kam karo|thoda kam|best price|cheaper|reduce price|less price/.test(msg)) return true;
  if (/\b1 day\b|\b2 day\b|\b3 day\b|tomorrow deadline|aaj chahiye|kal chahiye|tonight|emergency/.test(msg)) return true;
  if (/refund|scam|fake|fraud|trust|verify|genuine|proof/.test(msg)) return true;
  return false;
}

// ── Thinking message ──────────────────────────────────────────
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
async function loadConversationHistory(conversationId, limit = 20) {
  const { rows: countRows } = await query(
    "SELECT COUNT(*) FROM messages WHERE conversation_id = $1",
    [conversationId]
  );
  const total = parseInt(countRows[0].count) || 0;

  if (total <= limit) {
    const { rows } = await query(`
      SELECT role, content FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `, [conversationId]);
    return rows.map(toMessage);
  }

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

  lastRows.reverse();

  return [
    ...firstRows,
    { role: "assistant", content: "[Earlier conversation context omitted — customer details above are still valid]" },
    ...lastRows,
  ].map(toMessage);
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
          type:          "text",
          text:          systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools:    TOOLS,
      messages: dynamicContext
        ? [
            ...messages.slice(0, -1),
            {
              role:    "user",
              content: messages[messages.length - 1].content +
                "[RELEVANT BUSINESS DATA FOR THIS MESSAGE:" + dynamicContext + "]",
            },
          ]
        : messages,
    });

    const usage = response.usage;
    if (usage?.cache_read_input_tokens > 0) {
      console.log(`💰 Cache hit: ${usage.cache_read_input_tokens} tokens cached (saved $${((usage.cache_read_input_tokens * 0.9) / 1000000).toFixed(6)})`);
    }

    // ── Handle tool calls ─────────────────────────────────────
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
            type:          "text",
            text:          systemPrompt,
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
    case "save_lead":           return executeSaveLead(ctx);
    case "confirm_order":       return executeConfirmOrder(ctx);
    case "book_appointment":    return executeBookAppointment(ctx);
    case "check_availability":  return executeCheckAvailability(ctx);
    case "notify_owner":        return executeNotifyOwner(ctx);
    case "schedule_followup":   return executeScheduleFollowup(ctx);
    case "update_appointment":  return executeUpdateAppointment(ctx);
    case "cancel_appointment":  return executeCancelAppointment(ctx);
    case "update_order":        return executeUpdateOrder(ctx);
    case "cancel_order":        return executeCancelOrder(ctx);
    case "update_followup":     return executeUpdateFollowup(ctx);
    case "cancel_followup":     return executeCancelFollowup(ctx);
    default:                    return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Save message to DB ────────────────────────────────────────
async function saveMessage({ conversationId, businessId, role, content, waMessageId = null }) {
  await query(`
    INSERT INTO messages (conversation_id, business_id, role, content, wa_message_id, status)
    VALUES ($1, $2, $3, $4, $5, 'sent')
  `, [conversationId, businessId, role, content, waMessageId]);
}