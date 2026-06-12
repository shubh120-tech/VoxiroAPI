import express   from "express";
import axios     from "axios";
import Anthropic from "@anthropic-ai/sdk";
import multer    from "multer";
import path      from "path";
import fs        from "fs";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import { logAIUsage }    from "../utils/aiUsageLogger.js";

const router = express.Router();

router.use(authMiddleware);

const bId = (req) => req.user.business_id;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
const META_VERSION = process.env.META_API_VERSION || "v19.0";
const BACKEND_URL  = process.env.BACKEND_URL      || "https://voxiroapi-production.up.railway.app";

// ── IST helpers ───────────────────────────────────────────────
const IST_OFFSET_MS   = 5.5 * 60 * 60 * 1000;
const SEND_HOUR_START = 6;
const SEND_HOUR_END   = 23;

function nowIST()      { return new Date(Date.now() + IST_OFFSET_MS); }
function getISTHour(d) { return new Date(d.getTime() + IST_OFFSET_MS).getUTCHours(); }
function isValidSendTime(date) {
  const h = getISTHour(date);
  return h >= SEND_HOUR_START && h < SEND_HOUR_END;
}
function istInputToUTC(istStr) {
  if (!istStr) return null;
  const normalized = istStr.includes("T") ? istStr : istStr.replace(" ", "T");
  const istDate    = new Date(normalized + (normalized.includes("Z") ? "" : ":00"));
  if (isNaN(istDate.getTime())) return null;
  return new Date(istDate.getTime() - IST_OFFSET_MS);
}
function utcToISTString(utcDate) {
  if (!utcDate) return null;
  const ist = new Date(new Date(utcDate).getTime() + IST_OFFSET_MS);
  return ist.toISOString().replace("Z", "+05:30");
}
function sanitizeTemplateName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

// ── Multer — media upload ─────────────────────────────────────
const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "/tmp/broadcast_media";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `media_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage: mediaStorage,
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/3gpp"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG/PNG/WebP images and MP4/3GPP videos are allowed"));
  },
});

// ══════════════════════════════════════════════════════════════
//  MEDIA UPLOAD & SERVE
// ══════════════════════════════════════════════════════════════

// Upload image or video → returns public URL
router.post("/broadcast/templates/upload-media", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const fileType  = req.file.mimetype.startsWith("image/") ? "image" : "video";
    const publicUrl = `${BACKEND_URL}/api/broadcast/media/${req.file.filename}`;
    console.log(`📎 Media uploaded: ${req.file.filename} (${fileType})`);
    res.json({ url: publicUrl, type: fileType, fileName: req.file.filename });
  } catch (err) {
    res.status(500).json({ message: "Upload failed: " + err.message });
  }
});



// ══════════════════════════════════════════════════════════════
//  CONTACT LISTS
// ══════════════════════════════════════════════════════════════

router.get("/broadcast/lists", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT cl.*, COUNT(clm.contact_id) AS member_count
      FROM contact_lists cl
      LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
      WHERE cl.business_id = $1
      GROUP BY cl.id ORDER BY cl.created_at DESC
    `, [bId(req)]);
    res.json({ lists: rows });
  } catch (err) { res.status(500).json({ message: "Failed to load lists" }); }
});

router.post("/broadcast/lists", async (req, res) => {
  try {
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ message: "List name required" });
    const { rows } = await query(`
      INSERT INTO contact_lists (business_id, name, description, color)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [bId(req), name, description || null, color || "#0d9488"]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: "Failed to create list" }); }
});

router.put("/broadcast/lists/:id", async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const { rows } = await query(`
      UPDATE contact_lists SET name=$1, description=$2, color=$3, updated_at=NOW()
      WHERE id=$4 AND business_id=$5 RETURNING *
    `, [name, description, color, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: "Failed to update list" }); }
});

router.delete("/broadcast/lists/:id", async (req, res) => {
  try {
    await query("DELETE FROM contact_lists WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to delete list" }); }
});

router.get("/broadcast/lists/:id/contacts", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT bc.* FROM business_contacts bc
      JOIN contact_list_members clm ON clm.contact_id = bc.id
      WHERE clm.list_id=$1 AND bc.business_id=$2 ORDER BY bc.name ASC
    `, [req.params.id, bId(req)]);
    res.json({ contacts: rows });
  } catch (err) { res.status(500).json({ message: "Failed to load list contacts" }); }
});

router.post("/broadcast/lists/:id/contacts", async (req, res) => {
  try {
    const { contact_ids } = req.body;
    if (!contact_ids?.length) return res.status(400).json({ message: "No contacts provided" });
    let added = 0;
    for (const contactId of contact_ids) {
      try { await query(`INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, contactId]); added++; } catch {}
    }
    res.json({ success: true, added });
  } catch (err) { res.status(500).json({ message: "Failed to add contacts" }); }
});

router.delete("/broadcast/lists/:id/contacts/:contactId", async (req, res) => {
  try {
    await query("DELETE FROM contact_list_members WHERE list_id=$1 AND contact_id=$2", [req.params.id, req.params.contactId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to remove contact" }); }
});

// ══════════════════════════════════════════════════════════════
//  CONTACTS
// ══════════════════════════════════════════════════════════════

router.get("/broadcast/contacts", async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `SELECT * FROM business_contacts WHERE business_id=$1 AND opted_out=FALSE`;
    const params = [bId(req)];
    if (search) { params.push(`%${search}%`); sql += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await query(sql, params);
    res.json({ contacts: rows });
  } catch (err) { res.status(500).json({ message: "Failed to load contacts" }); }
});

router.post("/broadcast/contacts/extract", async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText?.trim()) return res.status(400).json({ message: "No text provided" });
    const extractModel = "claude-haiku-4-5-20251001";
    const response = await anthropic.messages.create({
      model: extractModel, max_tokens: 2000,
      messages: [{ role: "user", content: `Extract all contact information from this text. Return ONLY a valid JSON array.\n\nEach object: { phone, name, email, notes }\nNormalize Indian numbers to +91XXXXXXXXXX format.\nSkip entries with no valid phone.\n\nText:\n${rawText.slice(0, 5000)}` }],
    });
    await logAIUsage(req.user.business_id, "contact_extraction", extractModel, response.usage);
    const text = response.content[0]?.text || "[]";
    let contacts;
    try { contacts = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { contacts = []; }
    contacts = contacts.filter(c => c.phone && c.phone.length >= 10);
    res.json({ contacts, count: contacts.length });
  } catch (err) { res.status(500).json({ message: "Failed to extract contacts" }); }
});

router.post("/broadcast/contacts/import", async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!contacts?.length) return res.status(400).json({ message: "No contacts to import" });
    let imported = 0, skipped = 0;
    for (const c of contacts) {
      if (!c.phone) continue;
      try {
        await query(`
          INSERT INTO business_contacts (business_id, name, phone, email, notes, source)
          VALUES ($1,$2,$3,$4,$5,'import')
          ON CONFLICT (business_id, phone) DO UPDATE
          SET name=COALESCE($2, business_contacts.name), notes=COALESCE($5, business_contacts.notes), updated_at=NOW()
        `, [bId(req), c.name, c.phone, c.email, c.notes]);
        imported++;
      } catch { skipped++; }
    }
    res.json({ success: true, imported, skipped });
  } catch (err) { res.status(500).json({ message: "Failed to import contacts" }); }
});

router.delete("/broadcast/contacts/:id", async (req, res) => {
  try {
    await query("DELETE FROM business_contacts WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to delete contact" }); }
});

router.patch("/broadcast/contacts/:id/optout", async (req, res) => {
  try {
    await query("UPDATE business_contacts SET opted_out=TRUE WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to opt out contact" }); }
});

// ══════════════════════════════════════════════════════════════
//  TEMPLATES — with image/video header support
// ══════════════════════════════════════════════════════════════

router.get("/broadcast/templates", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM whatsapp_templates WHERE business_id=$1 ORDER BY created_at DESC",
      [bId(req)]
    );
    res.json({ templates: rows });
  } catch (err) { res.status(500).json({ message: "Failed to load templates" }); }
});

// ── AI Template Generator ─────────────────────────────────────
router.post("/broadcast/templates/ai-generate", async (req, res) => {
  try {
    const { prompt, category, language } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ message: "Prompt required" });

    const META_POLICY = `
Meta WhatsApp template rules (MUST follow or template gets rejected):
- No spam words: FREE!!, WINNER, CLAIM NOW, ACT NOW, GUARANTEED, URGENT in all caps
- No false urgency or misleading claims
- No promises of guaranteed results
- No phone numbers or raw URLs in body — use button components instead
- Variables like {{name}} must be syntactically correct
- Footer should have opt-out for marketing templates
- Max 1024 characters for body, 60 for header/footer
- Keep tone conversational and genuine — not pushy or salesy
- Max 4-5 emojis total
`.trim();

    const userPrompt = `You are an expert WhatsApp Business template writer who knows Meta policies deeply.

${META_POLICY}

Business request: "${prompt}"
Category: ${category || "MARKETING"}
Language: ${language === "hi" ? "Hindi" : "English"}

Generate a WhatsApp template that will get APPROVED by Meta.
Return ONLY valid JSON with no explanation, no markdown backticks:

{
  "name": "snake_case_name_under_30_chars",
  "category": "${category || "MARKETING"}",
  "header_text": "short header text or empty string if not needed",
  "body": "main message body, use {{name}} for personalization, max 1024 chars",
  "footer_text": "Reply STOP to unsubscribe",
  "variables": ["name"],
  "meta_compliance_notes": "one line explaining why this passes Meta review",
  "warnings": []
}`;

    const templateModel = process.env.ANTHROPIC_MODEL_SMART || "claude-sonnet-4-5";
    const response = await anthropic.messages.create({
      model:      templateModel,
      max_tokens: 1000,
      messages:   [{ role: "user", content: userPrompt }],
    });
    await logAIUsage(req.user.business_id, "template_generation", templateModel, response.usage);

    const text  = response.content[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ message: "AI returned invalid response. Please try again." });
    }

    // Sanitize name to snake_case
    if (parsed.name) {
      parsed.name = parsed.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
    }

    res.json(parsed);
  } catch (err) {
    console.error("AI template generate error:", err.message);
    res.status(500).json({ message: "Generation failed: " + err.message });
  }
});


// ── Create template (now includes header_type + header_media_url) ──
router.post("/broadcast/templates", async (req, res) => {
  try {
    const { name, category, language, header_type, header_text, header_media_url, body, footer_text, variables } = req.body;
    if (!name || !body) return res.status(400).json({ message: "Name and body required" });

    const { rows } = await query(`
      INSERT INTO whatsapp_templates
        (business_id, name, category, language, header_type, header_text, header_media_url, body, footer_text, variables)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [
      bId(req), name,
      category  || "MARKETING",
      language  || "en",
      header_type       || "none",
      header_text       || null,
      header_media_url  || null,
      body, footer_text || null,
      variables || [],
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to create template: " + err.message });
  }
});

// ── Update template ──
router.put("/broadcast/templates/:id", async (req, res) => {
  try {
    const { name, category, language, header_type, header_text, header_media_url, body, footer_text, variables } = req.body;
    const { rows } = await query(`
      UPDATE whatsapp_templates SET
        name=$1, category=$2, language=$3,
        header_type=$4, header_text=$5, header_media_url=$6,
        body=$7, footer_text=$8, variables=$9,
        meta_status='draft', updated_at=NOW()
      WHERE id=$10 AND business_id=$11 RETURNING *
    `, [name, category, language, header_type || "none", header_text || null, header_media_url || null, body, footer_text, variables, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: "Failed to update template" }); }
});

router.delete("/broadcast/templates/:id", async (req, res) => {
  try {
    await query("DELETE FROM whatsapp_templates WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to delete template" }); }
});

// ── Sync all templates ──
router.post("/broadcast/templates/sync", async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const recentOnly = req.query.recent === "true";
    const { rows: wRows } = await query("SELECT access_token, waba_id FROM whatsapp_configs WHERE business_id=$1", [businessId]);
    if (!wRows.length || !wRows[0].access_token) return res.status(400).json({ message: "WhatsApp not connected" });
    const { access_token, waba_id } = wRows[0];
    if (!waba_id) return res.status(400).json({ message: "WABA ID not set" });

    let tq = "SELECT * FROM whatsapp_templates WHERE business_id=$1";
    if (recentOnly) tq += " AND created_at >= NOW() - INTERVAL '2 days'";
    const { rows: localTemplates } = await query(tq, [businessId]);
    if (!localTemplates.length) return res.json({ success: true, synced: 0, templates: [] });

    const metaRes = await axios.get(
      `https://graph.facebook.com/${META_VERSION}/${waba_id}/message_templates`,
      { params: { limit: 250, fields: "name,status,category,language,quality_score,rejected_reason" }, headers: { Authorization: `Bearer ${access_token}` } }
    );
    const metaTemplates = metaRes.data?.data || [];
    const STATUS_MAP = { APPROVED:"approved", PENDING:"pending", REJECTED:"rejected", DISABLED:"rejected", PAUSED:"paused", IN_APPEAL:"pending", PENDING_DELETION:"pending" };
    let synced = 0;
    for (const lt of localTemplates) {
      const sanitized = sanitizeTemplateName(lt.name);
      const mt = metaTemplates.find(t => t.name === sanitized || t.name === lt.name);
      if (!mt) continue;
      const newStatus = STATUS_MAP[mt.status] || mt.status?.toLowerCase() || "pending";
      const rejReason = mt.rejected_reason || mt.quality_score?.reasons?.join(", ") || null;
      await query(`UPDATE whatsapp_templates SET meta_status=$1, rejection_reason=$2, updated_at=NOW() WHERE id=$3`, [newStatus, rejReason, lt.id]);
      synced++;
    }
    const { rows } = await query("SELECT * FROM whatsapp_templates WHERE business_id=$1 ORDER BY created_at DESC", [businessId]);
    res.json({ success: true, synced, templates: rows });
  } catch (err) { res.status(500).json({ message: "Failed to sync templates: " + err.message }); }
});

// ── Get single template status from Meta ──
router.get("/broadcast/templates/:id/status", async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { rows: tRows } = await query("SELECT * FROM whatsapp_templates WHERE id=$1 AND business_id=$2", [req.params.id, businessId]);
    if (!tRows.length) return res.status(404).json({ message: "Template not found" });
    const template = tRows[0];
    const { rows: wRows } = await query("SELECT access_token FROM whatsapp_configs WHERE business_id=$1", [businessId]);
    if (!wRows[0]?.access_token) return res.json({ template });
    const sanitized = sanitizeTemplateName(template.name);
    const metaRes = await axios.get(
      `https://graph.facebook.com/${META_VERSION}/${template.meta_template_id || sanitized}`,
      { params: { fields: "name,status,quality_score" }, headers: { Authorization: `Bearer ${wRows[0].access_token}` } }
    ).catch(() => null);
    if (metaRes?.data?.status) {
      const newStatus = metaRes.data.status.toLowerCase();
      await query("UPDATE whatsapp_templates SET meta_status=$1, updated_at=NOW() WHERE id=$2", [newStatus, template.id]);
      template.meta_status = newStatus;
    }
    res.json({ template });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Sync single template ──
router.post("/broadcast/templates/:id/sync", async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { rows: tRows } = await query("SELECT * FROM whatsapp_templates WHERE id=$1 AND business_id=$2", [req.params.id, businessId]);
    if (!tRows.length) return res.status(404).json({ message: "Template not found" });
    const template = tRows[0];
    const { rows: wRows } = await query("SELECT access_token, waba_id FROM whatsapp_configs WHERE business_id=$1", [businessId]);
    if (!wRows[0]?.access_token || !wRows[0]?.waba_id) return res.status(400).json({ message: "WhatsApp not connected" });
    const { access_token, waba_id } = wRows[0];
    const sanitized = sanitizeTemplateName(template.name);
    const metaRes = await axios.get(`https://graph.facebook.com/${META_VERSION}/${waba_id}/message_templates`, {
      params: { name: sanitized, fields: "name,status,rejected_reason,quality_score" },
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const mt = metaRes.data?.data?.[0];
    if (!mt) return res.json({ template, message: "Template not found on Meta yet" });
    const STATUS_MAP = { APPROVED:"approved", PENDING:"pending", REJECTED:"rejected", DISABLED:"rejected", PAUSED:"paused", IN_APPEAL:"pending" };
    const newStatus = STATUS_MAP[mt.status] || mt.status?.toLowerCase() || "pending";
    const rejReason = mt.rejected_reason || mt.quality_score?.reasons?.join(", ") || null;
    await query(`UPDATE whatsapp_templates SET meta_status=$1, rejection_reason=$2, updated_at=NOW() WHERE id=$3`, [newStatus, rejReason, template.id]);
    res.json({ success: true, status: newStatus, rejection_reason: rejReason });
  } catch (err) { res.status(500).json({ message: "Sync failed: " + err.message }); }
});

// ── Submit template to Meta (handles text, image, video headers) ──
router.post("/broadcast/templates/:id/submit", async (req, res) => {
  try {
    const { rows: tRows } = await query("SELECT * FROM whatsapp_templates WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    if (!tRows.length) return res.status(404).json({ message: "Template not found" });
    const template = tRows[0];

    const { rows: wc } = await query("SELECT * FROM whatsapp_configs WHERE business_id=$1", [bId(req)]);
    if (!wc.length) return res.status(400).json({ message: "WhatsApp not configured" });
    const { access_token, waba_id, phone_number_id } = wc[0];
    if (!access_token) return res.status(400).json({ message: "Access token missing" });

    // Resolve WABA ID if missing
    let finalWabaId = waba_id;
    if (!finalWabaId) {
      try {
        const wabaRes = await axios.get(`${META_BASE}/${META_VERSION}/me/whatsapp_business_accounts`, { headers: { Authorization: `Bearer ${access_token}` } });
        finalWabaId = wabaRes.data?.data?.[0]?.id;
        if (finalWabaId) await query("UPDATE whatsapp_configs SET waba_id=$1 WHERE business_id=$2", [finalWabaId, bId(req)]);
      } catch (err) { console.warn("Could not fetch WABA ID:", err.message); }
    }
    if (!finalWabaId) return res.status(400).json({ message: "WABA ID not found. Please re-save WhatsApp credentials." });

    // Convert named vars ({{name}}) → numbered ({{1}}) for Meta
    const varNames  = [];
    const metaBody  = (template.body || "").replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (/^\d+$/.test(name)) { if (!varNames.includes(name)) varNames.push(name); return match; }
      if (!varNames.includes(name)) varNames.push(name);
      return `{{${varNames.indexOf(name) + 1}}}`;
    });

    // ── Build components array ────────────────────────────────
    const components = [];
    const headerType = template.header_type || (template.header_text ? "text" : "none");

    if (headerType === "image" && template.header_media_url) {
      // Image header — Meta needs a public URL to fetch during review
      components.push({
        type:    "HEADER",
        format:  "IMAGE",
        example: { header_handle: [template.header_media_url] },
      });
    } else if (headerType === "video" && template.header_media_url) {
      // Video header
      components.push({
        type:    "HEADER",
        format:  "VIDEO",
        example: { header_handle: [template.header_media_url] },
      });
    } else if (headerType === "text" && template.header_text) {
      // Text header — convert named vars too
      const metaHeaderText = template.header_text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
        if (/^\d+$/.test(name)) return match;
        if (!varNames.includes(name)) varNames.push(name);
        return `{{${varNames.indexOf(name) + 1}}}`;
      });
      components.push({ type: "HEADER", format: "TEXT", text: metaHeaderText });
    }

    // Body component
    const bodyComponent = { type: "BODY", text: metaBody };
    if (varNames.length > 0) {
      bodyComponent.example = { 
      body_text: varNames.map((_, i) => `example_${i + 1}`) 
      };
    }
    components.push(bodyComponent);

    if (template.footer_text) {
      components.push({ type: "FOOTER", text: template.footer_text });
    }

    const metaName = sanitizeTemplateName(template.name);
    const metaRes  = await axios.post(
      `${META_BASE}/${META_VERSION}/${finalWabaId}/message_templates`,
      { name: metaName, category: template.category || "MARKETING", language: template.language || "en_US", components },
      { headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" } }
    );

    await query(
      `UPDATE whatsapp_templates SET meta_status='pending', meta_template_id=$1, name=$2, variables=$3, updated_at=NOW() WHERE id=$4`,
      [metaRes.data?.id?.toString(), metaName, JSON.stringify(varNames), req.params.id]
    );

    res.json({ success: true, metaTemplateId: metaRes.data?.id });
  } catch (err) {
    const errMsg  = err.response?.data?.error?.message || err.message;
    const errCode = err.response?.data?.error?.code;
    let userMessage = errMsg;
    if (errCode === 100) userMessage = "Invalid template format. Check your template body and variables.";
    if (errCode === 190) userMessage = "Access token expired. Please update your WhatsApp token in Settings.";
    if (errCode === 200) userMessage = "Permission denied. Make sure your token has whatsapp_business_management permission.";
    res.status(500).json({ message: userMessage });
  }
});

export async function handleTemplateStatusUpdate(value) {
  try {
    const { message_template_id, event } = value;
    if (!message_template_id || !event) return;
    const statusMap = { APPROVED:"approved", REJECTED:"rejected", PENDING:"pending", DELETED:"deleted" };
    const status = statusMap[event] || event.toLowerCase();
    await query(`UPDATE whatsapp_templates SET meta_status=$1, rejection_reason=$2, updated_at=NOW() WHERE meta_template_id=$3`,
      [status, value.rejection_reason || null, message_template_id.toString()]);
  } catch (err) { console.error("Template status update error:", err.message); }
}

// ══════════════════════════════════════════════════════════════
//  CAMPAIGNS
// ══════════════════════════════════════════════════════════════

router.get("/broadcast/campaigns", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM broadcast_campaigns WHERE business_id=$1 ORDER BY created_at DESC", [bId(req)]);
    const formatted = rows.map(c => ({ ...c, scheduled_at_ist: utcToISTString(c.scheduled_at), next_run_at_ist: utcToISTString(c.next_run_at), last_run_at_ist: utcToISTString(c.last_run_at) }));
    res.json({ campaigns: formatted });
  } catch (err) { res.status(500).json({ message: "Failed to load campaigns" }); }
});

router.get("/broadcast/campaigns/:id", async (req, res) => {
  try {
    const [camp, recipients] = await Promise.all([
      query("SELECT * FROM broadcast_campaigns WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]),
      query("SELECT * FROM broadcast_recipients WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 100", [req.params.id]),
    ]);
    const c = camp.rows[0];
    res.json({ campaign: { ...c, scheduled_at_ist: utcToISTString(c?.scheduled_at), next_run_at_ist: utcToISTString(c?.next_run_at) }, recipients: recipients.rows });
  } catch (err) { res.status(500).json({ message: "Failed to load campaign" }); }
});

router.post("/broadcast/campaigns", async (req, res) => {
  try {
    const { name, message_type, template_id, message_body, variables_map, scheduled_at, recurring_rule, recurring_time, recurring_days, recipient_source, contact_list_id, contact_ids, lead_filter } = req.body;
    if (!name) return res.status(400).json({ message: "Campaign name required" });
    if (!message_body && !template_id) return res.status(400).json({ message: "Message required" });
    let utcScheduledAt = null;
    if (scheduled_at) {
      const utcDate = istInputToUTC(scheduled_at);
      if (!utcDate) return res.status(400).json({ message: "Invalid scheduled time format" });
      if (!isValidSendTime(utcDate)) return res.status(400).json({ message: "Scheduled time must be between 6 AM and 11 PM IST" });
      utcScheduledAt = utcDate.toISOString();
    }
    const { rows: campRows } = await query(`
      INSERT INTO broadcast_campaigns
        (business_id, name, message_type, template_id, message_body, variables_map, scheduled_at, recurring_rule, recurring_time, recurring_days, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [bId(req), name, message_type || "session", template_id || null, message_body || null, variables_map ? JSON.stringify(variables_map) : "{}", utcScheduledAt || null, recurring_rule || null, recurring_time || null, recurring_days || null, utcScheduledAt ? "scheduled" : "draft"]);
    const campaign    = campRows[0];
    const recipients  = await resolveRecipients(bId(req), { recipient_source, contact_list_id, contact_ids, lead_filter });
    for (const r of recipients) {
      await query(`INSERT INTO broadcast_recipients (campaign_id, business_id, contact_id, phone, name, variables) VALUES ($1,$2,$3::uuid,$4,$5,$6) ON CONFLICT DO NOTHING`, [campaign.id, bId(req), r.contact_id || null, r.phone, r.name || null, JSON.stringify(r.variables || {})]);
    }
    await query("UPDATE broadcast_campaigns SET total_recipients=$1 WHERE id=$2", [recipients.length, campaign.id]);
    res.status(201).json({ ...campaign, total_recipients: recipients.length, scheduled_at_ist: utcToISTString(campaign.scheduled_at) });
  } catch (err) { console.error("Create campaign error:", err.message); res.status(500).json({ message: err.message }); }
});

router.post("/broadcast/campaigns/:id/launch", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM broadcast_campaigns WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    if (!rows.length) return res.status(404).json({ message: "Campaign not found" });
    await query("UPDATE broadcast_campaigns SET status='running', scheduled_at=NOW() WHERE id=$1", [req.params.id]);
    executeCampaign(rows[0], bId(req)).catch(console.error);
    res.json({ success: true, message: "Campaign launched" });
  } catch (err) { res.status(500).json({ message: "Failed to launch campaign" }); }
});

router.post("/broadcast/campaigns/:id/pause", async (req, res) => {
  try {
    await query("UPDATE broadcast_campaigns SET status='paused' WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to pause" }); }
});

router.delete("/broadcast/campaigns/:id", async (req, res) => {
  try {
    await query("DELETE FROM broadcast_campaigns WHERE id=$1 AND business_id=$2", [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed to delete" }); }
});

export async function updateBroadcastStatus(status) {
  try {
    const { id, status: s } = status;
    if (!id) return;
    const statusMap = { sent:"sent", delivered:"delivered", read:"read", failed:"failed" };
    await query("UPDATE broadcast_recipients SET status=$1, updated_at=NOW() WHERE wa_message_id=$2", [statusMap[s] || s, id]).catch(() => {});
  } catch (err) { console.error("Broadcast status update error:", err.message); }
}

// ══════════════════════════════════════════════════════════════
//  CAMPAIGN EXECUTION
// ══════════════════════════════════════════════════════════════

export async function executeCampaign(campaign, businessId) {
  try {
    const { rows: wc } = await query("SELECT phone_number_id, access_token FROM whatsapp_configs WHERE business_id=$1", [businessId]);
    if (!wc.length) throw new Error("WhatsApp not configured");
    const { phone_number_id, access_token } = wc[0];
    const { rows: recipients } = await query("SELECT * FROM broadcast_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY created_at ASC", [campaign.id]);
    console.log(`📢 Broadcasting to ${recipients.length} recipients: ${campaign.name}`);
    for (const recipient of recipients) {
      const { rows: check } = await query("SELECT status FROM broadcast_campaigns WHERE id=$1", [campaign.id]);
      if (check[0]?.status !== "running") break;
      try {
        let result;
        if (campaign.message_type === "template" && campaign.template_id) {
          result = await sendTemplateMessage({ phoneNumberId: phone_number_id, accessToken: access_token, to: recipient.phone, campaign, recipient });
        } else {
          let message = (campaign.message_body || "").replace(/\{\{name\}\}/gi, recipient.name || "there").replace(/\{\{phone\}\}/gi, recipient.phone);
          result = await sendSessionMessage({ phoneNumberId: phone_number_id, accessToken: access_token, to: recipient.phone, message });
        }
        await query("UPDATE broadcast_recipients SET status='sent', wa_message_id=$1, sent_at=NOW() WHERE id=$2", [result?.messages?.[0]?.id, recipient.id]);
        await query("UPDATE broadcast_campaigns SET sent_count=sent_count+1, updated_at=NOW() WHERE id=$1", [campaign.id]);
        await sleep(1500 + Math.random() * 1000);
      } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        await query("UPDATE broadcast_recipients SET status='failed', error_message=$1 WHERE id=$2", [errMsg, recipient.id]);
        await query("UPDATE broadcast_campaigns SET failed_count=failed_count+1 WHERE id=$1", [campaign.id]);
      }
    }
    await query("UPDATE broadcast_campaigns SET status='completed', last_run_at=NOW(), updated_at=NOW() WHERE id=$1", [campaign.id]);
    if (campaign.recurring_rule) {
      const nextRun = calculateNextRun(campaign);
      if (nextRun) {
        await query("UPDATE broadcast_campaigns SET status='scheduled', next_run_at=$1, scheduled_at=$1 WHERE id=$2", [nextRun.toISOString(), campaign.id]);
        await query("UPDATE broadcast_recipients SET status='pending' WHERE campaign_id=$1", [campaign.id]);
      }
    }
  } catch (err) {
    console.error("Campaign execution error:", err.message);
    await query("UPDATE broadcast_campaigns SET status='failed', updated_at=NOW() WHERE id=$1", [campaign.id]);
  }
}

async function sendSessionMessage({ phoneNumberId, accessToken, to, message }) {
  const response = await axios.post(
    `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`,
    { messaging_product:"whatsapp", recipient_type:"individual", to, type:"text", text:{ body:message, preview_url:false } },
    { headers: { Authorization:`Bearer ${accessToken}`, "Content-Type":"application/json" } }
  );
  return response.data;
}

async function sendTemplateMessage({ phoneNumberId, accessToken, to, campaign, recipient }) {
  const { rows: tRows } = await query("SELECT * FROM whatsapp_templates WHERE id=$1", [campaign.template_id]);
  if (!tRows.length) throw new Error("Template not found");
  const template   = tRows[0];
  const variables  = template.variables || [];
  const components = [];

  // Header component for image/video templates
  const headerType = template.header_type || "none";
  if ((headerType === "image" || headerType === "video") && template.header_media_url) {
    components.push({
      type:       "header",
      parameters: [{ type: headerType, [headerType]: { link: template.header_media_url } }],
    });
  }

  // Body parameters
  if (variables.length > 0) {
    const bodyParams = variables.map(varName => {
      if (varName === "name"  || varName === "1") return { type:"text", text: recipient.name  || campaign.variables_map?.[varName] || "" };
      if (varName === "phone" || varName === "2") return { type:"text", text: recipient.phone || campaign.variables_map?.[varName] || "" };
      return { type:"text", text: campaign.variables_map?.[varName] || recipient.variables?.[varName] || "" };
    });
    components.push({ type:"body", parameters: bodyParams });
  }

  const response = await axios.post(
    `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp", to,
      type: "template",
      template: { name: template.name, language:{ code: template.language || "en" }, components: components.length ? components : undefined },
    },
    { headers: { Authorization:`Bearer ${accessToken}`, "Content-Type":"application/json" } }
  );
  return response.data;
}

async function resolveRecipients(businessId, { recipient_source, contact_list_id, contact_ids, lead_filter }) {
  const recipients = [];
  if (recipient_source === "list" && contact_list_id) {
    const { rows } = await query(`SELECT bc.id AS contact_id, bc.phone, bc.name FROM business_contacts bc JOIN contact_list_members clm ON clm.contact_id = bc.id WHERE clm.list_id=$1 AND bc.business_id=$2 AND bc.opted_out=FALSE AND bc.phone IS NOT NULL`, [contact_list_id, businessId]);
    recipients.push(...rows);
  }
  if (recipient_source === "contacts" || recipient_source === "all") {
    const { rows } = await query("SELECT id AS contact_id, phone, name FROM business_contacts WHERE business_id=$1 AND opted_out=FALSE AND phone IS NOT NULL", [businessId]);
    recipients.push(...rows);
  }
  if (recipient_source === "leads" || recipient_source === "all") {
    let sql = "SELECT NULL::uuid AS contact_id, phone, customer_name AS name FROM leads WHERE business_id=$1 AND phone IS NOT NULL";
    const params = [businessId];
    if (lead_filter?.status) { params.push(lead_filter.status); sql += ` AND status=$${params.length}`; }
    const { rows } = await query(sql, params);
    recipients.push(...rows);
  }
  if (contact_ids?.length > 0) {
    const { rows } = await query("SELECT id AS contact_id, phone, name FROM business_contacts WHERE business_id=$1 AND id=ANY($2) AND opted_out=FALSE AND phone IS NOT NULL", [businessId, contact_ids]);
    recipients.push(...rows);
  }
  const seen = new Set();
  return recipients.filter(r => r.phone && !seen.has(r.phone) && seen.add(r.phone));
}

function calculateNextRun(campaign) {
  const now  = nowIST();
  const rule = campaign.recurring_rule;
  const time = campaign.recurring_time || "10:00";
  const [h, m] = time.split(":").map(Number);
  const next = new Date(now);
  next.setUTCHours(h - 5, m - 30, 0, 0);
  if (rule === "daily")        next.setUTCDate(next.getUTCDate() + 1);
  else if (rule === "weekly")  next.setUTCDate(next.getUTCDate() + 7);
  else if (rule === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  else return null;
  return next;
}

export async function runScheduledBroadcasts() {
  try {
    const { rows } = await query(`SELECT * FROM broadcast_campaigns WHERE status='scheduled' AND scheduled_at<=NOW() AND scheduled_at IS NOT NULL`);
    for (const campaign of rows) {
      if (!isValidSendTime(new Date())) { console.log(`⏸️ Outside send hours — skipping: ${campaign.name}`); continue; }
      await query("UPDATE broadcast_campaigns SET status='running' WHERE id=$1", [campaign.id]);
      executeCampaign(campaign, campaign.business_id).catch(console.error);
    }
  } catch (err) { console.error("Scheduled broadcast error:", err.message); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default router;