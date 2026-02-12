import axios from "axios";
import { getToken } from "../services/shopTokenService";

const API_VERSION = "2024-04";

export async function getShopifyClient(shop: string) {
  let token: string | null = null;

  /**
   * Local dev shortcut
   */
  if (process.env.NODE_ENV !== "production" && process.env.DEV_SHOP === shop) {
    token = process.env.DEV_SHOPIFY_TOKEN ?? null;
  }

  /**
   * Production token from DB
   */
  if (!token) {
    token = await getToken(shop);
  }

  if (!token) {
    throw new Error(`No Shopify token for shop: ${shop}`);
  }

  return axios.create({
    baseURL: `https://${shop}/admin/api/${API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });
}
