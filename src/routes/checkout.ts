import { Router } from "express";
import Razorpay from "razorpay";
import { getPool } from "../db";

import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";

const router = Router();


/**
 * ----------------------------------------
 * Razorpay client (singleton)
 * ----------------------------------------
 */
function getRazorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay env vars missing");
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/**
 * ----------------------------------------
 * POST /checkout/address
 * OTP_VERIFIED → ADDRESS_SAVED
 * ----------------------------------------
 */
router.post("/address", async (req, res) => {
  const pool = getPool();
  const { checkoutSessionId, address } = req.body;

  if (!checkoutSessionId || !address) {
    return res.status(400).json({
      error: "checkoutSessionId and address are required",
    });
  }

  const requiredFields = [
    "firstName",
    "lastName",
    "line1",
    "city",
    "state",
    "postalCode",
    "country",
  ];

  for (const field of requiredFields) {
    if (!address[field]) {
      return res.status(400).json({
        error: `Missing address field: ${field}`,
      });
    }
  }

  /**
   * 1️⃣ Load checkout session
   */
  const sessionResult = await pool.query(
    `
    SELECT step
    FROM checkout_sessions
    WHERE id = $1
    `,
    [checkoutSessionId]
  );

  if (sessionResult.rowCount === 0) {
    return res.status(404).json({ error: "Checkout session not found" });
  }

  const currentStep = sessionResult.rows[0].step;

  /**
   * 2️⃣ Idempotency guard
   */
  if (currentStep === CheckoutStep.ADDRESS_SAVED) {
    // Already saved → safe retry
    return res.json({
      success: true,
      checkoutSessionId,
      step: CheckoutStep.ADDRESS_SAVED,
    });
  }

  /**
   * 3️⃣ Enforce valid transition
   */
  assertTransition(currentStep, CheckoutStep.ADDRESS_SAVED);

  /**
   * 4️⃣ Pricing (server-authoritative)
   */
  const UNIT_PRICE_PAISE = 259800;
  const quantity = 1;
  const totalAmountPaise = UNIT_PRICE_PAISE * quantity;


  console.log(JSON.stringify({
      event: "checkout_transition",
      checkoutSessionId,
      from: currentStep,
      to: CheckoutStep.ADDRESS_SAVED
    }));
  /**
   * 5️⃣ Persist address + transition
   */
  await pool.query(
    `
    UPDATE checkout_sessions
    SET
      shipping_address = $1,
      total_amount = $2,
      currency = 'INR',
      step = $3,
      updated_at = now()
    WHERE id = $4
    `,
    [
      address,
      totalAmountPaise,
      CheckoutStep.ADDRESS_SAVED,
      checkoutSessionId,
    ]
  );

  return res.json({
    success: true,
    checkoutSessionId,
    totalAmountPaise,
    step: CheckoutStep.ADDRESS_SAVED,
  });
});




/**
 * ----------------------------------------
 * POST /checkout/pay/init
 * ADDRESS_SAVED → PAYMENT_INITIATED
 * ----------------------------------------
 */
router.post("/pay/init", async (req, res) => {
  const pool = getPool();
  try {
    const { checkoutSessionId, gateway } = req.body;

    if (!checkoutSessionId || gateway !== "razorpay") {
      return res.status(400).json({
        error: "checkoutSessionId and valid gateway required",
      });
    }

    /**
     * 1️⃣ Load checkout session
     */
    const sessionResult = await pool.query(
      `
      SELECT step, total_amount, currency
      FROM checkout_sessions
      WHERE id = $1
      `,
      [checkoutSessionId]
    );

    if (sessionResult.rowCount === 0) {
      return res.status(404).json({ error: "Checkout session not found" });
    }

    const session = sessionResult.rows[0];

    // 🔒 Terminal states
if (session.step === CheckoutStep.COMPLETED) {
  return res.status(409).json({
    error: "Checkout already completed",
    step: session.step,
  });
}

if (session.step === CheckoutStep.FAILED) {
  return res.status(409).json({
    error: "Checkout failed. Please restart checkout.",
    step: session.step,
  });
}

// 🔁 Idempotency: already initiated
if (session.step === CheckoutStep.PAYMENT_INITIATED) {
  const existing = await pool.query(
    `
    SELECT gateway_order_id
    FROM payments
    WHERE checkout_session_id = $1
      AND gateway = 'razorpay'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [checkoutSessionId]
  );

  const existingCount = existing.rowCount ?? 0;

  if (existingCount > 0) {
    return res.json({
      gateway: "razorpay",
      gatewayOrderId: existing.rows[0].gateway_order_id,
      amountPaise: session.total_amount,
      currency: session.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  }
}

// ✅ Only now enforce transition
assertTransition(
  session.step,
  CheckoutStep.PAYMENT_INITIATED
);


    const amountPaise = Number(session.total_amount);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    /**
     * 3️⃣ Check existing payment (IDEMPOTENCY)
     */
    const existing = await pool.query(
      `
      SELECT gateway_order_id
      FROM payments
      WHERE checkout_session_id = $1
        AND gateway = 'razorpay'
      `,
      [checkoutSessionId]
    );

    if ((existing.rowCount ?? 0) > 0) {
      return res.json({
        gateway: "razorpay",
        gatewayOrderId: existing.rows[0].gateway_order_id,
        amountPaise,
        currency: session.currency,
        key: process.env.RAZORPAY_KEY_ID,
      });
    }

    /**
     * 4️⃣ Create Razorpay order
     */
    const razorpay = getRazorpayClient();

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: session.currency,
      receipt: `ck_${checkoutSessionId.slice(0, 32)}`,
    });

    /**
     * 5️⃣ Insert payment (DB-locked)
     */
    await pool.query(
      `
      INSERT INTO payments (
        id,
        checkout_session_id,
        gateway,
        gateway_order_id,
        amount_paise,
        currency,
        status,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        'razorpay',
        $2,
        $3,
        $4,
        'CREATED',
        now(),
        now()
      )
      `,
      [
        checkoutSessionId,
        order.id,
        amountPaise,
        session.currency,
      ]
    );

    

    /**
     * 6️⃣ Transition checkout
     */
    await pool.query(
      `
      UPDATE checkout_sessions
      SET step = $1, updated_at = now()
      WHERE id = $2
      `,
      [CheckoutStep.PAYMENT_INITIATED, checkoutSessionId]
    );

    return res.json({
      gateway: "razorpay",
      gatewayOrderId: order.id,
      amountPaise,
      currency: session.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("❌ /checkout/pay/init failed:", err);
    return res.status(500).json({
      error: "Payment initialization failed",
    });
  }
});

/**
 * ----------------------------------------
 * GET /checkout/status/:id
 * Frontend polling endpoint
 * ----------------------------------------
 */
router.get("/status/:id", async (req, res) => {
  const pool = getPool();
  const { id } = req.params;

  const result = await pool.query(
    `
    SELECT
      step,
      shopify_order_id
    FROM checkout_sessions
    WHERE id = $1
    `,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  return res.json({
    step: result.rows[0].step,
    shopifyOrderId: result.rows[0].shopify_order_id,
  });
});

export default router;
