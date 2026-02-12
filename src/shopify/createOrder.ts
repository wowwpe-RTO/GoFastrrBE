import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../services/shopTokenService";
import { CheckoutStep } from "../domain/checkoutStates";

export async function createShopifyOrder(checkoutSessionId: string) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* --------------------------------------------------
       LOCK CHECKOUT SESSION
    -------------------------------------------------- */

    const sessionResult = await client.query(
      `
      SELECT
        step,
        shop,
        phone,
        email,
        shipping_address,
        shopify_order_id,
        subtotal_amount,
        shipping_amount,
        tax_amount,
        total_amount,
        currency
      FROM checkout_sessions
      WHERE id = $1
      FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (!sessionResult.rowCount) {
      throw new Error("Checkout not found");
    }

    const s = sessionResult.rows[0];

    /* --------------------------------------------------
       IDEMPOTENCY
    -------------------------------------------------- */

    if (s.shopify_order_id) {
      await client.query("COMMIT");
      return { id: s.shopify_order_id, alreadyCreated: true };
    }

    /* --------------------------------------------------
       STATE GUARD
    -------------------------------------------------- */

    if (s.step !== "COMPLETED") {
  await client.query("ROLLBACK");
  return {
    skipped: true,
    reason: `Checkout not completed. Current state: ${s.step}`,
  };
}

    /* --------------------------------------------------
       FETCH LINE ITEMS (SOURCE OF TRUTH)
    -------------------------------------------------- */

    const itemsResult = await client.query(
      `
      SELECT
        variant_id,
        quantity,
        unit_price_paise,
        title
      FROM checkout_line_items
      WHERE checkout_session_id = $1
      `,
      [checkoutSessionId]
    );

    if (!itemsResult.rowCount) {
      throw new Error(
        `No line items found for checkout ${checkoutSessionId}`
      );
    }

    const cartItems = itemsResult.rows;

    if (!s.total_amount || Number(s.total_amount) <= 0) {
      throw new Error(
        `Invalid totals for checkout ${checkoutSessionId}`
      );
    }

    if (!s.shipping_address) {
      throw new Error(
        `Shipping address missing for checkout ${checkoutSessionId}`
      );
    }

    const token = await getToken(s.shop);
    if (!token) {
      throw new Error("Missing Shopify token");
    }

    /* --------------------------------------------------
       FREEZE AMOUNTS
    -------------------------------------------------- */

    const subtotal = (Number(s.subtotal_amount) / 100).toFixed(2);
    const shipping = (Number(s.shipping_amount) / 100).toFixed(2);
    const totalTax = (Number(s.tax_amount || 0) / 100).toFixed(2);
    const total = (Number(s.total_amount) / 100).toFixed(2);

    const money = (v: string) => ({
      shop_money: { amount: v, currency_code: s.currency },
      presentment_money: { amount: v, currency_code: s.currency },
    });

    /* --------------------------------------------------
       BUILD SHOPIFY ORDER
    -------------------------------------------------- */

    const orderPayload = {
      order: {
        email: s.email,
        phone: s.phone,

        inventory_behavior: "decrement_ignoring_policy",

        currency: s.currency,
        presentment_currency: s.currency,

        financial_status: "paid",
        taxes_included: true,

        line_items: cartItems.map((i: any) => ({
          variant_id: Number(i.variant_id),
          quantity: Number(i.quantity),
          price: (Number(i.unit_price_paise) / 100).toFixed(2),
          title: i.title,
        })),

        shipping_address: s.shipping_address,

        shipping_lines: [
          {
            title: "Shipping",
            price: shipping,
            code: "custom",
            source: "custom",
            price_set: money(shipping),
          },
        ],

        tax_lines: [],

        subtotal_price: subtotal,
        total_line_items_price: subtotal,
        total_tax: totalTax,
        total_price: total,
        total_discounts: "0.00",

        subtotal_price_set: money(subtotal),
        total_line_items_price_set: money(subtotal),
        total_shipping_price_set: money(shipping),
        total_tax_set: money(totalTax),
        total_price_set: money(total),

        transactions: [
          {
            kind: "sale",
            status: "success",
            amount: total,
            currency: s.currency,
            gateway: "razorpay",
          },
        ],
      },
    };

    const resp = await axios.post(
      `https://${s.shop}/admin/api/2025-01/orders.json`,
      orderPayload,
      {
        headers: {
          "X-Shopify-Access-Token": token.trim(),
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const order = resp.data?.order;

    if (!order?.id) {
      throw new Error(
        `Shopify order creation failed: ${JSON.stringify(resp.data)}`
      );
    }

    /* --------------------------------------------------
       MARK COMPLETED
    -------------------------------------------------- */

    await client.query(
      `
      UPDATE checkout_sessions
      SET shopify_order_id = $1,
          step = $2,
          updated_at = now()
      WHERE id = $3
      `,
      [order.id, CheckoutStep.COMPLETED, checkoutSessionId]
    );

    await client.query("COMMIT");

    return order;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
