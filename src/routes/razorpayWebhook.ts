import { Router } from "express";
import crypto from "crypto";
import { handleRazorpayCapturedEvent } from "../services/razorpayHandler";

const router = Router();

/**
 * Razorpay webhook
 * IMPORTANT: req.body MUST be raw Buffer
 */
router.post("/", async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("❌ RAZORPAY_WEBHOOK_SECRET missing");
      return res.status(500).send("Server misconfigured");
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature || typeof signature !== "string") {
      return res.status(400).send("Missing signature");
    }

    /**
     * 1️⃣ Verify signature
     */
    const body = req.body as Buffer;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    if (signature !== expectedSignature) {
      return res.status(401).send("Invalid signature");
    }

    /**
     * 2️⃣ Parse event
     */
    const event = JSON.parse(body.toString("utf8"));

    if (event.event !== "payment.captured") {
      return res.status(200).send("Ignored");
    }

    const payment = event.payload.payment.entity;

    /**
     * 3️⃣ Build PCI-SAFE reference only
     */
    const safePaymentReference = {
      payment_id: payment.id,
      order_id: payment.order_id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      method: payment.method,
      captured_at: payment.captured_at,
    };

    /**
     * 4️⃣ Delegate ALL business logic
     */
    await handleRazorpayCapturedEvent({
      razorpayOrderId: payment.order_id,
      safePaymentReference,
    });

    /**
     * IMPORTANT:
     * Always ACK Razorpay to prevent retry storms
     */
    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Razorpay webhook failed:", err);

    /**
     * Still ACK.
     * Replay handled via dead-letter queue / reconciliation.
     */
    return res.status(200).send("Webhook received");
  }
});

export default router;
