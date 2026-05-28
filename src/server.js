import "dotenv/config";
import express      from "express";
import cors         from "cors";
import helmet       from "helmet";
import morgan       from "morgan";
import rateLimit    from "express-rate-limit";
import { processFollowUps }  from "./agents/followUpCron.js";
import { processBroadcasts } from "./agents/broadcastCron.js";
import { processStoreSyncs }  from "./agents/storeSyncCron.js";
import { processMessageBatches } from "./agents/messageBatchCron.js";

// Routes
import authRouter        from "./routes/auth.js";
import dashboardRouter   from "./routes/dashboard.js";
import adminRouter       from "./routes/admin.js";
import knowledgeRouter   from "./routes/knowledge.js";
import magicLinkRouter   from "./routes/magicLink.js";
import onboardingRouter  from "./routes/onboarding.js";
import broadcastRouter   from "./routes/broadcast.js";
import teamRouter        from "./routes/team.js";
import storeRouter       from "./routes/storeIntegration.js";
import trainingRouter    from "./routes/agentTraining.js";
import catalogRouter     from "./routes/productCatalog.js";
import shopifyOAuthRouter from "./routes/shopifyOAuth.js";
import whatsappWebhook   from "./webhook/whatsapp.js";

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Trust Proxy ───────────────────────────────────────────────
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Security ──────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

// ── Rate Limiting ─────────────────────────────────────────────
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { message: "Too many requests, please try again later" },
}));

app.use("/api", rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      200,
}));

// ── Health Check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), service: "Yougant Backend" });
});

// ── WhatsApp Webhook ──────────────────────────────────────────
app.use("/webhook", express.raw({ type: "*/*" }), (req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try { req.body = JSON.parse(req.body.toString()); }
    catch { req.body = {}; }
  }
  next();
});
app.use("/webhook", whatsappWebhook);

// ── Body Parsing ──────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// ── Routes ────────────────────────────────────────────────────
app.use("/join",       magicLinkRouter);
app.use("/api/auth",   authRouter);

// Public routes FIRST — must not be intercepted by dashboardRouter auth
app.use("/api",        teamRouter);        // invite routes
app.use("/api",        shopifyOAuthRouter); // shopify OAuth callback

// Protected routes — require auth
app.use("/api",        dashboardRouter);
app.use("/api",        knowledgeRouter);
app.use("/api",        onboardingRouter);
app.use("/api",        broadcastRouter);
app.use("/api",        storeRouter);
app.use("/api",        trainingRouter);
app.use("/api",        catalogRouter);
app.use("/api",        shopifyOAuthRouter);
app.use("/api/admin",  adminRouter);

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found` });
});

// ── Error Handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal server error" });
});

// ── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Yougant Backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Health:      http://localhost:${PORT}/health\n`);

  // ── Follow-up Cron — every 5 minutes ───────────────────────
  console.log("⏰ Follow-up scheduler started — runs every 5 minutes");
  processFollowUps();
  setInterval(processFollowUps, 5 * 60 * 1000);

  // ── Broadcast Cron — every 5 minutes ─────────────────────────
  console.log("📢 Broadcast scheduler started — runs every 5 minutes");
  processBroadcasts();
  setInterval(processBroadcasts, 5 * 60 * 1000);

  // ── Store Sync Cron — every 6 hours ──────────────────────────
  console.log("🛍️  Store sync started — runs every 6 hours");
  processStoreSyncs();
  setInterval(processStoreSyncs, 6 * 60 * 60 * 1000);

  // ── Message Batch Cron — every 3 seconds ──────────────────────
  // Collects messages in 10 second window then sends combined reply
  console.log("📦 Message batch processor started — runs every 3 seconds");
  setInterval(processMessageBatches, 3 * 1000);
});

export default app;