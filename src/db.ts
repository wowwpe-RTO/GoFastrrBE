import { Pool } from "pg";

let pool: Pool | null = null;

function createPool(): Pool {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,

    // 🔥 Reduced to prevent socket exhaustion
    max: 5,

    // Close idle clients faster
    idleTimeoutMillis: 10_000,

    // Faster fail on broken connection
    connectionTimeoutMillis: 5_000,

    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });

  /**
   * IMPORTANT:
   * Do NOT destroy pool on transient errors.
   * Just log.
   */
  p.on("error", (err: any) => {
    console.error("⚠️ PG pool error (non-fatal):", err?.message);

    // Ignore transient network errors
    if (
      err?.code === "ETIMEDOUT" ||
      err?.code === "ECONNRESET" ||
      err?.code === "EADDRNOTAVAIL"
    ) {
      return;
    }

    // Only log unexpected errors
  });

  return p;
}

export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }

  return pool;
}

/**
 * Graceful shutdown only.
 * Never auto-call this during runtime.
 */
export async function closePool() {
  if (!pool) return;

  try {
    await pool.end();
    console.log("🧹 DB pool closed");
  } catch (err) {
    console.error("⚠️ Error closing pool:", err);
  } finally {
    pool = null;
  }
}