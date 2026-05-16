import { query } from "../db/postgres.js";

/**
 * Each customer gets their own dedicated Managed Agent session.
 * Session ID = unique per business + customer phone combo.
 * We store the Anthropic session ID in PostgreSQL.
 */

export async function getOrCreateSession({ businessId, customerPhone }) {
  // Check for existing active session
  const { rows } = await query(`
    SELECT
      s.id,
      s.anthropic_session_id,
      s.status,
      s.created_at
    FROM agent_sessions s
    WHERE s.business_id   = $1
      AND s.customer_phone = $2
      AND s.status NOT IN ('terminated', 'expired')
    ORDER BY s.created_at DESC
    LIMIT 1
  `, [businessId, customerPhone]);

  if (rows.length > 0) {
    return rows[0];
  }

  // No active session — create a new record (Anthropic session created in agentManager)
  const { rows: newRows } = await query(`
    INSERT INTO agent_sessions (business_id, customer_phone, status)
    VALUES ($1, $2, 'pending')
    RETURNING id
  `, [businessId, customerPhone]);

  return { id: newRows[0].id, anthropic_session_id: null, status: "pending" };
}

export async function saveAnthropicSessionId({ sessionId, anthropicSessionId }) {
  await query(`
    UPDATE agent_sessions
    SET anthropic_session_id = $1,
        status = 'active',
        updated_at = NOW()
    WHERE id = $2
  `, [anthropicSessionId, sessionId]);
}

export async function markSessionTerminated({ sessionId }) {
  await query(`
    UPDATE agent_sessions
    SET status = 'terminated', updated_at = NOW()
    WHERE id = $1
  `, [sessionId]);
}

export async function getSessionByConversation({ conversationId }) {
  const { rows } = await query(`
    SELECT s.*
    FROM agent_sessions s
    JOIN conversations c ON c.customer_phone = s.customer_phone
      AND c.business_id = s.business_id
    WHERE c.id = $1
      AND s.status = 'active'
    LIMIT 1
  `, [conversationId]);
  return rows[0] || null;
}
