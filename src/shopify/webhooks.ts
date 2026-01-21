import { Router } from "express";
import { verifyShopifyWebhook } from "./verifyWebhook";
import { getPool } from "../db";

const router = Router();

router.post("/orders-create", async (req, res) => {
  const pool = getPool();

  const hmac = req.headers["x-shopify-hmac-sha256"] as string;
  const webhookId = req.headers["x-shopify-webhook-id"] as string;
  const topic = req.headers["x-shopify-topic"] as string;
  const shop = req.headers["x-shopify-shop-domain"] as string;

  if (!hmac || !webhookId || !shop) {
    return res.status(401).send("Unauthorized");
  }

  // 🔐 Verify HMAC
  if (!verifyShopifyWebhook(req.body, hmac)) {
    return res.status(401).send("Unauthorized");
  }

  const payload = JSON.parse(req.body.toString("utf8"));

  /**
   * DB-level dedupe
   */
  const result = await pool.query(
    `
    INSERT INTO shopify_webhook_events (shop, webhook_id, topic, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (webhook_id) DO NOTHING
    RETURNING id
    `,
    [shop, webhookId, topic, payload]
  );

  if (result.rowCount === 0) {
    return res.status(200).send("OK");
  }

  /**
   * Informational only — NO state mutation
   */
  console.log("📦 Shopify order.created received", {
    shop,
    orderId: payload.id,
    orderName: payload.name,
  });

  return res.status(200).send("OK");
});

export default router;
