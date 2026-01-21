import axios from "axios";
import { getToken } from "../storeTokens";

const API_VERSION = "2024-04";

// export function getShopifyClient(shop: string) {
//   const token = getToken(shop);

//   if (!token) {
//     throw new Error(`No Shopify token for shop: ${shop}`);
//   }

//   return axios.create({
//     baseURL: `https://${shop}/admin/api/2024-04`,
//     headers: {
//       "X-Shopify-Access-Token": token,
//       "Content-Type": "application/json",
//     },
//   });
// }

export function getShopifyClient(shop: string) {
  let token = getToken(shop);

  // 👇 DEV FALLBACK (LOCAL ONLY)
  if (!token && process.env.DEV_SHOP === shop) {
    token = process.env.DEV_SHOPIFY_TOKEN;
  }

  if (!token) {
    throw new Error(`No Shopify token for shop: ${shop}`);
  }

  return axios.create({
    baseURL: `https://${shop}/admin/api/2024-04`,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });
}
