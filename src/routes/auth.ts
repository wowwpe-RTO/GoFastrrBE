import { Router } from "express";
import { z } from "zod";
import { otpLimiter } from "../middleware/rateLimit";
import { getPool } from "../db";
import crypto from "crypto";
import querystring from "querystring";
import axios from "axios";

import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";
import { registerOrdersCreateWebhook } from "../shopify/createWebhook";
import { setToken, getToken } from "../services/shopTokenService";

const router = Router();

/**
 * OTP send schema (cart locked here)
 */
const otpSendSchema = z.object({
  phone: z.string().trim().regex(/^\d{6,15}$/),
  shop: z.string().trim().regex(/^[a-z0-9.-]+\.myshopify\.com$/),
  discountCode: z.string().optional(),
  lineItems: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(10),
      })
    )
    .min(1)
    .max(10),
});


const otpVerifySchema = z.object({
  checkoutSessionId: z.string().uuid(),
  otp: z.string().length(4),
});

function hashOtp(otp: string) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

/**
 * ----------------------------------------
 * POST /auth/otp/send
 * ----------------------------------------
 */
router.post("/otp/send", otpLimiter, async (req, res) => {
  const pool = getPool();
  const parsed = otpSendSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid input",
      details: parsed.error.flatten(),
    });
  }

  const { phone, shop, lineItems, discountCode } = parsed.data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // OTP Rate limit
    const recent = await client.query(
      `
      SELECT count(*)
      FROM otp_codes
      WHERE phone = $1
        AND created_at > now() - interval '10 minutes'
      `,
      [phone]
    );

    if (Number(recent.rows[0].count) >= 3) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        error: "Too many OTP requests",
        code: "OTP_RATE_LIMIT",
      });
    }

    const accessToken = await getToken(shop);
    if (!accessToken) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Shop not installed" });
    }

    // Create session
    const checkoutResult = await client.query(
      `
      INSERT INTO checkout_sessions (
        shop,
        phone,
        step,
        currency,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,'INR',now(),now())
      RETURNING id
      `,
      [shop, phone, CheckoutStep.PHONE_ENTERED]
    );

    const checkoutSessionId = checkoutResult.rows[0].id;

    // Build subtotal
    let subtotal = 0;

    for (const item of lineItems) {
      const variantResp = await axios.get(
        `https://${shop}/admin/api/2025-10/variants/${item.variantId}.json`,
        {
          headers: { "X-Shopify-Access-Token": accessToken },
        }
      );

      const variant = variantResp.data.variant;
      if (!variant?.price) throw new Error("Invalid variant");

      const unitPrice = Math.round(Number(variant.price) * 100);
      const lineTotal = unitPrice * item.quantity;

      subtotal += lineTotal;

      await client.query(
        `
        INSERT INTO checkout_line_items
        (checkout_session_id, variant_id, quantity, unit_price_paise, title)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          checkoutSessionId,
          item.variantId,
          item.quantity,
          unitPrice,
          variant.title,
        ]
      );
    }

    /**
     * DISCOUNT VALIDATION (Shopify Price Rules)
     */
    let discountAmount = 0;

    if (discountCode) {
      const discountResp = await axios.get(
        `https://${shop}/admin/api/2025-10/discount_codes/lookup.json?code=${discountCode}`,
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );

      const discount = discountResp.data.discount_code;

      if (discount) {
        const ruleResp = await axios.get(
          `https://${shop}/admin/api/2025-10/price_rules/${discount.price_rule_id}.json`,
          { headers: { "X-Shopify-Access-Token": accessToken } }
        );

        const rule = ruleResp.data.price_rule;

        if (rule.value_type === "percentage") {
          discountAmount = Math.round(
            subtotal * (Math.abs(Number(rule.value)) / 100)
          );
        }

        if (rule.value_type === "fixed_amount") {
          discountAmount = Math.abs(Math.round(Number(rule.value) * 100));
        }
      }
    }

    /**
     * TAX + SHIPPING SETTINGS
     */
    const settingsResult = await client.query(
      `
      SELECT tax_rate, free_shipping_threshold, default_shipping_rate
      FROM shop_settings
      WHERE shop = $1
      `,
      [shop]
    );

    const settings = settingsResult.rows[0] || {
      tax_rate: 0,
      free_shipping_threshold: 500000,
      default_shipping_rate: 5000,
    };

    const taxableAmount = subtotal - discountAmount;

    const taxAmount = Math.round(
      taxableAmount * Number(settings.tax_rate)
    );

    const shippingAmount =
      taxableAmount >= Number(settings.free_shipping_threshold)
        ? 0
        : Number(settings.default_shipping_rate);

    const total =
      taxableAmount + taxAmount + shippingAmount;

    // Persist breakdown
    await client.query(
      `
      UPDATE checkout_sessions
      SET
        subtotal_amount = $1,
        discount_code = $2,
        discount_amount = $3,
        shipping_amount = $4,
        tax_amount = $5,
        total_amount = $6,
        step = $7,
        updated_at = now()
      WHERE id = $8
      `,
      [
        subtotal,
        discountCode || null,
        discountAmount,
        shippingAmount,
        taxAmount,
        total,
        CheckoutStep.OTP_SENT,
        checkoutSessionId,
      ]
    );

    // OTP
    const otp = crypto.randomInt(1000, 10000).toString();
    const otpHash = hashOtp(otp);

    await client.query(
      `
      INSERT INTO otp_codes
      (phone, otp_hash, checkout_session_id, attempts, expires_at)
      VALUES ($1,$2,$3,0, now() + interval '5 minutes')
      `,
      [phone, otpHash, checkoutSessionId]
    );

    await client.query("COMMIT");

    if (process.env.NODE_ENV !== "production") {
      console.log(`OTP for ${phone}: ${otp}`);
    }

    return res.json({
      checkoutSessionId,
      subtotal,
      discountAmount,
      shippingAmount,
      taxAmount,
      total,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("OTP send failed:", err);
    return res.status(500).json({ error: "OTP send failed" });
  } finally {
    client.release();
  }
});




/**
 * ----------------------------------------
 * POST /auth/otp/verify
 * ----------------------------------------
 */
router.post("/otp/verify", otpLimiter, async (req, res) => {
  const pool = getPool();

  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { checkoutSessionId, otp } = parsed.data;
  const otpHash = hashOtp(otp);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /**
     * Lock checkout session
     */
    const sessionResult = await client.query(
      `SELECT step FROM checkout_sessions WHERE id = $1 FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Checkout session not found" });
    }

    const currentStep = sessionResult.rows[0].step;

    if (currentStep === CheckoutStep.OTP_VERIFIED) {
      await client.query("COMMIT");
      return res.json({ success: true, checkoutSessionId });
    }

    assertTransition(currentStep, CheckoutStep.OTP_VERIFIED);

    /**
     * Lock OTP row
     */
    const otpRow = await client.query(
      `
      SELECT id, attempts
      FROM otp_codes
      WHERE checkout_session_id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (!otpRow.rowCount) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        error: "OTP expired",
        code: "OTP_EXPIRED",
      });
    }

    const otpRecord = otpRow.rows[0];

    /**
     * Too many attempts
     */
    if (Number(otpRecord.attempts) >= 5) {
      await client.query("COMMIT");
      return res.status(429).json({
        error: "Too many failed attempts",
        code: "OTP_LOCKED",
      });
    }

    /**
     * Validate OTP
     */
    const validOtpResult = await client.query(
      `
      SELECT id
      FROM otp_codes
      WHERE id = $1
        AND otp_hash = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      `,
      [otpRecord.id, otpHash]
    );

    if (!validOtpResult.rowCount) {
      /**
       * Increment attempt count
       */
      await client.query(
        `
        UPDATE otp_codes
        SET attempts = attempts + 1
        WHERE id = $1
        `,
        [otpRecord.id]
      );

      await client.query("COMMIT");

      return res.status(401).json({
        error: "Invalid OTP",
        code: "OTP_INVALID",
      });
    }

    /**
     * Mark consumed
     */
    await client.query(
      `
      UPDATE otp_codes
      SET consumed_at = now()
      WHERE id = $1
      `,
      [otpRecord.id]
    );

    /**
     * Advance checkout step
     */
    await client.query(
      `
      UPDATE checkout_sessions
      SET step = $1, updated_at = now()
      WHERE id = $2
      `,
      [CheckoutStep.OTP_VERIFIED, checkoutSessionId]
    );

    await client.query("COMMIT");

    return res.json({ success: true, checkoutSessionId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("OTP verify failed:", err);
    return res.status(500).json({ error: "Verification failed" });
  } finally {
    client.release();
  }
});

/**
 * Shopify OAuth unchanged
 */
function verifyOAuthHmac(query: Record<string, string>) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = querystring.stringify(rest);

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET!)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmac));
}

router.get("/install", (req, res) => {
  const shop = req.query.shop as string;
  if (!shop) return res.status(400).send("Missing shop");

  const state = crypto.randomBytes(16).toString("hex");

  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    querystring.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      scope: process.env.SHOPIFY_SCOPES,
      redirect_uri: `${process.env.APP_URL}/auth/callback`,
      state,
    });

  res.redirect(installUrl);
});

router.get("/callback", async (req, res) => {
  const query = req.query as Record<string, string>;
  const { shop, code } = query;

  if (!shop || !code) return res.status(400).send("Invalid callback");
  if (!verifyOAuthHmac(query)) return res.status(401).send("Invalid HMAC");

  try {
    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }
    );

    const accessToken = tokenResponse.data.access_token;

    await setToken(shop, accessToken);
    await registerOrdersCreateWebhook(shop, accessToken, process.env.APP_URL!);

    return res.send("<h2>Installed. You may close this window.</h2>");
  } catch (err: any) {
  console.error("OAuth callback failed FULL:", err?.response?.data || err);
  return res.status(500).json(err?.response?.data || err);
}
});

export default router;
