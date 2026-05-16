# Voxiro Backend

> Node.js backend powering the Voxiro AI WhatsApp Agent Platform.
> Built around Claude Managed Agents — one dedicated agent per customer per business.

---

## 🚀 Quick Start

```bash
cd voxiro-backend
npm install
cp .env.example .env
# Fill in your .env values
npm run dev
```

Server runs on http://localhost:5000

---

## 🗄️ Database Setup

Run schemas in this order:

```bash
psql -U postgres -d voxiro -f ../voxiro_schema.sql
psql -U postgres -d voxiro -f ../voxiro_admin_schema.sql
psql -U postgres -d voxiro -f agent_sessions_schema.sql
```

---

## 📁 Project Structure

```
src/
├── server.js              → Express entry point
├── webhook/
│   └── whatsapp.js        → Receive WhatsApp messages from Meta
├── agents/
│   ├── agentManager.js    → Core: create/resume Managed Agent sessions
│   ├── sessionStore.js    → Track sessions in PostgreSQL
│   ├── systemPrompt.js    → Build human-like system prompt per business
│   └── tools/
│       ├── saveLead.js          → Capture leads to DB
│       ├── confirmOrder.js      → Save confirmed orders
│       ├── bookAppointment.js   → Book appointment slots
│       ├── checkAvailability.js → Check free slots
│       └── notifyOwner.js       → Send magic link to owner
├── whatsapp/
│   └── sender.js          → Send messages via Meta API + typing delay
├── db/
│   ├── postgres.js        → PostgreSQL connection pool
│   └── redis.js           → Redis client
├── middleware/
│   └── auth.js            → JWT auth for owners + admins
└── routes/
    ├── auth.js            → Login, signup, forgot password
    ├── dashboard.js       → All dashboard API endpoints
    ├── admin.js           → Superadmin portal endpoints
    ├── knowledge.js       → File upload + S3 + text extraction
    ├── magicLink.js       → Owner takeover via WhatsApp link
    └── onboarding.js      → Complete onboarding flow
```

---

## 🔌 How Claude Managed Agents Work Here

```
WhatsApp message arrives
        ↓
Find which business owns the number
        ↓
Get or create Managed Agent session for this customer
  - One session per customer per business
  - Sessions persist across conversations
  - Anthropic manages memory in /mnt/memory/
        ↓
Send message to agent session
        ↓
Agent replies with full context (never forgets)
        ↓
Agent can call tools: save_lead, book_appointment, etc.
        ↓
Reply sent back to customer via WhatsApp API
        ↓
Typing delay simulated for human feel
```

---

## 🔑 Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for business owner JWTs |
| `ADMIN_JWT_SECRET` | Separate secret for admin JWTs |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `ANTHROPIC_MODEL` | Model ID (use claude-haiku-4-5-20251001) |
| `META_APP_SECRET` | Meta app secret for webhook verification |
| `META_VERIFY_TOKEN` | Your custom webhook verify token |
| `AWS_ACCESS_KEY_ID` | AWS key for S3 uploads |
| `AWS_SECRET_ACCESS_KEY` | AWS secret |
| `AWS_S3_BUCKET` | S3 bucket name for knowledge base |
| `FRONTEND_URL` | React dashboard URL |

---

## 📡 API Endpoints

### Auth
```
POST /api/auth/signup
POST /api/auth/login
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

### Dashboard (requires JWT)
```
GET  /api/analytics/home
GET  /api/analytics/usage
GET  /api/analytics/activity
GET  /api/leads
GET  /api/orders
GET  /api/appointments
GET  /api/agent/status
GET  /api/agent/config
PUT  /api/agent/config
GET  /api/agent/conversations
GET  /api/agent/conversations/:id/messages
POST /api/agent/conversations/:id/takeover
POST /api/agent/conversations/:id/resume
POST /api/agent/conversations/:id/send
GET  /api/settings
PUT  /api/settings/profile
PUT  /api/settings/whatsapp
PUT  /api/settings/notifications
PUT  /api/settings/password
GET  /api/knowledge
POST /api/knowledge/upload
DELETE /api/knowledge/:id
```

### Admin (requires Admin JWT)
```
POST /api/admin/auth/login
GET  /api/admin/analytics/overview
GET  /api/admin/analytics/daily
GET  /api/admin/analytics/usage
GET  /api/admin/businesses
GET  /api/admin/businesses/:id
PATCH /api/admin/businesses/:id/toggle
GET  /api/admin/plans
PUT  /api/admin/plans/:id
GET  /api/admin/conversations
GET  /api/admin/conversations/:id/messages
GET  /api/admin/support
PATCH /api/admin/support/:id/resolve
```

### WhatsApp Webhook
```
GET  /webhook  → Meta verification
POST /webhook  → Incoming messages
```

### Magic Link
```
GET /join/:token → Owner takeover from WhatsApp notification
```

---

## 🤖 What Makes It Feel Human

1. **Dedicated agent per customer** — never mixes up customers
2. **Full persistent memory** — Anthropic Managed Agents remember everything
3. **Typing delay** — agent waits 1-4 seconds before replying
4. **Human persona** — system prompt makes agent act like a real person
5. **Never mentions AI** — stays in character always
6. **Natural uncertainty** — says "let me check!" instead of "I don't know"

---

Built with ❤️ for Voxiro
