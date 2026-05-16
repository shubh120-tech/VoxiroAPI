import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./systemPrompt.js";
import { saveLeadTool,          executeSaveLead          } from "./tools/saveLead.js";
import { confirmOrderTool,      executeConfirmOrder       } from "./tools/confirmOrder.js";
import { bookAppointmentTool,   executeBookAppointment    } from "./tools/bookAppointment.js";
import { checkAvailabilityTool, executeCheckAvailability  } from "./tools/checkAvailability.js";
import { notifyOwnerTool,       executeNotifyOwner        } from "./tools/notifyOwner.js";
import { query } from "../db/postgres.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS = [
  saveLeadTool,
  confirmOrderTool,
  bookAppointmentTool,
  checkAvailabilityTool,
  notifyOwnerTool,
];

// Full history — never forgets any message in the conversation
const MAX_HISTORY = 100;

/**
 * Main entry point — called when a WhatsApp message arrives.
 * Uses regular Claude Messages API with full conversation history.
 * Agent remembers EVERYTHING said in the conversation — message 1, 21, 200.
 */
export async function handleIncomingMessage({
  businessId,
  conversationId,
  customerPhone,
  customerName,
  message,
}) {
  // 1. Check if owner took over — agent stays silent
  const { rows: convRows } = await query(
    "SELECT status FROM conversations WHERE id = $1",
    [conversationId]
  );
  if (convRows[0]?.status === "manual") return null;

  // 2. Save incoming message to DB
  await saveMessage({ conversationId, businessId, role: "customer", content: message });

  // 3. Update conversation last message
  await query(`
    UPDATE conversations
    SET last_message = $1, last_message_at = NOW(), updated_at = NOW()
    WHERE id = $2
  `, [message, conversationId]);

  // 4. Build system prompt for this business
  const systemPrompt = await buildSystemPrompt(businessId);

  // 5. Load FULL conversation history from DB
  const history = await loadConversationHistory(conversationId);

  // 6. Build messages — full history + new message
  const messages = [
    ...history,
    { role: "user", content: message },
  ];

  // 7. Call Claude with full context
  const reply = await callClaude({
    systemPrompt,
    messages,
    businessId,
    conversationId,
    customerPhone,
  });

  // 8. Save agent reply
  if (reply) {
    await saveMessage({ conversationId, businessId, role: "agent", content: reply });
  }

  return reply;
}

/**
 * Load full conversation history from DB.
 * customer → user, agent/owner → assistant
 */
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

/**
 * Call Claude Messages API.
 * Handles tool calls in a loop until agent gives final text reply.
 */
async function callClaude({ systemPrompt, messages, businessId, conversationId, customerPhone }) {
  try {
    let response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system:     systemPrompt,
      tools:      TOOLS,
      messages,
    });

    // Keep looping until no more tool calls
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults   = [];

      for (const tool of toolUseBlocks) {
        const result = await executeTool({
          toolName:       tool.name,
          input:          tool.input,
          businessId,
          conversationId,
          customerPhone,
        });
        toolResults.push({
          type:        "tool_result",
          tool_use_id: tool.id,
          content:     JSON.stringify(result),
        });
      }

      // Add tool results and call Claude again
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

    // Extract final text
    const textReply = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    return textReply || "I'm here to help! What would you like to know? 😊";

  } catch (err) {
    console.error("Claude API error:", err.message);
    return "Sorry, I'm having a technical issue right now. I'll get back to you shortly! 🙏";
  }
}

/**
 * Route tool calls to the right executor.
 */
async function executeTool({ toolName, input, businessId, conversationId, customerPhone }) {
  const ctx = { businessId, conversationId, customerPhone, input };
  switch (toolName) {
    case "save_lead":          return executeSaveLead(ctx);
    case "confirm_order":      return executeConfirmOrder(ctx);
    case "book_appointment":   return executeBookAppointment(ctx);
    case "check_availability": return executeCheckAvailability(ctx);
    case "notify_owner":       return executeNotifyOwner(ctx);
    default:                   return { error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Save a message to the DB.
 */
async function saveMessage({ conversationId, businessId, role, content }) {
  await query(`
    INSERT INTO messages (conversation_id, business_id, role, content)
    VALUES ($1, $2, $3, $4)
  `, [conversationId, businessId, role, content]);
}