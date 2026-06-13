import "dotenv/config";
import express      from "express";
import fs           from "fs";
import path         from "path";
import cors         from "cors";
import helmet       from "helmet";
import morgan       from "morgan";
import rateLimit    from "express-rate-limit";
import axios        from "axios";
import { query }          from "./db/postgres.js";
import { processFollowUps }      from "./agents/followUpCron.js";
import { processBroadcasts }     from "./agents/broadcastCron.js";
import { processStoreSyncs }     from "./agents/storeSyncCron.js";
import { processMessageBatches } from "./agents/messageBatchCron.js";

// Routes
import authRouter          from "./routes/auth.js";
import dashboardRouter     from "./routes/dashboard.js";
import adminRouter         from "./routes/admin.js";
import knowledgeRouter     from "./routes/knowledge.js";
import magicLinkRouter     from "./routes/magicLink.js";
import onboardingRouter    from "./routes/onboarding.js";
import broadcastRouter     from "./routes/broadcast.js";
import teamRouter          from "./routes/team.js";
import storeRouter         from "./routes/storeIntegration.js";
import trainingRouter      from "./routes/agentTraining.js";
import catalogRouter       from "./routes/productCatalog.js";
import shopifyOAuthRouter  from "./routes/shopifyOAuth.js";
import whatsappWebhook     from "./webhook/whatsapp.js";
import bizKnowledgeRouter  from "./routes/businessKnowledge.js";
import billingRouter       from "./routes/billing.js";
import agentBehaviorRouter from "./routes/agentBehavior.js";
import { startEscalationCron } from "./crons/escalationCron.js";
import reportsRouter       from "./routes/reports.js";
import supportRouter       from "./routes/support.js";

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Trust Proxy ───────────────────────────────────────────────
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://yougant.com",
  "https://www.yougant.com",
  process.env.FRONTEND_URL,
  process.env.NODE_ENV !== "production" ? "http://localhost:5173" : null,
  process.env.NODE_ENV !== "production" ? "http://localhost:3000" : null,
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Vary", "Origin");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Security ──────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

// ── Rate Limiting ─────────────────────────────────────────────
app.use("/api/auth", rateLimit({ windowMs:15*60*1000, max:20, message:{ message:"Too many requests, please try again later" } }));
app.use("/api",      rateLimit({ windowMs:1*60*1000,  max:200 }));

// ── Health Check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status:"ok", timestamp:new Date().toISOString(), service:"Yougant Backend" });
});

// ── WhatsApp Webhook ──────────────────────────────────────────
app.use("/webhook", express.raw({ type:"*/*" }), (req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try { req.body = JSON.parse(req.body.toString()); } catch { req.body = {}; }
  }
  next();
});
app.use("/webhook", whatsappWebhook);

app.use("/api/store/shopify/webhook", express.raw({ type:"application/json" }), (req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) { req.rawBody = req.body; req.body = JSON.parse(req.body.toString()); }
  next();
});
app.use("/api/store/shopify/gdpr", express.raw({ type:"application/json" }), (req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) { req.rawBody = req.body; req.body = JSON.parse(req.body.toString()); }
  next();
});

// ── Body Parsing ──────────────────────────────────────────────
app.use(express.json({ limit:"10mb" }));
app.use(express.urlencoded({ extended:true }));

// ── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — no auth, registered before everything else
// ══════════════════════════════════════════════════════════════

// ── Public: WhatsApp media proxy ──────────────────────────────
app.get("/api/media/:messageId", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT m.media_url, m.media_type, m.media_filename, c.business_id
      FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1
    `, [req.params.messageId]);
    if (!rows.length) return res.status(404).json({ message:"Message not found" });
    const msg = rows[0];
    if (msg.media_url && !msg.media_url.startsWith("meta_media_id:")) return res.redirect(msg.media_url);
    if (msg.media_url?.startsWith("meta_media_id:")) {
      const metaMediaId = msg.media_url.replace("meta_media_id:","");
      const { rows: wc } = await query("SELECT access_token FROM whatsapp_configs WHERE business_id=$1",[msg.business_id]);
      if (!wc.length || !wc[0].access_token) return res.status(503).json({ message:"WhatsApp not configured" });
      const META_VERSION = process.env.META_API_VERSION || "v19.0";
      const metaRes  = await axios.get(`https://graph.facebook.com/${META_VERSION}/${metaMediaId}`,{ headers:{ Authorization:`Bearer ${wc[0].access_token}` } });
      const freshUrl = metaRes.data?.url;
      if (!freshUrl) return res.status(410).json({ message:"Media expired" });
      const fileRes = await axios.get(freshUrl,{ responseType:"stream", headers:{ Authorization:`Bearer ${wc[0].access_token}` } });
      const contentType = fileRes.headers["content-type"] || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control","private, max-age=300");
      if (msg.media_filename) {
        const disposition = contentType.startsWith("image/") ? "inline" : "attachment";
        res.setHeader("Content-Disposition",`${disposition}; filename="${msg.media_filename}"`);
      }
      return fileRes.data.pipe(res);
    }
    res.status(404).json({ message:"No media available" });
  } catch (err) { console.error("Media proxy error:",err.message); res.status(500).json({ message:"Failed to load media" }); }
});

// ── Public: Broadcast media ───────────────────────────────────
app.get("/api/broadcast/media/:filename", (req, res) => {
  const filePath = path.resolve("/tmp/broadcast_media", req.params.filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️ Broadcast media not found: ${filePath}`);
    return res.status(404).json({ message:"File not found" });
  }
  res.sendFile(filePath);
});

// ── Public: Complaint media ───────────────────────────────────
app.get("/api/complaints/media/:filename", (req, res) => {
  const filePath = path.resolve("/tmp/complaint_media", req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ message:"File not found" });
  res.sendFile(filePath);
});

// ── Public: Customer complaint status lookup (no login needed) ─
app.get("/api/public/complaint/:ticketNumber", async (req, res) => {
  try {
    const ticket = req.params.ticketNumber.toUpperCase().trim();
    if (!ticket.startsWith("INC-")) {
      return res.status(400).json({ message:"Invalid ticket number. Format is INC-00001" });
    }
    const { rows } = await query(`
      SELECT ticket_number, subject, description, category, priority,
             status, order_reference, preferred_resolution,
             resolution_notes, attachments, created_at, updated_at, resolved_at
      FROM customer_complaints WHERE ticket_number = $1
    `, [ticket]);
    if (!rows.length) return res.status(404).json({ message:`Ticket ${ticket} not found. Please check the number.` });
    res.json({ ticket:rows[0] });
  } catch (err) {
    console.error("Public complaint lookup error:", err.message);
    res.status(500).json({ message:"Something went wrong. Please try again." });
  }
});

// ══════════════════════════════════════════════════════════════
//  PROTECTED ROUTES
// ══════════════════════════════════════════════════════════════
app.use("/join",      magicLinkRouter);
app.use("/api/auth",  authRouter);
app.use("/api",       teamRouter);
app.use("/api",       shopifyOAuthRouter);
app.use("/api/admin", adminRouter);
app.use("/api",       billingRouter);
app.use("/api",       dashboardRouter);
app.use("/api",       knowledgeRouter);
app.use("/api",       onboardingRouter);
app.use("/api",       broadcastRouter);
app.use("/api",       storeRouter);
app.use("/api",       trainingRouter);
app.use("/api",       bizKnowledgeRouter);
app.use("/api",       catalogRouter);
app.use("/api",       agentBehaviorRouter);
app.use("/api",       reportsRouter);
app.use("/api/support", supportRouter);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message:`Route ${req.method} ${req.path} not found` });
});

// ── Error Handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message:"Internal server error" });
});

// ── Crons ─────────────────────────────────────────────────────
import("./crons/storeSyncCron.js").catch(e=>console.warn("storeSyncCron:",e.message));
import("./crons/insightsCron.js").catch(e=>console.warn("insightsCron:",e.message));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Yougant Backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV||"development"}`);
  console.log(`   Health:      http://localhost:${PORT}/health\n`);

  console.log("⏰ Follow-up scheduler started — runs every 5 minutes");
  processFollowUps();
  setInterval(processFollowUps, 5*60*1000);

  console.log("📢 Broadcast scheduler started — runs every 5 minutes");
  processBroadcasts();
  setInterval(processBroadcasts, 5*60*1000);

  console.log("🛍️  Store sync started — runs every 6 hours");
  processStoreSyncs();
  setInterval(processStoreSyncs, 6*60*60*1000);

  console.log("📦 Message batch processor started — runs every 3 seconds");
  setInterval(processMessageBatches, 3*1000);

  console.log("🚨 Escalation cron started");
  startEscalationCron();
});

export default app;