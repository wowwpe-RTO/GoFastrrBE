import crypto from "crypto";

export function verifyShopifyWebhook(
  rawBody: Buffer,
  hmacHeader?: string
): boolean {
  if (!hmacHeader) return false;

  const secret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!secret) {
    console.error("❌ SHOPIFY_CLIENT_SECRET is missing");
    return false;
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}