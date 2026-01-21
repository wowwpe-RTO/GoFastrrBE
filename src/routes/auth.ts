import { Router } from "express";
import { getPool } from "../db";
import bcrypt from "bcrypt";
import crypto from "crypto";
import querystring from "querystring";
import axios from "axios";

import { CheckoutStep } from "../domain/checkoutStates";
import { assertTransition } from "../domain/checkoutTransitions";
import { registerOrdersCreateWebhook } from "../shopify/createWebhook";
import { setToken } from "../storeTokens";

const router = Router();

/**
 * ----------------------------------------
 * OTP Store (TEMP – replace with Redis later)
 * ----------------------------------------
 */
type OtpRecord = {
  phone: string;
  otpHash: string;
  attempts: number;
  expiresAt: number;
};

const otpStore = new Map<string, OtpRecord>();

/**
 * ----------------------------------------
 * POST /auth/otp/send
 * PHONE_ENTERED → OTP_SENT
 * ----------------------------------------
 */
router.post("/otp/send", async (req, res) => {
  const pool = getPool();
  const { phone, shop } = req.body;

  if (!phone || !shop) {
    return res.status(400).json({ error: "Phone and shop required" });
  }

  const checkoutResult = await pool.query(
    `
    INSERT INTO checkout_sessions (
      shop,
      phone,
      step,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, now(), now())
    RETURNING id
    `,
    [shop, phone, CheckoutStep.PHONE_ENTERED]
  );

  const checkoutSessionId = checkoutResult.rows[0].id;

  /**
   * ✅ 4-DIGIT OTP
   */
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const otpHash = await bcrypt.hash(otp, 10);

  otpStore.set(checkoutSessionId, {
    phone,
    otpHash,
    attempts: 0,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  // ⚠️ Replace with SMS provider
  console.log(`📨 OTP for ${phone}: ${otp}`);

  return res.json({ checkoutSessionId });
});

/**
 * ----------------------------------------
 * POST /auth/otp/verify
 * OTP_SENT → OTP_VERIFIED
 * ----------------------------------------
 */
router.post("/otp/verify", async (req, res) => {
  const pool = getPool();
  const { checkoutSessionId, otp } = req.body;

  if (!checkoutSessionId || !otp) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const sessionResult = await pool.query(
    `SELECT step FROM checkout_sessions WHERE id = $1`,
    [checkoutSessionId]
  );

  if (sessionResult.rowCount === 0) {
    return res.status(404).json({ error: "Checkout session not found" });
  }

  const currentStep = sessionResult.rows[0].step;

  /**
   * ✅ Idempotent success
   */
  if (currentStep === CheckoutStep.OTP_VERIFIED) {
    return res.json({ success: true, checkoutSessionId });
  }

  const record = otpStore.get(checkoutSessionId);
  if (!record) {
    return res.status(400).json({ error: "Invalid or expired session" });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(checkoutSessionId);
    return res.status(400).json({ error: "OTP expired" });
  }

  if (record.attempts >= 3) {
    otpStore.delete(checkoutSessionId);
    return res.status(400).json({ error: "Too many attempts" });
  }

  const isValid = await bcrypt.compare(otp, record.otpHash);
  if (!isValid) {
    record.attempts += 1;
    return res.status(400).json({ error: "Invalid OTP" });
  }

  assertTransition(currentStep, CheckoutStep.OTP_VERIFIED);

  console.log(JSON.stringify({
    event: "checkout_transition",
    checkoutSessionId,
    from: currentStep,
    to: CheckoutStep.OTP_VERIFIED
  }));

  await pool.query(
    `
    UPDATE checkout_sessions
    SET step = $1, updated_at = now()
    WHERE id = $2
    `,
    [CheckoutStep.OTP_VERIFIED, checkoutSessionId]
  );

  otpStore.delete(checkoutSessionId);

  return res.json({ success: true, checkoutSessionId });
});

/**
 * ----------------------------------------
 * Shopify OAuth helpers
 * ----------------------------------------
 */
function verifyOAuthHmac(query: Record<string, string>) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET!)
    .update(message)
    .digest("hex");

  if (generated.length !== hmac.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(generated),
    Buffer.from(hmac)
  );
}

/**
 * ----------------------------------------
 * GET /auth/install
 * ----------------------------------------
 */
router.get("/install", (req, res) => {
  const shop = req.query.shop as string;
  if (!shop) return res.status(400).send("Missing shop parameter");

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

/**
 * ----------------------------------------
 * GET /auth/callback
 * ----------------------------------------
 */
router.get("/callback", async (req, res) => {
  const pool = getPool();
  const query = req.query as Record<string, string>;
  const { shop, code } = query;

  if (!shop || !code) {
    return res.status(400).send("Invalid OAuth callback");
  }

  if (!verifyOAuthHmac(query)) {
    return res.status(401).send("Invalid OAuth HMAC");
  }

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

    await registerOrdersCreateWebhook(
      shop,
      accessToken,
      process.env.APP_URL!
    );

    res.setHeader("ngrok-skip-browser-warning", "true");

    return res.send(`
      <html>
        <body style="font-family: sans-serif;">
          <h2>✅ App installed successfully</h2>
          <p>You can now close this window.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ OAuth callback failed", err);
    return res.status(500).send("OAuth failed");
  }
});

export default router;
