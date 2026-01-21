import { Router } from "express";
import axios from "axios";
import crypto from "crypto";
import { storeTokens } from "../storeTokens";

const router = Router();

const SCOPES =
  "read_products,write_draft_orders,read_customers,write_customers";

// 1️⃣ Install URL
router.get("/install", (req, res) => {
  const shop = req.query.shop as string;
  if (!shop) return res.status(400).send("Missing shop");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${process.env.APP_URL}/shopify/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  res.redirect(installUrl);
});

// 2️⃣ OAuth callback
router.get("/callback", async (req, res) => {
  const { shop, code } = req.query as { shop: string; code: string };

  if (!shop || !code) {
    return res.status(400).send("Invalid OAuth callback");
  }

  try {
    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // 🔐 Store per-shop token
    storeTokens.set(shop, accessToken);

    res.send("App installed successfully. You can close this tab.");
  } catch (err: any) {
    console.error(err?.response?.data || err);
    res.status(500).send("OAuth failed");
  }
});

export default router;
