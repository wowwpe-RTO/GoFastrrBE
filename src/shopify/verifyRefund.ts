import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../services/shopTokenService";
import { sendAlert } from "../services/alertService";

/**
 * Verifies Shopify refund matches Razorpay refund amount
 */
export async function verifyShopifyRefund({
  checkoutSessionId,
  razorpayAmountPaise,
}: {
  checkoutSessionId: string;
  razorpayAmountPaise: number;
}) {
  const pool = getPool();

  const r = await pool.query(
    `
    SELECT shop, shopify_order_id, currency
    FROM checkout_sessions
    WHERE id=$1
    `,
    [checkoutSessionId]
  );

  if (!r.rowCount) return;

  const row = r.rows[0];
  const token = await getToken(row.shop);
  if (!token) return;

  const resp = await axios.get(
    `https://${row.shop}/admin/api/2024-01/orders/${row.shopify_order_id}/refunds.json`,
    {
      headers: {
        "X-Shopify-Access-Token": token.trim(),
      },
    }
  );

  const refunds = resp.data?.refunds || [];

  let shopifyRefundTotal = 0;

  for (const refund of refunds) {
    for (const tx of refund.transactions || []) {
      if (tx.kind === "refund") {
        shopifyRefundTotal += Math.round(Number(tx.amount) * 100);
      }
    }
  }

  if (shopifyRefundTotal !== razorpayAmountPaise) {
    await sendAlert({
      level: "critical",
      event: "refund_mismatch",
      checkoutSessionId,
      message: "Refund totals mismatch Shopify vs Razorpay",
      meta: {
        razorpayPaise: razorpayAmountPaise,
        shopifyPaise: shopifyRefundTotal,
      },
    });

    throw new Error("Refund mismatch");
  }

  await pool.query(
    `
    UPDATE refunds
    SET verified=true, updated_at=now()
    WHERE checkout_session_id=$1
    `,
    [checkoutSessionId]
  );
}
