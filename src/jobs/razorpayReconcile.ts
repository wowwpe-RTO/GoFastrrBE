import { getPool } from "../db";
import { getRazorpayClient } from "../gateways/razorpay";
import { CheckoutStep } from "../domain/checkoutStates";

export async function reconcileRazorpayPayments() {
  const pool = getPool(); // ✅ safe
  const razorpay = getRazorpayClient();

  const pending = await pool.query(
    `
    SELECT
      p.id,
      p.gateway_order_id,
      p.checkout_session_id
    FROM payments p
    JOIN checkout_sessions c
      ON c.id = p.checkout_session_id
    WHERE p.gateway = 'razorpay'
      AND p.status = 'CREATED'
      AND c.step = 'PAYMENT_INITIATED'
    `
  );

  for (const row of pending.rows) {
    const payments = await razorpay.orders.fetchPayments(
      row.gateway_order_id
    );

    const captured = payments.items.find(
      (p: any) => p.status === "captured"
    );

    if (!captured) continue;

    await pool.query("BEGIN");

    try {
      await pool.query(
        `
        UPDATE payments
        SET status = 'CAPTURED'
        WHERE id = $1
        `,
        [row.id]
      );

      await pool.query(
        `
        UPDATE checkout_sessions
        SET step = $1, updated_at = now()
        WHERE id = $2
        `,
        [CheckoutStep.COMPLETED, row.checkout_session_id]
      );

      await pool.query("COMMIT");

      console.log(
        "🔁 Reconciled payment:",
        row.gateway_order_id
      );
    } catch (e) {
      await pool.query("ROLLBACK");
      console.error("❌ Reconcile failed:", e);
    }
  }
}
