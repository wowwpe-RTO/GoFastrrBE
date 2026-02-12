import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import crypto from "crypto";
import http from "http";

import { getPool, closePool } from "./db";

// Routes
import authRoutes from "./routes/auth";
import checkoutRoutes from "./routes/checkout";
import shopifyAuthRoutes from "./routes/shopifyAuth";
import shopifyRoutes from "./routes/shopify";
import refundRoutes from "./routes/refund";

// Webhooks
import shopifyWebhooks from "./shopify/webhooks";
import razorpayWebhooks from "./routes/razorpayWebhook";

// Jobs
import { reconcileRazorpayPayments } from "./jobs/razorpayReconcile";
import { replayFailedWebhooks } from "./jobs/replayFailedWebhooks";
import { reconcileCheckouts } from "./jobs/reconcileCheckouts";
import { cleanupExpiredOtps } from "./jobs/otpCleanup";
import { expireStaleCheckouts } from "./jobs/checkoutTimeout";
import { reconcileRefunds } from "./jobs/refundReconcile";

const app = express();
let server: http.Server;
const intervals: NodeJS.Timeout[] = [];

/* ======================================================
   Request ID + Logging
====================================================== */

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  (req as any).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const start = Date.now();

  res.on("finish", () => {
    console.log(
      JSON.stringify({
        event: "http_request",
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      })
    );
  });

  next();
});

/* ======================================================
   Crash Guards (Non-Fatal Network)
====================================================== */

process.on("uncaughtException", (err: any) => {
  console.error("🚨 UNCAUGHT EXCEPTION:", err?.message);

  if (
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "EADDRNOTAVAIL"
  ) {
    return; // do not crash
  }

  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  console.error("🚨 UNHANDLED PROMISE:", reason?.message);
});

/* ======================================================
   Guarded Background Jobs (Calm + No DB Reset Storm)
====================================================== */

function guardedInterval(fn: () => Promise<void>, ms: number) {
  let running = false;

  const t = setInterval(async () => {
    if (running) return;
    running = true;

    try {
      await fn();
    } catch (err: any) {
      console.error("⚠️ Background job error:", err?.message);
      // Do NOT reset pool
      // Do NOT re-init DB
    } finally {
      running = false;
    }
  }, ms);

  intervals.push(t);
}

/* ======================================================
   Boot
====================================================== */

async function startServer() {
  // Simple DB test
  await getPool().query("SELECT 1");

  app.use(
    cors({
      origin: process.env.FRONTEND_URL,
      credentials: true,
    })
  );

  /* ---------- Webhooks FIRST ---------- */

  app.use(
    "/webhooks/razorpay",
    express.raw({ type: "application/json" }),
    razorpayWebhooks
  );

  app.use(
    "/webhooks/orders-create",
    express.raw({ type: "application/json" }),
    shopifyWebhooks
  );

  /* ---------- JSON Routes ---------- */

  app.use(express.json());

  app.use("/auth", authRoutes);
  app.use("/checkout", checkoutRoutes);
  app.use("/shopify", shopifyAuthRoutes);
  app.use("/shopify", shopifyRoutes);
  app.use("/payments", refundRoutes);

  /* ---------- Health ---------- */

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.get("/db-health", async (_, res) => {
    try {
      await getPool().query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  /* ---------- Express Error Handler ---------- */

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("Unhandled express error:", err?.message);
    res.status(500).json({ error: "Internal server error" });
  });

  const PORT = Number(process.env.PORT) || 4000;

  server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  /* ======================================================
     BACKGROUND JOBS (SLOWER + SAFE)
  ====================================================== */

  // Minimal background jobs (optional)
// Run rarely to reduce DB churn

// guardedInterval(cleanupExpiredOtps, 600_000);      // 10 minutes
// guardedInterval(expireStaleCheckouts, 600_000);   // 10 minutes
}

startServer().catch(async (err) => {
  console.error("❌ Failed to start server:", err?.message);
  await closePool();
  process.exit(1);
});

/* ======================================================
   Graceful Shutdown
====================================================== */

async function shutdown(signal: string) {
  console.log(`🛑 ${signal} received. Shutting down...`);

  server.close(async () => {
    intervals.forEach(clearInterval);
    await closePool();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 15000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));