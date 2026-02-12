import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";
import { createShopifyOrder } from "../shopify/createOrder";
import { verifyShopifyOrder } from "../shopify/verifyOrder";
import { sendAlert } from "../services/alertService";


/**
 * Background reconciliation job
 *
 * Fixes:
 * - Razorpay CAPTURED but checkout not COMPLETED
 * - Missing Shopify orders
 *
 * Safe:
 * - Idempotent
 * - Row locked
 * - Retryable
 */
export async function reconcileCheckouts() {
  const pool = getPool();

  /**
   * Find sessions that:
   * - Have CAPTURED payment
   * - Are NOT completed
   */
  const stuck = await pool.query(`
    SELECT
      cs.id AS checkout_session_id,
      cs.step,
      cs.shopify_order_id
    FROM checkout_sessions cs
    JOIN payments p
      ON p.checkout_session_id = cs.id
    WHERE
      p.gateway = 'razorpay'
      AND p.status = 'CAPTURED'
      AND cs.step != '${CheckoutStep.COMPLETED}'
      AND cs.updated_at < now() - interval '2 minutes'
    LIMIT 20
  `);

  if (!stuck.rowCount) return;

  for (const row of stuck.rows) {
    const checkoutSessionId = row.checkout_session_id;

    try {
      await pool.query("BEGIN");

      /**
       * Lock checkout
       */
      const locked = await pool.query(
        `
        SELECT step, shopify_order_id
        FROM checkout_sessions
        WHERE id = $1
        FOR UPDATE
        `,
        [checkoutSessionId]
      );

      if (!locked.rowCount) {
        await pool.query("ROLLBACK");
        continue;
      }

      const session = locked.rows[0];

      if (session.step === CheckoutStep.COMPLETED) {
        await pool.query("COMMIT");
        continue;
      }

      let shopifyOrderId = session.shopify_order_id;

      /**
       * Create Shopify order if missing
       */
      if (!shopifyOrderId) {
        const order = await createShopifyOrder(checkoutSessionId);
        shopifyOrderId = order.id;
      }

      /**
       * Verify Shopify order totals
       */
      await verifyShopifyOrder({
        checkoutSessionId,
        shopifyOrderId,
      });

      /**
       * Finalize checkout
       */
      await pool.query(
        `
        UPDATE checkout_sessions
        SET
          step = $1,
          shopify_order_id = $2,
          updated_at = now()
        WHERE id = $3
        `,
        [CheckoutStep.COMPLETED, shopifyOrderId, checkoutSessionId]
      );

      console.log(
        JSON.stringify({
          event: "reconcile_fix",
          checkoutSessionId,
        })
      );

      await pool.query("COMMIT");
    } catch (err) {
  await pool.query("ROLLBACK");

  console.error(
    JSON.stringify({
      event: "reconcile_failed",
      checkoutSessionId,
      error: String(err),
    })
  );

  await sendAlert({
    level: "critical",
    event: "checkout_reconcile_failed",
    checkoutSessionId,
    message: "Automatic reconciliation failed",
    meta: { error: String(err) },
  });
}
  }
}
