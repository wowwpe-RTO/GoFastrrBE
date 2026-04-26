import { Router } from "express";
import crypto from "crypto";
import { handleRazorpayCapturedEvent } from "../services/razorpayHandler";
import { handleRefundProcessed } from "../services/refundHandler";

const router = Router();

/**
 * Razorpay Webhook
 * Mounted at /webhooks/razorpay
 * IMPORTANT: req.body MUST be raw Buffer (configured in server.ts)
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
      // Always ACK to avoid retry storms
      return res.status(200).send("OK");
    }

    /**
     * 1️⃣ RAW BODY ONLY
     */
    const body = req.body as Buffer;

    /**
     * 2️⃣ Compute expected signature (hex)
     */
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    /**
     * 3️⃣ Timing-safe comparison
     */
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expectedSignature, "utf8");

    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      console.error("❌ Invalid Razorpay webhook signature");

      // IMPORTANT: ACK anyway
      return res.status(200).send("OK");
    }

    /**
     * 4️⃣ Parse payload AFTER verification
     */
    let event: any;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {
      console.error("❌ Razorpay webhook JSON parse failed");
      return res.status(200).send("OK");
    }

    /**
     * =========================
     * REFUND PROCESSED
     * =========================
     */
    if (event.event === "refund.processed") {
      const refund = event?.payload?.refund?.entity;

      if (!refund?.id || !refund?.amount) {
        console.error("❌ Razorpay refund payload missing fields");
        return res.status(200).send("OK");
      }

      await handleRefundProcessed({
        razorpayRefundId: refund.id,
        amount: Number(refund.amount),
      });

      return res.status(200).send("OK");
    }

    /**
     * Only care about captured payments
     */
    if (event.event !== "payment.captured") {
      return res.status(200).send("OK");
    }

    const payment = event?.payload?.payment?.entity;

    if (!payment?.id || !payment?.order_id) {
      console.error("❌ Razorpay payload missing ids");
      return res.status(200).send("OK");
    }

    /**
     * Minimal safe reference (no secrets)
     */
    const safePaymentReference = {
      payment_id: payment.id,
      order_id: payment.order_id,
      amount: Number(payment.amount),
      currency: payment.currency,
      status: payment.status,
      method: payment.method,
      captured_at: payment.captured_at,
    };

    /**
     * Delegate idempotent reconciliation to service layer
     */
    await handleRazorpayCapturedEvent({
      razorpayOrderId: payment.order_id,
      safePaymentReference,
    });

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Razorpay webhook failed:", err);

    /**
     * Always ACK to prevent Razorpay retry storms
     */
    return res.status(200).send("OK");
  }
});

export default router;
