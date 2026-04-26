import { Router } from "express";
import { getPool } from "../db";

// FIX #9: removed dead import `getToken` from shopTokenService — was never used

const router = Router();

/* ===============================
   PREVIEW (SHOPIFY HYDRATED)
=============================== */

router.post("/preview", async (req, res) => {
  const { checkoutSessionId } = req.body;
  const pool = getPool();

  if (!checkoutSessionId) {
    return res.status(400).json({
      error: "checkoutSessionId required",
    });
  }

  const client = await pool.connect();

  try {
    const items = await client.query(
      `SELECT
        variant_id,
        quantity,
        unit_price_paise,
        compare_at_price_paise,
        product_title,
        variant_title,
        image
       FROM checkout_line_items
       WHERE checkout_session_id = $1
       ORDER BY created_at ASC`,
      [checkoutSessionId]
    );

    if (!items.rowCount) {
      return res.json({
        items: [],
        subtotalPaise: 0,
        discountPaise: 0,
        shippingPaise: 0,
        shippingCalculated: false,
        totalPaise: 0,
      });
    }

    let subtotal = 0;
    let compareTotal = 0;

    const previewItems: any[] = [];

    for (const item of items.rows) {
      subtotal += item.unit_price_paise * item.quantity;

      if (item.compare_at_price_paise) {
        compareTotal += item.compare_at_price_paise * item.quantity;
      }

      previewItems.push(item);
    }

    const discount = compareTotal > subtotal ? compareTotal - subtotal : 0;

    return res.json({
      items: previewItems,
      subtotalPaise: subtotal,
      discountPaise: discount,
      shippingPaise: 0,
      shippingCalculated: false,
      totalPaise: subtotal,
    });

  } catch (err) {
    console.error("Preview failed:", err);
    return res.status(500).json({ error: "Preview failed" });
  } finally {
    client.release();
  }
});

export default router;