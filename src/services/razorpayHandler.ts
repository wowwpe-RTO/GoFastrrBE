import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";
import { createShopifyOrder } from "../shopify/createOrder";
import { verifyShopifyOrder } from "../shopify/verifyOrder";
import { completeDraftOrder } from "../shopify/completeDraftOrder";
import { sendAlert } from "../services/alertService";
import crypto from "crypto";

/**
 * Normalize Razorpay paise → bigint
 */
function toPaiseBigInt(
  v: number | string | bigint | null | undefined
): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;

  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid paise value: ${v}`);
  }

  return BigInt(n);
}

/**
 * Razorpay payment.captured handler
 */
export async function handleRazorpayCapturedEvent({
  razorpayOrderId,
  safePaymentReference,
}: {
  razorpayOrderId: string;
  safePaymentReference: {
    payment_id: string;
    order_id: string;
    amount: number | string;
    currency: string;
    status: string;
    method: string;
    captured_at: number;
  };
}) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* ======================================================
       1️⃣ LOCK PAYMENT
    ====================================================== */

    const paymentRes = await client.query(
      `
      SELECT
        id,
        checkout_session_id,
        amount_paise::bigint,
        captured_amount_paise::bigint,
        currency,
        is_partial
      FROM payments
      WHERE gateway='razorpay'
        AND gateway_order_id=$1
      FOR UPDATE
      `,
      [razorpayOrderId]
    );

    if (!paymentRes.rowCount) {
      await client.query("ROLLBACK");
      return;
    }

    const payment = paymentRes.rows[0];

    if (payment.currency !== safePaymentReference.currency) {
      throw new Error("Currency mismatch");
    }

    const capturedDelta = toPaiseBigInt(
      safePaymentReference.amount
    );

    const alreadyCaptured = toPaiseBigInt(
      payment.captured_amount_paise
    );

    const orderTotal = toPaiseBigInt(
      payment.amount_paise
    );

    // Idempotency
    if (capturedDelta <= alreadyCaptured) {
      await client.query("COMMIT");
      return;
    }

    const newCaptured = alreadyCaptured + capturedDelta;

    const paymentFullyCompleted = newCaptured === orderTotal;

    if (newCaptured > orderTotal) {
      throw new Error("Over-capture detected");
    }

    await client.query(
      `
      UPDATE payments
      SET
        captured_amount_paise = $1::bigint,
        status = CASE
          WHEN $1::bigint = amount_paise::bigint THEN 'CAPTURED'
          ELSE 'PARTIALLY_CAPTURED'
        END,
        gateway_reference = $2,
        updated_at = now()
      WHERE id = $3
      `,
      [
        newCaptured.toString(),
        JSON.stringify(safePaymentReference),
        payment.id,
      ]
    );

    const checkoutSessionId: string =
      payment.checkout_session_id;

    /* ======================================================
       2️⃣ LOCK CHECKOUT
    ====================================================== */

    const sessionRes = await client.query(
      `
      SELECT
        step,
        shop,
        shopify_order_id,
        shopify_draft_order_id,
        cart_items,
        subtotal_amount,
        shipping_amount,
        tax_amount,
        total_amount,
        currency,
        cart_hash
      FROM checkout_sessions
      WHERE id=$1
      FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (!sessionRes.rowCount) {
      throw new Error("Checkout missing");
    }

    const session = sessionRes.rows[0];
    const isPartial = payment.is_partial === true;

    /* ======================================================
       3️⃣ PARTIAL PAYMENT FLOW
    ====================================================== */

    if (isPartial) {
      if (session.step === CheckoutStep.COMPLETED) {
        await client.query("COMMIT");
        return;
      }

      assertTransition(
        session.step,
        CheckoutStep.PARTIALLY_PAID
      );

      await client.query(
        `
        UPDATE checkout_sessions
        SET step=$1,
            updated_at=now()
        WHERE id=$2
        `,
        [CheckoutStep.PARTIALLY_PAID, checkoutSessionId]
      );

      await client.query("COMMIT");

      // Outside transaction → create draft
      if (!session.shopify_draft_order_id) {
        await createShopifyOrder(checkoutSessionId, {
          mode: "draft",
        });
      }

      return;
    }

    /* ======================================================
       4️⃣ FULL PAYMENT INTEGRITY CHECK
    ====================================================== */

    const recomputedHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          items: session.cart_items,
          subtotalPaise: Number(session.subtotal_amount),
          shippingPaise: Number(session.shipping_amount),
          taxPaise: Number(session.tax_amount || 0),
          totalAmountPaise: Number(session.total_amount),
          currency: session.currency,
        })
      )
      .digest("hex");

    if (recomputedHash !== session.cart_hash) {
      const drift = Math.abs(
        Number(session.total_amount) -
          Number(safePaymentReference.amount)
      );

      if (drift > 100) {
        await sendAlert({
          level: "critical",
          event: "cart_integrity_violation",
          checkoutSessionId,
          message:
            "Cart hash mismatch during full capture",
        });

        throw new Error("Cart integrity violation");
      }
    }

    /* ======================================================
       5️⃣ FULL PAYMENT FLOW
    ====================================================== */

    if (session.step === CheckoutStep.COMPLETED) {
      await client.query("COMMIT");
      return;
    }

    assertTransition(
      session.step,
      CheckoutStep.COMPLETED
    );

    await client.query(
      `
      UPDATE checkout_sessions
      SET step=$1,
          updated_at=now()
      WHERE id=$2
      `,
      [CheckoutStep.COMPLETED, checkoutSessionId]
    );

    await client.query("COMMIT");

    if (!session.shopify_order_id) {

      if (session.shopify_draft_order_id) {

        const order = await completeDraftOrder(
          session.shop,
          session.shopify_draft_order_id
        );

        if (order?.order_id) {
          await verifyShopifyOrder({
            checkoutSessionId,
            shopifyOrderId: order.order_id,
          });
        }

      } else {

      const order = await createShopifyOrder(
          checkoutSessionId,
          { mode: "final" }
        ).catch(async (err) => {
          // Shopify order creation failed AFTER payment was captured and
          // step was committed to COMPLETED. Do NOT re-throw — that would
          // be a no-op since the transaction is already committed.
          // Alert ops and let the reconcile job retry.
          console.error("createShopifyOrder failed after COMPLETED:", err?.message || err);
          await sendAlert({
            level: "critical",
            event: "shopify_order_creation_failed",
            checkoutSessionId,
            message: "Shopify order creation failed after payment captured. Reconcile job will retry.",
            meta: { error: err?.message, response: err?.response?.data },
          });
          return null;
        });

        if (order?.id) {
          await verifyShopifyOrder({
            checkoutSessionId,
            shopifyOrderId: order.id,
          });
        }

      }
    }

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}