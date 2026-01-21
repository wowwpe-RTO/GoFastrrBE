import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { initDb, getPool } from "./db";

// Routes
import authRoutes from "./routes/auth";
import checkoutRoutes from "./routes/checkout";
import shopifyAuthRoutes from "./routes/shopifyAuth";
import shopifyRoutes from "./routes/shopify";

// Webhooks
import shopifyWebhooks from "./shopify/webhooks";
import razorpayWebhooks from "./routes/razorpayWebhook";

// Jobs
import { expireStaleCheckouts } from "./jobs/checkoutTimeout";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

/**
 * Global crash guards
 */
process.on("unhandledRejection", (reason) => {
  console.error("🚨 UNHANDLED PROMISE REJECTION", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🚨 UNCAUGHT EXCEPTION", err);
});

/**
 * Boot sequence (STRICT ORDER)
 */
async function startServer() {
  // 1️⃣ Init DB FIRST
  await initDb();

  // 2️⃣ Middleware
  app.use(
    cors({
      origin: "http://localhost:5173",
      credentials: true,
    })
  );

  /**
   * WEBHOOKS — RAW BODY FIRST
   */
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

  /**
   * NORMAL JSON ROUTES
   */
  app.use(express.json());

  app.use("/auth", authRoutes);
  app.use("/checkout", checkoutRoutes);
  app.use("/shopify", shopifyAuthRoutes);
  app.use("/shopify", shopifyRoutes);

  /**
   * HEALTH
   */
  app.get("/health", (_, res) => {
    res.json({ status: "ok" });
  });

  app.get("/db-health", async (_, res) => {
    try {
      const pool = getPool();
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch (err) {
      console.error("DB health failed:", err);
      res.status(500).json({ ok: false });
    }
  });

  /**
   * 3️⃣ START SERVER (ONCE)
   */
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  /**
   * 4️⃣ START BACKGROUND JOBS (AFTER DB)
   */
  setInterval(() => {
    expireStaleCheckouts().catch((err) =>
      console.error("❌ Background job error:", err)
    );
  }, 30_000);
}

startServer().catch((err) => {
  console.error("❌ Failed to start server", err);
  process.exit(1);
});
