// src/utils/aiUsageLogger.js
// Call this after EVERY anthropic.messages.create() call
// Logs tokens + estimated cost to ai_usage_logs table

import { query } from "../db/postgres.js";

// Pricing per 1M tokens (as of mid-2025, in USD)
const MODEL_PRICING = {
  // Haiku 4.5
  "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00  },
  "claude-haiku-4-5":          { input: 0.80,  output: 4.00  },
  // Sonnet 4.5 / 4
  "claude-sonnet-4-5":         { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-20250514":  { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-6":         { input: 3.00,  output: 15.00 },
  // Opus
  "claude-opus-4-5":           { input: 15.00, output: 75.00 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  return (
    (inputTokens  / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

export async function logAIUsage(businessId, feature, model, usage) {
  try {
    if (!businessId || !usage) return;

    const inputTokens  = usage.input_tokens  || 0;
    const outputTokens = usage.output_tokens || 0;
    const totalTokens  = inputTokens + outputTokens;
    const costUsd      = estimateCost(model, inputTokens, outputTokens);

    await query(`
      INSERT INTO ai_usage_logs
        (business_id, feature, model, input_tokens, output_tokens, total_tokens, cost_usd)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [businessId, feature, model, inputTokens, outputTokens, totalTokens, costUsd]);

  } catch (err) {
    // Non-fatal — never let logging break the main flow
    console.warn(`[aiUsageLogger] Failed to log usage: ${err.message}`);
  }
}