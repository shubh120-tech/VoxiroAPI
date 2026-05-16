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
      "image/jpeg",
      "image/png",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File type not supported. Use PDF, Word, Excel, Image or TXT."));
    }
  },
});

// ── Upload to Cloudinary ──────────────────────────────────────
async function uploadToCloudinary(buffer, filename, mimetype) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder:        "voxiro/knowledge",
        resource_type: "auto",
        public_id:     `${Date.now()}_${filename.replace(/\s+/g, "_")}`,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

// ── Upload Document ───────────────────────────────────────────
router.post("/knowledge/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }

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
        message: `Document limit reached for your plan (${sub[0].doc_limit} docs max). Please upgrade.`
      });
    }

    // Upload to Cloudinary
    const uploadResult = await uploadToCloudinary(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    // Save to DB with status processing
    const { rows } = await query(`
      INSERT INTO knowledge_docs
        (business_id, file_name, file_size, file_type, s3_key, status)
      VALUES ($1, $2, $3, $4, $5, 'processing')
      RETURNING *
    `, [
      bId,
      req.file.originalname,
      req.file.size,
      ext,
      uploadResult.secure_url, // store Cloudinary URL in s3_key column
    ]);

    // Process document asynchronously
    processDocumentAsync(rows[0].id, bId, req.file.buffer, ext, req.file.mimetype)
      .catch(console.error);

    res.status(201).json(rows[0]);

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

// ── Reprocess Document ────────────────────────────────────────
router.post("/knowledge/:id/reprocess", async (req, res) => {
  try {
    await query(
      "UPDATE knowledge_docs SET status = 'processing' WHERE id = $1 AND business_id = $2",
      [req.params.id, req.user.business_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to reprocess" });
  }
});

// ── Process Document Async ────────────────────────────────────
async function processDocumentAsync(docId, businessId, buffer, ext, mimetype) {
  try {
    let extractedText = "";

    if (ext === "txt") {
      // Plain text — read directly
      extractedText = buffer.toString("utf-8");
    } else {
      // Use Claude to extract text from PDF/image/doc
      extractedText = await extractWithClaude(buffer, mimetype);
    }

    // Clean extracted text
    extractedText = extractedText.trim().slice(0, 50000); // limit to 50k chars

    // Save extracted text
    await query(`
      UPDATE knowledge_docs
      SET extracted_text = $1, status = 'processed', updated_at = NOW()
      WHERE id = $2
    `, [extractedText, docId]);

    // Rebuild agent system prompt with new knowledge
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

  // Determine media type for Claude
  let mediaType = mimetype;
  if (!["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimetype)) {
    // For unsupported types, return empty string
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
          source: {
            type:       "base64",
            media_type: mediaType,
            data:        base64,
          },
        },
        {
          type: "text",
          text: "Extract all text content from this document. Include all details like prices, services, policies, contact info, and any other information. Return only the extracted text, no commentary or formatting.",
        },
      ],
    }],
  });

  return response.content[0]?.text || "";
}

// ── Rebuild Agent System Prompt With New Knowledge ────────────
async function rebuildAgentPrompt(businessId) {
  const { rows } = await query(`
    SELECT file_name, extracted_text
    FROM knowledge_docs
    WHERE business_id = $1
      AND status = 'processed'
      AND extracted_text IS NOT NULL
      AND extracted_text != ''
    ORDER BY created_at DESC
  `, [businessId]);

  if (!rows.length) return;

  // Build knowledge section
  const knowledge = rows.map(r =>
    `=== ${r.file_name} ===\n${r.extracted_text}`
  ).join("\n\n---\n\n");

  // Update agent config with compiled knowledge
  await query(`
    UPDATE agent_configs
    SET system_prompt = $1, updated_at = NOW()
    WHERE business_id = $2
  `, [knowledge, businessId]);

  console.log(`✅ Agent knowledge updated for business: ${businessId}`);
}

export default router;