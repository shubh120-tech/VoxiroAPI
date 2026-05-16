import { createClient } from "redis";
import dotenv from "dotenv";
dotenv.config();

const redis = createClient({ url: process.env.REDIS_URL });

redis.on("error",   (err) => console.error("❌ Redis error:", err));
redis.on("connect", ()    => console.log("✅ Redis connected"));

await redis.connect();

export default redis;
