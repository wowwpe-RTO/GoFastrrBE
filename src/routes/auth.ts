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
import { setToken } from "../services/shopTokenService";

// FIX #8: import both WA and SMS senders at top level — no more dynamic imports
import { sendWhatsAppOtp } from "../services/smsala.service";
import { sendSmsOtp } from "../services/sms.service";

const router = Router();

// Utility: 1s delay for WA retry backoff
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ======================================================
   SCHEMAS
====================================================== */

// FIX #3: removed `shop` — was parsed but never used in handler
const otpSendSchema = z.object({
  checkoutSessionId: z.string().uuid(),
  phone: z.string().trim().regex(/^(\+91|91)?[6-9]\d{9}$/),
});

const otpVerifySchema = z.object({
  checkoutSessionId: z.string().uuid(),
  otp: z.string().length(4),
});

function hashOtp(otp: string) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function normalizePhone(phone: string): string {
  // remove non-digits
  let cleaned = phone.replace(/\D/g, "");

  // remove leading country code if already present
  if (cleaned.startsWith("91") && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  }

  // now enforce 10-digit format
  if (cleaned.length !== 10) {
    throw new Error("Invalid phone number");
  }

  return cleaned;
}

/* ======================================================
   POST /auth/otp/send
====================================================== */

router.post("/otp/send", otpLimiter, async (req, res) => {
  const pool = getPool();
  const parsed = otpSendSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid input",
      details: parsed.error.flatten(),
    });
  }

  const { checkoutSessionId, phone: rawPhone } = parsed.data;
  const phone = normalizePhone(rawPhone);


  const client = await pool.connect();

try {
  await client.query("SELECT 1"); 
  await client.query("BEGIN");

  

const sessionResult = await client.query(
  `SELECT step FROM checkout_sessions
   WHERE id = $1
   FOR UPDATE`,
  [checkoutSessionId]
);

if (!sessionResult.rowCount) {
  await client.query("ROLLBACK");
  return res.status(404).json({ error: "Session not found" });
}

const currentStep = sessionResult.rows[0].step;


    if (
      currentStep !== CheckoutStep.CART &&
      currentStep !== CheckoutStep.OTP_SENT
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid checkout state" });
    }

    // await client.query(
    //   `UPDATE checkout_sessions
    //    SET phone = $1,
    //        step = $2,
    //        updated_at = now()
    //    WHERE id = $3`,
    //   [phone, CheckoutStep.OTP_SENT, checkoutSessionId]
    // );

    const otp = crypto.randomInt(1000, 10000).toString();
    const otpHash = hashOtp(otp);

    // await client.query(
    //   `INSERT INTO otp_codes
    //    (phone, otp_hash, checkout_session_id, attempts, expires_at)
    //    VALUES ($1, $2, $3, 0, now() + interval '5 minutes')`,
    //   [phone, otpHash, checkoutSessionId]
    // );

  // ALWAYS update DB — remove condition
await client.query(
  `UPDATE checkout_sessions
   SET phone = $1,
       step = $2,
       updated_at = now()
   WHERE id = $3`,
  [phone, CheckoutStep.OTP_SENT, checkoutSessionId]
);

await client.query(
  `INSERT INTO otp_codes
   (phone, otp_hash, checkout_session_id, attempts, expires_at)
   VALUES ($1, $2, $3, 0, now() + interval '5 minutes')`,
  [phone, otpHash, checkoutSessionId]
);


  await client.query("COMMIT");

    // --- OTP delivery: WA attempt → WA retry (1s backoff) → SMS fallback ---
    // FIX #2: real retry with delay + SMS fallback wired (was duplicate WA call with no delay)
    let campaignId: number | null = null;
    let deliveryMode = "whatsapp";

   try {
  campaignId = await sendWhatsAppOtp(phone, otp);
} catch (err1: any) {
  console.error("❌ WA ERROR (first attempt):", {
    message: err1.message,
    status: err1.response?.status,
    data: err1.response?.data,
  });

  await delay(1000);

  try {
    campaignId = await sendWhatsAppOtp(phone, otp);
  } catch (err2: any) {
    console.error("❌ WA ERROR (retry):", {
      message: err2.message,
      status: err2.response?.status,
      data: err2.response?.data,
    });

    try {
      await sendSmsOtp(phone, otp);
      deliveryMode = "sms";
    } catch (err3: any) {
      console.error("❌ SMS ERROR:", {
        message: err3.message,
        status: err3.response?.status,
        data: err3.response?.data,
      });

      deliveryMode = "failed";
    }
  }
}

    // FIX #1: campaign_id persisted BEFORE return — was unreachable dead code
    if (campaignId) {
     await client.query(
  `UPDATE otp_codes
   SET campaign_id = $1
   WHERE id = (
     SELECT id FROM otp_codes
     WHERE checkout_session_id = $2
       AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
   )`,
  [campaignId, checkoutSessionId]
);
    }

    return res.json({ checkoutSessionId, campaignId, deliveryMode });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("OTP send failed:", err);
    return res.status(500).json({ error: "OTP send failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   POST /auth/otp/resend
====================================================== */

router.post("/otp/resend", otpLimiter, async (req, res) => {
  const pool = getPool();

  const schema = z.object({
    checkoutSessionId: z.string().uuid(),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { checkoutSessionId } = parsed.data;

  const client = await pool.connect();

try {
  await client.query("SELECT 1");
  await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT step, phone FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    const { step, phone } = sessionResult.rows[0];

    if (step !== CheckoutStep.OTP_SENT) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid checkout state for resend" });
    }

    if (!phone) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No phone on session" });
    }

    // FIX #6: phone is already "91XXXXXXXXXX" from DB — normalizePhone is safe/defensive here
    const normalizedPhone = normalizePhone(phone);

    await client.query(
      `UPDATE otp_codes
       SET consumed_at = now()
       WHERE checkout_session_id = $1
         AND consumed_at IS NULL`,
      [checkoutSessionId]
    );

    const otp = crypto.randomInt(1000, 10000).toString();
    const otpHash = hashOtp(otp);

    await client.query(
      `INSERT INTO otp_codes
       (phone, otp_hash, checkout_session_id, attempts, expires_at)
       VALUES ($1, $2, $3, 0, now() + interval '5 minutes')`,
      [normalizedPhone, otpHash, checkoutSessionId]
    );

    await client.query("COMMIT");

    // FIX #2: same retry + SMS fallback pattern as /otp/send
    let campaignId: number | null = null;
    let deliveryMode = "whatsapp";

    try {
      campaignId = await sendWhatsAppOtp(normalizedPhone, otp);
    } catch (err1) {
      console.error("Resend WA failed, retrying after 1s...", err1);
      await delay(1000);

      try {
        campaignId = await sendWhatsAppOtp(normalizedPhone, otp);
      } catch (err2) {
        console.error("Resend WA retry failed, SMS fallback...", err2);

        try {
          await sendSmsOtp(normalizedPhone, otp);
          deliveryMode = "sms";
        } catch (err3) {
          console.error("Resend SMS fallback also failed:", err3);
          deliveryMode = "failed";
        }
      }
    }

    // FIX #1: persist campaignId on resend path too
    if (campaignId) {
      await client.query(
  `UPDATE otp_codes
   SET campaign_id = $1
   WHERE id = (
     SELECT id FROM otp_codes
     WHERE checkout_session_id = $2
       AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
   )`,
  [campaignId, checkoutSessionId]
);
    }

    return res.json({ success: true, deliveryMode });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("OTP resend failed:", err);
    return res.status(500).json({ error: "OTP resend failed" });
  } finally {
    client.release();
  }
});

/* ======================================================
   POST /auth/otp/verify
====================================================== */

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
  await client.query("SELECT 1");
  await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT step, phone
       FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Checkout session not found" });
    }

    const currentStep = sessionResult.rows[0].step as CheckoutStep;
    const phone: string | null = sessionResult.rows[0].phone;

    if (currentStep === CheckoutStep.ADDRESS_SAVED) {
      await client.query("COMMIT");
      return res.json({ success: true, checkoutSessionId });
    }

    assertTransition(currentStep, CheckoutStep.OTP_VERIFIED);

    const otpRow = await client.query(
      `SELECT id, attempts
       FROM otp_codes
       WHERE checkout_session_id = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!otpRow.rowCount) {
      await client.query("ROLLBACK");
      return res.status(401).json({ error: "OTP expired" });
    }

    const otpRecord = otpRow.rows[0];

    if (Number(otpRecord.attempts) >= 5) {
      await client.query("COMMIT");
      return res.status(429).json({ error: "Too many attempts" });
    }

    const validOtp = await client.query(
      `SELECT id
       FROM otp_codes
       WHERE id = $1
         AND otp_hash = $2
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [otpRecord.id, otpHash]
    );

    if (!validOtp.rowCount) {
      await client.query(
        `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`,
        [otpRecord.id]
      );
      await client.query("COMMIT");
      return res.status(401).json({ error: "Invalid OTP" });
    }

    await client.query(
      `UPDATE otp_codes SET consumed_at = now() WHERE id = $1`,
      [otpRecord.id]
    );

    let nextStep: CheckoutStep = CheckoutStep.OTP_VERIFIED;
    let previousAddresses: any[] = [];

    if (phone) {
      // FIX #4: single query — rows[0] is already the most recent
      // Removed the redundant second LIMIT 1 query
      const previous = await client.query(
        `SELECT shipping_address, email, created_at
         FROM checkout_sessions
         WHERE phone = $1
           AND shipping_address IS NOT NULL
           AND id <> $2
         ORDER BY created_at DESC`,
        [phone, checkoutSessionId]
      );

      if (previous.rowCount && previous.rows.length > 0) {
        // rows[0] = most recent — no second query needed
        const savedAddress = previous.rows[0].shipping_address;

        await client.query(
          `UPDATE checkout_sessions
           SET shipping_address = $1,
               step = $2,
               updated_at = now()
           WHERE id = $3`,
          [savedAddress, CheckoutStep.ADDRESS_SAVED, checkoutSessionId]
        );

        nextStep = CheckoutStep.ADDRESS_SAVED;

        const seen = new Set<string>();
        previousAddresses = previous.rows.reduce((acc: any[], r: any) => {
          const addr =
            typeof r.shipping_address === "string"
              ? JSON.parse(r.shipping_address)
              : r.shipping_address;
          const key = `${(addr.line1 || "").toLowerCase().trim()}|${(addr.postalCode || "").trim()}`;
          if (!seen.has(key)) {
            seen.add(key);
            acc.push({ ...addr, email: r.email });
          }
          return acc;
        }, []);

        console.log(
          `Returning user ${phone}: ${previousAddresses.length} unique address(es) found`
        );
      } else {
        await client.query(
          `UPDATE checkout_sessions
           SET step = $1, updated_at = now()
           WHERE id = $2`,
          [CheckoutStep.OTP_VERIFIED, checkoutSessionId]
        );
      }
    } else {
      await client.query(
        `UPDATE checkout_sessions
         SET step = $1, updated_at = now()
         WHERE id = $2`,
        [CheckoutStep.OTP_VERIFIED, checkoutSessionId]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      checkoutSessionId,
      step: nextStep,
      previousAddresses,
    });

  } catch (err: any) {
  await client.query("ROLLBACK");

  if (err.message?.includes("Connection terminated")) {
    console.warn("⚠️ Dead DB connection, retrying once...");

    try {
      const retryClient = await pool.connect();
      await retryClient.query("SELECT 1");

      // minimal retry (don’t repeat full logic, just fail gracefully)
      retryClient.release();

      return res.status(503).json({ error: "Temporary DB issue, retry" });
    } catch (retryErr) {
      console.error("Retry failed:", retryErr);
    }
  }

  console.error("OTP verify failed:", err);
  return res.status(500).json({ error: "Verification failed" });
} finally {
    client.release();
  }
});

/* ======================================================
   POST /auth/otp/edit
====================================================== */

router.post("/otp/edit", async (req, res) => {
  const { checkoutSessionId } = req.body;
  const pool = getPool();

  if (!checkoutSessionId) {
    return res.status(400).json({ error: "Missing session id" });
  }

  // FIX #5: wrap in transaction with FOR UPDATE — prevents race condition
  // where two concurrent /otp/edit requests both read CART state and both succeed
  const client = await pool.connect();

try {
  await client.query("SELECT 1");
  await client.query("BEGIN");

    const check = await client.query(
      `SELECT step, shopify_order_id
       FROM checkout_sessions
       WHERE id = $1
       FOR UPDATE`,
      [checkoutSessionId]
    );

    if (!check.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }

    const { step, shopify_order_id } = check.rows[0];

    if (
      step === CheckoutStep.COMPLETED ||
      step === CheckoutStep.PARTIALLY_PAID ||
      shopify_order_id
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot edit a completed order" });
    }

    await client.query(
      `UPDATE checkout_sessions
       SET step = $1, updated_at = now()
       WHERE id = $2`,
      [CheckoutStep.CART, checkoutSessionId]
    );

    await client.query("COMMIT");

    return res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("OTP edit failed:", err);
    return res.status(500).json({ error: "Failed to edit phone" });
  } finally {
    client.release();
  }
});

/* ======================================================
   SHOPIFY OAUTH
====================================================== */

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
      redirect_uri: `${process.env.APP_URL}/shopify/callback`,
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
    console.error("OAuth callback failed:", err?.response?.data || err);
    return res.status(500).json(err?.response?.data || err);
  }
});

router.get("/otp/dlr/:campaignId", async (req, res) => {
  const { campaignId } = req.params;

  try {
    const { getDlr } = await import("../services/smsala.dlr.service");
    const data = await getDlr(campaignId);

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch DLR" });
  }
});

export default router;