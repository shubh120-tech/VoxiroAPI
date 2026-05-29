import express    from "express";
import Anthropic  from "@anthropic-ai/sdk";
import { query }  from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import { generateBusinessPrompt } from "../agents/generatePrompt.js";

const router   = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(authMiddleware);

const bId = (req) => req.user.business_id;

// ── Get current prompt ────────────────────────────────────────
router.get("/training/prompt", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT system_prompt, agent_name FROM agent_configs WHERE business_id = $1",
      [bId(req)]
    );
    res.json({ prompt: rows[0]?.system_prompt || "", agentName: rows[0]?.agent_name || "Agent" });
  } catch (err) {
    res.status(500).json({ message: "Failed to load prompt" });
  }
});

// ── Generate prompt from business data ────────────────────────
router.post("/training/generate", async (req, res) => {
  try {
    const prompt = await generateBusinessPrompt(bId(req));
    res.json({ success: true, prompt });
  } catch (err) {
    console.error("Prompt generate error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Fix prompt with AI ────────────────────────────────────────
router.post("/training/fix", async (req, res) => {
  try {
    const { problem, exampleConversation } = req.body;
    if (!problem?.trim()) return res.status(400).json({ message: "Describe the problem" });

    // Get current prompt
    const { rows } = await query(
      "SELECT system_prompt FROM agent_configs WHERE business_id = $1",
      [bId(req)]
    );
    const currentPrompt = rows[0]?.system_prompt || "";
    if (!currentPrompt) return res.status(400).json({ message: "No prompt configured yet" });

    // Build meta-prompt for Claude Sonnet
    const metaPrompt = `You are an expert WhatsApp sales agent prompt engineer.

A business owner has a problem with their AI sales agent's behavior.

CURRENT PROMPT:
${currentPrompt}

PROBLEM DESCRIBED BY OWNER:
${problem}

${exampleConversation ? `EXAMPLE OF BAD BEHAVIOR (conversation):
${exampleConversation}` : ""}

YOUR TASK:
1. Identify exactly which part of the prompt is causing this problem
2. Fix ONLY that part — do not rewrite the whole prompt unnecessarily
3. Return the complete fixed prompt

RULES:
- Keep all existing rules that are working
- Only change what is needed to fix the described problem
- Do not add unnecessary content
- Keep the same language and style as the original
- Return ONLY the fixed prompt text, nothing else — no explanation, no preamble`;

    // Call Claude Sonnet (smarter for this task)
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages:   [{ role: "user", content: metaPrompt }],
    });

    const fixedPrompt = response.content[0]?.text?.trim() || "";
    if (!fixedPrompt) return res.status(500).json({ message: "AI could not generate a fix" });

    // Build diff for display
    const diff = buildDiff(currentPrompt, fixedPrompt);

    res.json({ fixedPrompt, diff, currentPrompt });

  } catch (err) {
    console.error("Prompt fix error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Approve and save fixed prompt ────────────────────────────
router.post("/training/approve", async (req, res) => {
  try {
    const { fixedPrompt, changeNote } = req.body;
    if (!fixedPrompt?.trim()) return res.status(400).json({ message: "No prompt to save" });

    // Save current prompt to history first
    const { rows: current } = await query(
      "SELECT system_prompt FROM agent_configs WHERE business_id = $1",
      [bId(req)]
    );

    if (current[0]?.system_prompt) {
      await query(`
        INSERT INTO prompt_history (business_id, prompt, change_note, changed_by)
        VALUES ($1, $2, $3, 'ai')
      `, [bId(req), current[0].system_prompt, changeNote || "AI fix applied"]);
    }

    // Save new prompt
    await query(`
      UPDATE agent_configs
      SET system_prompt = $1, updated_at = NOW()
      WHERE business_id = $2
    `, [fixedPrompt, bId(req)]);

    // Clear prompt cache so agent picks up new prompt immediately
    // The cache will rebuild on next message
    res.json({ success: true, message: "Prompt updated — agent will use new rules immediately" });

  } catch (err) {
    res.status(500).json({ message: "Failed to save prompt" });
  }
});

// ── Save prompt directly (manual edit) ───────────────────────
router.post("/training/save", async (req, res) => {
  try {
    const { prompt, changeNote } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ message: "Prompt cannot be empty" });

    const { rows: current } = await query(
      "SELECT system_prompt FROM agent_configs WHERE business_id = $1",
      [bId(req)]
    );

    if (current[0]?.system_prompt) {
      await query(`
        INSERT INTO prompt_history (business_id, prompt, change_note, changed_by)
        VALUES ($1, $2, $3, 'owner')
      `, [bId(req), current[0].system_prompt, changeNote || "Manual edit"]);
    }

    await query(`
      UPDATE agent_configs SET system_prompt = $1, updated_at = NOW()
      WHERE business_id = $2
    `, [prompt, bId(req)]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to save prompt" });
  }
});

// ── Test agent (simulate conversation) ───────────────────────
router.post("/training/test", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message required" });

    // Get current prompt
    const { rows } = await query(
      "SELECT system_prompt, agent_name FROM agent_configs WHERE business_id = $1",
      [bId(req)]
    );
    const systemPrompt = rows[0]?.system_prompt || "";
    if (!systemPrompt) return res.status(400).json({ message: "No prompt configured" });

    // Build conversation history
    const messages = [
      ...(history || []),
      { role: "user", content: message },
    ];

    // Call agent with current prompt — no tools in test mode
    const response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system:     systemPrompt,
      messages,
    });

    const reply = response.content[0]?.text?.trim() || "";
    res.json({ reply, usage: response.usage });

  } catch (err) {
    console.error("Test error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Prompt history ────────────────────────────────────────────
router.get("/training/history", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, change_note, changed_by, created_at,
             LEFT(prompt, 100) AS prompt_preview
      FROM prompt_history
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [bId(req)]);
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load history" });
  }
});

// ── Rollback to a previous prompt ────────────────────────────
router.post("/training/rollback/:id", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT prompt FROM prompt_history WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    if (!rows.length) return res.status(404).json({ message: "Version not found" });

    // Save current as history
    const { rows: current } = await query(
      "SELECT system_prompt FROM agent_configs WHERE business_id = $1",
      [bId(req)]
    );
    if (current[0]?.system_prompt) {
      await query(`
        INSERT INTO prompt_history (business_id, prompt, change_note, changed_by)
        VALUES ($1, $2, 'Rolled back to previous version', 'owner')
      `, [bId(req), current[0].system_prompt]);
    }

    // Restore old prompt
    await query(`
      UPDATE agent_configs SET system_prompt = $1, updated_at = NOW()
      WHERE business_id = $2
    `, [rows[0].prompt, bId(req)]);

    res.json({ success: true, message: "Rolled back successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to rollback" });
  }
});

// ── Build simple diff ─────────────────────────────────────────
function buildDiff(original, fixed) {
  const origLines  = original.split("\n");
  const fixedLines = fixed.split("\n");
  const diff       = [];

  const maxLen = Math.max(origLines.length, fixedLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine  = origLines[i] ?? "";
    const fixedLine = fixedLines[i] ?? "";
    if (origLine === fixedLine) {
      diff.push({ type: "same",    text: fixedLine });
    } else if (!origLines.includes(fixedLine) && fixedLine) {
      diff.push({ type: "added",   text: fixedLine });
    } else if (!fixedLines.includes(origLine) && origLine) {
      diff.push({ type: "removed", text: origLine });
    } else {
      diff.push({ type: "same",    text: fixedLine });
    }
  }
  return diff;
}

export default router;