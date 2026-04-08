import dotenv from "dotenv";
dotenv.config();
import path from "path";
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

import checkoutPreview from "./routes/checkoutPreview";

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



app.use(
  cors({
    origin: "*", // 🔥 allow all for now (we'll tighten later)
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

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
    return;
  }

  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  console.error("🚨 UNHANDLED PROMISE:", reason?.message);
});

/* ======================================================
   Guarded Background Jobs
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
  await getPool().query("SELECT 1");

  app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://checkout.wowwpe.io",
    ],
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

  /* ======================================================
     NEW: Draft Order Webhook
  ====================================================== */

  app.post(
    "/webhooks/draft_orders/create",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      try {
        const body = JSON.parse(req.body.toString());

        console.log(
          "📦 Shopify draft order created:",
          body?.id
        );

        res.status(200).send("ok");
      } catch (err: any) {
        console.error(
          "Draft order webhook error:",
          err?.message
        );
        res.status(200).send("ok");
      }
    }
  );

  /* ---------- JSON Routes ---------- */

  app.use(express.json());

  app.use("/auth", authRoutes);
  app.use("/checkout", checkoutRoutes);
  app.use("/checkout", checkoutPreview);
  app.use("/shopify", shopifyAuthRoutes);
  app.use("/shopify", shopifyRoutes);
  app.use("/payments", refundRoutes);

  app.get("/script.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "../public/script.js"));
});

  /* ---------- Health ---------- */

  app.get("/debug/sessions", async (_, res) => {
    const r = await getPool().query(
      "SELECT id FROM checkout_sessions ORDER BY created_at DESC LIMIT 5"
    );
    res.json(r.rows);
  });

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.get("/db-health", async (_, res) => {
    try {
      await getPool().query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  /* ---------- Root — handles Shopify embedded redirect ---------- */
  app.get("/", (req, res) => {
    const shop = req.query.shop as string;
    const host = req.query.host as string;

    if (!shop) {
      // No shop param — show install form
      return res.send(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:400px;margin:auto">
          <h2>Wowwpe Checkout</h2>
          <p>Enter your store to install:</p>
          <form method="GET" action="/shopify/install">
            <input name="shop" placeholder="yourstore.myshopify.com"
              style="padding:10px;width:100%;box-sizing:border-box;margin-bottom:10px;border:1px solid #ccc;border-radius:6px" required />
            <button type="submit"
              style="padding:10px 20px;background:#0B7E63;color:white;border:none;border-radius:6px;cursor:pointer;width:100%">
              Install App
            </button>
          </form>
        </body></html>
      `);
    }

    // Has shop + host — embedded load after OAuth, redirect to Shopify admin
    if (host) {
      const adminBase = Buffer.from(host, "base64").toString("utf8");
      return res.redirect(`https://${adminBase}/apps/${process.env.SHOPIFY_CLIENT_ID}`);
    }

    // Has shop but no host — trigger OAuth
    return res.redirect(`/shopify/install?shop=${shop}`);
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
     BACKGROUND JOBS
  ====================================================== */

  // guardedInterval(cleanupExpiredOtps, 600_000);
  // guardedInterval(expireStaleCheckouts, 600_000);
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