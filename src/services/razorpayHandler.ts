import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";
import { createShopifyOrder } from "../shopify/createOrder";

/**
 * Canonical handler for Razorpay payment.captured
 * - Idempotent
 * - PCI-safe
 * - Transaction-safe
 * - Safe for retries & replays
 */
export async function handleRazorpayCapturedEvent({
  razorpayOrderId,
  safePaymentReference,
}: {
  razorpayOrderId: string;
  safePaymentReference: {
    payment_id: string;
    order_id: string;
    amount: number;
    currency: string;
    status: string;
    method: string;
    captured_at: number;
  };
}) {
  const pool = getPool();

  await pool.query("BEGIN");

  try {
    /**
     * 1️⃣ Lock + capture payment (idempotent)
     */
    const paymentResult = await pool.query(
      `
      UPDATE payments
      SET
        status = 'CAPTURED',
        gateway_reference = $1,
        updated_at = now()
      WHERE gateway = 'razorpay'
        AND gateway_order_id = $2
        AND status != 'CAPTURED'
      RETURNING checkout_session_id
      `,
      [
        JSON.stringify(safePaymentReference),
        razorpayOrderId,
      ]
    );

    // Already processed or unknown payment
    if (paymentResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return;
    }

    const checkoutSessionId =
      paymentResult.rows[0].checkout_session_id;

    /**
     * 2️⃣ Lock checkout session
     */
    const sessionResult = await pool.query(
      `
      SELECT step, shopify_order_id
      FROM checkout_sessions
      WHERE id = $1
      FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (sessionResult.rowCount === 0) {
      throw new Error("Checkout session not found");
    }

    const { step: currentStep, shopify_order_id } =
      sessionResult.rows[0];

    /**
     * 3️⃣ Idempotency guard
     */
    if (currentStep === CheckoutStep.COMPLETED) {
      await pool.query("COMMIT");
      return;
    }

    assertTransition(currentStep, CheckoutStep.COMPLETED);

    /**
     * 4️⃣ Create Shopify order ONLY if missing
     */
    let finalShopifyOrderId = shopify_order_id;

    if (!finalShopifyOrderId) {
      const shopifyOrder =
        await createShopifyOrder(checkoutSessionId);
      finalShopifyOrderId = shopifyOrder.id;
    }

    /**
     * 5️⃣ Finalize checkout
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
      [
        CheckoutStep.COMPLETED,
        finalShopifyOrderId,
        checkoutSessionId,
      ]
    );

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}
