import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";

/**
 * Expire stale checkout sessions safely
 *
 * - PostgreSQL-safe UPDATE pattern
 * - Small batches
 * - Short transaction
 * - Statement timeout
 * - Never crashes the process
 */
export async function expireStaleCheckouts(limit = 50) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Prevent hanging connections
    await client.query("SET LOCAL statement_timeout = '5s'");

    const res = await client.query(
      `
      UPDATE checkout_sessions
      SET
        step = $1,
        updated_at = now()
      WHERE id IN (
        SELECT id
        FROM checkout_sessions
        WHERE step IN ($2, $3)
          AND updated_at < now() - interval '15 minutes'
        ORDER BY updated_at ASC
        LIMIT $4
      )
      `,
      [
        CheckoutStep.FAILED,
        CheckoutStep.PAYMENT_INITIATED,
        CheckoutStep.ADDRESS_SAVED,
        limit,
      ]
    );

    await client.query("COMMIT");

    const affected = res.rowCount ?? 0;

    if (affected > 0) {
      console.log(`🕒 Expired ${affected} stale checkouts`);
    }
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    if (err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET") {
      console.warn("⚠️ DB temporarily unreachable during expireStaleCheckouts");
      return;
    }

    console.error("❌ expireStaleCheckouts failed:", err);
    throw err; // guardedInterval handles retry + cooldown
  } finally {
    client.release();
  }
}
