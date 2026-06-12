import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "./agentManager.js";

const BATCH_WAIT_SECONDS = 3;

// In-memory lock
const processingLock = new Set();

export async function processMessageBatches() {
  try {
    // ✅ ONLY SELECT (DO NOT mark processed here)
    const { rows: readyCustomers } = await query(`
      SELECT
        customer_phone,
        business_id,
        conversation_id,
        customer_name,
        phone_number_id,
        access_token,
        MAX(received_at) AS last_received,
        COUNT(*) AS message_count,
        ARRAY_AGG(message_text ORDER BY received_at ASC) AS messages,
        ARRAY_AGG(wa_message_id ORDER BY received_at ASC) AS wa_message_ids
      FROM pending_messages
      WHERE processed = FALSE
        AND received_at < NOW() - INTERVAL '${BATCH_WAIT_SECONDS} seconds'
      GROUP BY customer_phone, business_id, conversation_id, customer_name, phone_number_id, access_token
      ORDER BY last_received ASC
      LIMIT 10
    `);

    if (!readyCustomers.length) return;

    console.log(`📦 Processing ${readyCustomers.length} batch(es)...`);

    for (const batch of readyCustomers) {
      const lockKey = `${batch.business_id}:${batch.customer_phone}`;

      // Skip if already processing
      if (processingLock.has(lockKey)) {
        console.log(`🔒 Skipping ${batch.customer_phone} — already processing`);
        continue;
      }

      processingLock.add(lockKey);

      // ✅ Safety unlock (VERY IMPORTANT)
      setTimeout(() => processingLock.delete(lockKey), 20000);

      processBatch(batch)
        .catch(err => console.error("Batch error:", err.message))
        .finally(() => processingLock.delete(lockKey));
    }

  } catch (err) {
    console.error("Message batch cron error:", err.message);
  }
}

async function processBatch(batch) {
  const {
    customer_phone,
    business_id,
    conversation_id,
    customer_name,
    phone_number_id,
    access_token,
    messages,
    wa_message_ids,
    message_count,
  } = batch;

  try {
    // ✅ Check conversation mode
    const { rows: convRows } = await query(
      "SELECT status FROM conversations WHERE id = $1",
      [conversation_id]
    );

    if (["manual", "needs-help"].includes(convRows[0]?.status)) {
      console.log(`⏭️ Skipping ${customer_phone} — manual mode`);
      return;
    }

    const combinedMessage = combineMessages(messages);
    const lastWaMessageId = wa_message_ids?.filter(Boolean).pop() || null;

    console.log(`📨 ${customer_phone}: "${combinedMessage.slice(0, 60)}"`);

    // ✅ Call AI
    const reply = await handleIncomingMessage({
      businessId: business_id,
      conversationId: conversation_id,
      customerPhone: customer_phone,
      customerName: customer_name,
      message: combinedMessage,
      phoneNumberId: phone_number_id,
      accessToken: access_token,
      waMessageId: lastWaMessageId,
    });

    // ✅ ONLY mark processed if reply was attempted
    if (reply) {
      await query(`
        UPDATE pending_messages
        SET processed = TRUE, processed_at = NOW()
        WHERE customer_phone = $1
          AND business_id = $2
          AND processed = FALSE
      `, [customer_phone, business_id]);
    } else {
      console.warn(`⚠️ No reply generated for ${customer_phone}, will retry`);
    }

  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    const errCode = err.response?.data?.error?.code;

    console.error(`❌ Error for ${customer_phone}:`, errMsg);

    // 🔴 Token expired
    if (err.response?.status === 401 || errCode === 190) {
      console.error(`🔑 Token expired for business ${business_id}`);

      await query(`
        UPDATE whatsapp_configs
        SET status = 'token_expired', updated_at = NOW()
        WHERE business_id = $1
      `, [business_id]).catch(() => {});

      return;
    }

    // ✅ Retry: reset processed flag
    await query(`
      UPDATE pending_messages
      SET processed = FALSE, processed_at = NULL
      WHERE customer_phone = $1
        AND business_id = $2
    `, [customer_phone, business_id]).catch(() => {});
  }
}

// ✅ SIMPLIFIED (more reliable)
function combineMessages(messages) {
  if (!messages?.length) return "";
  return messages.map(m => (m || "").trim()).filter(Boolean).join("\n");
}