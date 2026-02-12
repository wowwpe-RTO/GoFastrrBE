import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../services/shopTokenService";

export async function createShopifyRefund(checkoutSessionId: string, amountPaise: number) {
  const pool = getPool();

  const s = await pool.query(
    `SELECT shop,shopify_order_id,currency FROM checkout_sessions WHERE id=$1`,
    [checkoutSessionId]
  );

  if (!s.rowCount) return;

  const row = s.rows[0];
  const token = await getToken(row.shop);

  await axios.post(
    `https://${row.shop}/admin/api/2024-01/orders/${row.shopify_order_id}/refunds.json`,
    {
      refund: {
        transactions: [
          {
            kind: "refund",
            amount: (amountPaise / 100).toFixed(2),
            currency: row.currency,
          },
        ],
      },
    },
    {
      headers: {
        "X-Shopify-Access-Token": token!,
        "Content-Type": "application/json",
      },
    }
  );
}
