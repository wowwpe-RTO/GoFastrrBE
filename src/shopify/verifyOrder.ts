// import axios from "axios";
// import { getPool } from "../db";
// import { getToken } from "../storeTokens";
// import { sendAlert } from "../services/alertService";

// /**
//  * Verifies Shopify order against frozen checkout session
//  * Uses MoneySets ONLY (never legacy totals)
//  * Allows 1-paise rounding drift
//  */
// export async function verifyShopifyOrder({
//   checkoutSessionId,
//   shopifyOrderId,
// }: {
//   checkoutSessionId: string;
//   shopifyOrderId: string;
// }) {
//   const pool = getPool();

//   const sessionRes = await pool.query(
//     `
//     SELECT
//       shop,
//       subtotal_amount,
//       shipping_amount,
//       tax_amount,
//       total_amount,
//       currency
//     FROM checkout_sessions
//     WHERE id = $1
//     `,
//     [checkoutSessionId]
//   );

//   if (!sessionRes.rowCount) {
//     throw new Error("Session missing during verification");
//   }

//   const s = sessionRes.rows[0];

//   const accessToken = await getToken(s.shop);
//   if (!accessToken) throw new Error("Missing Shopify token");

//   const resp = await axios.get(
//     `https://${s.shop}/admin/api/2024-01/orders/${shopifyOrderId}.json`,
//     {
//       headers: {
//         "X-Shopify-Access-Token": accessToken.trim(),
//       },
//       timeout: 15000,
//     }
//   );

//   const order = resp.data?.order;
//   if (!order) throw new Error("Shopify order missing");

//   /**
//    * ✅ ONLY MoneySets (authoritative)
//    */
//   const shopSubtotal =
//     Number(order.current_subtotal_price_set?.shop_money?.amount || 0) * 100;

//   const shopTax =
//     Number(order.current_total_tax_set?.shop_money?.amount || 0) * 100;

//   const shopTotal =
//     Number(order.current_total_price_set?.shop_money?.amount || 0) * 100;

//   const expectedSubtotal = Number(s.subtotal_amount);
//   const expectedTax = Number(s.tax_amount || 0);
//   const expectedTotal = Number(s.total_amount);

//   /**
//    * Drift in paise (integer math)
//    */
//   const drift =
//     Math.abs(shopSubtotal - expectedSubtotal) +
//     Math.abs(shopTax - expectedTax) +
//     Math.abs(shopTotal - expectedTotal);

//   // ✅ Allow 1 paise rounding
//   if (drift <= 1) {
//     console.log("⚠️ Minor cart drift tolerated:", drift);
//     return order;
//   }

//   /**
//    * 🚨 Real mismatch → alert
//    */
//   await sendAlert({
//     level: "critical",
//     event: "shopify_order_mismatch",
//     checkoutSessionId,
//     message: "Shopify totals do not match checkout session",
//     meta: {
//       shopifyOrderId,
//       expected: {
//         subtotal: expectedSubtotal,
//         tax: expectedTax,
//         total: expectedTotal,
//       },
//       actual: {
//         subtotal: shopSubtotal,
//         tax: shopTax,
//         total: shopTotal,
//       },
//     },
//   });

//   throw new Error("Shopify totals mismatch");
// }


import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../services/shopTokenService";
import { sendAlert } from "../services/alertService";

/**
 * Fetch Shopify order and verify against frozen checkout totals.
 * Persists verification result.
 */
export async function verifyShopifyOrder({
  checkoutSessionId,
  shopifyOrderId,
}: {
  checkoutSessionId: string;
  shopifyOrderId: string;
}) {
  const pool = getPool();

  const session = await pool.query(
    `
    SELECT
      shop,
      subtotal_amount,
      shipping_amount,
      tax_amount,
      total_amount,
      currency
    FROM checkout_sessions
    WHERE id = $1
    `,
    [checkoutSessionId]
  );

  if (!session.rowCount) throw new Error("Session missing during verification");

  const row = session.rows[0];

  const accessToken = await getToken(row.shop);
  if (!accessToken) throw new Error("Missing Shopify token");

  try {
    const resp = await axios.get(
      `https://${row.shop}/admin/api/2025-10/orders/${shopifyOrderId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
        timeout: 15000,
      }
    );

    const order = resp.data.order;

    const expectedTotal = Number(row.total_amount) / 100;
    const actualTotal = Number(order.total_price);

    const ok =
      Math.abs(expectedTotal - actualTotal) <= 0.01 &&
      order.currency === row.currency;

    if (!ok) {
      await pool.query(
        `
        UPDATE checkout_sessions
        SET
          shopify_verified_at = now(),
          shopify_verified_ok = false,
          shopify_verify_error = $1
        WHERE id = $2
        `,
        [
          `Totals/currency mismatch: expected ${expectedTotal}, got ${actualTotal}`,
          checkoutSessionId,
        ]
      );

      await sendAlert({
        level: "critical",
        event: "shopify_order_mismatch",
        checkoutSessionId,
        message: "Shopify totals do not match checkout session",
        meta: { shopifyOrderId },
      });

      throw new Error("Shopify verification failed");
    }

    /**
     * ✅ Verified OK
     */
    await pool.query(
      `
      UPDATE checkout_sessions
      SET
        shopify_verified_at = now(),
        shopify_verified_ok = true,
        shopify_verify_error = null
      WHERE id = $1
      `,
      [checkoutSessionId]
    );

    return order;
  } catch (err: any) {
    await pool.query(
      `
      UPDATE checkout_sessions
      SET
        shopify_verified_at = now(),
        shopify_verified_ok = false,
        shopify_verify_error = $1
      WHERE id = $2
      `,
      [String(err.message || err), checkoutSessionId]
    );

    throw err;
  }
}
