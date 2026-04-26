import { getPool } from "../db";
import { handleRefundProcessed } from "../services/refundHandler";

/**
 * Replays unprocessed refunds (safety net)
 */
export async function reconcileRefunds(limit = 10) {
  const pool = getPool();

  const r = await pool.query(
    `
    SELECT gateway_refund_id, amount_paise
    FROM refunds
    WHERE status != 'PROCESSED'
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [limit]
  );

  for (const row of r.rows) {
    try {
      await handleRefundProcessed({
        razorpayRefundId: row.gateway_refund_id,
        amount: Number(row.amount_paise),
      });

      console.log("🔁 Reconciled refund:", row.gateway_refund_id);
    } catch (err) {
      console.error("Refund reconcile failed:", row.gateway_refund_id, err);
    }
  }
}