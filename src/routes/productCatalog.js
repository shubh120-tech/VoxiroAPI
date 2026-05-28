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
  const allPages  = []; // { url, title, content, images }
  let   pageCount = 0;
  const MAX_PAGES = 50;

  // Priority pages first
  const priorityPaths = [
    "/products", "/shop", "/store", "/catalog", "/collection",
    "/services", "/pricing", "/packages", "/plans",
    "/about", "/faq", "/contact",
  ];
  for (const path of priorityPaths) {
    toVisit.push(baseUrl + path);
  }

  while (toVisit.length > 0 && pageCount < MAX_PAGES) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const { data: html } = await axios.get(url, {
        timeout: 12000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; YougantBot/1.0; +https://yougant.com)" },
      });

      const $ = cheerio.load(html);

      // Remove noise elements
      $("script, style, nav, footer, header, iframe, .cookie-banner, #cookie-notice, .popup, .modal, .newsletter").remove();

      // ── Extract page content ──────────────────────────────
      const title   = $("title").text().trim();
      const h1      = $("h1").first().text().trim();

      // Try multiple content selectors
      const contentEl = $("main").length ? $("main") :
                        $("article").length ? $("article") :
                        $(".products, .product-list, .shop-grid").length ? $(".products, .product-list, .shop-grid") :
                        $(".content, #content").length ? $(".content, #content") :
                        $("body");

      const content = contentEl.text().replace(/\s+/g, " ").trim();

      // ── Extract images from this page ─────────────────────
      const images = [];
      $("img").each((_, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src");
        const alt = $(el).attr("alt") || "";
        if (!src) return;
        try {
          const absImg = new URL(src, url).href;
          // Only include product-like images (skip icons, logos, tiny images)
          const isIcon = absImg.match(/logo|icon|favicon|sprite|banner|thumb-tiny|\.svg/i);
          const hasProductHint = alt.match(/product|item|shop|buy|price|₹|\d/i) ||
                                 absImg.match(/product|item|catalog|shop|upload|media/i);
          if (!isIcon && absImg.startsWith("http") && (hasProductHint || images.length < 5)) {
            images.push({ src: absImg, alt });
          }
        } catch { /* invalid URL */ }
      });

      // ── Identify if this is a product/service page ───────
      const isProductPage = url.match(/product|item|shop|catalog|service|pricing|package/i) ||
                            content.match(/₹\s*\d|price|buy now|add to cart|order now|book now/i);

      if (content.length > 80) {
        allPages.push({
          url,
          title: title || h1 || url,
          content: content.slice(0, isProductPage ? 4000 : 2000),
          images: images.slice(0, 10),
          isProductPage: !!isProductPage,
        });
        pageCount++;
      }

      // ── Collect more links to crawl ───────────────────────
      if (pageCount < MAX_PAGES) {
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          try {
            const abs = new URL(href, url).href;
            if (
              abs.startsWith(baseUrl) &&
              !visited.has(abs) &&
              !abs.includes("#") &&
              !abs.match(/\.(pdf|zip|mp4|mp3|exe)/i) &&
              !abs.match(/login|logout|cart|checkout|account|wishlist|compare/i)
            ) {
              // Prioritize product-looking links
              if (abs.match(/product|item|shop|catalog|service|pricing|package/i)) {
                toVisit.unshift(abs); // Add to front
              } else {
                toVisit.push(abs);
              }
            }
          } catch { /* invalid URL */ }
        });
      }
    } catch (err) {
      // Skip failed pages silently
      console.log(`Crawl skip: ${url} — ${err.message}`);
    }
  }

  if (!allPages.length) {
    await query(
      "UPDATE website_crawls SET status='failed', error_message='Could not extract content from website. Make sure the URL is correct and publicly accessible.' WHERE id=$1",
      [crawlId]
    );
    return;
  }

  console.log(`🕷️ Crawled ${pageCount} pages from ${startUrl}`);

  // ── Step 1: Extract structured products with Claude ──────
  const productPages = allPages.filter(p => p.isProductPage);
  const otherPages   = allPages.filter(p => !p.isProductPage);

  const productPrompt = `You are extracting product/service catalog data from a business website.

Pages crawled:
${allPages.map(p => `
=== ${p.title} (${p.url}) ===
${p.content}
${p.images.length > 0 ? `Images found: ${p.images.map(i => `${i.src} [${i.alt}]`).join(", ")}` : ""}
`).join("\n").slice(0, 18000)}

Extract ALL products or services mentioned. Return ONLY valid JSON, no explanation, no markdown:
{
  "products": [
    {
      "name": "Product Name",
      "description": "Full description",
      "price": 999,
      "sale_price": null,
      "category": "Category name",
      "stock_status": "in_stock",
      "variants": [{"name": "Size", "options": ["S", "M", "L"]}],
      "image_url": "https://...",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- price must be a number (just digits, no ₹ or commas). null if not found.
- sale_price is the discounted price if there's an offer. null if not found.
- category: guess from context if not explicit
- stock_status: "in_stock", "out_of_stock", or "limited"
- variants: only if multiple sizes/colors/options exist
- image_url: use the most relevant image URL from the Images found lines. null if none.
- Extract every distinct product/service you can find
- If no products found, return {"products": []}`;

  let extractedProducts = [];
  try {
    const prodResponse = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages:   [{ role: "user", content: productPrompt }],
    });

    const rawJson = prodResponse.content[0]?.text?.trim() || "{}";
    const cleaned = rawJson.replace(/^```json\n?|^```\n?|\n?```$/g, "").trim();
    const parsed  = JSON.parse(cleaned);
    extractedProducts = parsed.products || [];
    console.log(`📦 Extracted ${extractedProducts.length} products`);
  } catch (err) {
    console.error("Product extraction error:", err.message);
  }

  // ── Step 2: Save products to products table ──────────────
  let savedCount = 0;
  for (const p of extractedProducts) {
    try {
      if (!p.name) continue;
      await query(`
        INSERT INTO products
          (business_id, name, description, price, sale_price, category,
           stock_status, variants, images, tags, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'website')
        ON CONFLICT DO NOTHING
      `, [
        businessId,
        p.name,
        p.description || null,
        p.price        ? parseFloat(p.price)      : null,
        p.sale_price   ? parseFloat(p.sale_price) : null,
        p.category     || null,
        p.stock_status || "in_stock",
        JSON.stringify(p.variants || []),
        JSON.stringify(p.image_url ? [p.image_url] : []),
        JSON.stringify(p.tags     || []),
      ]);
      savedCount++;
    } catch (err) {
      console.error("Product save error:", p.name, err.message);
    }
  }

  // ── Step 3: Extract general knowledge ────────────────────
  const knowledgePrompt = `You are extracting business knowledge from a website to train a WhatsApp sales agent.

Website content:
${allPages.map(p => `\n--- ${p.title} ---\n${p.content}`).join("\n").slice(0, 14000)}

Extract and structure clearly:

1. BUSINESS OVERVIEW (what they do, USPs, why choose them)
2. PRODUCTS/SERVICES SUMMARY (brief overview of what they offer with prices if found)
3. PRICING & PACKAGES (any specific plans, packages, pricing tiers)
4. POLICIES (return, refund, shipping, warranty, delivery time)
5. FAQS (common questions and answers from the site)
6. CONTACT & HOURS (address, phone, email, working hours, location)

Be concise. Focus on information a sales agent needs to answer customer questions accurately.
Skip sections where no info is found.`;

  const knowledgeResponse = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    messages:   [{ role: "user", content: knowledgePrompt }],
  });

  const knowledge = knowledgeResponse.content[0]?.text || "";

  // ── Step 4: Sync products to agent knowledge ─────────────
  await syncProductKnowledge(businessId);

  // Update agent_configs with general knowledge too
  await query(`
    UPDATE agent_configs
    SET product_knowledge = COALESCE(product_knowledge, '') || $1, updated_at = NOW()
    WHERE business_id = $2
  `, ["\n\n" + knowledge, businessId]);

  // ── Step 5: Update crawl record ──────────────────────────
  await query(`
    UPDATE website_crawls
    SET status='done', pages_crawled=$1, products_found=$2,
        knowledge_extracted=$3, crawled_at=NOW()
    WHERE id=$4
  `, [pageCount, savedCount, knowledge, crawlId]);

  console.log(`✅ Crawl complete: ${pageCount} pages, ${savedCount} products saved, business ${businessId}`);
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