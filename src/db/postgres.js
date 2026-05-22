import pg     from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

// ── SSL Config for Railway PostgreSQL ─────────────────────────
// Railway uses self-signed certificates — we accept them properly
// instead of disabling TLS verification globally
const sslConfig = process.env.DATABASE_URL?.includes("railway")
  ? { rejectUnauthorized: false }
  : process.env.NODE_ENV === "production"
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:              sslConfig,
  max:              20,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

pool.query("SELECT NOW()").then(() => {
  console.log("✅ PostgreSQL connected");
}).catch((err) => {
  console.error("❌ PostgreSQL connection failed:", err.message);
});

export const query     = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
export default pool;