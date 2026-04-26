import axios from "axios";
import { getToken } from "../services/shopTokenService";

export async function completeDraftOrder(shop: string, draftId: string) {

  const token = await getToken(shop);

  if (!token) {
    throw new Error(`Missing Shopify token for shop ${shop}`);
  }

  const resp = await axios.post(
    `https://${shop}/admin/api/2025-01/draft_orders/${draftId}/complete.json`,
    {},
    {
      headers: {
        "X-Shopify-Access-Token": token.trim(),
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  return resp.data?.draft_order;
}