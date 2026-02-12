import { getPool } from "../db";
import { createShopifyRefund } from "../shopify/refundOrder";
import { verifyShopifyRefund } from "../shopify/verifyRefund";

export async function handleRefundProcessed({
  razorpayRefundId,
  amount,
}: {
  razorpayRefundId: string;
  amount: number;
}) {
  const pool = getPool();
  await pool.query("BEGIN");

  try {
    const r = await pool.query(
      `
      UPDATE refunds
      SET status='PROCESSED',updated_at=now()
      WHERE gateway_refund_id=$1
      RETURNING checkout_session_id
      `,
      [razorpayRefundId]
    );

    if (!r.rowCount) {
      await pool.query("ROLLBACK");
      return;
    }

    const checkoutSessionId = r.rows[0].checkout_session_id;

    const totals = await pool.query(
      `
      SELECT total_amount,
             COALESCE(SUM(amount),0) refunded
      FROM refunds
      WHERE checkout_session_id=$1
      GROUP BY total_amount
      `,
      [checkoutSessionId]
    );

    const total = Number(totals.rows[0].total_amount);
    const refunded = Number(totals.rows[0].refunded);

    const state = refunded >= total ? "REFUNDED" : "PARTIALLY_REFUNDED";

    await pool.query(
      `
      UPDATE checkout_sessions
      SET refund_state=$1, updated_at=now()
      WHERE id=$2
      `,
      [state, checkoutSessionId]
    );

    await createShopifyRefund(checkoutSessionId, amount);

    await verifyShopifyRefund({
      checkoutSessionId,
      razorpayAmountPaise: amount,
    });

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}
