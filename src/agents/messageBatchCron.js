import { query }                from "../db/postgres.js";
import { handleIncomingMessage } from "./agentManager.js";

const BATCH_WAIT_SECONDS = 10; // Wait 10 seconds after last message

/**
 * Process batched messages.
 * Runs every 3 seconds.
 *
 * Flow:
 * 1. Find customers whose last message was > 10 seconds ago
 * 2. Collect all unprocessed messages for that customer
 * 3. Combine into one context
 * 4. Send to agent for ONE combined reply
 * 5. Mark messages as processed
 */
export async function processMessageBatches() {
  try {
    // Find customers ready for processing
    // "Ready" = last message received > 10 seconds ago AND has unprocessed messages
    const { rows: readyCustomers } = await query(`
      SELECT
        customer_phone,
        business_id,
        conversation_id,
        customer_name,
        phone_number_id,
        access_token,
        MAX(received_at)  AS last_received,
        COUNT(*)          AS message_count,
        ARRAY_AGG(
          message_text ORDER BY received_at ASC
        ) AS messages,
        ARRAY_AGG(
          wa_message_id ORDER BY received_at ASC
        ) AS wa_message_ids,
        MIN(id::text) AS first_id
      FROM pending_messages
      WHERE processed = FALSE
        AND received_at < NOW() - INTERVAL '10 seconds'
      GROUP BY customer_phone, business_id, conversation_id, customer_name, phone_number_id, access_token
      ORDER BY last_received ASC
      LIMIT 20
    `);

    if (!readyCustomers.length) return;

    console.log(`📦 Processing ${readyCustomers.length} message batch(es)...`);

    for (const batch of readyCustomers) {
      await processBatch(batch);
    }

  } catch (err) {
    console.error("Message batch cron error:", err.message);
  }
}

async function processBatch(batch) {
  const {
    customer_phone, business_id, conversation_id,
    customer_name,  phone_number_id, access_token,
    messages, wa_message_ids, message_count,
  } = batch;

  try {
    // Mark all as processing to prevent double-processing
    await query(`
      UPDATE pending_messages
      SET processed = TRUE, processed_at = NOW()
      WHERE customer_phone = $1
        AND business_id    = $2
        AND processed      = FALSE
        AND received_at    < NOW() - INTERVAL '10 seconds'
    `, [customer_phone, business_id]);

    // Check conversation status — skip if manual mode
    const { rows: convRows } = await query(
      "SELECT status FROM conversations WHERE id = $1",
      [conversation_id]
    );
    if (convRows[0]?.status === "manual") {
      console.log(`⏭️  Skipping batch for ${customer_phone} — conversation in manual mode`);
      return;
    }

    // Combine messages intelligently
    const combinedMessage = combineMessages(messages);
    const lastWaMessageId = wa_message_ids?.filter(Boolean).pop() || null;

    console.log(`📨 Processing batch: ${message_count} message(s) from ${customer_phone}`);
    console.log(`   Combined: "${combinedMessage.slice(0, 80)}..."`);

    // Send to agent — agent handles ONE combined reply
    await handleIncomingMessage({
      businessId:     business_id,
      conversationId: conversation_id,
      customerPhone:  customer_phone,
      customerName:   customer_name,
      message:        combinedMessage,
      phoneNumberId:  phone_number_id,
      accessToken:    access_token,
      waMessageId:    lastWaMessageId,
    });

  } catch (err) {
    console.error(`Batch processing error for ${customer_phone}:`, err.message);

    // Unmark as processed so it can be retried
    await query(`
      UPDATE pending_messages
      SET processed = FALSE
      WHERE customer_phone = $1
        AND business_id    = $2
        AND processed_at   > NOW() - INTERVAL '1 minute'
    `, [customer_phone, business_id]).catch(() => {});
  }
}

/**
 * Combine multiple messages from same customer into one coherent message.
 *
 * Rules:
 * - If all messages are about the same topic → combine naturally
 * - If different topics → separate with newlines
 * - Remove duplicate info
 */
function combineMessages(messages) {
  if (!messages || messages.length === 0) return "";
  if (messages.length === 1) return messages[0];

  // Filter out empty messages
  const cleaned = messages.map(m => (m || "").trim()).filter(Boolean);
  if (cleaned.length === 1) return cleaned[0];

  // Check if messages seem like one split thought
  // e.g. ["hi", "I need help", "with my thesis"]
  const totalLength = cleaned.join(" ").length;

  // Short messages likely one split thought — join with space
  if (cleaned.every(m => m.length < 50) && totalLength < 200) {
    return cleaned.join(" ");
  }

  // Mix of short and long — join with newline
  return cleaned.join("\n");
}