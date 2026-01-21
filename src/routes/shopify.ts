import { Router } from "express";
import { getShopifyClient } from "../lib/shopifyClient";

const router = Router();

router.post("/draft-order", async (req, res) => {
  try {
    const { shop, variantId, quantity, customer } = req.body;

    if (!shop || !variantId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const shopify = await getShopifyClient(shop);

    const response = await shopify.post("/draft_orders.json", {
      draft_order: {
        line_items: [
          {
            variant_id: Number(variantId),
            quantity: quantity || 1
          }
        ],
        shipping_address: {
          first_name: customer.firstName,
          last_name: customer.lastName,
          address1: customer.address1,
          city: customer.city,
          province: customer.province,
          zip: customer.zip,
          country: customer.country,
          phone: customer.phone
        },
        email: null
      }
    });

    const draft = response.data.draft_order;

    return res.json({
      draftOrderId: draft.id,
      invoiceUrl: draft.invoice_url
    });
  } catch (err: any) {
    console.error(err?.response?.data || err.message);
    return res.status(500).json({ error: "Draft order creation failed" });
  }
});

export default router;
