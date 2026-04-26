import { getPool } from "../db";
import { handleRazorpayCapturedEvent } from "../services/razorpayHandler";

export async function replayFailedWebhooks(limit = 10) {
  const pool = getPool(); // ✅ lazy

  const result = await pool.query(
    `
    SELECT *
    FROM failed_webhooks
    WHERE gateway = 'razorpay'
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [limit]
  );

  for (const row of result.rows) {
    try {
      await handleRazorpayCapturedEvent(row.payload);

      await pool.query(
        `DELETE FROM failed_webhooks WHERE id = $1`,
        [row.id]
      );
    } catch (err) {
  await pool.query(
    `
    UPDATE failed_webhooks
    SET attempts = attempts + 1,
        last_error = $2
    WHERE id = $1
    `,
    [row.id, String(err)]
  );

  console.error("Replay failed:", row.id, err);
}

  }
}
