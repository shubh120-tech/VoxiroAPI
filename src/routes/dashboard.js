import express      from "express";
import { query }    from "../db/postgres.js";
import { authMiddleware } from "../middleware/auth.js";
import { clearPromptCache } from "../agents/systemPrompt.js";
import multer from "multer";
import fs     from "fs";
import path   from "path";

const router = express.Router();

// ── Complaint media upload ────────────────────────────────────
const complaintStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "/tmp/complaint_media";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage: complaintStorage,
  limits: { fileSize: 16 * 1024 * 1024 },
});

// ── Public plans (no auth) ────────────────────────────────────
router.get("/plans/public", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, name, display_name, price_inr,
             message_limit, doc_limit,
             COALESCE(trial_days, 0) AS trial_days,
             features
      FROM plans
      WHERE is_active = TRUE
      ORDER BY price_inr ASC
    `);
    res.json({ plans: rows });
  } catch (err) {
    console.error("Plans fetch error:", err.message);
    res.status(500).json({ message: "Failed to load plans" });
  }
});

// ── Select plan during onboarding (auth required) ─────────────
router.post("/onboarding/select-plan", async (req, res) => {
  try {
    const bId    = req.user.business_id;
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ message: "plan_id is required" });

    const { rows: planRows } = await query(
      "SELECT * FROM plans WHERE id = $1 AND is_active = TRUE", [plan_id]
    );
    if (!planRows.length) return res.status(404).json({ message: "Plan not found" });

    const plan        = planRows[0];
    const trialDays   = parseInt(plan.trial_days) || 0;
    const now         = new Date();
    const trialEndsAt = trialDays > 0 ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000) : null;
    const billingEnd  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await query(`
      INSERT INTO subscriptions
        (business_id, plan_id, trial_ends_at, billing_cycle_end, messages_used, is_active, created_at, updated_at)
      VALUES ($1,$2,$3,$4,0,TRUE,NOW(),NOW())
      ON CONFLICT (business_id) DO UPDATE SET
        plan_id=$2, trial_ends_at=$3, billing_cycle_end=$4, messages_used=0, is_active=TRUE, updated_at=NOW()
    `, [bId, plan_id, trialEndsAt, billingEnd]);

    await query(`UPDATE agent_configs SET message_limit=$1, updated_at=NOW() WHERE business_id=$2`,
      [plan.message_limit, bId]);
    await query(`UPDATE businesses SET onboarding_completed=TRUE, updated_at=NOW() WHERE id=$1`, [bId]);

    res.json({ success:true, plan:plan.name, status:trialDays>0?"trialing":"active", trial_days:trialDays, trial_ends_at:trialEndsAt });
  } catch (err) {
    console.error("Select plan error:", err.message);
    res.status(500).json({ message: "Failed to select plan: " + err.message });
  }
});

// ── All routes below require auth ─────────────────────────────
router.use(authMiddleware);

// ── Analytics / Home ──────────────────────────────────────────
router.get("/analytics/home", async (req, res) => {
  try {
    const bId = req.user.business_id;
    const [stats, agent, usage] = await Promise.all([
      query(`SELECT * FROM today_stats WHERE business_id=$1`, [bId]),
      query(`SELECT agent_name, is_active FROM agent_configs WHERE business_id=$1`, [bId]),
      query(`SELECT s.messages_used, p.message_limit FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1`, [bId]),
    ]);
    res.json({
      messagesToday:     stats.rows[0]?.messages_today     || 0,
      leadsToday:        stats.rows[0]?.leads_today        || 0,
      ordersToday:       stats.rows[0]?.orders_today       || 0,
      appointmentsToday: stats.rows[0]?.appointments_today || 0,
      agentName:         agent.rows[0]?.agent_name         || "Aria",
      agentActive:       agent.rows[0]?.is_active          || false,
      messagesUsed:      usage.rows[0]?.messages_used      || 0,
      messageLimit:      usage.rows[0]?.message_limit      || 0,
    });
  } catch (err) { res.status(500).json({ message: "Failed to load stats" }); }
});

router.get("/analytics/usage", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT s.messages_used AS used, p.message_limit AS limit, s.billing_cycle_end
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1
    `, [req.user.business_id]);
    res.json(rows[0] || { used:0, limit:0 });
  } catch (err) { res.status(500).json({ message: "Failed to load usage" }); }
});

router.get("/analytics/activity", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { rows } = await query(`
      SELECT * FROM activity_logs WHERE business_id=$1 ORDER BY created_at DESC LIMIT $2
    `, [req.user.business_id, limit]);
    res.json({ activities: rows });
  } catch (err) { res.status(500).json({ message: "Failed to load activity" }); }
});

router.get("/analytics/dashboard", async (req, res) => {
  try {
    const bId  = req.user.business_id;
    const days = Math.min(parseInt(req.query.range) || 7, 90);

    const [todayStats, trendData, funnelData, peakHours, agentStats, planUsage, tokenUsage] = await Promise.all([
      query(`
        SELECT
          (SELECT COUNT(*) FROM messages WHERE business_id=$1 AND role='customer' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS messages_today,
          (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE business_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS conversations_today,
          (SELECT COUNT(*) FROM leads WHERE business_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS leads_today,
          (SELECT COUNT(*) FROM orders WHERE business_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS orders_today,
          (SELECT COALESCE(SUM(amount),0) FROM orders WHERE business_id=$1 AND status='confirmed' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS revenue_today,
          (SELECT COUNT(*) FROM appointments WHERE business_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS appointments_today
      `, [bId]),
      query(`
        SELECT d::date AS date, COUNT(DISTINCT c.id) AS conversations, COUNT(DISTINCT l.id) AS leads,
               COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(CASE WHEN o.status='confirmed' THEN o.amount END),0) AS revenue
        FROM generate_series((NOW() AT TIME ZONE 'Asia/Kolkata')::date-($2-1)*INTERVAL '1 day',(NOW() AT TIME ZONE 'Asia/Kolkata')::date,INTERVAL '1 day') d
        LEFT JOIN conversations c ON c.business_id=$1 AND (c.created_at AT TIME ZONE 'Asia/Kolkata')::date=d::date
        LEFT JOIN leads l ON l.business_id=$1 AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date=d::date
        LEFT JOIN orders o ON o.business_id=$1 AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date=d::date
        GROUP BY d::date ORDER BY d::date ASC
      `, [bId, days]),
      query(`
        SELECT COUNT(DISTINCT c.id) AS total_conversations, COUNT(DISTINCT l.id) AS total_leads,
               COUNT(DISTINCT o.id) AS total_orders, COUNT(DISTINCT CASE WHEN o.status='confirmed' THEN o.id END) AS confirmed_orders,
               COALESCE(SUM(CASE WHEN o.status='confirmed' THEN o.amount END),0) AS total_revenue
        FROM conversations c LEFT JOIN leads l ON l.conversation_id=c.id
        LEFT JOIN orders o ON o.business_id=c.business_id AND o.created_at>=NOW()-$2*INTERVAL '1 day'
        WHERE c.business_id=$1 AND c.created_at>=NOW()-$2*INTERVAL '1 day'
      `, [bId, days]),
      query(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*) AS messages FROM messages WHERE business_id=$1 AND role='customer' AND created_at>=NOW()-INTERVAL '30 days' GROUP BY 1 ORDER BY 1`, [bId]),
      query(`SELECT COUNT(*) FILTER(WHERE status='agent') AS agent_handled, COUNT(*) FILTER(WHERE status='manual') AS manual_handled, COUNT(*) FILTER(WHERE status='needs-help') AS needs_help, COUNT(*) AS total_convs FROM conversations WHERE business_id=$1 AND created_at>=NOW()-$2*INTERVAL '1 day'`, [bId, days]),
      query(`SELECT messages_used, message_limit FROM agent_configs WHERE business_id=$1`, [bId]),
      query(`SELECT COUNT(*) AS total_messages, COUNT(*) FILTER(WHERE role='agent') AS agent_messages, SUM(CHAR_LENGTH(content)) FILTER(WHERE role='agent') AS agent_chars FROM messages WHERE business_id=$1 AND created_at>=NOW()-$2*INTERVAL '1 day'`, [bId, days]),
    ]);

    const agentChars = parseInt(tokenUsage.rows[0]?.agent_chars) || 0;
    const estTokens  = Math.round(agentChars / 4);
    const estCostUSD = (estTokens / 1000) * 0.00025;

    res.json({
      today:  todayStats.rows[0] || {},
      trend:  trendData.rows     || [],
      funnel: funnelData.rows[0] || {},
      peaks:  peakHours.rows     || [],
      agent:  agentStats.rows[0] || {},
      usage:  planUsage.rows[0]  || {},
      tokens: { total:estTokens, messages:parseInt(tokenUsage.rows[0]?.agent_messages)||0, costUSD:estCostUSD.toFixed(4), costINR:(estCostUSD*84).toFixed(2) },
    });
  } catch (err) {
    console.error("Analytics error:", err.message);
    res.status(500).json({ message: "Failed to load analytics: " + err.message });
  }
});

// ── Leads ─────────────────────────────────────────────────────
router.get("/leads", async (req, res) => {
  try {
    const { page=1, limit=20, status, search } = req.query;
    const offset = (page-1)*limit;
    const isTeam = req.user.type === "team_member";
    let sql = `SELECT * FROM leads WHERE business_id=$1`;
    const params = [req.user.business_id];
    if (isTeam) { params.push(req.user.id); sql += ` AND conversation_id IN (SELECT id FROM conversations WHERE business_id=$1 AND assigned_to=$${params.length}::uuid)`; }
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (customer_name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
    const countSql = sql.replace("SELECT *","SELECT COUNT(*)");
    sql += ` ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0,-2))]);
    res.json({ leads:data.rows, total:parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ message:"Failed to load leads" }); }
});

router.post("/leads", async (req, res) => {
  try {
    const { customer_name, phone, product_interest, budget, intent, status, notes } = req.body;
    if (!customer_name?.trim()) return res.status(400).json({ message:"Customer name required" });
    const { rows } = await query(`INSERT INTO leads (business_id,customer_name,phone,product_interest,budget,intent,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
      [req.user.business_id, customer_name, phone||null, product_interest||null, budget||null, intent||"warm", status||"new", notes||null]);
    res.json({ success:true, id:rows[0].id });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.put("/leads/:id", async (req, res) => {
  try {
    const { customer_name, phone, product_interest, budget, intent, status, notes } = req.body;
    await query(`UPDATE leads SET customer_name=$1,phone=$2,product_interest=$3,budget=$4,intent=$5,status=$6,notes=$7,updated_at=NOW() WHERE id=$8 AND business_id=$9`,
      [customer_name, phone||null, product_interest||null, budget||null, intent, status, notes||null, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.patch("/leads/:id/status", async (req, res) => {
  try {
    await query(`UPDATE leads SET status=$1 WHERE id=$2 AND business_id=$3`, [req.body.status, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to update lead" }); }
});

router.delete("/leads/:id", async (req, res) => {
  try {
    await query("DELETE FROM leads WHERE id=$1 AND business_id=$2", [req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to delete lead" }); }
});

// ── Orders ────────────────────────────────────────────────────
router.get("/orders", async (req, res) => {
  try {
    const { page=1, limit=20, status, search } = req.query;
    const offset = (page-1)*limit;
    const isTeam = req.user.type === "team_member";
    let sql = `SELECT * FROM orders WHERE business_id=$1`;
    const params = [req.user.business_id];
    if (isTeam) { params.push(req.user.id); sql += ` AND conversation_id IN (SELECT id FROM conversations WHERE business_id=$1 AND assigned_to=$${params.length}::uuid)`; }
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length})`; }
    const countSql = sql.replace("SELECT *","SELECT COUNT(*)");
    sql += ` ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0,-2))]);
    res.json({ orders:data.rows, total:parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ message:"Failed to load orders" }); }
});

router.post("/orders", async (req, res) => {
  try {
    const { customer_name, customer_phone, items, total_amount, payment_method, delivery_address, status, notes } = req.body;
    if (!customer_name?.trim()) return res.status(400).json({ message:"Customer name required" });
    const { rows } = await query(`INSERT INTO orders (business_id,customer_name,customer_phone,items,amount,payment_method,delivery_address,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,
      [req.user.business_id, customer_name, customer_phone||null, JSON.stringify(items||[]), total_amount||null, payment_method||"COD", delivery_address||null, status||"pending", notes||null]);
    res.json({ success:true, id:rows[0].id });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.put("/orders/:id", async (req, res) => {
  try {
    const { customer_name, customer_phone, items, total_amount, payment_method, delivery_address, status, notes } = req.body;
    await query(`UPDATE orders SET customer_name=$1,customer_phone=$2,items=$3,amount=$4,payment_method=$5,delivery_address=$6,status=$7,notes=$8,updated_at=NOW() WHERE id=$9 AND business_id=$10`,
      [customer_name, customer_phone||null, JSON.stringify(items||[]), total_amount||null, payment_method||"COD", delivery_address||null, status, notes||null, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.patch("/orders/:id/status", async (req, res) => {
  try {
    await query("UPDATE orders SET status=$1 WHERE id=$2 AND business_id=$3", [req.body.status, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to update order" }); }
});

router.delete("/orders/:id", async (req, res) => {
  try {
    await query("DELETE FROM orders WHERE id=$1 AND business_id=$2", [req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to delete order" }); }
});

// ── Appointments ──────────────────────────────────────────────
router.get("/appointments", async (req, res) => {
  try {
    const { page=1, limit=20, status, date } = req.query;
    const offset = (page-1)*limit;
    const isTeam = req.user.type === "team_member";
    let sql = `SELECT * FROM appointments WHERE business_id=$1`;
    const params = [req.user.business_id];
    if (isTeam) { params.push(req.user.id); sql += ` AND conversation_id IN (SELECT id FROM conversations WHERE business_id=$1 AND assigned_to=$${params.length}::uuid)`; }
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (date)   { params.push(date);   sql += ` AND DATE(scheduled_at)=$${params.length}`; }
    const countSql = sql.replace("SELECT *","SELECT COUNT(*)");
    sql += ` ORDER BY scheduled_at ASC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const [data, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0,-2))]);
    res.json({ appointments:data.rows, total:parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ message:"Failed to load appointments" }); }
});

router.post("/appointments", async (req, res) => {
  try {
    const { customer_name, customer_phone, service, scheduled_at, status, notes } = req.body;
    if (!customer_name?.trim()) return res.status(400).json({ message:"Customer name required" });
    if (!service?.trim())       return res.status(400).json({ message:"Service required" });
    const { rows } = await query(`INSERT INTO appointments (business_id,customer_name,customer_phone,service,scheduled_at,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
      [req.user.business_id, customer_name, customer_phone||null, service, scheduled_at||null, status||"pending", notes||null]);
    res.json({ success:true, id:rows[0].id });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.put("/appointments/:id", async (req, res) => {
  try {
    const { customer_name, customer_phone, service, scheduled_at, status, notes } = req.body;
    await query(`UPDATE appointments SET customer_name=$1,customer_phone=$2,service=$3,scheduled_at=$4,status=$5,notes=$6,updated_at=NOW() WHERE id=$7 AND business_id=$8`,
      [customer_name, customer_phone||null, service, scheduled_at||null, status, notes||null, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.patch("/appointments/:id/status", async (req, res) => {
  try {
    await query("UPDATE appointments SET status=$1 WHERE id=$2 AND business_id=$3", [req.body.status, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to update appointment" }); }
});

router.delete("/appointments/:id", async (req, res) => {
  try {
    await query("DELETE FROM appointments WHERE id=$1 AND business_id=$2", [req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to delete appointment" }); }
});

// ── Agent ─────────────────────────────────────────────────────
router.get("/agent/status", async (req, res) => {
  try {
    const bId = req.user.business_id;
    const [agent, convs, msgCount] = await Promise.all([
      query("SELECT agent_name,is_active,messages_used,message_limit FROM agent_configs WHERE business_id=$1",[bId]),
      query("SELECT COUNT(*) FROM conversations WHERE business_id=$1 AND status!='closed'",[bId]),
      query(`SELECT COUNT(*) AS cnt FROM messages WHERE business_id=$1 AND role='agent' AND created_at>=date_trunc('month',NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,[bId]).catch(()=>({rows:[{cnt:0}]})),
    ]);
    let subUsed=null, subLimit=null;
    try {
      const sub = await query(`SELECT s.messages_used,p.message_limit FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1 ORDER BY s.created_at DESC LIMIT 1`,[bId]);
      if (sub.rows[0]) { subUsed=parseInt(sub.rows[0].messages_used); subLimit=parseInt(sub.rows[0].message_limit); }
    } catch {}
    const actualUsed = parseInt(msgCount.rows[0]?.cnt)||0;
    const used  = (subUsed!==null&&subUsed>0)?subUsed:actualUsed;
    const limit = (subLimit!==null&&subLimit>0)?subLimit:(parseInt(agent.rows[0]?.message_limit)||1000);
    res.json({ agentName:agent.rows[0]?.agent_name||"Aria", active:agent.rows[0]?.is_active||false, used, limit, activeConversations:parseInt(convs.rows[0]?.count)||0, unreadCount:0, notifCount:0 });
  } catch (err) { console.error("Agent status error:",err.message); res.status(500).json({ message:"Failed to load agent status" }); }
});

router.get("/agent/config", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM agent_configs WHERE business_id=$1",[req.user.business_id]);
    res.json(rows[0]||{});
  } catch (err) { res.status(500).json({ message:"Failed to load agent config" }); }
});

router.put("/agent/config", async (req, res) => {
  try {
    const { agentName, tone, language, greeting, services, pricing } = req.body;
    await query(`UPDATE agent_configs SET agent_name=$1,tone=$2,language=$3,greeting=$4,services=$5,pricing=$6,updated_at=NOW() WHERE business_id=$7`,
      [agentName, tone, language, greeting, services, pricing, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to update agent config" }); }
});

router.patch("/agent/toggle", async (req, res) => {
  try {
    await query("UPDATE agent_configs SET is_active=$1 WHERE business_id=$2",[req.body.active, req.user.business_id]);
    clearPromptCache(req.user.business_id);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to toggle agent" }); }
});

// ── Conversations ─────────────────────────────────────────────
router.get("/agent/conversations", async (req, res) => {
  try {
    const { page=1, limit=30, status } = req.query;
    const offset = (page-1)*limit;
    const bId    = req.user.business_id;
    const isTeam = req.user.type === "team_member";
    let conversationAccess = "all";
    if (isTeam) {
      const { rows: memberRows } = await query("SELECT conversation_access FROM team_members WHERE id=$1",[req.user.id]).catch(()=>({rows:[]}));
      conversationAccess = memberRows[0]?.conversation_access || "all";
    }
    let sql = `SELECT * FROM conversations WHERE business_id=$1`;
    const params = [bId];
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    if (isTeam && conversationAccess==="assigned") { params.push(req.user.id); sql += ` AND assigned_to=$${params.length}::uuid`; }
    sql += ` ORDER BY last_message_at DESC NULLS LAST LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const { rows } = await query(sql, params);
    res.json({ conversations:rows });
  } catch (err) { console.error("Conversations error:",err.message); res.status(500).json({ message:"Failed to load conversations" }); }
});

router.get("/agent/conversations/:id/messages", async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM messages WHERE conversation_id=$1 AND business_id=$2 ORDER BY created_at ASC`,[req.params.id, req.user.business_id]);
    res.json({ messages:rows });
  } catch (err) { res.status(500).json({ message:"Failed to load messages" }); }
});

router.post("/agent/conversations/:id/takeover", async (req, res) => {
  try {
    await query(`UPDATE conversations SET status='manual',takeover_at=NOW() WHERE id=$1 AND business_id=$2`,[req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to take over" }); }
});

router.post("/agent/conversations/:id/resume", async (req, res) => {
  try {
    await query(`UPDATE conversations SET status='agent',updated_at=NOW() WHERE id=$1 AND business_id=$2`,[req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to resume agent" }); }
});

router.post("/agent/conversations/:id/send", async (req, res) => {
  try {
    const { message } = req.body;
    const { rows: conv } = await query("SELECT * FROM conversations WHERE id=$1 AND business_id=$2",[req.params.id, req.user.business_id]);
    if (!conv.length) return res.status(404).json({ message:"Conversation not found" });
    await query(`INSERT INTO messages (conversation_id,business_id,role,content) VALUES ($1,$2,'owner',$3)`,[req.params.id, req.user.business_id, message]);
    const { rows: wc } = await query("SELECT phone_number_id,access_token FROM whatsapp_configs WHERE business_id=$1",[req.user.business_id]);
    if (wc.length) {
      const { sendWhatsAppMessage } = await import("../whatsapp/sender.js");
      await sendWhatsAppMessage({ phoneNumberId:wc[0].phone_number_id, accessToken:wc[0].access_token, to:conv[0].customer_phone, message });
    }
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to send message" }); }
});

// ── Settings ──────────────────────────────────────────────────
router.get("/settings", async (req, res) => {
  try {
    const bId = req.user.business_id;
    const [biz, agent, wc, notif] = await Promise.all([
      query("SELECT * FROM businesses WHERE id=$1",[bId]),
      query("SELECT agent_name,tone,language,system_prompt,messages_used,message_limit FROM agent_configs WHERE business_id=$1",[bId]),
      query("SELECT phone_number_id,whatsapp_number,is_verified,display_name,waba_id FROM whatsapp_configs WHERE business_id=$1",[bId]),
      query("SELECT * FROM notification_settings WHERE business_id=$1",[bId]).catch(()=>({rows:[]})),
    ]);
    let billing = {};
    try {
      const sub = await query(`SELECT s.*,p.name AS plan_name,p.price_inr,p.message_limit FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.business_id=$1 ORDER BY s.created_at DESC LIMIT 1`,[bId]);
      billing = sub.rows[0] || {};
    } catch {
      try {
        const plan = await query(`SELECT p.name AS plan_name,p.price_inr,p.message_limit FROM businesses b JOIN plans p ON p.id=b.plan_id WHERE b.id=$1`,[bId]);
        billing = plan.rows[0] || {};
      } catch { billing = {}; }
    }
    res.json({ profile:{...biz.rows[0], ownerName:req.user.owner_name, email:req.user.email}, agent:agent.rows[0]||{}, whatsapp:wc.rows[0]||{}, notifications:notif.rows[0]||{}, billing });
  } catch (err) { console.error("Settings load error:",err.message); res.status(500).json({ message:"Failed to load settings: "+err.message }); }
});

router.put("/settings/profile", async (req, res) => {
  try {
    const { businessName, ownerName, phone, address, website } = req.body;
    if (!businessName?.trim()) return res.status(400).json({ message:"Business name is required" });
    await Promise.all([
      query(`UPDATE businesses SET name=$1,phone=$2,address=$3,website=$4,updated_at=NOW() WHERE id=$5`,
        [businessName.trim(), phone||null, address||null, website||null, req.user.business_id]),
      ownerName ? query("UPDATE users SET owner_name=$1,updated_at=NOW() WHERE id=$2",[ownerName.trim(), req.user.id]) : Promise.resolve(),
    ]);
    res.json({ success:true });
  } catch (err) { console.error("Profile update error:",err.message); res.status(500).json({ message:"Failed to update profile: "+err.message }); }
});

router.put("/settings/whatsapp", async (req, res) => {
  try {
    const { phoneNumberId, accessToken, webhookSecret } = req.body;
    if (!phoneNumberId?.trim()) return res.status(400).json({ message:"Phone Number ID is required" });
    const { rows: existing } = await query("SELECT id FROM whatsapp_configs WHERE business_id=$1",[req.user.business_id]);
    if (existing.length > 0) {
      await query(`UPDATE whatsapp_configs SET phone_number_id=$1, access_token=CASE WHEN $2::text IS NOT NULL AND $2::text!='' THEN $2 ELSE access_token END, webhook_secret=CASE WHEN $3::text IS NOT NULL AND $3::text!='' THEN $3 ELSE webhook_secret END, updated_at=NOW() WHERE business_id=$4`,
        [phoneNumberId.trim(), accessToken||null, webhookSecret||null, req.user.business_id]);
    } else {
      await query(`INSERT INTO whatsapp_configs (business_id,phone_number_id,access_token,webhook_secret,is_verified) VALUES ($1,$2,$3,$4,FALSE)`,
        [req.user.business_id, phoneNumberId.trim(), accessToken||null, webhookSecret||null]);
    }
    res.json({ success:true });
  } catch (err) { console.error("WhatsApp config error:",err.message); res.status(500).json({ message:"Failed to update WhatsApp config: "+err.message }); }
});

router.put("/settings/notifications", async (req, res) => {
  try {
    const { whatsappAlerts, emailAlerts, needsHelpAlert, ownerNotifyNumber } = req.body;
    await query(`UPDATE notification_settings SET whatsapp_alerts=$1,email_alerts=$2,needs_help_alert=$3,owner_notify_number=$4,updated_at=NOW() WHERE business_id=$5`,
      [whatsappAlerts, emailAlerts, needsHelpAlert, ownerNotifyNumber, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to update notifications" }); }
});

router.put("/settings/password", async (req, res) => {
  try {
    const bcrypt = (await import("bcrypt")).default;
    const { currentPassword, newPassword } = req.body;
    const { rows } = await query("SELECT password_hash FROM users WHERE id=$1",[req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(400).json({ message:"Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await query("UPDATE users SET password_hash=$1 WHERE id=$2",[hash, req.user.id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to update password" }); }
});

// ── Knowledge Base ────────────────────────────────────────────
router.get("/knowledge", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM knowledge_docs WHERE business_id=$1 ORDER BY created_at DESC",[req.user.business_id]);
    res.json({ documents:rows });
  } catch (err) { res.status(500).json({ message:"Failed to load documents" }); }
});

router.delete("/knowledge/:id", async (req, res) => {
  try {
    await query("DELETE FROM knowledge_docs WHERE id=$1 AND business_id=$2",[req.params.id, req.user.business_id]);
    clearPromptCache(req.user.business_id);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to delete document" }); }
});

// ── Follow-ups ────────────────────────────────────────────────
router.get("/follow-ups", async (req, res) => {
  try {
    const isTeam = req.user.type === "team_member";
    let sql = `SELECT f.*, COALESCE(c.customer_name,f.customer_name) AS customer_name, COALESCE(c.customer_phone,f.customer_phone) AS customer_phone FROM follow_ups f LEFT JOIN conversations c ON c.id=f.conversation_id WHERE f.business_id=$1`;
    const params = [req.user.business_id];
    if (isTeam) { params.push(req.user.id); sql += ` AND c.assigned_to=$${params.length}::uuid`; }
    sql += ` ORDER BY f.scheduled_at DESC LIMIT 200`;
    const { rows } = await query(sql, params);
    res.json({ followups:rows });
  } catch (err) { console.error("Followups error:",err.message); res.status(500).json({ message:"Failed to load follow-ups" }); }
});

router.post("/followups", async (req, res) => {
  try {
    const { customer_phone, message, scheduled_at } = req.body;
    if (!customer_phone?.trim()) return res.status(400).json({ message:"Customer phone required" });
    if (!message?.trim())        return res.status(400).json({ message:"Message required" });
    const { rows } = await query(`INSERT INTO follow_ups (business_id,customer_phone,message,scheduled_at,sent,created_at) VALUES ($1,$2,$3,$4,FALSE,NOW()) RETURNING id`,
      [req.user.business_id, customer_phone, message, scheduled_at||null]);
    res.json({ success:true, id:rows[0].id });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.put("/followups/:id", async (req, res) => {
  try {
    const { customer_phone, message, scheduled_at } = req.body;
    await query(`UPDATE follow_ups SET customer_phone=$1,message=$2,scheduled_at=$3 WHERE id=$4 AND business_id=$5 AND sent=FALSE`,
      [customer_phone, message, scheduled_at||null, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.patch("/followups/:id/cancel", async (req, res) => {
  try {
    await query(`UPDATE follow_ups SET sent=TRUE,sent_at=NOW(),error_message='Cancelled manually',updated_at=NOW() WHERE id=$1 AND business_id=$2`,
      [req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to cancel" }); }
});

router.delete("/followups/:id", async (req, res) => {
  try {
    await query("DELETE FROM follow_ups WHERE id=$1 AND business_id=$2",[req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

// ── Conversation Labels ───────────────────────────────────────
router.get("/agent/conversations/:id/labels", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM conversation_labels WHERE conversation_id=$1 AND business_id=$2 ORDER BY created_at ASC",[req.params.id, req.user.business_id]);
    res.json({ labels:rows });
  } catch (err) { res.status(500).json({ message:"Failed to load labels" }); }
});

router.post("/agent/conversations/:id/labels", async (req, res) => {
  try {
    const { label_key, label_label, label_color, label_icon } = req.body;
    if (!label_key) return res.status(400).json({ message:"label_key required" });
    await query(`INSERT INTO conversation_labels (conversation_id,business_id,label_key,label_label,label_color,label_icon,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (conversation_id,label_key) DO UPDATE SET label_label=$4,label_color=$5,label_icon=$6`,
      [req.params.id, req.user.business_id, label_key, label_label, label_color, label_icon, req.user.id]);
    const { rows: allLabels } = await query("SELECT label_key,label_label,label_color,label_icon FROM conversation_labels WHERE conversation_id=$1",[req.params.id]);
    await query("UPDATE conversations SET labels=$1,updated_at=NOW() WHERE id=$2",[JSON.stringify(allLabels), req.params.id]);
    if (label_key === "follow_up") {
      const { rows: conv } = await query("SELECT customer_phone,customer_name FROM conversations WHERE id=$1",[req.params.id]);
      if (conv.length) {
        await query(`INSERT INTO follow_ups (business_id,conversation_id,customer_phone,customer_name,scheduled_at,message,sent) VALUES ($1,$2,$3,$4,NOW()+INTERVAL '24 hours','Following up on your inquiry. How can we help?',FALSE) ON CONFLICT DO NOTHING`,
          [req.user.business_id, req.params.id, conv[0].customer_phone, conv[0].customer_name]).catch(()=>{});
      }
    }
    res.json({ success:true });
  } catch (err) { console.error("Add label error:",err.message); res.status(500).json({ message:"Failed to add label: "+err.message }); }
});

router.delete("/agent/conversations/:id/labels/:key", async (req, res) => {
  try {
    await query("DELETE FROM conversation_labels WHERE conversation_id=$1 AND business_id=$2 AND label_key=$3",[req.params.id, req.user.business_id, req.params.key]);
    const { rows: allLabels } = await query("SELECT label_key,label_label,label_color,label_icon FROM conversation_labels WHERE conversation_id=$1",[req.params.id]);
    await query("UPDATE conversations SET labels=$1,updated_at=NOW() WHERE id=$2",[JSON.stringify(allLabels), req.params.id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:"Failed to remove label" }); }
});

// ── Conversation Assignment ───────────────────────────────────
router.post("/agent/conversations/:id/assign", async (req, res) => {
  try {
    const { team_member_id } = req.body;
    const bId = req.user.business_id;
    const { rows: conv } = await query("SELECT customer_name,customer_phone,last_message FROM conversations WHERE id=$1 AND business_id=$2",[req.params.id, bId]);
    if (!conv.length) return res.status(404).json({ message:"Conversation not found" });
    if (!team_member_id) {
      await query("UPDATE conversations SET assigned_to=NULL,assigned_name=NULL,updated_at=NOW() WHERE id=$1",[req.params.id]);
      return res.json({ success:true });
    }
    const { rows: member } = await query("SELECT id,name,role,whatsapp_number FROM team_members WHERE id=$1 AND business_id=$2 AND status='active'",[team_member_id, bId]);
    if (!member.length) return res.status(404).json({ message:"Team member not found" });
    await query("UPDATE conversations SET assigned_to=$1,assigned_name=$2,updated_at=NOW() WHERE id=$3",[team_member_id, member[0].name, req.params.id]);
    try {
      const { rows: wc } = await query("SELECT phone_number_id,access_token FROM whatsapp_configs WHERE business_id=$1",[bId]);
      const memberWaNumber = member[0].whatsapp_number;
      if (wc.length && memberWaNumber) {
        const { sendWhatsAppMessage } = await import("../whatsapp/sender.js");
        const cleanNumber = memberWaNumber.replace(/\s/g,"").replace(/^\+/,"").replace(/^0/,"91");
        const dashboardLink = `${process.env.FRONTEND_URL||"https://yougant.com"}/dashboard?conv=${req.params.id}`;
        await sendWhatsAppMessage({ phoneNumberId:wc[0].phone_number_id, accessToken:wc[0].access_token, to:cleanNumber, message:`👤 ${member[0].name}, you have been assigned a conversation.\n\nCustomer: ${conv[0].customer_name||conv[0].customer_phone}\nLast message: "${(conv[0].last_message||"").slice(0,100)}"\n\nOpen: ${dashboardLink}` });
      }
    } catch (notifErr) { console.error("Assignment notification error:",notifErr.message); }
    res.json({ success:true, assigned_to:team_member_id, assigned_name:member[0].name });
  } catch (err) { console.error("Assign error:",err.message); res.status(500).json({ message:"Failed to assign: "+err.message }); }
});

router.get("/agent/team-members", async (req, res) => {
  try {
    const { rows } = await query("SELECT id,name,role FROM team_members WHERE business_id=$1 AND status='active' ORDER BY name ASC",[req.user.business_id]);
    res.json({ members:rows });
  } catch (err) { res.status(500).json({ message:"Failed to load team members" }); }
});

// ── Data Deletion / Account ───────────────────────────────────
router.post("/auth/data-deletion", async (req, res) => {
  try {
    const { signed_request } = req.body;
    if (signed_request) {
      const [, payload] = signed_request.split(".");
      const data = JSON.parse(Buffer.from(payload,"base64").toString("utf8"));
      const confirmationCode = Buffer.from(`yougant_delete_${data.user_id}_${Date.now()}`).toString("base64");
      return res.json({ url:`https://yougant.com/data-deletion?code=${confirmationCode}`, confirmation:confirmationCode });
    }
    res.json({ success:true });
  } catch (err) { console.error("Data deletion callback error:",err.message); res.status(200).json({ success:true }); }
});

router.delete("/account", async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const userId     = req.user.id;
    const tables = ["messages","conversations","pending_messages","leads","orders","appointments","follow_ups","contact_list_members","contact_lists","broadcast_recipients","broadcast_campaigns","business_contacts","whatsapp_templates","knowledge_docs","business_services","business_faqs","business_payment_methods","business_company_details","training_qa","prompt_history","products","website_crawls","store_integrations","agent_configs","whatsapp_configs","notification_settings","activity_logs","oauth_states","subscriptions"];
    for (const table of tables) {
      await query(`DELETE FROM ${table} WHERE business_id=$1`,[businessId]).catch(err=>console.warn(`Skip ${table}: ${err.message}`));
    }
    await query(`UPDATE users SET is_active=FALSE,owner_name='[DELETED]',email=CONCAT('deleted_',id,'@deleted.yougant.com'),password_hash='DELETED',updated_at=NOW() WHERE id=$1`,[userId]).catch(()=>{});
    await query("DELETE FROM users WHERE business_id=$1 AND id!=$2",[businessId, userId]).catch(()=>{});
    await query(`UPDATE payment_history SET description='Account deleted' WHERE business_id=$1`,[businessId]).catch(()=>{});
    res.json({ success:true });
  } catch (err) { console.error("Account deletion error:",err.message); res.status(500).json({ message:"Failed to delete account: "+err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  COMPLAINTS
// ══════════════════════════════════════════════════════════════

router.get("/complaints", async (req, res) => {
  try {
    const { status, search } = req.query;
    let sql = `SELECT * FROM customer_complaints WHERE business_id=$1`;
    const params = [req.user.business_id];
    if (status && status !== "all") { params.push(status); sql += ` AND status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length} OR ticket_number ILIKE $${params.length} OR subject ILIKE $${params.length})`; }
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const { rows } = await query(sql, params);
    const { rows: statsRows } = await query(`SELECT status, COUNT(*) AS count FROM customer_complaints WHERE business_id=$1 GROUP BY status`,[req.user.business_id]);
    res.json({ complaints:rows, stats:Object.fromEntries(statsRows.map(s=>[s.status,parseInt(s.count)])) });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.get("/complaints/:id", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM customer_complaints WHERE id=$1 AND business_id=$2",[req.params.id, req.user.business_id]);
    if (!rows.length) return res.status(404).json({ message:"Not found" });
    res.json({ complaint:rows[0] });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.post("/complaints", async (req, res) => {
  try {
    const { customer_name, customer_phone, category, subject, description, order_reference, purchase_date, preferred_resolution, priority } = req.body;
    if (!customer_phone?.trim()) return res.status(400).json({ message:"Customer phone required" });
    if (!subject?.trim())        return res.status(400).json({ message:"Subject required" });
    if (!description?.trim())    return res.status(400).json({ message:"Description required" });

    // Use per-business INC sequence
    const { rows: seqRows } = await query("SELECT generate_ticket_number($1) AS ticket_number",[req.user.business_id]);
    const ticketNumber = seqRows[0].ticket_number;

    const { rows } = await query(`
      INSERT INTO customer_complaints
        (business_id,ticket_number,customer_name,customer_phone,category,subject,description,order_reference,purchase_date,preferred_resolution,priority,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open') RETURNING id,ticket_number
    `,[req.user.business_id, ticketNumber, customer_name||null, customer_phone, category||"other", subject, description, order_reference||null, purchase_date||null, preferred_resolution||null, priority||"medium"]);
    res.status(201).json({ success:true, id:rows[0].id, ticket_number:rows[0].ticket_number });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.put("/complaints/:id", async (req, res) => {
  try {
    const { customer_name, customer_phone, category, subject, description, order_reference, purchase_date, preferred_resolution, priority, status, resolution_notes } = req.body;
    await query(`UPDATE customer_complaints SET customer_name=$1,customer_phone=$2,category=$3,subject=$4,description=$5,order_reference=$6,purchase_date=$7,preferred_resolution=$8,priority=$9,status=$10,resolution_notes=$11,updated_at=NOW() WHERE id=$12 AND business_id=$13`,
      [customer_name||null, customer_phone, category||"other", subject, description, order_reference||null, purchase_date||null, preferred_resolution||null, priority||"medium", status||"open", resolution_notes||null, req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.patch("/complaints/:id/status", async (req, res) => {
  try {
    const { status, resolution_notes } = req.body;
    const sets = [`status=$1`, `updated_at=NOW()`];
    const params = [status];
    if (resolution_notes !== undefined) { params.push(resolution_notes); sets.push(`resolution_notes=$${params.length}`); }
    if (status === "resolved" || status === "closed") sets.push(`resolved_at=NOW()`);
    params.push(req.params.id, req.user.business_id);
    await query(`UPDATE customer_complaints SET ${sets.join(",")} WHERE id=$${params.length-1} AND business_id=$${params.length}`, params);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.delete("/complaints/:id", async (req, res) => {
  try {
    await query("DELETE FROM customer_complaints WHERE id=$1 AND business_id=$2",[req.params.id, req.user.business_id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

// ── Complaint Comments ────────────────────────────────────────
router.get("/complaints/:id/comments", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM complaint_comments WHERE complaint_id=$1 ORDER BY created_at ASC",[req.params.id]);
    res.json({ comments:rows });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.post("/complaints/:id/comments", async (req, res) => {
  try {
    const { content, attachments, author_role } = req.body;
    if (!content?.trim()) return res.status(400).json({ message:"Content required" });
    const { rows: userRows } = await query("SELECT name,type,role FROM users WHERE id=$1",[req.user.id]);
    const u          = userRows[0];
    const authorName = u?.name || "Team Member";
    const authorRole = author_role || (u?.type === "owner" ? "owner" : u?.role || "team");
    const { rows } = await query(`INSERT INTO complaint_comments (complaint_id,business_id,author_name,author_role,content,attachments) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, req.user.business_id, authorName, authorRole, content.trim(), JSON.stringify(attachments||[])]);
    await query("UPDATE customer_complaints SET updated_at=NOW() WHERE id=$1",[req.params.id]);
    res.status(201).json({ comment:rows[0] });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

router.delete("/complaints/:id/comments/:commentId", async (req, res) => {
  try {
    await query("DELETE FROM complaint_comments WHERE id=$1 AND complaint_id=$2",[req.params.commentId, req.params.id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ message:err.message }); }
});

// ── Complaint Attachments ─────────────────────────────────────
router.post("/complaints/:id/attachments", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message:"No file uploaded" });
    const BACKEND_URL = process.env.BACKEND_URL || "https://voxiroapi-production.up.railway.app";
    const publicUrl   = `${BACKEND_URL}/api/complaints/media/${req.file.filename}`;
    const fileType    = req.file.mimetype.startsWith("image/") ? "image"
                      : req.file.mimetype.startsWith("video/") ? "video"
                      : "document";
    const attachment  = { url:publicUrl, name:req.file.originalname, type:fileType, size:req.file.size };
    await query(`UPDATE customer_complaints SET attachments=COALESCE(attachments,'[]'::jsonb)||$1::jsonb,updated_at=NOW() WHERE id=$2 AND business_id=$3`,
      [JSON.stringify([attachment]), req.params.id, req.user.business_id]);
    res.json(attachment);
  } catch (err) { console.error("Complaint upload error:",err.message); res.status(500).json({ message:err.message }); }
});

router.get("/complaints/media/:filename", (req, res) => {
  const filepath = path.resolve("/tmp/complaint_media", req.params.filename);
  if (fs.existsSync(filepath)) res.sendFile(filepath);
  else res.status(404).json({ message:"File not found" });
});

export default router;