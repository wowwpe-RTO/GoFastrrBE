import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../storeTokens";

/**
 * Creates a Shopify order from a PAID checkout session
 * Idempotent, transaction-safe
 */
export async function createShopifyOrder(
  checkoutSessionId: string
) {
  const pool = getPool();

  await pool.query("BEGIN");

  try {
    /**
     * 1️⃣ Lock checkout session
     */
    const sessionResult = await pool.query(
      `
      SELECT
        id,
        shop,
        phone,
        shipping_address,
        shopify_order_id
      FROM checkout_sessions
      WHERE id = $1
      FOR UPDATE
      `,
      [checkoutSessionId]
    );

    if (sessionResult.rowCount === 0) {
      throw new Error("Checkout session not found");
    }

    const session = sessionResult.rows[0];

    /**
     * 🛑 Idempotency guard
     */
    if (session.shopify_order_id) {
      await pool.query("COMMIT");
      return {
        id: session.shopify_order_id,
        alreadyCreated: true,
      };
    }

    /**
     * 2️⃣ Fetch Shopify token
     */
    const accessToken = await getToken(session.shop);
    if (!accessToken) {
      throw new Error(
        `Missing Shopify access token for shop ${session.shop}`
      );
    }

    /**
     * 3️⃣ Build order payload
     */
    const orderPayload = {
      order: {
        line_items: [
          {
            variant_id: 46873673498802, // TODO: replace later
            quantity: 1,
          },
        ],
        shipping_address: session.shipping_address,
        phone: session.phone,
        financial_status: "paid",
      },
    };

    /**
     * 4️⃣ Create order in Shopify
     */
    const response = await axios.post(
      `https://${session.shop}/admin/api/2024-01/orders.json`,
      orderPayload,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    const order = response.data.order;

    /**
     * 5️⃣ Persist Shopify order ID (idempotent)
     */
    await pool.query(
      `
      UPDATE checkout_sessions
      SET shopify_order_id = $1
      WHERE id = $2
      `,
      [order.id, checkoutSessionId]
    );

    await pool.query("COMMIT");
    return order;
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}
