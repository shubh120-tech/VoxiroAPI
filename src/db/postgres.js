import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

// Fix for Railway self-signed certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 10000,
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