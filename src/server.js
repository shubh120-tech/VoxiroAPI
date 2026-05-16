import "dotenv/config";
import express      from "express";
import cors         from "cors";
import helmet       from "helmet";
import morgan       from "morgan";
import rateLimit    from "express-rate-limit";

// Routes
import authRouter        from "./routes/auth.js";
import dashboardRouter   from "./routes/dashboard.js";
import adminRouter       from "./routes/admin.js";
import knowledgeRouter   from "./routes/knowledge.js";
import magicLinkRouter   from "./routes/magicLink.js";
import onboardingRouter  from "./routes/onboarding.js";
import whatsappWebhook   from "./webhook/whatsapp.js";

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Trust Proxy — required for ngrok + Railway ────────────────
app.set("trust proxy", 1);
// Allow all origins including ngrok
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
// ── Security Middleware ───────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: true,
  credentials: true,
}));

// ── Rate Limiting ─────────────────────────────────────────────
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { message: "Too many requests, please try again later" },
}));

app.use("/api", rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      100,
}));

// ── Body Parsing ──────────────────────────────────────────────
// ── Webhook FIRST before body parsing ────────────────────────
app.use("/webhook", express.raw({ type: "application/json" }), (req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    req.body    = JSON.parse(req.body.toString());
  }
  next();
});

// Then import and use webhook router
app.use("/webhook", whatsappWebhook);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// ── Health Check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), service: "Voxiro Backend" });
});

// ── Routes ────────────────────────────────────────────────────
app.use("/webhook",    whatsappWebhook);
app.use("/join",       magicLinkRouter);
app.use("/api/auth",   authRouter);
app.use("/api",        dashboardRouter);
app.use("/api",        knowledgeRouter);
app.use("/api",        onboardingRouter);
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
  console.log(`\n🚀 Voxiro Backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Health:      http://localhost:${PORT}/health\n`);
});

export default app;