import { Pool } from "pg";

let pool: Pool | null = null;

export async function initDb(retries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      });

      await pool.query("SELECT 1");
      console.log("✅ Database connected");
      return;
    } catch (err) {
      console.error(`❌ DB connection failed (attempt ${attempt})`, err);

      if (attempt === retries) {
        throw err;
      }

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error("DB not initialized");
  }
  return pool;
}
