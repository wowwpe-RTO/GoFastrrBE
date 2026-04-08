import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import axios from "axios";
import { checkoutLimiter } from "../middleware/rateLimit";
import { getPool } from "../db";
import { CheckoutStep } from "../domain/checkoutStates";
import { recalcTotals } from "../services/recalculateTotals";
import { assertTransition } from "../domain/checkoutTransitions";
import { getToken } from "../services/shopTokenService";
import { getShopBranding } from "../services/shopBrandingService";
import { getRazorpayClient } from "../gateways/razorpay";

const router = Router();

/* ======================================================
   SCHEMAS
====================================================== */

const addressSchema = z.object({
  checkoutSessionId: z.string().uuid(),
  email: z.string().email().optional(),
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
  paymentMethod: z.string().optional(),
});

/* ======================================================
   START CHECKOUT
====================================================== */

router.post("/start", async (req, res) => {
  const { shop, lineItems } = req.body;
  const pool = getPool();

  if (!shop || !Array.isArray(lineItems) || !lineItems.length) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  console.log("SHOP:", shop);



  const client = await pool.connect();
const token = await getToken(shop);

  try {
    await client.query("BEGIN");

    let token = await getToken(shop);

// 🔥 fallback for local dev
if (!token && process.env.SHOPIFY_ADMIN_TOKEN) {
  token = process.env.SHOPIFY_ADMIN_TOKEN;
}

if (!token) {
  throw new Error("Shop token missing");
}

    const sessionResult = await client.query(
      `INSERT INTO checkout_sessions (shop, step, subtotal_amount, currency)
       VALUES ($1, $2, 0, 'INR')
       RETURNING id`,
      [shop, CheckoutStep.CART]
    );

    const sessionId = sessionResult.rows[0].id;

    

    let subtotal = 0;

    for (const item of lineItems) {
      const variantRes = await axios.get(
        `https://${shop}/admin/api/2025-01/variants/${item.variantId}.json`,
        { headers: { "X-Shopify-Access-Token": token.trim() } }
      );

      const variant = variantRes.data?.variant;

      if (!variant) {
        throw new Error("Variant not found");
      }

      if (
        variant.inventory_management &&
        variant.inventory_quantity < item.quantity
      ) {
        throw new Error(`Insufficient stock for ${variant.title}`);
      }

      const productRes = await axios.get(
        `https://${shop}/admin/api/2025-01/products/${variant.product_id}.json`,
        { headers: { "X-Shopify-Access-Token": token.trim() } }
      );

      const product = productRes.data?.product;

      if (!product) {
        throw new Error("Product not found");
      }

      const productTitle = product.title;
      const variantTitle =
        variant.title !== "Default Title" ? variant.title : null;
      const image =
        product?.images?.[0]?.src || product?.image?.src || null;
      const pricePaise = Math.round(Number(variant.price) * 100);
      const comparePrice = variant.compare_at_price
        ? Math.round(Number(variant.compare_at_price) * 100)
        : null;

      subtotal += pricePaise * item.quantity;

      

      await client.query(
        `INSERT INTO checkout_line_items
         (checkout_session_id, variant_id, quantity, unit_price_paise,
          compare_at_price_paise, product_title, variant_title, image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          sessionId,
          variant.id,
          item.quantity,
          pricePaise,
          comparePrice,
          productTitle,
          variantTitle,
          image,
        ]
      );
    }
    
    

    await client.query(
      `UPDATE checkout_sessions
       SET subtotal_amount = $1::numeric,
           total_amount    = $1::numeric,
           updated_at      = now()
       WHERE id = $2`,
      [subtotal, sessionId]
    );

    await client.query("COMMIT");

    return res.json({ checkoutSessionId: sessionId });

  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("Checkout start failed:", err);
    return res.status(500).json({
      error: err.message || "Checkout start failed",
    });
  } finally {
    client.release();
  }
  
});

/* ======================================================
   CART UPDATE
====================================================== */

router.post("/cart/update", async (req, res) => {
  const pool = getPool();

  const schema = z.object({
    checkoutSessionId: z.string().uuid(),
    variantId: z.number(),
    quantity: z.number().min(0).max(10),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { checkoutSessionId, variantId, quantity } = parsed.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const session = await client.query(
      `SELECT shop, cart_locked
       FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!session.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.rows[0].cart_locked) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cart locked during payment" });
    }

    const shop = session.rows[0].shop;

    if (quantity === 0) {
      await client.query(
        `DELETE FROM checkout_line_items
         WHERE checkout_session_id = $1 AND variant_id = $2`,
        [checkoutSessionId, variantId]
      );

      await recalcTotals(client, checkoutSessionId);
      await client.query("COMMIT");

      return res.json({ success: true });
    }

    const existing = await client.query(
      `SELECT id FROM checkout_line_items
       WHERE checkout_session_id = $1 AND variant_id = $2`,
      [checkoutSessionId, variantId]
    );

    if (existing.rowCount) {
      await client.query(
        `UPDATE checkout_line_items
         SET quantity = $1, updated_at = now()
         WHERE checkout_session_id = $2 AND variant_id = $3`,
        [quantity, checkoutSessionId, variantId]
      );
    } else {
      const token = await getToken(shop);

      if (!token) throw new Error("Missing Shopify token");

      const variantRes = await axios.get(
        `https://${shop}/admin/api/2025-01/variants/${variantId}.json`,
        { headers: { "X-Shopify-Access-Token": token.trim() } }
      );

      const variant = variantRes.data?.variant;
      if (!variant) throw new Error("Variant not found");

      const productRes = await axios.get(
        `https://${shop}/admin/api/2025-01/products/${variant.product_id}.json`,
        { headers: { "X-Shopify-Access-Token": token.trim() } }
      );

      const product = productRes.data?.product;

      const productTitle = product?.title || "";
      const variantTitle =
        variant.title !== "Default Title" ? variant.title : null;
      const image =
        variant.image?.src || product?.image?.src || null;
      const pricePaise = Math.round(Number(variant.price) * 100);
      const comparePaise = variant.compare_at_price
        ? Math.round(Number(variant.compare_at_price) * 100)
        : null;

      await client.query(
        `INSERT INTO checkout_line_items
         (checkout_session_id, variant_id, quantity, unit_price_paise,
          compare_at_price_paise, product_title, variant_title, image, vendor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          checkoutSessionId,
          variantId,
          quantity,
          pricePaise,
          comparePaise,
          productTitle,
          variantTitle,
          image,
          product?.vendor || null,
        ]
      );
    }

    await recalcTotals(client, checkoutSessionId);
    await client.query("COMMIT");

    res.json({ success: true });

  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("Cart update failed:", err.message);
    res.status(500).json({ error: "Cart update failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   SHIPPING CALCULATION
====================================================== */

router.post("/shipping/calculate", async (req, res) => {
  const pool = getPool();

  const schema = z.object({
    checkoutSessionId: z.string().uuid(),
    pincode: z.string().min(4),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { checkoutSessionId, pincode } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT subtotal_amount, discount_amount
       FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionResult.rows[0];
    const subtotal = Number(session.subtotal_amount || 0);
    const discount = Number(session.discount_amount || 0);
    const taxableAmount = Math.max(subtotal - discount, 0);

    // Import here to keep calculateShipping as single source of truth
    const { calculateShipping } = await import("../services/calculateShipping");
    const shippingAmount = calculateShipping(taxableAmount, pincode);
    const totalAmount = Math.max(taxableAmount + shippingAmount, 0);

    await client.query(
      `UPDATE checkout_sessions
       SET shipping_amount = $1,
           total_amount    = $2,
           updated_at      = now()
       WHERE id = $3`,
      [shippingAmount, totalAmount, checkoutSessionId]
    );

    await client.query("COMMIT");

    res.json({ shippingPaise: shippingAmount, totalPaise: totalAmount });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Shipping calculation failed:", err);
    res.status(500).json({ error: "Shipping calculation failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   ADDRESS SAVE
====================================================== */

router.post("/address", async (req, res) => {
  const pool = getPool();
  const parsed = addressSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid input",
      details: parsed.error.flatten(),
    });
  }

  const { checkoutSessionId, email, phone, address } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT step FROM checkout_sessions WHERE id = $1 FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    const currentStep = sessionResult.rows[0].step;

    let nextStep: CheckoutStep;

    if (
      currentStep === CheckoutStep.OTP_VERIFIED ||
      currentStep === CheckoutStep.ADDRESS_SAVED
    ) {
      nextStep = CheckoutStep.PAYMENT_READY;
    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid checkout state" });
    }

    await client.query(
      `UPDATE checkout_sessions
       SET email            = $1,
           phone            = $2,
           shipping_address = $3,
           step             = $4,
           updated_at       = now()
       WHERE id = $5`,
      [email, phone, JSON.stringify(address), nextStep, checkoutSessionId]
    );

    await client.query("COMMIT");

    return res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Address save failed:", err);
    return res.status(500).json({ error: "Address save failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   PAY INIT
   FIX: writes PAYMENT_INITIATED step so reconciliation
   job can find stuck sessions.
====================================================== */

router.post("/pay/init", checkoutLimiter, async (req, res) => {
  const pool = getPool();
  const parsed = payInitSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Bad payload" });
  }

  const { checkoutSessionId, paymentMethod } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const r = await client.query(
      `SELECT step, total_amount, currency
       FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Checkout not found" });
    }

    const s = r.rows[0];

    if (
      s.step !== CheckoutStep.ADDRESS_SAVED &&
      s.step !== CheckoutStep.PAYMENT_READY &&
      s.step !== CheckoutStep.PAYMENT_INITIATED
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Checkout not ready for payment" });
    }

    const totalPaise = Number(s.total_amount || 0);

    if (!totalPaise || !s.currency) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid checkout totals" });
    }

    const isPartial = paymentMethod === "PARTIAL";
    const amountPaise = isPartial
      ? Math.floor(totalPaise * 0.5)
      : totalPaise;
    const remainingAmount = isPartial ? totalPaise - amountPaise : 0;

    // Idempotency — return existing order if already created
    const existingPayment = await client.query(
      `SELECT gateway_order_id
       FROM payments
       WHERE checkout_session_id = $1
         AND status IN ('CREATED','AUTHORIZED','CAPTURED')
       LIMIT 1`,
      [checkoutSessionId]
    );

    if (existingPayment.rowCount) {
      await client.query("ROLLBACK");
      return res.json({
        gatewayOrderId: existingPayment.rows[0].gateway_order_id,
        reused: true,
      });
    }

    const razorpay = getRazorpayClient();

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: s.currency,
      receipt: `ck_${checkoutSessionId.slice(0, 20)}`,
    });

    await client.query(
      `INSERT INTO payments(
         id,
         checkout_session_id,
         gateway,
         gateway_order_id,
         amount_paise,
         currency,
         status,
         selected_method,
         is_partial,
         remaining_amount_paise,
         created_at,
         updated_at
       )
       VALUES(
         gen_random_uuid(),
         $1, 'razorpay',
         $2, $3, $4,
         'CREATED',
         $5, $6, $7,
         now(), now()
       )`,
      [
        checkoutSessionId,
        order.id,
        amountPaise,
        s.currency,
        paymentMethod || null,
        isPartial,
        remainingAmount,
      ]
    );

    // ✅ Advance step so reconciliation job can find stuck sessions
    await client.query(
      `UPDATE checkout_sessions
       SET step       = 'PAYMENT_INITIATED',
           updated_at = now()
       WHERE id = $1`,
      [checkoutSessionId]
    );

    await client.query("COMMIT");

    res.json({
      gatewayOrderId: order.id,
      amountPaise,
      currency: s.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });

  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("Pay init failed:", err);
    res.status(500).json({ error: "Pay init failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   DETAILS
   FIX: missing comma after applied_coupon_code
====================================================== */

router.get("/details/:id", async (req, res) => {
  const pool = getPool();

  try {
    const checkoutSessionId = req.params.id;

    const sessionResult = await pool.query(
      `SELECT
         id,
         step,
         shop,
         phone,
         email,
         shipping_address,
         subtotal_amount,
         discount_amount,
         applied_coupon_code,
         shipping_amount,
         tax_amount,
         total_amount,
         currency
       FROM checkout_sessions
       WHERE id = $1`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      return res.status(404).json({ error: "Checkout not found" });
    }

    const session = sessionResult.rows[0];

    const itemsResult = await pool.query(
      `SELECT
         variant_id,
         quantity,
         unit_price_paise,
         compare_at_price_paise,
         product_title,
         variant_title,
         image
       FROM checkout_line_items
       WHERE checkout_session_id = $1`,
      [checkoutSessionId]
    );

    res.set("Cache-Control", "no-store");

    // Fetch branding in parallel with items — cached after first call
    const branding = await getShopBranding(session.shop).catch(() => ({
      storeName: null,
      logoUrl: null,
    }));

    return res.json({
      checkoutSessionId: session.id,
      step: session.step,
      currency: session.currency,
      phone: session.phone || null,
      email: session.email || null,
      shippingAddress: session.shipping_address
        ? (typeof session.shipping_address === "string"
            ? JSON.parse(session.shipping_address)
            : session.shipping_address)
        : null,

      totals: {
        subtotalPaise: Number(session.subtotal_amount || 0),
        discountPaise: Number(session.discount_amount || 0),
        couponCode: session.applied_coupon_code || null,
        shippingPaise: Number(session.shipping_amount || 0),
        taxPaise: Number(session.tax_amount || 0),
        totalPaise: Number(session.total_amount || 0),
      },

      lineItems: itemsResult.rows,

      branding,
    });

  } catch (err) {
    console.error("Details fetch failed:", err);
    return res.status(500).json({ error: "Details lookup failed" });
  }
});

/* ======================================================
   UPSELL
====================================================== */

router.get("/upsell", async (req, res) => {
  const { shop } = req.query;

  if (!shop || typeof shop !== "string") {
    return res.status(400).json({ error: "Missing shop" });
  }

  try {
    const token = await getToken(shop);

    if (!token) {
      return res.status(400).json({ error: "Shop not installed" });
    }

    const response = await axios.get(
      `https://${shop}/admin/api/2025-01/products.json?limit=6&status=active`,
      { headers: { "X-Shopify-Access-Token": token.trim() } }
    );

    const products = response.data.products || [];

    const formatted = products
      .filter((p: any) => p.variants?.length)
      .map((p: any) => ({
        id: p.id,
        title: p.title,
        brand: p.vendor,
        price: Math.round(Number(p.variants[0].price)),
        compareAtPrice: p.variants[0].compare_at_price
          ? Math.round(Number(p.variants[0].compare_at_price))
          : null,
        image: p.image?.src || null,
        variantId: p.variants[0].id,
      }));

    return res.json({ products: formatted });

  } catch (err: any) {
    console.error("Upsell fetch failed:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to fetch upsell products" });
  }
});

/* ======================================================
   COUPONS LIST
====================================================== */

router.get("/coupons", async (_req, res) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT code, type, value, min_order_amount
    FROM coupons
    WHERE active = true
    AND (expires_at IS NULL OR expires_at > now())
  `);

  res.json({ coupons: result.rows });
});

/* ======================================================
   COUPON APPLY
====================================================== */

router.post("/coupon/apply", async (req, res) => {
  const { checkoutSessionId, code } = req.body;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const session = await client.query(
      `SELECT subtotal_amount
       FROM checkout_sessions
       WHERE id=$1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!session.rowCount) throw new Error("Session not found");

    const subtotal = Number(session.rows[0].subtotal_amount || 0);

    const coupon = await client.query(
      `SELECT *
       FROM coupons
       WHERE code=$1
         AND active=true
         AND (expires_at IS NULL OR expires_at > now())`,
      [code]
    );

    if (!coupon.rowCount) throw new Error("Invalid coupon");

    const c = coupon.rows[0];

    if (subtotal < c.min_order_amount) {
      throw new Error("Minimum order not met");
    }

    let discount = 0;

    if (c.type === "FLAT") discount = c.value;
    if (c.type === "PERCENT") {
      discount = Math.floor(subtotal * (c.value / 100));
    }
    if (c.max_discount) {
      discount = Math.min(discount, c.max_discount);
    }

    await client.query(
      `UPDATE checkout_sessions
       SET discount_amount     = $1,
           applied_coupon_code = $2,
           updated_at          = now()
       WHERE id = $3`,
      [discount, code, checkoutSessionId]
    );

    await recalcTotals(client, checkoutSessionId);

    const totals = await client.query(
      `SELECT total_amount FROM checkout_sessions WHERE id = $1`,
      [checkoutSessionId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      couponCode: code,
      couponType: c.type,
      couponValue: c.value,
      discountPaise: discount,
      totalPaise: Number(totals.rows[0].total_amount || 0),
    });

  } catch (err: any) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message || "Coupon apply failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   COUPON REMOVE
====================================================== */

router.post("/coupon/remove", async (req, res) => {
  const { checkoutSessionId } = req.body;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE checkout_sessions
       SET discount_amount     = 0,
           applied_coupon_code = NULL,
           updated_at          = now()
       WHERE id = $1`,
      [checkoutSessionId]
    );

    await recalcTotals(client, checkoutSessionId);

    const totals = await client.query(
      `SELECT total_amount FROM checkout_sessions WHERE id = $1`,
      [checkoutSessionId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      couponCode: null,
      discountPaise: 0,
      totalPaise: Number(totals.rows[0].total_amount || 0),
    });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Coupon remove failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   STEP BACK
   Allows mobile back button to navigate one step back.
   Safe — only allows stepping back, never forward.
====================================================== */

router.post("/step/back", async (req, res) => {
  const { checkoutSessionId } = req.body;
  const pool = getPool();

  if (!checkoutSessionId) {
    return res.status(400).json({ error: "Missing checkoutSessionId" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT step FROM checkout_sessions WHERE id = $1 FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    const currentStep = result.rows[0].step;

    // Map each step to the previous step
    const backMap: Record<string, string> = {
      [CheckoutStep.OTP_SENT]:          CheckoutStep.CART,
      [CheckoutStep.OTP_VERIFIED]:      CheckoutStep.CART,
      [CheckoutStep.ADDRESS_SAVED]:     CheckoutStep.OTP_VERIFIED,
      [CheckoutStep.PAYMENT_READY]:     CheckoutStep.OTP_VERIFIED,
      [CheckoutStep.PAYMENT_INITIATED]: CheckoutStep.OTP_VERIFIED,
      [CheckoutStep.PARTIALLY_PAID]:    CheckoutStep.OTP_VERIFIED,
    };

    const previousStep = backMap[currentStep];

    if (!previousStep) {
      await client.query("ROLLBACK");
      // Already at the start or a terminal step — treat as no-op
      return res.json({ success: true, step: currentStep, noop: true });
    }

    await client.query(
      `UPDATE checkout_sessions SET step = $1, updated_at = now() WHERE id = $2`,
      [previousStep, checkoutSessionId]
    );

    await client.query("COMMIT");

    return res.json({ success: true, step: previousStep });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Step back failed:", err);
    return res.status(500).json({ error: "Step back failed" });
  } finally {
    client.release();
  }
});

router.get("/redirect", async (req, res) => {
  try {
    const { shop, variantId, quantity } = req.query;

    if (!shop || !variantId) {
      return res.status(400).send("Missing params");
    }

    // 🔥 IMPORTANT: call your existing /start endpoint internally
    const startResponse = await axios.post(
      `${process.env.APP_URL}/checkout/start`,
      {
        shop,
        lineItems: [
          {
            variantId: Number(variantId),
            quantity: Number(quantity || 1),
          },
        ],
      }
    );

    const sessionId = startResponse.data.checkoutSessionId;

    return res.redirect(
      `https://checkout.wowwpe.io/checkout?session=${sessionId}&shop=${shop}`
    );

  } catch (err: any) {
    console.error("Redirect error FULL:", err?.response?.data || err.message);
    return res.status(500).json({
      error: err?.response?.data || err?.message || "Unknown error",
    });
  }
});


export default router;