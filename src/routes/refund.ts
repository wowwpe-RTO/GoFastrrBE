import { Router } from "express";
import Razorpay from "razorpay";
import { getPool } from "../db";

const router = Router();

router.post("/refund", async (req, res) => {
  const { checkoutSessionId, amountPaise } = req.body;

  if (!checkoutSessionId || !amountPaise) {
    return res.status(400).json({ error: "Missing params" });
  }

  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });

  const pool = getPool();
  await pool.query("BEGIN");

  try {
    /**
     * Lock captured payment
     */
    const p = await pool.query(
      `
      SELECT id,gateway_order_id,amount_paise,captured_amount_paise
      FROM payments
      WHERE checkout_session_id=$1
        AND gateway='razorpay'
      FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (!p.rowCount) throw new Error("Payment not found");

    const payment = p.rows[0];

    const maxRefundable = Number(payment.captured_amount_paise || 0);

    if (Number(amountPaise) > maxRefundable) {
      throw new Error("Refund exceeds captured amount");
    }

    /**
     * Razorpay refund
     */
    const refund = await razorpay.payments.refund(
      payment.gateway_order_id,
      { amount: Number(amountPaise) }
    );

    /**
     * Persist refund
     */
    await pool.query(
      `
      INSERT INTO refunds(
        id,
        payment_id,
        checkout_session_id,
        gateway,
        gateway_refund_id,
        amount_paise,
        status,
        created_at,
        updated_at
      )
      VALUES(
        gen_random_uuid(),
        $1,
        $2,
        'razorpay',
        $3,
        $4,
        'CREATED',
        now(),
        now()
      )
      ON CONFLICT (gateway_refund_id) DO NOTHING
      `,
      [
        payment.id,
        checkoutSessionId,
        refund.id,
        amountPaise,
      ]
    );

    await pool.query("COMMIT");

    res.json({ success: true, razorpayRefundId: refund.id });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Refund failed:", err);
    res.status(400).json({ error: "Refund failed" });
  }
});

export default router;
