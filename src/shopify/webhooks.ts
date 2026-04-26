import { Router } from "express";
import crypto from "crypto";
import { getPool } from "../db";

const router = Router();

/**
 * Shopify Orders Create Webhook
 * MUST receive raw Buffer (mounted with express.raw in server.ts)
 */
router.post("/", async (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  // Always ACK if missing to avoid retry storms
  if (!hmacHeader) {
    return res.status(200).send("OK");
  }

  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    console.error("❌ SHOPIFY_CLIENT_SECRET missing");
    return res.status(500).send("Server misconfigured");
  }

  const webhookId = req.get("X-Shopify-Webhook-Id");
  const topic = req.get("X-Shopify-Topic") ?? "orders/create";
  const shop = req.get("X-Shopify-Shop-Domain");

  if (!webhookId || !shop) {
    return res.status(200).send("OK");
  }

  try {
    /* ======================================================
       1️⃣ VERIFY SIGNATURE (RAW BODY ONLY)
    ====================================================== */

    const rawBody = req.body as Buffer;

    if (!Buffer.isBuffer(rawBody)) {
      console.error("❌ Webhook body is not raw Buffer");
      return res.status(200).send("OK");
    }

    const generatedHmac = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");

    const safeCompare = (a: string, b: string) => {
  const aBuf = Buffer.from(a, "base64");
  const bBuf = Buffer.from(b, "base64");

  if (aBuf.length !== bBuf.length) return false;

  return crypto.timingSafeEqual(aBuf, bBuf);
};

if (!safeCompare(hmacHeader.trim(), generatedHmac.trim())) {
  if (process.env.NODE_ENV !== "production") {
    console.warn("⚠️ Shopify webhook signature mismatch");
  }
  return res.status(200).send("OK");
}


    /* ======================================================
       2️⃣ PARSE AFTER VERIFICATION
    ====================================================== */

    const payload = JSON.parse(rawBody.toString("utf8"));

    /* ======================================================
       3️⃣ DB-LEVEL IDEMPOTENCY
    ====================================================== */

    const pool = getPool();

    const insert = await pool.query(
      `
      INSERT INTO shopify_webhook_events (shop, webhook_id, topic, payload)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (webhook_id) DO NOTHING
      RETURNING id
      `,
      [shop, webhookId, topic, payload]
    );

    // Duplicate delivery → silently ACK
    if (!insert.rowCount) {
      return res.status(200).send("OK");
    }
    

    /* ======================================================
       4️⃣ LOG + OPTIONAL BACKFILL
    ====================================================== */

    // if (payload?.id) {
    //   console.log("📦 Shopify order.created received", {
    //     shop,
    //     orderId: payload.id,
    //     orderName: payload.name,
    //   });
    // }

    return res.status(200).send("OK");
  } catch (err: any) {
    console.error("❌ Shopify webhook failed:", err?.message);
    return res.status(200).send("OK");
  }
});

export default router;