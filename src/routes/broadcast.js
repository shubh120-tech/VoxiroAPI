import express   from "express";
import axios     from "axios";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

const bId = (req) => req.user.business_id;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const META_BASE    = process.env.META_BASE_URL    || "https://graph.facebook.com";
const META_VERSION = process.env.META_API_VERSION || "v19.0";

// IST helpers
const IST_OFFSET      = 5.5 * 60 * 60 * 1000;
const SEND_HOUR_START = 6;   // 6 AM IST
const SEND_HOUR_END   = 23;  // 11 PM IST

function nowIST()       { return new Date(Date.now() + IST_OFFSET); }
function getISTHour(d)  { return new Date(d.getTime() + IST_OFFSET).getUTCHours(); }
function isValidSendTime(date) {
  const h = getISTHour(date);
  return h >= SEND_HOUR_START && h < SEND_HOUR_END;
}

// ── Helper: sanitize template name same way Meta expects ──────
function sanitizeTemplateName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

// ══════════════════════════════════════════════════════════════
//  CONTACT LISTS
// ══════════════════════════════════════════════════════════════

// Get all lists with member count
router.get("/broadcast/lists", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT cl.*,
        COUNT(clm.contact_id) AS member_count
      FROM contact_lists cl
      LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
      WHERE cl.business_id = $1
      GROUP BY cl.id
      ORDER BY cl.created_at DESC
    `, [bId(req)]);
    res.json({ lists: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load lists" });
  }
});

// Create list
router.post("/broadcast/lists", async (req, res) => {
  try {
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ message: "List name required" });
    const { rows } = await query(`
      INSERT INTO contact_lists (business_id, name, description, color)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [bId(req), name, description || null, color || "#0d9488"]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to create list" });
  }
});

// Update list
router.put("/broadcast/lists/:id", async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const { rows } = await query(`
      UPDATE contact_lists SET name = $1, description = $2, color = $3, updated_at = NOW()
      WHERE id = $4 AND business_id = $5 RETURNING *
    `, [name, description, color, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to update list" });
  }
});

// Delete list
router.delete("/broadcast/lists/:id", async (req, res) => {
  try {
    await query("DELETE FROM contact_lists WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete list" });
  }
});

// Get contacts in a list
router.get("/broadcast/lists/:id/contacts", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT bc.* FROM business_contacts bc
      JOIN contact_list_members clm ON clm.contact_id = bc.id
      WHERE clm.list_id = $1 AND bc.business_id = $2
      ORDER BY bc.name ASC
    `, [req.params.id, bId(req)]);
    res.json({ contacts: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load list contacts" });
  }
});

// Add contacts to list
router.post("/broadcast/lists/:id/contacts", async (req, res) => {
  try {
    const { contact_ids } = req.body;
    if (!contact_ids?.length) return res.status(400).json({ message: "No contacts provided" });
    let added = 0;
    for (const contactId of contact_ids) {
      try {
        await query(`
          INSERT INTO contact_list_members (list_id, contact_id)
          VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [req.params.id, contactId]);
        added++;
      } catch {}
    }
    res.json({ success: true, added });
  } catch (err) {
    res.status(500).json({ message: "Failed to add contacts" });
  }
});

// Remove contact from list
router.delete("/broadcast/lists/:id/contacts/:contactId", async (req, res) => {
  try {
    await query("DELETE FROM contact_list_members WHERE list_id = $1 AND contact_id = $2",
      [req.params.id, req.params.contactId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove contact" });
  }
});

// ══════════════════════════════════════════════════════════════
//  CONTACTS
// ══════════════════════════════════════════════════════════════

// Get all contacts
router.get("/broadcast/contacts", async (req, res) => {
  try {
    const { search, tag } = req.query;
    let sql    = `SELECT * FROM business_contacts WHERE business_id = $1 AND opted_out = FALSE`;
    const params = [bId(req)];
    if (search) { params.push(`%${search}%`); sql += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await query(sql, params);
    res.json({ contacts: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load contacts" });
  }
});

// Claude-powered contact extraction from raw text
router.post("/broadcast/contacts/extract", async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText?.trim()) return res.status(400).json({ message: "No text provided" });

    const response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{
        role:    "user",
        content: `Extract all contact information from this text. Return ONLY a valid JSON array, no other text.

Each contact object should have:
- phone: string (normalize to +91XXXXXXXXXX format for Indian numbers, add country code if missing)
- name: string or null
- email: string or null  
- notes: string or null (any other relevant info like domain, requirement, service needed)

Rules:
- Include ALL contacts found
- Normalize phone numbers (remove spaces, dashes, brackets)
- Add +91 for 10-digit Indian numbers
- Skip entries with no valid phone number
- Return empty array [] if no contacts found

Text to extract from:
${rawText.slice(0, 5000)}`,
      }],
    });

    const text    = response.content[0]?.text || "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    let   contacts;

    try {
      contacts = JSON.parse(cleaned);
    } catch {
      contacts = [];
    }

    // Validate phone numbers
    contacts = contacts.filter(c => c.phone && c.phone.length >= 10);

    res.json({ contacts, count: contacts.length });
  } catch (err) {
    console.error("Extract error:", err.message);
    res.status(500).json({ message: "Failed to extract contacts" });
  }
});

// Save extracted contacts to DB
router.post("/broadcast/contacts/import", async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!contacts?.length) return res.status(400).json({ message: "No contacts to import" });

    let imported = 0;
    let skipped  = 0;

    for (const contact of contacts) {
      if (!contact.phone) continue;
      try {
        await query(`
          INSERT INTO business_contacts (business_id, name, phone, email, notes, source)
          VALUES ($1, $2, $3, $4, $5, 'import')
          ON CONFLICT (business_id, phone) DO UPDATE
          SET name = COALESCE($2, business_contacts.name),
              notes = COALESCE($5, business_contacts.notes),
              updated_at = NOW()
        `, [bId(req), contact.name, contact.phone, contact.email, contact.notes]);
        imported++;
      } catch {
        skipped++;
      }
    }

    res.json({ success: true, imported, skipped });
  } catch (err) {
    res.status(500).json({ message: "Failed to import contacts" });
  }
});

// Delete contact
router.delete("/broadcast/contacts/:id", async (req, res) => {
  try {
    await query("DELETE FROM business_contacts WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete contact" });
  }
});

// Opt out contact
router.patch("/broadcast/contacts/:id/optout", async (req, res) => {
  try {
    await query("UPDATE business_contacts SET opted_out = TRUE WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to opt out contact" });
  }
});

// ══════════════════════════════════════════════════════════════
//  TEMPLATES
// ══════════════════════════════════════════════════════════════

router.get("/broadcast/templates", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM whatsapp_templates WHERE business_id = $1 ORDER BY created_at DESC",
      [bId(req)]
    );
    res.json({ templates: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load templates" });
  }
});


// ── Sync ALL template statuses from Meta ──────────────────────
router.post("/broadcast/templates/sync", async (req, res) => {
  try {
    const businessId  = req.user.business_id;
    const recentOnly  = req.query.recent === "true";

    // Get WhatsApp config
    const { rows: wRows } = await query(
      "SELECT access_token, waba_id FROM whatsapp_configs WHERE business_id = $1",
      [businessId]
    );
    if (!wRows.length || !wRows[0].access_token) {
      return res.status(400).json({ message: "WhatsApp not connected" });
    }

    const { access_token, waba_id } = wRows[0];
    if (!waba_id) {
      return res.status(400).json({ message: "WABA ID not set. Please update WhatsApp settings." });
    }

    // Get local templates to sync
    let templateQuery = "SELECT * FROM whatsapp_templates WHERE business_id = $1";
    if (recentOnly) {
      templateQuery += " AND created_at >= NOW() - INTERVAL '2 days'";
    }
    const { rows: localTemplates } = await query(templateQuery, [businessId]);

    if (!localTemplates.length) {
      return res.json({ success: true, synced: 0, templates: [] });
    }

    // Fetch all templates from Meta
    const metaRes = await axios.get(
      `https://graph.facebook.com/${META_VERSION}/${waba_id}/message_templates`,
      {
        params:  { limit: 250, fields: "name,status,category,language,quality_score,rejected_reason" },
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    const metaTemplates = metaRes.data?.data || [];

    // Map Meta status to our status
    const STATUS_MAP = {
      "APPROVED":         "approved",
      "PENDING":          "pending",
      "REJECTED":         "rejected",
      "DISABLED":         "rejected",
      "PAUSED":           "paused",
      "IN_APPEAL":        "pending",
      "PENDING_DELETION": "pending",
    };

    let synced = 0;
    for (const lt of localTemplates) {
      // FIX: match by sanitized name (what Meta actually stores) OR exact name
      const sanitized = sanitizeTemplateName(lt.name);
      const mt = metaTemplates.find(t => t.name === sanitized || t.name === lt.name);

      if (!mt) {
        console.log(`⚠️  Template "${lt.name}" (sanitized: "${sanitized}") not found on Meta — skipping`);
        continue;
      }

      const newStatus = STATUS_MAP[mt.status] || mt.status?.toLowerCase() || "pending";
      const rejReason = mt.rejected_reason || mt.quality_score?.reasons?.join(", ") || null;

      await query(`
        UPDATE whatsapp_templates
        SET meta_status      = $1,
            rejection_reason = $2,
            updated_at       = NOW()
        WHERE id = $3
      `, [newStatus, rejReason, lt.id]).catch(async () => {
        // Fallback: add missing columns if needed
        await query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS meta_status VARCHAR(50) DEFAULT 'pending'`);
        await query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
        await query(`UPDATE whatsapp_templates SET meta_status = $1 WHERE id = $2`, [newStatus, lt.id]);
      });

      synced++;
      console.log(`📋 Template "${lt.name}" (Meta: "${mt.name}"): → ${newStatus}`);
    }

    const { rows } = await query(
      "SELECT * FROM whatsapp_templates WHERE business_id = $1 ORDER BY created_at DESC",
      [businessId]
    );

    console.log(`✅ Synced ${synced} templates for business ${businessId}`);
    res.json({ success: true, synced, templates: rows });
  } catch (err) {
    console.error("Template sync error:", err.response?.data || err.message);
    res.status(500).json({ message: "Failed to sync templates: " + err.message });
  }
});

// ── Sync single template status ───────────────────────────────
router.post("/broadcast/templates/:id/sync", authMiddleware, async (req, res) => {
  try {
    const businessId = req.user.business_id;

    const { rows: tRows } = await query(
      "SELECT * FROM whatsapp_templates WHERE id = $1 AND business_id = $2",
      [req.params.id, businessId]
    );
    if (!tRows.length) return res.status(404).json({ message: "Template not found" });
    const template = tRows[0];

    const { rows: wRows } = await query(
      "SELECT access_token, waba_id FROM whatsapp_configs WHERE business_id = $1",
      [businessId]
    );
    if (!wRows[0]?.access_token || !wRows[0]?.waba_id) {
      return res.status(400).json({ message: "WhatsApp not connected" });
    }

    const { access_token, waba_id } = wRows[0];

    // FIX: search by sanitized name (what Meta stores) OR exact name
    const sanitized = sanitizeTemplateName(template.name);

    const metaRes = await axios.get(
      `https://graph.facebook.com/${META_VERSION}/${waba_id}/message_templates`,
      {
        params:  { name: sanitized, fields: "name,status,rejected_reason,quality_score" },
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    // Also try exact name if sanitized returns nothing
    let mt = metaRes.data?.data?.[0];
    if (!mt && sanitized !== template.name) {
      const fallbackRes = await axios.get(
        `https://graph.facebook.com/${META_VERSION}/${waba_id}/message_templates`,
        {
          params:  { name: template.name, fields: "name,status,rejected_reason,quality_score" },
          headers: { Authorization: `Bearer ${access_token}` },
        }
      ).catch(() => null);
      mt = fallbackRes?.data?.data?.[0];
    }

    if (!mt) return res.json({ template, message: "Template not found on Meta yet" });

    const STATUS_MAP = {
      "APPROVED": "approved", "PENDING": "pending", "REJECTED": "rejected",
      "DISABLED": "rejected", "PAUSED": "paused",   "IN_APPEAL": "pending",
    };

    const newStatus = STATUS_MAP[mt.status] || mt.status?.toLowerCase() || "pending";
    const rejReason = mt.rejected_reason || mt.quality_score?.reasons?.join(", ") || null;

    await query(`
      UPDATE whatsapp_templates
      SET meta_status = $1, rejection_reason = $2, updated_at = NOW()
      WHERE id = $3
    `, [newStatus, rejReason, template.id]);

    console.log(`📋 Template "${template.name}" synced: → ${newStatus}`);
    res.json({ success: true, status: newStatus, rejection_reason: rejReason });

  } catch (err) {
    console.error("Single template sync error:", err.response?.data || err.message);
    res.status(500).json({ message: "Sync failed: " + err.message });
  }
});


router.get("/broadcast/templates/:id/status", async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { rows: tRows } = await query(
      "SELECT * FROM whatsapp_templates WHERE id = $1 AND business_id = $2",
      [req.params.id, businessId]
    );
    if (!tRows.length) return res.status(404).json({ message: "Template not found" });

    const template = tRows[0];

    const { rows: wRows } = await query(
      "SELECT access_token FROM whatsapp_configs WHERE business_id = $1",
      [businessId]
    );
    if (!wRows[0]?.access_token) {
      return res.json({ template });
    }

    // FIX: use sanitized name for lookup
    const sanitized = sanitizeTemplateName(template.name);
    const metaRes = await axios.get(
      `https://graph.facebook.com/${META_VERSION}/${template.meta_template_id || sanitized}`,
      {
        params:  { fields: "name,status,quality_score" },
        headers: { Authorization: `Bearer ${wRows[0].access_token}` },
      }
    ).catch(() => null);

    if (metaRes?.data?.status) {
      const newStatus = metaRes.data.status.toLowerCase();
      await query(
        "UPDATE whatsapp_templates SET meta_status = $1, updated_at = NOW() WHERE id = $2",
        [newStatus, template.id]
      );
      template.meta_status = newStatus;
    }

    res.json({ template });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/broadcast/templates", async (req, res) => {
  try {
    const { name, category, language, header_text, body, footer_text, variables } = req.body;
    if (!name || !body) return res.status(400).json({ message: "Name and body required" });

    const { rows } = await query(`
      INSERT INTO whatsapp_templates
        (business_id, name, category, language, header_text, body, footer_text, variables)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [bId(req), name, category || "MARKETING", language || "en",
        header_text, body, footer_text, variables || []]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to create template" });
  }
});

router.put("/broadcast/templates/:id", async (req, res) => {
  try {
    const { name, category, language, header_text, body, footer_text, variables } = req.body;
    const { rows } = await query(`
      UPDATE whatsapp_templates
      SET name = $1, category = $2, language = $3, header_text = $4,
          body = $5, footer_text = $6, variables = $7,
          meta_status = 'draft', updated_at = NOW()
      WHERE id = $8 AND business_id = $9
      RETURNING *
    `, [name, category, language, header_text, body, footer_text, variables, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to update template" });
  }
});

router.delete("/broadcast/templates/:id", async (req, res) => {
  try {
    await query("DELETE FROM whatsapp_templates WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete template" });
  }
});

// Submit template to Meta for approval
router.post("/broadcast/templates/:id/submit", async (req, res) => {
  try {
    const { rows: tRows } = await query(
      "SELECT * FROM whatsapp_templates WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    if (!tRows.length) return res.status(404).json({ message: "Template not found" });
    const template = tRows[0];

    // Get WhatsApp config including WABA ID
    const { rows: wc } = await query(
      "SELECT * FROM whatsapp_configs WHERE business_id = $1",
      [bId(req)]
    );
    if (!wc.length) return res.status(400).json({ message: "WhatsApp not configured. Please save your WhatsApp credentials first." });

    const { access_token, waba_id, phone_number_id } = wc[0];

    if (!access_token) return res.status(400).json({ message: "Access token missing. Please update your WhatsApp credentials." });

    // Auto-fetch WABA ID if not stored yet
    let finalWabaId = waba_id;
    if (!finalWabaId) {
      try {
        const wabaRes = await axios.get(
          `${META_BASE}/${META_VERSION}/me/whatsapp_business_accounts`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        finalWabaId = wabaRes.data?.data?.[0]?.id;
        if (finalWabaId) {
          await query(
            "UPDATE whatsapp_configs SET waba_id = $1 WHERE business_id = $2",
            [finalWabaId, bId(req)]
          );
          console.log(`✅ WABA ID auto-fetched: ${finalWabaId}`);
        }
      } catch (err) {
        console.warn("Could not fetch WABA ID:", err.message);
      }
    }

    if (!finalWabaId) {
      return res.status(400).json({
        message: "WhatsApp Business Account ID (WABA ID) not found. Please re-save your WhatsApp credentials with a valid access token.",
      });
    }

    // FIX: sanitize template name and store it back to DB so future syncs match
    const metaName = sanitizeTemplateName(template.name);

    // Build Meta template components
    const components = [];
    if (template.header_text) {
      components.push({ type: "HEADER", format: "TEXT", text: template.header_text });
    }
    components.push({ type: "BODY", text: template.body });
    if (template.footer_text) {
      components.push({ type: "FOOTER", text: template.footer_text });
    }

    console.log(`📝 Submitting template "${metaName}" to Meta WABA: ${finalWabaId}`);

    // Submit to Meta
    const metaRes = await axios.post(
      `${META_BASE}/${META_VERSION}/${finalWabaId}/message_templates`,
      {
        name:       metaName,
        category:   template.category,
        language:   template.language,
        components,
      },
      {
        headers: {
          Authorization:  `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // FIX: store the sanitized name back to DB so sync can match by name later
    await query(`
      UPDATE whatsapp_templates
      SET meta_status      = 'pending',
          meta_template_id = $1,
          name             = $2,
          updated_at       = NOW()
      WHERE id = $3
    `, [metaRes.data?.id?.toString(), metaName, req.params.id]);

    console.log(`✅ Template submitted: ${metaName} → ID: ${metaRes.data?.id}`);
    res.json({ success: true, metaTemplateId: metaRes.data?.id });

  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    const errCode = err.response?.data?.error?.code;
    console.error("Template submit error:", errMsg);

    // Give helpful error messages
    let userMessage = errMsg;
    if (errCode === 100) userMessage = "Invalid template format. Check your template body and variables.";
    if (errCode === 190) userMessage = "Access token expired. Please update your WhatsApp token in Settings.";
    if (errCode === 200) userMessage = "Permission denied. Make sure your token has whatsapp_business_management permission.";

    res.status(500).json({ message: userMessage });
  }
});

// Handle Meta template approval webhook
export async function handleTemplateStatusUpdate(value) {
  try {
    const { message_template_id, event } = value;
    if (!message_template_id || !event) return;

    const statusMap = {
      APPROVED: "approved",
      REJECTED: "rejected",
      PENDING:  "pending",
      DELETED:  "deleted",
    };

    const status = statusMap[event] || event.toLowerCase();

    await query(`
      UPDATE whatsapp_templates
      SET meta_status      = $1,
          rejection_reason = $2,
          updated_at       = NOW()
      WHERE meta_template_id = $3
    `, [
      status,
      value.rejection_reason || null,
      message_template_id.toString(),
    ]);

    console.log(`✅ Template ${message_template_id} status updated via webhook: ${status}`);
  } catch (err) {
    console.error("Template status update error:", err.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  CAMPAIGNS
// ══════════════════════════════════════════════════════════════

router.get("/broadcast/campaigns", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM broadcast_campaigns WHERE business_id = $1 ORDER BY created_at DESC",
      [bId(req)]
    );
    res.json({ campaigns: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load campaigns" });
  }
});

router.get("/broadcast/campaigns/:id", async (req, res) => {
  try {
    const [camp, recipients] = await Promise.all([
      query("SELECT * FROM broadcast_campaigns WHERE id = $1 AND business_id = $2",
        [req.params.id, bId(req)]),
      query("SELECT * FROM broadcast_recipients WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 100",
        [req.params.id]),
    ]);
    res.json({ campaign: camp.rows[0], recipients: recipients.rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load campaign" });
  }
});

// Create campaign
router.post("/broadcast/campaigns", async (req, res) => {
  try {
    const {
      name, message_type, template_id, message_body,
      variables_map, scheduled_at, recurring_rule,
      recurring_time, recurring_days,
      recipient_source, contact_ids, lead_filter,
    } = req.body;

    if (!name) return res.status(400).json({ message: "Campaign name required" });
    if (!message_body && !template_id) return res.status(400).json({ message: "Message required" });

    // Validate scheduled time is in business hours
    let finalScheduledAt = scheduled_at;
    if (scheduled_at) {
      // Normalize datetime — handle both "2026-06-01T17:36" and "01-06-2026 17:36" formats
      const normalized = scheduled_at.includes("T")
        ? scheduled_at
        : scheduled_at.replace(" ", "T");
      const schedDate = new Date(normalized);
      if (!isNaN(schedDate.getTime()) && !isValidSendTime(schedDate)) {
        return res.status(400).json({
          message: "Scheduled time must be between 6 AM and 11 PM IST",
        });
      }
      finalScheduledAt = isNaN(schedDate.getTime()) ? scheduled_at : schedDate.toISOString();
    }

    // Create campaign
    const { rows: campRows } = await query(`
      INSERT INTO broadcast_campaigns
        (business_id, name, message_type, template_id, message_body,
         variables_map, scheduled_at, recurring_rule, recurring_time, recurring_days,
         status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      bId(req), name,
      message_type || "session",
      template_id  || null,
      message_body || null,
      variables_map ? JSON.stringify(variables_map) : "{}",
      finalScheduledAt || null,
      recurring_rule   || null,
      recurring_time   || null,
      recurring_days   || null,
      scheduled_at ? "scheduled" : "draft",
    ]);

    const campaign = campRows[0];

    // Add recipients
    const phones = await resolveRecipients(bId(req), { recipient_source, contact_ids, lead_filter });

    for (const r of phones) {
      await query(`
        INSERT INTO broadcast_recipients
          (campaign_id, business_id, contact_id, phone, name, variables)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [campaign.id, bId(req), r.contact_id || null, r.phone, r.name || null, JSON.stringify(r.variables || {})]);
    }

    // Update total recipients
    await query(`
      UPDATE broadcast_campaigns SET total_recipients = $1 WHERE id = $2
    `, [phones.length, campaign.id]);

    res.status(201).json({ ...campaign, total_recipients: phones.length });
  } catch (err) {
    console.error("Create campaign error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Launch campaign now
router.post("/broadcast/campaigns/:id/launch", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM broadcast_campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    if (!rows.length) return res.status(404).json({ message: "Campaign not found" });

    await query("UPDATE broadcast_campaigns SET status = 'running', scheduled_at = NOW() WHERE id = $1", [req.params.id]);

    // Run async
    executeCampaign(rows[0], bId(req)).catch(console.error);

    res.json({ success: true, message: "Campaign launched" });
  } catch (err) {
    res.status(500).json({ message: "Failed to launch campaign" });
  }
});

// Pause campaign
router.post("/broadcast/campaigns/:id/pause", async (req, res) => {
  try {
    await query("UPDATE broadcast_campaigns SET status = 'paused' WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to pause" });
  }
});

// Delete campaign
router.delete("/broadcast/campaigns/:id", async (req, res) => {
  try {
    await query("DELETE FROM broadcast_campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete" });
  }
});

// ══════════════════════════════════════════════════════════════
//  CAMPAIGN EXECUTION
// ══════════════════════════════════════════════════════════════

export async function executeCampaign(campaign, businessId) {
  try {
    // Get WhatsApp config
    const { rows: wc } = await query(
      "SELECT phone_number_id, access_token FROM whatsapp_configs WHERE business_id = $1",
      [businessId]
    );
    if (!wc.length) throw new Error("WhatsApp not configured");

    const { phone_number_id, access_token } = wc[0];

    // Get pending recipients
    const { rows: recipients } = await query(`
      SELECT * FROM broadcast_recipients
      WHERE campaign_id = $1 AND status = 'pending'
      ORDER BY created_at ASC
    `, [campaign.id]);

    console.log(`📢 Broadcasting to ${recipients.length} recipients for campaign: ${campaign.name}`);

    for (const recipient of recipients) {
      // Check campaign is still running
      const { rows: campCheck } = await query(
        "SELECT status FROM broadcast_campaigns WHERE id = $1",
        [campaign.id]
      );
      if (campCheck[0]?.status !== "running") {
        console.log(`⏸️ Campaign ${campaign.name} paused/stopped`);
        break;
      }

      try {
        let result;

        if (campaign.message_type === "template" && campaign.template_id) {
          // Send template message
          result = await sendTemplateMessage({
            phoneNumberId:  phone_number_id,
            accessToken:    access_token,
            to:             recipient.phone,
            campaign,
            recipient,
          });
        } else {
          // Send session message — personalize with recipient name
          let message = campaign.message_body || "";
          message = message
            .replace(/\{\{name\}\}/gi,  recipient.name || "there")
            .replace(/\{\{phone\}\}/gi, recipient.phone)
            .replace(/\{\{notes\}\}/gi, recipient.variables?.notes || "");

          result = await sendSessionMessage({
            phoneNumberId: phone_number_id,
            accessToken:   access_token,
            to:            recipient.phone,
            message,
          });
        }

        const waMessageId = result?.messages?.[0]?.id;

        await query(`
          UPDATE broadcast_recipients
          SET status = 'sent', wa_message_id = $1, sent_at = NOW()
          WHERE id = $2
        `, [waMessageId, recipient.id]);

        await query(`
          UPDATE broadcast_campaigns
          SET sent_count = sent_count + 1, updated_at = NOW()
          WHERE id = $1
        `, [campaign.id]);

        console.log(`✅ Sent to ${recipient.phone}`);

        // Delay between messages — avoid Meta rate limits
        await sleep(1500 + Math.random() * 1000);

      } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        console.error(`❌ Failed to send to ${recipient.phone}:`, errMsg);

        await query(`
          UPDATE broadcast_recipients
          SET status = 'failed', error_message = $1
          WHERE id = $2
        `, [errMsg, recipient.id]);

        await query(`
          UPDATE broadcast_campaigns SET failed_count = failed_count + 1 WHERE id = $1
        `, [campaign.id]);
      }
    }

    // Mark completed
    await query(`
      UPDATE broadcast_campaigns
      SET status = 'completed', last_run_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [campaign.id]);

    // Schedule next run if recurring
    if (campaign.recurring_rule) {
      const nextRun = calculateNextRun(campaign);
      if (nextRun) {
        await query(`
          UPDATE broadcast_campaigns
          SET status = 'scheduled', next_run_at = $1, scheduled_at = $1
          WHERE id = $2
        `, [nextRun.toISOString(), campaign.id]);

        // Reset recipients for next run
        await query(`
          UPDATE broadcast_recipients SET status = 'pending' WHERE campaign_id = $1
        `, [campaign.id]);
      }
    }

    console.log(`✅ Campaign completed: ${campaign.name}`);

  } catch (err) {
    console.error("Campaign execution error:", err.message);
    await query(`
      UPDATE broadcast_campaigns SET status = 'failed', updated_at = NOW() WHERE id = $1
    `, [campaign.id]);
  }
}

// ── Send session message ──────────────────────────────────────
async function sendSessionMessage({ phoneNumberId, accessToken, to, message }) {
  const response = await axios.post(
    `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "text",
      text:              { body: message, preview_url: false },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

// ── Send template message ─────────────────────────────────────
async function sendTemplateMessage({ phoneNumberId, accessToken, to, campaign, recipient }) {
  const { rows: tRows } = await query(
    "SELECT * FROM whatsapp_templates WHERE id = $1",
    [campaign.template_id]
  );
  if (!tRows.length) throw new Error("Template not found");
  const template = tRows[0];

  // Build variable components
  const components = [];
  const variables  = template.variables || [];
  if (variables.length > 0) {
    const bodyParams = variables.map(varName => ({
      type: "text",
      text: recipient.variables?.[varName] || campaign.variables_map?.[varName] || "",
    }));
    components.push({ type: "body", parameters: bodyParams });
  }

  const response = await axios.post(
    `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type:     "template",
      template: {
        name:       template.name,
        language:   { code: template.language || "en" },
        components: components.length > 0 ? components : undefined,
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

// ── Resolve recipients from source ───────────────────────────
async function resolveRecipients(businessId, { recipient_source, contact_ids, lead_filter }) {
  const recipients = [];

  if (recipient_source === "contacts" || recipient_source === "all") {
    const { rows } = await query(`
      SELECT id AS contact_id, phone, name FROM business_contacts
      WHERE business_id = $1 AND opted_out = FALSE
    `, [businessId]);
    recipients.push(...rows);
  }

  if (recipient_source === "leads" || recipient_source === "all") {
    let sql    = `SELECT id AS contact_id, phone, customer_name AS name FROM leads WHERE business_id = $1`;
    const params = [businessId];
    if (lead_filter?.status) { params.push(lead_filter.status); sql += ` AND status = $${params.length}`; }
    const { rows } = await query(sql, params);
    recipients.push(...rows);
  }

  if (contact_ids?.length > 0) {
    const { rows } = await query(`
      SELECT id AS contact_id, phone, name FROM business_contacts
      WHERE business_id = $1 AND id = ANY($2) AND opted_out = FALSE
    `, [businessId, contact_ids]);
    recipients.push(...rows);
  }

  // Deduplicate by phone
  const seen    = new Set();
  const unique  = [];
  for (const r of recipients) {
    if (!seen.has(r.phone)) {
      seen.add(r.phone);
      unique.push(r);
    }
  }
  return unique;
}

// ── Calculate next recurring run ──────────────────────────────
function calculateNextRun(campaign) {
  const now  = nowIST();
  const rule = campaign.recurring_rule;
  const time = campaign.recurring_time || "10:00";
  const [h, m] = time.split(":").map(Number);

  const next = new Date(now);
  next.setUTCHours(h - 5, m - 30, 0, 0); // Convert IST to UTC

  if (rule === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (rule === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
  } else if (rule === "monthly") {
    next.setUTCMonth(next.getUTCMonth() + 1);
  } else {
    return null;
  }

  return next;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default router;