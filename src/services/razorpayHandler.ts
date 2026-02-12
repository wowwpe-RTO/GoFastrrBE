import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";
import { createShopifyOrder } from "../shopify/createOrder";
import { verifyShopifyOrder } from "../shopify/verifyOrder";
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
       1️⃣ Lock payment
    ====================================================== */

    const paymentRes = await client.query(
      `
      SELECT
        id,
        checkout_session_id,
        amount_paise::bigint,
        captured_amount_paise::bigint,
        currency
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

    const capturedDelta = toPaiseBigInt(safePaymentReference.amount);
    const alreadyCaptured = toPaiseBigInt(payment.captured_amount_paise);
    const orderTotal = toPaiseBigInt(payment.amount_paise);

    // Idempotency
    if (capturedDelta <= alreadyCaptured) {
      await client.query("COMMIT");
      return;
    }

    const newCaptured = alreadyCaptured + capturedDelta;

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

    // Stop on partial capture
    if (newCaptured !== orderTotal) {
      await client.query("COMMIT");
      return;
    }

    const checkoutSessionId: string =
      payment.checkout_session_id;

    /* ======================================================
       2️⃣ Lock checkout
    ====================================================== */

    const sessionRes = await client.query(
      `
      SELECT
        step,
        shopify_order_id,
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

    // Already completed → idempotent
    if (session.step === CheckoutStep.COMPLETED) {
      await client.query("COMMIT");
      return;
    }

    // Must come from PAYMENT_INITIATED
    assertTransition(
      session.step,
      CheckoutStep.COMPLETED
    );

    /* ======================================================
       3️⃣ Cart integrity check
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
            "Cart hash mismatch during capture",
        });

        throw new Error("Cart integrity violation");
      }
    }

    /* ======================================================
       4️⃣ Move state → COMPLETED
    ====================================================== */

    await client.query(
      `
      UPDATE checkout_sessions
      SET step=$1, updated_at=now()
      WHERE id=$2
      `,
      [CheckoutStep.COMPLETED, checkoutSessionId]
    );

    await client.query("COMMIT");

    /* ======================================================
       5️⃣ OUTSIDE TRANSACTION → Create Shopify order
    ====================================================== */

    if (!session.shopify_order_id) {
      const order = await createShopifyOrder(
        checkoutSessionId
      );

      if (order?.id) {
        await verifyShopifyOrder({
          checkoutSessionId,
          shopifyOrderId: order.id,
        });
      }
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
