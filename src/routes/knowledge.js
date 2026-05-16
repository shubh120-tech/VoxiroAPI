import express  from "express";
import multer   from "multer";
import AWS      from "aws-sdk";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

// Multer — memory storage before sending to S3
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg", "image/png", "text/plain"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File type not supported"));
    }
  },
});

const s3 = new AWS.S3({
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region:          process.env.AWS_REGION,
});

// Upload document
router.post("/knowledge/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    const bId     = req.user.business_id;
    const ext     = req.file.originalname.split(".").pop().toLowerCase();
    const s3Key   = `${bId}/${Date.now()}_${req.file.originalname}`;

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
      return res.status(403).json({ message: `Document limit reached for your plan (${sub[0].doc_limit} docs)` });
    }

    // Upload to S3
    await s3.upload({
      Bucket:      process.env.AWS_S3_BUCKET,
      Key:         s3Key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype,
    }).promise();

    // Save to DB with status pending
    const { rows } = await query(`
      INSERT INTO knowledge_docs (business_id, file_name, file_size, file_type, s3_key, status)
      VALUES ($1, $2, $3, $4, $5, 'processing')
      RETURNING *
    `, [bId, req.file.originalname, req.file.size, ext, s3Key]);

    // Process asynchronously — extract text and update agent system prompt
    processDocumentAsync(rows[0].id, bId, req.file.buffer, ext).catch(console.error);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

// Reprocess a document
router.post("/knowledge/:id/reprocess", async (req, res) => {
  try {
    await query("UPDATE knowledge_docs SET status = 'processing' WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reprocess" });
  }
});

/**
 * Extract text from document and save to DB.
 * This runs in background — doesn't block the response.
 */
async function processDocumentAsync(docId, businessId, buffer, ext) {
  try {
    let extractedText = "";

    // Basic text extraction — extend with proper parsers per type
    if (ext === "txt") {
      extractedText = buffer.toString("utf-8");
    } else {
      // For PDF/DOCX/XLSX — use Anthropic vision to extract text
      extractedText = await extractWithClaude(buffer, ext);
    }

    // Save extracted text
    await query(`
      UPDATE knowledge_docs
      SET extracted_text = $1, status = 'processed', updated_at = NOW()
      WHERE id = $2
    `, [extractedText, docId]);

    // Rebuild agent system prompt with new knowledge
    await rebuildAgentPrompt(businessId);

  } catch (err) {
    console.error("Document processing error:", err);
    await query(`
      UPDATE knowledge_docs
      SET status = 'error', error_message = $1 WHERE id = $2
    `, [err.message, docId]);
  }
}

async function extractWithClaude(buffer, ext) {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const base64 = buffer.toString("base64");
  const mediaType = ext === "pdf" ? "application/pdf" : "image/jpeg";

  const response = await anthropic.messages.create({
    model:     process.env.ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [
        {
          type:   "document",
          source: { type: "base64", media_type: mediaType, data: base64 },
        },
        { type: "text", text: "Extract all text content from this document. Return only the extracted text, no commentary." },
      ],
    }],
  });

  return response.content[0]?.text || "";
}

async function rebuildAgentPrompt(businessId) {
  // Get all processed docs for this business
  const { rows } = await query(`
    SELECT extracted_text FROM knowledge_docs
    WHERE business_id = $1 AND status = 'processed' AND extracted_text IS NOT NULL
  `, [businessId]);

  const knowledge = rows.map(r => r.extracted_text).join("\n\n---\n\n");

  // Update agent config with compiled knowledge
  await query(`
    UPDATE agent_configs
    SET system_prompt = system_prompt || $1, updated_at = NOW()
    WHERE business_id = $2
  `, [`\n\nKNOWLEDGE BASE:\n${knowledge}`, businessId]);
}

export default router;
