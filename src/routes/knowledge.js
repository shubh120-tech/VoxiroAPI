import express      from "express";
import multer       from "multer";
import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import { query }    from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import Anthropic    from "@anthropic-ai/sdk";

const router = express.Router();
router.use(authMiddleware);

// ── Cloudinary Config ─────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
      "image/jpeg", "image/png",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("File type not supported. Use PDF, Word, Excel, Image or TXT."));
  },
});

// ── Upload to Cloudinary ──────────────────────────────────────
async function uploadToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "voxiro/knowledge", resource_type: "auto", public_id: `${Date.now()}_${filename.replace(/\s+/g, "_")}` },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

// ── Detect if file is a WhatsApp chat export ──────────────────
function isWhatsAppChatExport(text) {
  // WhatsApp exports have lines like:
  // "17/05/2026, 10:30 - John: Hello"
  // "[17/05/2026, 10:30:00] John: Hello"
  const patterns = [
    /\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/,
    /\[\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}/,
    /Messages and calls are end-to-end encrypted/,
    /<Media omitted>/,
  ];
  return patterns.some(p => p.test(text.slice(0, 2000)));
}

// ── Process WhatsApp Chat Export with Claude ──────────────────
async function processWhatsAppChat(chatText, businessName) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Limit chat to avoid token overuse
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
5. TONE AND STYLE — Is it formal/informal? Do they use Hindi/English/Hinglish? Any specific phrases they always use?
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
      return res.status(403).json({ message: `Document limit reached for your plan (${sub[0].doc_limit} docs max). Please upgrade.` });
    }

    // Upload to Cloudinary
    const uploadResult = await uploadToCloudinary(req.file.buffer, req.file.originalname);

    // Detect if WhatsApp chat export
    let fileType = ext;
    if (ext === "txt") {
      const textPreview = req.file.buffer.toString("utf-8").slice(0, 2000);
      if (isWhatsAppChatExport(textPreview)) {
        fileType = "whatsapp_chat";
      }
    }

    // Save to DB
    const { rows } = await query(`
      INSERT INTO knowledge_docs (business_id, file_name, file_size, file_type, s3_key, status)
      VALUES ($1, $2, $3, $4, $5, 'processing')
      RETURNING *
    `, [bId, req.file.originalname, req.file.size, fileType, uploadResult.secure_url]);

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

// ── Reprocess ─────────────────────────────────────────────────
router.post("/knowledge/:id/reprocess", async (req, res) => {
  try {
    await query("UPDATE knowledge_docs SET status = 'processing' WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reprocess" });
  }
});

// ── Process Document Async ────────────────────────────────────
async function processDocumentAsync(docId, businessId, buffer, fileType, mimetype) {
  try {
    let extractedText = "";

    if (fileType === "whatsapp_chat") {
      // Smart WhatsApp chat processing
      const rawText = buffer.toString("utf-8");

      // Get business name for context
      const { rows } = await query("SELECT name FROM businesses WHERE id = $1", [businessId]);
      const businessName = rows[0]?.name || "the business";

      console.log(`📱 Processing WhatsApp chat export for ${businessName}...`);
      extractedText = await processWhatsAppChat(rawText, businessName);

    } else if (fileType === "txt") {
      extractedText = buffer.toString("utf-8");

    } else {
      // PDF, DOCX, images — use Claude vision
      extractedText = await extractWithClaude(buffer, mimetype);
    }

    // Limit size
    extractedText = extractedText.trim().slice(0, 50000);

    // Save extracted text
    await query(`
      UPDATE knowledge_docs
      SET extracted_text = $1, status = 'processed', updated_at = NOW()
      WHERE id = $2
    `, [extractedText, docId]);

    // Rebuild agent knowledge
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

// ── Extract Text from PDF/Image using Claude ──────────────────
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

// ── Rebuild Agent System Prompt With All Knowledge ────────────
async function rebuildAgentPrompt(businessId) {
  const { rows } = await query(`
    SELECT file_name, file_type, extracted_text
    FROM knowledge_docs
    WHERE business_id = $1
      AND status = 'processed'
      AND extracted_text IS NOT NULL
      AND extracted_text != ''
    ORDER BY
      CASE WHEN file_type = 'whatsapp_chat' THEN 0 ELSE 1 END, -- chat exports first
      created_at DESC
  `, [businessId]);

  if (!rows.length) return;

  // Separate chat exports from regular docs
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

  // Save to agent_configs system_prompt field
  await query(`
    UPDATE agent_configs
    SET system_prompt = $1, updated_at = NOW()
    WHERE business_id = $2
  `, [knowledge.trim(), businessId]);

  console.log(`✅ Agent knowledge rebuilt for business: ${businessId}`);
}

export default router;