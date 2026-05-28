import express       from "express";
import axios         from "axios";
import * as cheerio  from "cheerio";
import Anthropic     from "@anthropic-ai/sdk";
import { query }     from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";

const router    = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(authMiddleware);
const bId = (req) => req.user.business_id;

// ── GET all products ────────────────────────────────────────
router.get("/products", async (req, res) => {
  try {
    const { category, search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = "WHERE business_id = $1 AND is_active = TRUE";
    const params = [bId(req)];

    if (category) {
      params.push(category);
      whereClause += ` AND category = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }

    const { rows: products } = await query(`
      SELECT * FROM products ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM products ${whereClause}`, params
    );

    const { rows: categories } = await query(`
      SELECT DISTINCT category FROM products
      WHERE business_id = $1 AND is_active = TRUE AND category IS NOT NULL
      ORDER BY category
    `, [bId(req)]);

    res.json({
      products,
      total: parseInt(countRows[0].count),
      categories: categories.map(c => c.category),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET single product ──────────────────────────────────────
router.get("/products/:id", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM products WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    if (!rows.length) return res.status(404).json({ message: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── CREATE product ──────────────────────────────────────────
router.post("/products", async (req, res) => {
  try {
    const {
      name, description, price, sale_price, category,
      sku, stock_status, stock_qty, variants, images, tags,
    } = req.body;

    if (!name) return res.status(400).json({ message: "Product name is required" });

    const { rows } = await query(`
      INSERT INTO products
        (business_id, name, description, price, sale_price, category,
         sku, stock_status, stock_qty, variants, images, tags, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual')
      RETURNING *
    `, [
      bId(req), name, description, price || null, sale_price || null,
      category, sku, stock_status || "in_stock", stock_qty || null,
      JSON.stringify(variants || []),
      JSON.stringify(images || []),
      JSON.stringify(tags || []),
    ]);

    await syncProductKnowledge(bId(req));
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── UPDATE product ──────────────────────────────────────────
router.put("/products/:id", async (req, res) => {
  try {
    const {
      name, description, price, sale_price, category,
      sku, stock_status, stock_qty, variants, images, tags, is_active,
    } = req.body;

    const { rows } = await query(`
      UPDATE products SET
        name         = COALESCE($3, name),
        description  = COALESCE($4, description),
        price        = COALESCE($5, price),
        sale_price   = COALESCE($6, sale_price),
        category     = COALESCE($7, category),
        sku          = COALESCE($8, sku),
        stock_status = COALESCE($9, stock_status),
        stock_qty    = COALESCE($10, stock_qty),
        variants     = COALESCE($11::jsonb, variants),
        images       = COALESCE($12::jsonb, images),
        tags         = COALESCE($13::jsonb, tags),
        is_active    = COALESCE($14, is_active),
        updated_at   = NOW()
      WHERE id = $1 AND business_id = $2
      RETURNING *
    `, [
      req.params.id, bId(req), name, description, price, sale_price,
      category, sku, stock_status, stock_qty,
      variants ? JSON.stringify(variants) : null,
      images   ? JSON.stringify(images)   : null,
      tags     ? JSON.stringify(tags)     : null,
      is_active,
    ]);

    if (!rows.length) return res.status(404).json({ message: "Product not found" });
    await syncProductKnowledge(bId(req));
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── DELETE product ──────────────────────────────────────────
router.delete("/products/:id", async (req, res) => {
  try {
    await query(
      "UPDATE products SET is_active = FALSE WHERE id = $1 AND business_id = $2",
      [req.params.id, bId(req)]
    );
    await syncProductKnowledge(bId(req));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── CSV IMPORT ──────────────────────────────────────────────
router.post("/products/import/csv", async (req, res) => {
  try {
    const { csvData } = req.body;
    if (!csvData) return res.status(400).json({ message: "No CSV data provided" });

    // Parse CSV — handle both comma and tab separated
    const lines  = csvData.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, "_"));

    const getCol = (row, ...names) => {
      for (const name of names) {
        const idx = headers.findIndex(h => h.includes(name));
        if (idx >= 0 && row[idx]) return row[idx].trim().replace(/^"|"$/g, "");
      }
      return null;
    };

    const products = [];
    const errors   = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      // Handle quoted CSV values
      const row = lines[i].match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g)?.map(v => v.trim()) || lines[i].split(",");

      const name = getCol(row, "name", "product", "title", "item");
      if (!name) { errors.push(`Row ${i + 1}: missing product name`); continue; }

      const priceRaw = getCol(row, "price", "amount", "cost", "rate", "mrp");
      const price    = priceRaw ? parseFloat(priceRaw.replace(/[^0-9.]/g, "")) : null;

      products.push({
        business_id:  bId(req),
        name,
        description:  getCol(row, "description", "desc", "detail", "about"),
        price:        isNaN(price) ? null : price,
        sale_price:   null,
        category:     getCol(row, "category", "type", "dept", "group"),
        sku:          getCol(row, "sku", "code", "id", "product_id"),
        stock_status: getCol(row, "stock", "availability", "available")?.toLowerCase().includes("out") ? "out_of_stock" : "in_stock",
        stock_qty:    parseInt(getCol(row, "qty", "quantity", "stock_qty")) || null,
        variants:     "[]",
        images:       "[]",
        tags:         "[]",
        source:       "csv",
      });
    }

    if (!products.length) return res.status(400).json({ message: "No valid products found in CSV", errors });

    // Bulk insert
    let inserted = 0;
    for (const p of products) {
      await query(`
        INSERT INTO products
          (business_id, name, description, price, sale_price, category,
           sku, stock_status, stock_qty, variants, images, tags, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT DO NOTHING
      `, [
        p.business_id, p.name, p.description, p.price, p.sale_price,
        p.category, p.sku, p.stock_status, p.stock_qty,
        p.variants, p.images, p.tags, p.source,
      ]);
      inserted++;
    }

    await syncProductKnowledge(bId(req));
    res.json({ success: true, inserted, errors, total: products.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── WEBSITE CRAWL ───────────────────────────────────────────
router.post("/products/crawl/website", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: "URL is required" });

    // Validate URL
    let crawlUrl;
    try {
      crawlUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
    } catch {
      return res.status(400).json({ message: "Invalid URL" });
    }

    // Create crawl record
    const { rows: crawlRows } = await query(`
      INSERT INTO website_crawls (business_id, url, status)
      VALUES ($1, $2, 'crawling')
      RETURNING id
    `, [bId(req), crawlUrl.href]);

    const crawlId = crawlRows[0].id;

    // Run crawl async — respond immediately
    res.json({ success: true, crawlId, message: "Crawl started — usually takes 30-60 seconds" });

    // Run in background
    runCrawl(crawlId, bId(req), crawlUrl.href).catch(err => {
      console.error("Crawl error:", err.message);
      query("UPDATE website_crawls SET status='failed', error_message=$1 WHERE id=$2",
        [err.message, crawlId]).catch(() => {});
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET crawl status ────────────────────────────────────────
router.get("/products/crawl/:id", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM website_crawls WHERE id=$1 AND business_id=$2",
      [req.params.id, bId(req)]
    );
    if (!rows.length) return res.status(404).json({ message: "Crawl not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET crawl history ───────────────────────────────────────
router.get("/products/crawl/history/list", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, url, status, pages_crawled, products_found, error_message, crawled_at, created_at
      FROM website_crawls WHERE business_id=$1
      ORDER BY created_at DESC LIMIT 10
    `, [bId(req)]);
    res.json({ crawls: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── BACKGROUND CRAWL FUNCTION ───────────────────────────────
async function runCrawl(crawlId, businessId, startUrl) {
  const baseUrl   = new URL(startUrl).origin;
  const visited   = new Set();
  const toVisit   = [startUrl];
  const allText   = [];
  let   pageCount = 0;

  // Priority pages to also try
  const priorityPaths = ["/products", "/shop", "/services", "/about", "/faq", "/pricing", "/catalog", "/store"];
  for (const path of priorityPaths) {
    toVisit.push(baseUrl + path);
  }

  while (toVisit.length > 0 && pageCount < 20) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const { data: html } = await axios.get(url, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; YougantBot/1.0)" },
      });

      const $ = cheerio.load(html);

      // Remove noise
      $("script, style, nav, footer, header, iframe, .cookie-banner, #cookie-notice").remove();

      // Extract page title + content
      const title   = $("title").text().trim();
      const h1      = $("h1").first().text().trim();
      const content = $("main, article, .content, .products, .services, body").text()
        .replace(/\s+/g, " ").trim().slice(0, 3000);

      if (content.length > 100) {
        allText.push(`--- PAGE: ${title || url} ---\n${h1 ? "H1: " + h1 + "\n" : ""}${content}`);
        pageCount++;
      }

      // Find more relevant links on this domain
      if (pageCount < 15) {
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          try {
            const abs = new URL(href, url).href;
            if (abs.startsWith(baseUrl) && !visited.has(abs) && !abs.includes("#") && !abs.match(/\.(pdf|jpg|png|zip)/i)) {
              toVisit.push(abs);
            }
          } catch { /* invalid URL */ }
        });
      }
    } catch (err) {
      // Skip failed pages silently
    }
  }

  if (!allText.length) {
    await query(
      "UPDATE website_crawls SET status='failed', error_message='Could not extract content from website' WHERE id=$1",
      [crawlId]
    );
    return;
  }

  // Use Claude to extract structured knowledge
  const prompt = `You are extracting business knowledge from a website to train a WhatsApp sales agent.

Website content:
${allText.join("\n\n").slice(0, 12000)}

Extract and structure the following information in a clear format:

1. BUSINESS OVERVIEW (what the business does, USPs)
2. PRODUCTS/SERVICES (name, description, price if mentioned, variants if any)
3. PRICING (any pricing info, packages, plans)
4. POLICIES (return policy, shipping, delivery, warranty)
5. FAQS (common questions and answers found on site)
6. CONTACT & HOURS (address, phone, email, working hours)

Format each section clearly. If information is not found, skip that section.
Be concise but comprehensive. Focus on information useful for a sales agent answering customer questions.`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages:   [{ role: "user", content: prompt }],
  });

  const knowledge = response.content[0]?.text || "";

  // Count products mentioned
  const productMatches = knowledge.match(/\d+\.\s+\*\*[^*]+\*\*/g)?.length || 0;

  // Save to knowledge base
  await query(`
    UPDATE agent_configs
    SET product_knowledge = $1, updated_at = NOW()
    WHERE business_id = $2
  `, [knowledge, businessId]);

  // Update crawl record
  await query(`
    UPDATE website_crawls
    SET status='done', pages_crawled=$1, products_found=$2,
        knowledge_extracted=$3, crawled_at=NOW()
    WHERE id=$4
  `, [pageCount, productMatches, knowledge, crawlId]);

  console.log(`✅ Crawl done: ${pageCount} pages, business ${businessId}`);
}

// ── SYNC all products to agent knowledge ────────────────────
async function syncProductKnowledge(businessId) {
  try {
    const { rows: products } = await query(`
      SELECT name, description, price, sale_price, category,
             stock_status, stock_qty, variants
      FROM products
      WHERE business_id = $1 AND is_active = TRUE
      ORDER BY category, name
    `, [businessId]);

    if (!products.length) return;

    // Build product knowledge text
    const lines = ["PRODUCT CATALOG:\n"];
    let   currentCat = null;

    for (const p of products) {
      if (p.category && p.category !== currentCat) {
        currentCat = p.category;
        lines.push(`\n[${currentCat.toUpperCase()}]`);
      }

      let line = `• ${p.name}`;
      if (p.price)      line += ` — ₹${p.price}`;
      if (p.sale_price) line += ` (Sale: ₹${p.sale_price})`;
      if (p.stock_status === "out_of_stock") line += " [OUT OF STOCK]";
      if (p.stock_status === "limited")      line += " [LIMITED STOCK]";
      if (p.description) line += `\n  ${p.description.slice(0, 150)}`;

      const variants = typeof p.variants === "string" ? JSON.parse(p.variants) : p.variants;
      if (variants?.length) {
        for (const v of variants) {
          line += `\n  ${v.name}: ${v.options?.join(", ")}`;
        }
      }

      lines.push(line);
    }

    const knowledge = lines.join("\n");

    await query(`
      UPDATE agent_configs
      SET product_knowledge = $1, updated_at = NOW()
      WHERE business_id = $2
    `, [knowledge, businessId]);

  } catch (err) {
    console.error("syncProductKnowledge error:", err.message);
  }
}

export default router;
export { syncProductKnowledge };