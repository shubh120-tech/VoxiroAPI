import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt }                        from "./systemPrompt.js";
import { saveLeadTool,          executeSaveLead          } from "./tools/saveLead.js";
import { confirmOrderTool,      executeConfirmOrder       } from "./tools/confirmOrder.js";
import { bookAppointmentTool,   executeBookAppointment    } from "./tools/bookAppointment.js";
import { checkAvailabilityTool, executeCheckAvailability  } from "./tools/checkAvailability.js";
import { notifyOwnerTool,       executeNotifyOwner        } from "./tools/notifyOwner.js";
import { scheduleFollowupTool,  executeScheduleFollowup   } from "./tools/scheduleFollowup.js";
import { sendWhatsAppMessages, sendWhatsAppMessage, splitIntoMessages } from "../whatsapp/sender.js";
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

// Keep last 20 messages — enough context, low cost
const MAX_HISTORY = 20;

// ── Prompt cache (5 min) — avoid rebuilding every message ─────
const promptCache = new Map();

async function getCachedSystemPrompt(businessId) {
  const key    = `prompt_${businessId}`;
  const cached = promptCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.prompt;

  const prompt = await buildSystemPrompt(businessId);
  promptCache.set(key, { prompt, expiry: Date.now() + 5 * 60 * 1000 });
  return prompt;
}

/**
 * Main entry — called when WhatsApp message arrives.
 * Returns array of reply parts to send as separate messages.
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
  // Check if manual mode
  const { rows: convRows } = await query(
    "SELECT status FROM conversations WHERE id = $1",
    [conversationId]
  );
  if (convRows[0]?.status === "manual") return null;

  // Save customer message
  await saveMessage({ conversationId, businessId, role: "customer", content: message });

  // Update last message
  await query(`
    UPDATE conversations
    SET last_message = $1, last_message_at = NOW(), updated_at = NOW()
    WHERE id = $2
  `, [message, conversationId]);

  // Build prompt (cached)
  const systemPrompt = await getCachedSystemPrompt(businessId);

  // Load conversation history
  const history = await loadConversationHistory(conversationId);

  const messages = [
    ...history,
    { role: "user", content: message },
  ];

  // Call Claude
  const reply = await callClaude({
    systemPrompt,
    messages,
    businessId,
    conversationId,
    customerPhone,
    customerName,
  });

  if (!reply) return null;

  // Split reply into human-like parts
  const parts = splitIntoMessages(reply);

  // Send each part as separate WhatsApp message
  if (phoneNumberId && accessToken) {
    const results = await sendWhatsAppMessages({ phoneNumberId, accessToken, to: customerPhone, messages: parts });

    // Save all parts to DB
    for (let i = 0; i < parts.length; i++) {
      const waId = results[i]?.messages?.[0]?.id || null;
      await saveMessage({
        conversationId, businessId, role: "agent",
        content: parts[i], waMessageId: waId,
      });
    }
  } else {
    // Fallback — save combined reply
    await saveMessage({ conversationId, businessId, role: "agent", content: parts.join("\n\n") });
  }

  return parts;
}

async function loadConversationHistory(conversationId) {
  const { rows } = await query(`
    SELECT role, content FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
    LIMIT $2
  `, [conversationId, MAX_HISTORY]);

  return rows.map(row => ({
    role:    row.role === "customer" ? "user" : "assistant",
    content: row.content,
  }));
}

async function callClaude({ systemPrompt, messages, businessId, conversationId, customerPhone, customerName }) {
  try {
    let response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system:     systemPrompt,
      tools:      TOOLS,
      messages,
    });

    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults   = [];

      for (const tool of toolUseBlocks) {
        const result = await executeTool({
          toolName: tool.name, input: tool.input,
          businessId, conversationId, customerPhone, customerName,
        });
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: JSON.stringify(result) });
      }

      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user",      content: toolResults },
      ];

      response = await anthropic.messages.create({
        model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system:     systemPrompt,
        tools:      TOOLS,
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

async function saveMessage({ conversationId, businessId, role, content, waMessageId = null }) {
  await query(`
    INSERT INTO messages (conversation_id, business_id, role, content, wa_message_id, status)
    VALUES ($1, $2, $3, $4, $5, 'sent')
  `, [conversationId, businessId, role, content, waMessageId]);
}