import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../services/shopTokenService";
import { sendAlert } from "../services/alertService";

/**
 * Fetch Shopify order and verify totals against frozen checkout session.
 *
 * IMPORTANT DESIGN DECISION:
 * A totals mismatch is logged + alerted but does NOT throw.
 * Reason: money has already been captured by Razorpay at this point.
 * Throwing here rolls back COMPLETED and leaves the checkout in a stuck
 * state where the customer paid but has no order. The alert gives ops
 * visibility to investigate without blocking order fulfilment.
 */
export async function verifyShopifyOrder({
  checkoutSessionId,
  shopifyOrderId,
}: {
  checkoutSessionId: string;
  shopifyOrderId: string | number;
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

  if (!session.rowCount) {
    throw new Error("Session missing during verification");
  }

  const row = session.rows[0];

  const accessToken = await getToken(row.shop);
  if (!accessToken) throw new Error("Missing Shopify token");

  let order: any;

  try {
    const resp = await axios.get(
      `https://${row.shop}/admin/api/2025-01/orders/${shopifyOrderId}.json`,
      {
        headers: { "X-Shopify-Access-Token": accessToken },
        timeout: 15000,
      }
    );

    order = resp.data.order;
  } catch (err: any) {
    /**
     * Shopify fetch failed (network, 404, etc.)
     * Log + alert but do not throw — checkout is already COMPLETED.
     */
    const message = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;

    console.error("verifyShopifyOrder: fetch failed", {
      checkoutSessionId,
      shopifyOrderId,
      message,
    });

    await pool.query(
      `
      UPDATE checkout_sessions
      SET shopify_verified_at    = now(),
          shopify_verified_ok    = false,
          shopify_verify_error   = $1
      WHERE id = $2
      `,
      [`Shopify fetch failed: ${message}`, checkoutSessionId]
    );

    await sendAlert({
      level: "warn",
      event: "shopify_order_fetch_failed",
      checkoutSessionId,
      message: "Could not fetch Shopify order for verification",
      meta: { shopifyOrderId, error: message },
    });

    // Do not throw — order exists, money captured, ops alerted
    return null;
  }

  /* ======================================================
     TOTALS COMPARISON
     expectedTotal is in paise → divide by 100 for rupees
     Shopify total_price is already in rupees (e.g. "1200.00")
  ====================================================== */

  const expectedTotal = Number(row.total_amount) / 100;
  const actualTotal = Number(order.total_price);

  // Allow ₹1 tolerance to absorb rounding differences
  const totalsMatch = Math.abs(expectedTotal - actualTotal) <= 1.0;
  const currencyMatch =
    order.currency?.toUpperCase() === row.currency?.toUpperCase();

  const ok = totalsMatch && currencyMatch;

  if (!ok) {
    const errorMsg = `Totals/currency mismatch: expected ₹${expectedTotal} ${row.currency}, got ₹${actualTotal} ${order.currency}`;

    console.error("verifyShopifyOrder: mismatch", {
      checkoutSessionId,
      shopifyOrderId,
      expectedTotal,
      actualTotal,
      expectedCurrency: row.currency,
      actualCurrency: order.currency,
    });

    await pool.query(
      `
      UPDATE checkout_sessions
      SET shopify_verified_at    = now(),
          shopify_verified_ok    = false,
          shopify_verify_error   = $1
      WHERE id = $2
      `,
      [errorMsg, checkoutSessionId]
    );

    await sendAlert({
      level: "critical",
      event: "shopify_order_mismatch",
      checkoutSessionId,
      message: "Shopify order totals do not match checkout session",
      meta: {
        shopifyOrderId,
        expectedTotal,
        actualTotal,
        expectedCurrency: row.currency,
        actualCurrency: order.currency,
      },
    });

    // ⚠️ Do NOT throw — money is captured, ops have been alerted.
    // Throwing here would prevent COMPLETED from being written.
    return order;
  }

  /* ======================================================
     ✅ VERIFIED OK
  ====================================================== */

  await pool.query(
    `
    UPDATE checkout_sessions
    SET shopify_verified_at    = now(),
        shopify_verified_ok    = true,
        shopify_verify_error   = null
    WHERE id = $1
    `,
    [checkoutSessionId]
  );

  return order;
}