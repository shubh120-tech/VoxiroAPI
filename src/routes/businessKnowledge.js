import express from "express";
import { query } from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();
router.use(authMiddleware);

const bId = (req) => req.user.business_id;

// ══════════════════════════════════════════════════════════════
//  SERVICES & PRICING
// ══════════════════════════════════════════════════════════════

router.get("/knowledge/services", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM business_services
      WHERE business_id = $1
      ORDER BY sort_order ASC, name ASC
    `, [bId(req)]);
    res.json({ services: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load services" });
  }
});

router.post("/knowledge/services", async (req, res) => {
  try {
    const { name, description, price, price_min, price_max, price_unit, duration } = req.body;
    if (!name) return res.status(400).json({ message: "Service name is required" });

    const { rows } = await query(`
      INSERT INTO business_services
        (business_id, name, description, price, price_min, price_max, price_unit, duration)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [bId(req), name, description, price, price_min, price_max, price_unit || "fixed", duration]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to create service" });
  }
});

router.put("/knowledge/services/:id", async (req, res) => {
  try {
    const { name, description, price, price_min, price_max, price_unit, duration, is_active } = req.body;
    const { rows } = await query(`
      UPDATE business_services
      SET name = $1, description = $2, price = $3, price_min = $4,
          price_max = $5, price_unit = $6, duration = $7,
          is_active = $8, updated_at = NOW()
      WHERE id = $9 AND business_id = $10
      RETURNING *
    `, [name, description, price, price_min, price_max, price_unit, duration, is_active, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to update service" });
  }
});

router.delete("/knowledge/services/:id", async (req, res) => {
  try {
    await query("DELETE FROM business_services WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete service" });
  }
});

// ══════════════════════════════════════════════════════════════
//  FAQ
// ══════════════════════════════════════════════════════════════

router.get("/knowledge/faqs", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM business_faqs
      WHERE business_id = $1
      ORDER BY category ASC, sort_order ASC
    `, [bId(req)]);
    res.json({ faqs: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load FAQs" });
  }
});

router.post("/knowledge/faqs", async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer) return res.status(400).json({ message: "Question and answer required" });
    const { rows } = await query(`
      INSERT INTO business_faqs (business_id, question, answer, category)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [bId(req), question, answer, category || "general"]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to create FAQ" });
  }
});

router.put("/knowledge/faqs/:id", async (req, res) => {
  try {
    const { question, answer, category, is_active } = req.body;
    const { rows } = await query(`
      UPDATE business_faqs
      SET question = $1, answer = $2, category = $3, is_active = $4, updated_at = NOW()
      WHERE id = $5 AND business_id = $6
      RETURNING *
    `, [question, answer, category, is_active, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to update FAQ" });
  }
});

router.delete("/knowledge/faqs/:id", async (req, res) => {
  try {
    await query("DELETE FROM business_faqs WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete FAQ" });
  }
});

// ══════════════════════════════════════════════════════════════
//  PAYMENT DETAILS
// ══════════════════════════════════════════════════════════════

router.get("/knowledge/payment", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM business_payment_details
      WHERE business_id = $1
      ORDER BY is_primary DESC, created_at ASC
    `, [bId(req)]);
    res.json({ paymentMethods: rows });
  } catch (err) {
    res.status(500).json({ message: "Failed to load payment details" });
  }
});

router.post("/knowledge/payment", async (req, res) => {
  try {
    const { method_name, details, instructions, is_primary } = req.body;
    if (!method_name || !details) return res.status(400).json({ message: "Method name and details required" });

    // If setting as primary, unset others
    if (is_primary) {
      await query("UPDATE business_payment_details SET is_primary = FALSE WHERE business_id = $1", [bId(req)]);
    }

    const { rows } = await query(`
      INSERT INTO business_payment_details (business_id, method_name, details, instructions, is_primary)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [bId(req), method_name, details, instructions, is_primary || false]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to create payment method" });
  }
});

router.put("/knowledge/payment/:id", async (req, res) => {
  try {
    const { method_name, details, instructions, is_primary, is_active } = req.body;
    if (is_primary) {
      await query("UPDATE business_payment_details SET is_primary = FALSE WHERE business_id = $1", [bId(req)]);
    }
    const { rows } = await query(`
      UPDATE business_payment_details
      SET method_name = $1, details = $2, instructions = $3,
          is_primary = $4, is_active = $5, updated_at = NOW()
      WHERE id = $6 AND business_id = $7
      RETURNING *
    `, [method_name, details, instructions, is_primary, is_active, req.params.id, bId(req)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Failed to update payment method" });
  }
});

router.delete("/knowledge/payment/:id", async (req, res) => {
  try {
    await query("DELETE FROM business_payment_details WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete payment method" });
  }
});

// ══════════════════════════════════════════════════════════════
//  COMPANY DETAILS
// ══════════════════════════════════════════════════════════════

router.get("/knowledge/company", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM business_company_details WHERE business_id = $1",
      [bId(req)]
    );
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ message: "Failed to load company details" });
  }
});

router.put("/knowledge/company", async (req, res) => {
  try {
    const { gst_number, registration_no, founded_year, team_size,
            total_clients, certifications, social_links, trust_message } = req.body;

    await query(`
      INSERT INTO business_company_details
        (business_id, gst_number, registration_no, founded_year, team_size,
         total_clients, certifications, social_links, trust_message)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (business_id) DO UPDATE
      SET gst_number      = $2,
          registration_no = $3,
          founded_year    = $4,
          team_size       = $5,
          total_clients   = $6,
          certifications  = $7,
          social_links    = $8,
          trust_message   = $9,
          updated_at      = NOW()
    `, [bId(req), gst_number, registration_no, founded_year, team_size,
        total_clients, certifications, social_links || {}, trust_message]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update company details" });
  }
});

export default router;