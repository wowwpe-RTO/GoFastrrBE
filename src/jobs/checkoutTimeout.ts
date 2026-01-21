import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";

export async function expireStaleCheckouts() {
  try {
    const pool = getPool(); // ✅ inside function

    await pool.query(
      `
      UPDATE checkout_sessions
      SET
        step = $1,
        updated_at = now()
      WHERE step IN ($2, $3)
        AND updated_at < now() - interval '15 minutes'
      `,
      [
        CheckoutStep.FAILED,
        CheckoutStep.PAYMENT_INITIATED,
        CheckoutStep.ADDRESS_SAVED,
      ]
    );

    // console.log("🕒 Stale checkout cleanup ran");
  } catch (err: any) {
    /**
     * NEVER crash process for background jobs
     */
    if (err.code === "ENOTFOUND") {
      console.warn("⚠️ DB temporarily unreachable (Neon DNS)");
      return;
    }

    console.error("❌ expireStaleCheckouts failed:", err);
  }
}
