import { query } from "../db/postgres.js";
import { handleIncomingMessage } from "./agentManager.js";

const BATCH_WAIT_SECONDS = 3;

// In-memory lock — backup only, DB-level lock below is the real guard
const processingLock = new Set();

export async function processMessageBatches() {
  try {
    // ✅ ONLY SELECT rows that are NOT processed AND NOT currently being processed
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
        ARRAY_AGG(wa_message_id ORDER BY received_at ASC) AS wa_message_ids,
        ARRAY_AGG(id ORDER BY received_at ASC) AS pending_ids
      FROM pending_messages
      WHERE processed = FALSE
        AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '90 seconds')
        AND received_at < NOW() - INTERVAL '${BATCH_WAIT_SECONDS} seconds'
      GROUP BY customer_phone, business_id, conversation_id, customer_name, phone_number_id, access_token
      ORDER BY last_received ASC
      LIMIT 10
    `);

    if (!readyCustomers.length) return;

    console.log(`📦 Processing ${readyCustomers.length} batch(es)...`);

    for (const batch of readyCustomers) {
      const lockKey = `${batch.business_id}:${batch.customer_phone}`;

      // In-memory backup lock — skip if this process is already handling it
      if (processingLock.has(lockKey)) {
        console.log(`🔒 Skipping ${batch.customer_phone} — already processing (in-memory)`);
        continue;
      }

      // ── DB-level lock: mark these specific rows as "in progress" ────
      // This is the REAL guard. Even if the cron tick races or the
      // in-memory lock is lost (process restart, long delay), these
      // exact row IDs will not be selected again for 90 seconds.
      const { rowCount } = await query(`
        UPDATE pending_messages
        SET processing_started_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND processed = FALSE
          AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '90 seconds')
      `, [batch.pending_ids]);

      // If 0 rows were updated, another tick already claimed this batch
      if (rowCount === 0) {
        console.log(`🔒 Skipping ${batch.customer_phone} — rows already claimed (DB lock)`);
        continue;
      }

      processingLock.add(lockKey);

      // Safety unlock — generous timeout for slow Claude + WhatsApp delays
      // (3 message parts × up to 7s delay + typing indicators + Claude call
      //  can realistically take 20-30s; give it real headroom)
      const safetyUnlock = setTimeout(() => processingLock.delete(lockKey), 120000);

      processBatch(batch)
        .catch(err => console.error("Batch error:", err.message))
        .finally(() => {
          clearTimeout(safetyUnlock);
          processingLock.delete(lockKey);
        });
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
    pending_ids,
  } = batch;

  try {
    // ✅ Check conversation mode
    const { rows: convRows } = await query(
      "SELECT status FROM conversations WHERE id = $1",
      [conversation_id]
    );

    if (["manual", "needs-help"].includes(convRows[0]?.status)) {
      console.log(`⏭️ Skipping ${customer_phone} — manual mode`);
      // Mark these specific rows processed so they don't get retried forever
      await query(`
        UPDATE pending_messages SET processed = TRUE, processed_at = NOW()
        WHERE id = ANY($1::uuid[])
      `, [pending_ids]);
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

    // ✅ Mark THESE SPECIFIC rows as processed (by id, not by customer/business)
    // This prevents accidentally marking newer messages (that arrived during
    // processing) as processed when they haven't been replied to yet.
    if (reply) {
      await query(`
        UPDATE pending_messages
        SET processed = TRUE, processed_at = NOW()
        WHERE id = ANY($1::uuid[])
      `, [pending_ids]);
    } else {
      console.warn(`⚠️ No reply generated for ${customer_phone}, will retry`);
      // Release the processing lock so it can be retried
      await query(`
        UPDATE pending_messages
        SET processing_started_at = NULL
        WHERE id = ANY($1::uuid[])
      `, [pending_ids]);
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

    // ✅ Retry: release the processing lock on these specific rows
    await query(`
      UPDATE pending_messages
      SET processing_started_at = NULL
      WHERE id = ANY($1::uuid[])
    `, [pending_ids]).catch(() => {});
  }
}

// ✅ SIMPLIFIED (more reliable)
function combineMessages(messages) {
  if (!messages?.length) return "";
  return messages.map(m => (m || "").trim()).filter(Boolean).join("\n");
}