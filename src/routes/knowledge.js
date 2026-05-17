import express      from "express";
import multer       from "multer";
import AWS          from "aws-sdk";
import { query }    from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import Anthropic    from "@anthropic-ai/sdk";

const router = express.Router();
router.use(authMiddleware);

// ── Cloudflare R2 Config ──────────────────────────────────────
const r2 = new AWS.S3({
  endpoint:        `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId:     process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  region:          "auto",
  signatureVersion: "v4",
});

const BUCKET = process.env.CLOUDFLARE_R2_BUCKET || "voxiro-knowledge";

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg", "image/png", "text/plain",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("File type not supported."));
  },
});

// ── Upload to R2 ──────────────────────────────────────────────
async function uploadToR2(buffer, filename, mimetype, businessId) {
  const key = `${businessId}/${Date.now()}_${filename.replace(/\s+/g, "_")}`;
  await r2.putObject({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimetype }).promise();
  return key;
}

async function deleteFromR2(key) {
  try { await r2.deleteObject({ Bucket: BUCKET, Key: key }).promise(); } catch {}
}

// ── Detect WhatsApp Chat ──────────────────────────────────────
function isWhatsAppChatExport(text) {
  return [
    /\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/,
    /\[\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}/,
    /Messages and calls are end-to-end encrypted/,
    /<Media omitted>/,
  ].some(p => p.test(text.slice(0, 2000)));
}

// ── CONSOLIDATE all chat exports into ONE master knowledge ─────
async function consolidateAllChats(businessId) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Get all processed chat exports
  const { rows: chatDocs } = await query(`
    SELECT file_name, extracted_text
    FROM knowledge_docs
    WHERE business_id = $1
      AND file_type = 'whatsapp_chat'
      AND extracted_text IS NOT NULL
      AND extracted_text != ''
    ORDER BY created_at ASC
  `, [businessId]);

  if (chatDocs.length === 0) return null;

  // Get business name
  const { rows: bizRows } = await query("SELECT name FROM businesses WHERE id = $1", [businessId]);
  const businessName = bizRows[0]?.name || "the business";

  console.log(`🔄 Consolidating ${chatDocs.length} chat exports for ${businessName}...`);

  // Combine all extracted chat knowledge
  const allChatKnowledge = chatDocs
    .map((d, i) => `=== Chat Export ${i + 1}: ${d.file_name} ===\n${d.extracted_text}`)
    .join("\n\n---\n\n");

  // Limit to avoid token overflow
  const trimmed = allChatKnowledge.slice(0, 60000);

  const response = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    messages: [{
      role:    "user",
      content: `You are consolidating knowledge from ${chatDocs.length} WhatsApp chat exports from ${businessName}.

These chats may have conflicting information (different prices, different responses). Your job is to:

1. RESOLVE CONFLICTS intelligently:
   - For prices: use the MOST RECENT or MOST COMMON price
   - For policies: use the STRICTEST version
   - Note any price ranges if they exist legitimately

2. Create ONE authoritative knowledge document with:

SERVICES & PRICING (EXACT - Agent must never deviate):
[List each service with the definitive price]

STANDARD RESPONSES TO COMMON QUESTIONS:
[Exact phrases the business uses for top 10 questions]

HOW TO HANDLE PRICE OBJECTIONS:
[Exact scripts used]

HOW TO CLOSE A BOOKING:
[Exact closing technique used]

COMMUNICATION STYLE:
[Language: Hindi/English/Hinglish, formal/casual, key phrases always used]

DO NOT ASK FOR DISCOUNTS POLICY:
[How to handle discount requests]

FOLLOW-UP STYLE:
[How business follows up]

IMPORTANT RULES FOR AGENT:
- Always quote the EXACT prices listed above — never different amounts
- If unsure about a price, say "Let me confirm that for you" — never guess
- Stay consistent throughout the conversation
- Never contradict yourself in the same chat

Here are the ${chatDocs.length} chat analyses to consolidate:

${trimmed}`,
    }],
  });

  return response.content[0]?.text || "";
}

// ── Upload Route ──────────────────────────────────────────────
router.post("/knowledge/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    const bId = req.user.business_id;
    const ext  = req.file.originalname.split(".").pop().toLowerCase();

    // Check doc limit
    const { rows: sub } = await query(`
      SELECT COUNT(kd.id) AS doc_count, p.doc_limit
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      LEFT JOIN knowledge_docs kd ON kd.business_id = s.business_id
      WHERE s.business_id = $1
      GROUP BY p.doc_limit
    `, [bId]);

    if (sub.length && parseInt(sub[0].doc_count) >= parseInt(sub[0].doc_limit)) {
      return res.status(403).json({ message: `Document limit reached. Please upgrade your plan.` });
    }

    // Detect WhatsApp chat
    let fileType = ext;
    if (ext === "txt") {
      const preview = req.file.buffer.toString("utf-8").slice(0, 2000);
      if (isWhatsAppChatExport(preview)) fileType = "whatsapp_chat";
    }

    // Upload to R2
    const r2Key = await uploadToR2(req.file.buffer, req.file.originalname, req.file.mimetype, bId);

    // Save to DB
    const { rows } = await query(`
      INSERT INTO knowledge_docs (business_id, file_name, file_size, file_type, s3_key, status)
      VALUES ($1, $2, $3, $4, $5, 'processing')
      RETURNING *
    `, [bId, req.file.originalname, req.file.size, fileType, r2Key]);

    // Process async
    processDocumentAsync(rows[0].id, bId, req.file.buffer, fileType, req.file.mimetype)
      .catch(console.error);

    res.status(201).json({ ...rows[0], isWhatsAppChat: fileType === "whatsapp_chat" });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

// ── Consolidate All Chats Endpoint ────────────────────────────
router.post("/knowledge/consolidate", async (req, res) => {
  try {
    const bId = req.user.business_id;

    // Count chat exports
    const { rows: countRows } = await query(`
      SELECT COUNT(*) FROM knowledge_docs
      WHERE business_id = $1 AND file_type = 'whatsapp_chat' AND status = 'processed'
    `, [bId]);

    const count = parseInt(countRows[0].count);
    if (count === 0) {
      return res.status(400).json({ message: "No processed chat exports found. Please upload WhatsApp chats first." });
    }

    // Mark as consolidating
    await query(`
      UPDATE knowledge_docs
      SET status = 'processing'
      WHERE business_id = $1 AND file_type = 'whatsapp_chat'
    `, [bId]);

    // Run consolidation async
    runConsolidationAsync(bId).catch(console.error);

    res.json({
      success: true,
      message: `Consolidating ${count} chat exports. This takes 30-60 seconds.`,
      count,
    });

  } catch (err) {
    res.status(500).json({ message: "Failed to start consolidation" });
  }
});

async function runConsolidationAsync(businessId) {
  try {
    // First extract raw text from all chats that haven't been extracted yet
    const { rows: unextracted } = await query(`
      SELECT id, file_name, s3_key, file_type FROM knowledge_docs
      WHERE business_id = $1
        AND file_type = 'whatsapp_chat'
        AND (extracted_text IS NULL OR extracted_text = '')
    `, [businessId]);

    for (const doc of unextracted) {
      try {
        const obj    = await r2.getObject({ Bucket: BUCKET, Key: doc.s3_key }).promise();
        const buffer = obj.Body;
        const text   = buffer.toString("utf-8");
        const parsed = await parseWhatsAppChat(text);
        await query(`
          UPDATE knowledge_docs SET extracted_text = $1 WHERE id = $2
        `, [parsed, doc.id]);
      } catch (err) {
        console.error(`Failed to extract ${doc.file_name}:`, err.message);
      }
    }

    // Now consolidate all chat knowledge
    const consolidated = await consolidateAllChats(businessId);

    if (consolidated) {
      // Update all chat docs to processed with consolidated knowledge
      await query(`
        UPDATE knowledge_docs
        SET status = 'processed', updated_at = NOW()
        WHERE business_id = $1 AND file_type = 'whatsapp_chat'
      `, [businessId]);

      // Save consolidated knowledge to agent config
      await query(`
        UPDATE agent_configs
        SET system_prompt = $1, updated_at = NOW()
        WHERE business_id = $2
      `, [consolidated, businessId]);

      console.log(`✅ Consolidation complete for business: ${businessId}`);
    }

    // Also rebuild full knowledge including regular docs
    await rebuildAgentPrompt(businessId);

  } catch (err) {
    console.error("Consolidation error:", err.message);
    await query(`
      UPDATE knowledge_docs
      SET status = 'error', error_message = $1
      WHERE business_id = $2 AND file_type = 'whatsapp_chat'
    `, [err.message, businessId]);
  }
}

// ── Parse raw WhatsApp chat text ──────────────────────────────
async function parseWhatsAppChat(chatText) {
  const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const trimmed    = chatText.slice(0, 15000);

  const response = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [{
      role:    "user",
      content: `Extract key business information from this WhatsApp chat:
- Services mentioned and prices quoted
- How the business responds to inquiries  
- Objection handling phrases used
- Closing techniques
- Communication style (formal/casual, language used)

Be concise. List only facts found in this specific chat.

CHAT:
${trimmed}`,
    }],
  });

  return response.content[0]?.text || "";
}

// ── Reprocess ─────────────────────────────────────────────────
router.post("/knowledge/:id/reprocess", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ message: "Not found" });

    await query("UPDATE knowledge_docs SET status = 'processing' WHERE id = $1", [req.params.id]);

    const obj    = await r2.getObject({ Bucket: BUCKET, Key: rows[0].s3_key }).promise();
    processDocumentAsync(rows[0].id, req.user.business_id, obj.Body, rows[0].file_type, rows[0].file_type)
      .catch(console.error);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reprocess" });
  }
});

// ── Delete ────────────────────────────────────────────────────
router.delete("/knowledge/:id", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT s3_key FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );
    if (rows.length && rows[0].s3_key) await deleteFromR2(rows[0].s3_key);
    await query("DELETE FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]);
    await rebuildAgentPrompt(req.user.business_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete" });
  }
});

// ── Process Document Async ────────────────────────────────────
async function processDocumentAsync(docId, businessId, buffer, fileType, mimetype) {
  try {
    let extractedText = "";

    if (fileType === "whatsapp_chat") {
      const rawText = buffer.toString("utf-8");
      extractedText = await parseWhatsAppChat(rawText);
    } else if (fileType === "txt") {
      extractedText = buffer.toString("utf-8");
    } else {
      extractedText = await extractWithClaude(buffer, mimetype);
    }

    extractedText = extractedText.trim().slice(0, 50000);

    await query(`
      UPDATE knowledge_docs
      SET extracted_text = $1, status = 'processed', updated_at = NOW()
      WHERE id = $2
    `, [extractedText, docId]);

    await rebuildAgentPrompt(businessId);
    console.log(`✅ Document processed: ${docId}`);

  } catch (err) {
    console.error("Processing error:", err.message);
    await query(`
      UPDATE knowledge_docs SET status = 'error', error_message = $1 WHERE id = $2
    `, [err.message, docId]);
  }
}

// ── Extract with Claude Vision ────────────────────────────────
async function extractWithClaude(buffer, mimetype) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const base64    = buffer.toString("base64");
  if (!["application/pdf","image/jpeg","image/png","image/gif","image/webp"].includes(mimetype)) return "";
  const contentType = mimetype === "application/pdf" ? "document" : "image";
  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: [
      { type: contentType, source: { type: "base64", media_type: mimetype, data: base64 } },
      { type: "text", text: "Extract all text content. Include prices, services, policies, contact info. Return only extracted text." },
    ]}],
  });
  return response.content[0]?.text || "";
}

// ── Rebuild Full Agent Knowledge ──────────────────────────────
async function rebuildAgentPrompt(businessId) {
  const { rows } = await query(`
    SELECT file_name, file_type, extracted_text
    FROM knowledge_docs
    WHERE business_id = $1
      AND status = 'processed'
      AND extracted_text IS NOT NULL
      AND extracted_text != ''
    ORDER BY
      CASE WHEN file_type = 'whatsapp_chat' THEN 0 ELSE 1 END,
      created_at DESC
  `, [businessId]);

  if (!rows.length) return;

  const chatDocs    = rows.filter(r => r.file_type === "whatsapp_chat");
  const regularDocs = rows.filter(r => r.file_type !== "whatsapp_chat");

  let knowledge = "";
  if (chatDocs.length > 0) {
    knowledge += `\n\n=== HOW THIS BUSINESS COMMUNICATES ===\n`;
    knowledge += chatDocs.map(r => r.extracted_text).join("\n\n---\n\n");
  }
  if (regularDocs.length > 0) {
    knowledge += `\n\n=== BUSINESS KNOWLEDGE BASE ===\n`;
    knowledge += regularDocs.map(r => `--- ${r.file_name} ---\n${r.extracted_text}`).join("\n\n");
  }

  await query(`
    UPDATE agent_configs SET system_prompt = $1, updated_at = NOW()
    WHERE business_id = $2
  `, [knowledge.trim(), businessId]);
}

export default router;