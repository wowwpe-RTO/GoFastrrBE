import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import Razorpay from "razorpay";
import { checkoutLimiter } from "../middleware/rateLimit";
import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";

const router = Router();

/* ---------------- Schemas ---------------- */

const addressSchema = z.object({
  checkoutSessionId: z.string().uuid(),
  email: z.string().email(),
  phone: z.string(),
  address: z.object({
    firstName: z.string(),
    lastName: z.string(),
    line1: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
  }),
});

const payInitSchema = z.object({
  checkoutSessionId: z.string().uuid(),
  gateway: z.literal("razorpay"),
});

/* ---------------- Razorpay ---------------- */

function getRazorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay env vars missing");
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/* ======================================================
   ADDRESS
====================================================== */

router.post("/address", async (req, res) => {
  const pool = getPool();
  const parsed = addressSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { checkoutSessionId, address, email, phone } = parsed.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT step, shop, subtotal_amount, discount_amount
       FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Checkout not found" });
    }

    const session = sessionResult.rows[0];

    assertTransition(session.step, CheckoutStep.ADDRESS_SAVED);

    const subtotal = Number(session.subtotal_amount || 0);
    const discount = Number(session.discount_amount || 0);
    const taxableAmount = Math.max(subtotal - discount, 0);

    /* ---------- Shipping Zone Lookup ---------- */

    const zone = await client.query(
      `
      SELECT shipping_rate, min_order
      FROM shipping_zones
      WHERE shop = $1
        AND country = $2
        AND (state IS NULL OR state = $3)
      ORDER BY state DESC
      LIMIT 1
      `,
      [session.shop, address.country, address.state]
    );

    let shippingAmount = 5000;

    if (zone.rowCount) {
      const z = zone.rows[0];
      shippingAmount =
        taxableAmount >= Number(z.min_order)
          ? 0
          : Number(z.shipping_rate);
    }

    /* ---------- GST ---------- */

    const settings = await client.query(
      `SELECT tax_rate FROM shop_settings WHERE shop = $1`,
      [session.shop]
    );

    const taxRate = Number(settings.rows[0]?.tax_rate || 0);
    const totalTax = Math.round(taxableAmount * taxRate);

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (address.country === "IN") {
      cgst = Math.round(totalTax / 2);
      sgst = totalTax - cgst;
    } else {
      igst = totalTax;
    }

    const totalAmount =
      taxableAmount + shippingAmount + totalTax;

    const cartHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          subtotal,
          discount,
          shippingAmount,
          cgst,
          sgst,
          igst,
          totalAmount,
        })
      )
      .digest("hex");

    await client.query(
      `
      UPDATE checkout_sessions
      SET
        shipping_address = $1,
        email = $2,
        phone = $3,
        shipping_amount = $4,
        tax_amount = $5,
        cgst_amount = $6,
        sgst_amount = $7,
        igst_amount = $8,
        total_amount = $9,
        cart_hash = $10,
        step = $11,
        updated_at = now()
      WHERE id = $12
      `,
      [
        address,
        email,
        phone,
        shippingAmount,
        totalTax,
        cgst,
        sgst,
        igst,
        totalAmount,
        cartHash,
        CheckoutStep.ADDRESS_SAVED,
        checkoutSessionId,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      checkoutSessionId,
      totalAmount,
      step: CheckoutStep.ADDRESS_SAVED,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Address update failed:", err);
    return res.status(500).json({ error: "Address save failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   PAY INIT (HARDENED)
====================================================== */

router.post("/pay/init", checkoutLimiter, async (req, res) => {
  const pool = getPool();
  const parsed = payInitSchema.safeParse(req.body);

  if (!parsed.success)
    return res.status(400).json({ error: "Bad payload" });

  const { checkoutSessionId } = parsed.data;

  const r = await pool.query(
    `
    SELECT
      step,
      total_amount,
      currency,
      cart_hash
    FROM checkout_sessions
    WHERE id = $1
    `,
    [checkoutSessionId]
  );

  if (!r.rowCount)
    return res.status(404).json({ error: "Checkout not found" });

  const s = r.rows[0];

  /* ---------- HARD GUARDS ---------- */

  if (s.step !== CheckoutStep.ADDRESS_SAVED) {
    return res.status(400).json({
      error: "Address not completed",
      code: "ADDRESS_REQUIRED",
    });
  }

  if (!s.total_amount || Number(s.total_amount) <= 0) {
    return res.status(400).json({
      error: "Invalid checkout totals",
      code: "TOTALS_MISSING",
    });
  }

  if (!s.cart_hash) {
    return res.status(400).json({
      error: "Checkout not finalized",
      code: "CHECKOUT_NOT_FINALIZED",
    });
  }

  const razorpay = getRazorpayClient();
  const amountPaise = Math.round(Number(s.total_amount));

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: s.currency,
    receipt: `ck_${checkoutSessionId.slice(0, 32)}`,
  });

  await pool.query(
    `
    INSERT INTO payments(
      id,checkout_session_id,gateway,gateway_order_id,
      amount_paise,currency,status,created_at,updated_at
    )
    VALUES(gen_random_uuid(),$1,'razorpay',$2,$3,$4,'CREATED',now(),now())
    `,
    [checkoutSessionId, order.id, amountPaise, s.currency]
  );

  await pool.query(
    `UPDATE checkout_sessions
     SET step=$1, updated_at=now()
     WHERE id=$2`,
    [CheckoutStep.PAYMENT_INITIATED, checkoutSessionId]
  );

  return res.json({
    gateway: "razorpay",
    gatewayOrderId: order.id,
    amountPaise,
    currency: s.currency,
    key: process.env.RAZORPAY_KEY_ID,
  });
});

/* ======================================================
   STATUS
====================================================== */

router.get("/status/:id", async (req, res) => {
  const pool = getPool();

  try {
    const checkoutSessionId = req.params.id;

    const result = await pool.query(
      `
      SELECT
        c.id,
        c.step,
        c.shopify_order_id,
        c.total_amount,
        c.currency,
        p.gateway_order_id,
        p.status AS payment_status
      FROM checkout_sessions c
      LEFT JOIN payments p
        ON p.checkout_session_id = c.id
       AND p.gateway = 'razorpay'
      WHERE c.id = $1
      ORDER BY p.created_at DESC
      LIMIT 1
      `,
      [checkoutSessionId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Checkout not found" });
    }

    const row = result.rows[0];

    return res.json({
      checkoutSessionId: row.id,
      step: row.step,
      shopifyOrderId: row.shopify_order_id,
      paymentStatus: row.payment_status,
      gatewayOrderId: row.gateway_order_id,
      totalAmountPaise: Number(row.total_amount),
      currency: row.currency,
    });
  } catch (err) {
    console.error("Status fetch failed:", err);
    return res.status(500).json({ error: "Status lookup failed" });
  }
});

export default router;
