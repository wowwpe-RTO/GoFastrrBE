import { Router } from "express";
import axios from "axios";
import crypto from "crypto";
import querystring from "querystring";
import { setToken } from "../services/shopTokenService";
import { registerOrdersCreateWebhook } from "../shopify/createWebhook";

const router = Router();

const SCOPES =
  "read_customers,write_draft_orders,read_products,read_inventory,read_orders,write_orders,write_customers,read_files,read_themes";

/**
 * ----------------------------------------
 * Shopify HMAC verification
 * ----------------------------------------
 */
function verifyOAuthHmac(query: Record<string, string>) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = querystring.stringify(rest);

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET!)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(generated, "utf8"),
    Buffer.from(hmac, "utf8")
  );
}

/**
 * ----------------------------------------
 * GET /shopify/install
 * ----------------------------------------
 */
router.get("/install", (req, res) => {
  const shop = req.query.shop as string;
  if (!shop) return res.status(400).send("Missing shop");

  const state = crypto.randomBytes(16).toString("hex");

  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  const redirectUri = `${appUrl}/shopify/callback`;

  console.log(`[shopifyAuth] Installing for ${shop}, redirect_uri: ${redirectUri}`);

  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    querystring.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      scope: SCOPES,
      redirect_uri: redirectUri,
      state,
    });

  res.redirect(installUrl);
});

/**
 * ----------------------------------------
 * GET /shopify/callback
 * ----------------------------------------
 */
router.get("/callback", async (req, res) => {
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

    /**
     * Persist token in DB
     */
    await setToken(shop, accessToken);

    try {
  await axios.post(
    `https://${shop}/admin/api/2024-01/script_tags.json`,
    {
      script_tag: {
        event: "onload",
        src: `${process.env.APP_URL}/script.js`,
      },
    },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  console.log("✅ Script injected");
} catch (err: any) {
  console.error("⚠️ Script injection failed:", err?.response?.data || err.message);
}

    /**
     * Register webhook
     */
    try {
  await registerOrdersCreateWebhook(
    shop,
    accessToken,
    process.env.APP_URL!
  );
  console.log("✅ Webhook registered");
} catch (err: any) {
  console.error("⚠️ Webhook failed:", err?.response?.data || err.message);
  // DO NOT throw
}

   return res.send(`
  <html>
    <body style="font-family: sans-serif;">
      <h2>App installed successfully 🚀</h2>
      <p>You can now close this window.</p>
    </body>
  </html>
`);
  } catch (err: any) {
  console.error("🔥 FULL ERROR:", err);
  console.error("🔥 RESPONSE:", err?.response?.data);

  return res.status(500).send(`
    <pre>${JSON.stringify(err?.response?.data || err.message, null, 2)}</pre>
  `);
}
});

export default router;