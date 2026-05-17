import express      from "express";
import multer       from "multer";
import AWS          from "aws-sdk";
import { query }    from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import Anthropic    from "@anthropic-ai/sdk";

const router = express.Router();
router.use(authMiddleware);

// ── Cloudflare R2 Config (S3-compatible) ─────────────────────
const r2 = new AWS.S3({
  endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId:     process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  region:          "auto",
  signatureVersion: "v4",
});

const BUCKET = process.env.CLOUDFLARE_R2_BUCKET || "voxiro-knowledge";

// ── Multer — memory storage ───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg", "image/png",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("File type not supported. Use PDF, Word, Excel, Image or TXT."));
  },
});

// ── Upload to Cloudflare R2 ───────────────────────────────────
async function uploadToR2(buffer, filename, mimetype, businessId) {
  const key = `${businessId}/${Date.now()}_${filename.replace(/\s+/g, "_")}`;

  await r2.putObject({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype,
  }).promise();

  return key;
}

// ── Delete from Cloudflare R2 ─────────────────────────────────
async function deleteFromR2(key) {
  try {
    await r2.deleteObject({ Bucket: BUCKET, Key: key }).promise();
  } catch (err) {
    console.error("R2 delete error:", err.message);
  }
}

// ── Detect WhatsApp Chat Export ───────────────────────────────
function isWhatsAppChatExport(text) {
  const patterns = [
    /\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/,
    /\[\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}/,
    /Messages and calls are end-to-end encrypted/,
    /<Media omitted>/,
  ];
  return patterns.some(p => p.test(text.slice(0, 2000)));
}

// ── Process WhatsApp Chat Export ──────────────────────────────
async function processWhatsAppChat(chatText, businessName) {
  const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const trimmedChat = chatText.slice(0, 30000);

  const response = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [{
      role:    "user",
      content: `You are analyzing a WhatsApp chat export from ${businessName} to extract sales and customer handling patterns.

Analyze this chat export and extract:

1. COMMON CUSTOMER QUESTIONS — What do customers typically ask?
2. HOW BUSINESS RESPONDS — Exact phrases and style used to answer
3. OBJECTION HANDLING — How does the business handle price objections, hesitation, "too expensive", "let me think"
4. CLOSING TECHNIQUES — How does the business close a sale or booking
5. TONE AND STYLE — Is it formal/informal? Hindi/English/Hinglish? Specific phrases always used?
6. PRICING CONVERSATIONS — How do they discuss pricing?
7. FOLLOW-UP STYLE — How do they follow up with leads?

Format your response as clear sections that an AI agent can learn from and replicate.
Be specific — include actual example phrases used by the business.

CHAT EXPORT:
${trimmedChat}`,
    }],
  });

  return `=== LEARNED FROM BUSINESS CHAT HISTORY ===\n\n${response.content[0]?.text || ""}`;
}

// ── Upload Route ──────────────────────────────────────────────
router.post("/knowledge/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    const bId = req.user.business_id;
    const ext  = req.file.originalname.split(".").pop().toLowerCase();

    // Check doc limit for plan
    const { rows: sub } = await query(`
      SELECT COUNT(kd.id) AS doc_count, p.doc_limit
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      LEFT JOIN knowledge_docs kd ON kd.business_id = s.business_id
      WHERE s.business_id = $1
      GROUP BY p.doc_limit
    `, [bId]);

    if (sub.length && parseInt(sub[0].doc_count) >= parseInt(sub[0].doc_limit)) {
      return res.status(403).json({
        message: `Document limit reached for your plan (${sub[0].doc_limit} docs max). Please upgrade.`,
      });
    }

    // Detect WhatsApp chat export
    let fileType = ext;
    if (ext === "txt") {
      const preview = req.file.buffer.toString("utf-8").slice(0, 2000);
      if (isWhatsAppChatExport(preview)) {
        fileType = "whatsapp_chat";
      }
    }

    // Upload to Cloudflare R2
    const r2Key = await uploadToR2(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      bId
    );

    // Save to DB
    const { rows } = await query(`
      INSERT INTO knowledge_docs
        (business_id, file_name, file_size, file_type, s3_key, status)
      VALUES ($1, $2, $3, $4, $5, 'processing')
      RETURNING *
    `, [bId, req.file.originalname, req.file.size, fileType, r2Key]);

    // Process async
    processDocumentAsync(rows[0].id, bId, req.file.buffer, fileType, req.file.mimetype)
      .catch(console.error);

    res.status(201).json({
      ...rows[0],
      isWhatsAppChat: fileType === "whatsapp_chat",
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

// ── Reprocess Document ────────────────────────────────────────
router.post("/knowledge/:id/reprocess", async (req, res) => {
  try {
    // Get doc details
    const { rows } = await query(
      "SELECT * FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );
    if (!rows.length) return res.status(404).json({ message: "Document not found" });

    await query(
      "UPDATE knowledge_docs SET status = 'processing' WHERE id = $1",
      [req.params.id]
    );

    // Re-download from R2 and reprocess
    const r2Object = await r2.getObject({ Bucket: BUCKET, Key: rows[0].s3_key }).promise();
    const buffer   = r2Object.Body;

    processDocumentAsync(rows[0].id, req.user.business_id, buffer, rows[0].file_type, rows[0].file_type)
      .catch(console.error);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reprocess" });
  }
});

// ── Delete Document ───────────────────────────────────────────
router.delete("/knowledge/:id", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT s3_key FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );

    if (rows.length && rows[0].s3_key) {
      await deleteFromR2(rows[0].s3_key);
    }

    await query(
      "DELETE FROM knowledge_docs WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );

    // Rebuild agent knowledge after deletion
    await rebuildAgentPrompt(req.user.business_id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete document" });
  }
});

// ── Process Document Async ────────────────────────────────────
async function processDocumentAsync(docId, businessId, buffer, fileType, mimetype) {
  try {
    let extractedText = "";

    if (fileType === "whatsapp_chat") {
      const rawText = buffer.toString("utf-8");
      const { rows } = await query("SELECT name FROM businesses WHERE id = $1", [businessId]);
      const businessName = rows[0]?.name || "the business";
      console.log(`📱 Processing WhatsApp chat for ${businessName}...`);
      extractedText = await processWhatsAppChat(rawText, businessName);

    } else if (fileType === "txt") {
      extractedText = buffer.toString("utf-8");

    } else {
      extractedText = await extractWithClaude(buffer, mimetype);
    }

    // Limit size
    extractedText = extractedText.trim().slice(0, 50000);

    await query(`
      UPDATE knowledge_docs
      SET extracted_text = $1, status = 'processed', updated_at = NOW()
      WHERE id = $2
    `, [extractedText, docId]);

    await rebuildAgentPrompt(businessId);
    console.log(`✅ Document processed: ${docId}`);

  } catch (err) {
    console.error("Document processing error:", err.message);
    await query(`
      UPDATE knowledge_docs
      SET status = 'error', error_message = $1, updated_at = NOW()
      WHERE id = $2
    `, [err.message, docId]);
  }
}

// ── Extract Text Using Claude Vision ─────────────────────────
async function extractWithClaude(buffer, mimetype) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const base64    = buffer.toString("base64");

  if (!["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimetype)) {
    return "";
  }

  const contentType = mimetype === "application/pdf" ? "document" : "image";

  const response = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{
      role:    "user",
      content: [
        {
          type:   contentType,
          source: { type: "base64", media_type: mimetype, data: base64 },
        },
        {
          type: "text",
          text: "Extract all text content from this document. Include all details like prices, services, policies, contact info. Return only the extracted text, no commentary.",
        },
      ],
    }],
  });

  return response.content[0]?.text || "";
}

// ── Rebuild Agent Knowledge From All Docs ─────────────────────
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

  const chatExports = rows.filter(r => r.file_type === "whatsapp_chat");
  const regularDocs = rows.filter(r => r.file_type !== "whatsapp_chat");

  let knowledge = "";

  if (chatExports.length > 0) {
    knowledge += `\n\n=== HOW THIS BUSINESS COMMUNICATES (Learned from real conversations) ===\n`;
    knowledge += chatExports.map(r => r.extracted_text).join("\n\n---\n\n");
  }

  if (regularDocs.length > 0) {
    knowledge += `\n\n=== BUSINESS KNOWLEDGE BASE ===\n`;
    knowledge += regularDocs.map(r => `--- ${r.file_name} ---\n${r.extracted_text}`).join("\n\n");
  }

  await query(`
    UPDATE agent_configs
    SET system_prompt = $1, updated_at = NOW()
    WHERE business_id = $2
  `, [knowledge.trim(), businessId]);

  console.log(`✅ Agent knowledge rebuilt for business: ${businessId}`);
}

export default router;