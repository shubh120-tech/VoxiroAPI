import { query }                from "../db/postgres.js";
import { handleIncomingMessage } from "./agentManager.js";

const BATCH_WAIT_SECONDS = 10;

// In-memory lock to prevent same customer being processed twice simultaneously
const processingLock = new Set();

export async function processMessageBatches() {
  try {
    // Atomically mark messages as processing AND select them in one query
    // This prevents race condition when cron runs every 3 seconds
    const { rows: readyCustomers } = await query(`
      WITH to_process AS (
        SELECT
          customer_phone,
          business_id,
          conversation_id,
          customer_name,
          phone_number_id,
          access_token,
          MAX(received_at)                          AS last_received,
          COUNT(*)                                  AS message_count,
          ARRAY_AGG(message_text ORDER BY received_at ASC)   AS messages,
          ARRAY_AGG(wa_message_id ORDER BY received_at ASC)  AS wa_message_ids
        FROM pending_messages
        WHERE processed    = FALSE
          AND received_at  < NOW() - INTERVAL '10 seconds'
        GROUP BY customer_phone, business_id, conversation_id, customer_name, phone_number_id, access_token
        ORDER BY last_received ASC
        LIMIT 10
      ),
      mark_processed AS (
        UPDATE pending_messages pm
        SET processed = TRUE, processed_at = NOW()
        FROM to_process tp
        WHERE pm.customer_phone = tp.customer_phone
          AND pm.business_id    = tp.business_id
          AND pm.processed      = FALSE
          AND pm.received_at    < NOW() - INTERVAL '10 seconds'
      )
      SELECT * FROM to_process
    `);

    if (!readyCustomers.length) return;

    console.log(`📦 Processing ${readyCustomers.length} message batch(es)...`);

    for (const batch of readyCustomers) {
      const lockKey = `${batch.business_id}:${batch.customer_phone}`;

      // Skip if already being processed in this server instance
      if (processingLock.has(lockKey)) {
        console.log(`🔒 Skipping ${batch.customer_phone} — already processing`);
        continue;
      }

      processingLock.add(lockKey);
      processBatch(batch).finally(() => processingLock.delete(lockKey));
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
    // Check conversation status
    const { rows: convRows } = await query(
      "SELECT status FROM conversations WHERE id = $1",
      [conversation_id]
    );
    if (convRows[0]?.status === "manual") {
      console.log(`⏭️  Skipping ${customer_phone} — manual mode`);
      return;
    }

    const combinedMessage = combineMessages(messages);
    const lastWaMessageId = wa_message_ids?.filter(Boolean).pop() || null;

    console.log(`📨 Batch: ${message_count} msg(s) from ${customer_phone}: "${combinedMessage.slice(0, 60)}"`);

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
    const errMsg  = err.response?.data?.error?.message || err.message;
    const errCode = err.response?.data?.error?.code;
    console.error(`Batch error for ${customer_phone}:`, errMsg);

    // Token expired (401/190) — mark business as token_expired, don't retry
    if (err.response?.status === 401 || errCode === 190) {
      console.error(`🔑 Token expired for business ${business_id} — update token in Settings`);
      await query(`
        UPDATE whatsapp_configs
        SET status = 'token_expired', updated_at = NOW()
        WHERE business_id = $1
      `, [business_id]).catch(() => {});

      // Don't retry — token is invalid, retrying wastes API calls
      return;
    }

    // Other errors — unmark so it retries
    await query(`
      UPDATE pending_messages
      SET processed = FALSE, processed_at = NULL
      WHERE customer_phone = $1
        AND business_id    = $2
        AND processed_at   > NOW() - INTERVAL '1 minute'
    `, [customer_phone, business_id]).catch(() => {});
  }
}

function combineMessages(messages) {
  if (!messages?.length) return "";
  if (messages.length === 1) return messages[0];

  const cleaned = messages.map(m => (m || "").trim()).filter(Boolean);
  if (cleaned.length === 1) return cleaned[0];

  const totalLength = cleaned.join(" ").length;

  // All short messages — likely one split thought, join with space
  if (cleaned.every(m => m.length < 60) && totalLength < 250) {
    return cleaned.join(" ");
  }

  // Mix of lengths — join with newline
  return cleaned.join("\n");
}