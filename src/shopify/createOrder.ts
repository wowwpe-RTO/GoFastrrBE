import axios from "axios";
import { getPool } from "../db";
import { getToken } from "../services/shopTokenService";
import { CheckoutStep } from "../domain/checkoutStates";

/**
 * Retry an async operation up to `attempts` times with exponential backoff.
 * Only retries on network/timeout errors, not on 4xx responses.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 1000
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const isNetworkError = !err.response; // no response = network/timeout
      const isRetryable = isNetworkError || err.response?.status >= 500;
      if (!isRetryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

export async function createShopifyOrder(
  checkoutSessionId: string,
  options?: { mode?: "draft" | "final" }
) {
  const pool = getPool();
  const client = await pool.connect();

  const mode = options?.mode || "final";

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `
      SELECT
        step,
        shop,
        phone,
        email,
        shipping_address,
        shopify_order_id,
        shopify_draft_order_id,
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

    /* ==============================
       IDEMPOTENCY
    ============================== */

    if (mode === "draft" && s.shopify_draft_order_id) {
      await client.query("COMMIT");
      return { id: s.shopify_draft_order_id, alreadyCreated: true };
    }

    if (mode === "final" && s.shopify_order_id) {
      await client.query("COMMIT");
      return { id: s.shopify_order_id, alreadyCreated: true };
    }

    /* ==============================
       STATE GUARDS
    ============================== */

    if (mode === "final" && s.step !== CheckoutStep.COMPLETED) {
      await client.query("ROLLBACK");
      return {
        skipped: true,
        reason: `Checkout not completed. Current state: ${s.step}`,
      };
    }

    if (mode === "draft" && s.step !== CheckoutStep.PARTIALLY_PAID) {
      await client.query("ROLLBACK");
      return {
        skipped: true,
        reason: `Checkout not partially paid. Current state: ${s.step}`,
      };
    }

    /* ==============================
       FETCH LINE ITEMS
    ============================== */

    const itemsResult = await client.query(
      `
      SELECT variant_id, quantity
      FROM checkout_line_items
      WHERE checkout_session_id = $1
      `,
      [checkoutSessionId]
    );

    if (!itemsResult.rowCount) {
      throw new Error("No line items found");
    }

    const cartItems = itemsResult.rows;

    const token = await getToken(s.shop);
    if (!token) throw new Error("Missing Shopify token");

    const trimmedToken: string = token.trim();

    /* ==============================
       HELPERS
    ============================== */

    function normalizePhone(phone?: string) {
      if (!phone) return undefined;
      let cleaned = phone.replace(/\D/g, "");
      if (!cleaned.startsWith("91")) cleaned = "91" + cleaned;
      return "+" + cleaned;
    }

    function normalizeCountry(code?: string) {
      if (!code) return undefined;
      if (code === "IN") return "India";
      return code;
    }

    const formattedPhone = normalizePhone(s.phone);
    const total = (Number(s.total_amount) / 100).toFixed(2);
    const shipping = (Number(s.shipping_amount) / 100).toFixed(2);

    const rawAddress = s.shipping_address;

    if (!rawAddress) throw new Error("Shipping address missing");

    const firstName = (rawAddress.firstName || "").trim() || "Customer";
    const lastName = (rawAddress.lastName || "").trim() || "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ");

    /* ==============================
       RESOLVE CUSTOMER
       Look up existing customer by phone to avoid "phone already taken" error.
       Fall back to creating by email, then anonymous.
    ============================== */

    async function resolveCustomer(): Promise<Record<string, any>> {
      // 1. Try to find existing customer by phone
      if (s.phone) {
        try {
          const phoneSearch = await axios.get(
            `https://${s.shop}/admin/api/2025-01/customers/search.json?query=phone:${encodeURIComponent(formattedPhone || s.phone)}&limit=1`,
            { headers: { "X-Shopify-Access-Token": trimmedToken }, timeout: 15000 }
          );
          const existing = phoneSearch.data?.customers?.[0];
          if (existing?.id) {
            return { id: existing.id };
          }
        } catch {
          // search failed — fall through to create
        }
      }

      // 2. Try to find by email
      if (s.email) {
        try {
          const emailSearch = await axios.get(
            `https://${s.shop}/admin/api/2025-01/customers/search.json?query=email:${encodeURIComponent(s.email)}&limit=1`,
            { headers: { "X-Shopify-Access-Token": trimmedToken }, timeout: 15000 }
          );
          const existing = emailSearch.data?.customers?.[0];
          if (existing?.id) {
            return { id: existing.id };
          }
        } catch {
          // fall through to inline create
        }
      }

      // 3. No existing customer — pass inline (Shopify will create)
      return {
        first_name: firstName,
        last_name: lastName,
        email: s.email || undefined,
        phone: formattedPhone,
      };
    }

    const customer = await resolveCustomer();

    const shippingAddress = {
      first_name: firstName,
      last_name: lastName,
      name: fullName,
      address1: rawAddress.line1,
      city: rawAddress.city,
      province: rawAddress.state,
      country: normalizeCountry(rawAddress.country),
      country_code: rawAddress.country,
      zip: rawAddress.postalCode,
      phone: formattedPhone,
    };

    /* ==============================
       DRAFT ORDER MODE
    ============================== */

    if (mode === "draft") {
      const deposit = (Number(s.total_amount) / 200).toFixed(2);

      const draftPayload = {
        draft_order: {
          customer,
          currency: s.currency,
          line_items: cartItems.map((i: any) => ({
            variant_id: Number(i.variant_id),
            quantity: Number(i.quantity),
          })),
          shipping_address: shippingAddress,
          shipping_line: {
            title: "Shipping",
            price: shipping,
          },
          transactions: [
            {
              kind: "sale",
              status: "success",
              amount: deposit,
              gateway: "Razorpay",
            },
          ],
          payment_terms: {
            payment_terms_name: "Due on fulfillment",
          },
          note: "Partial payment received",
          tags: "PARTIAL_PAYMENT",
        },
        note_attributes: [
          {
            name: "Wowwpe Checkout Session",
            value: checkoutSessionId,
          },
        ],
      };

      const resp = await withRetry(() => axios.post(
        `https://${s.shop}/admin/api/2025-01/draft_orders.json`,
        draftPayload,
        {
          headers: {
            "X-Shopify-Access-Token": trimmedToken,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      ));

      const draft = resp.data?.draft_order;

      if (!draft?.id) throw new Error("Shopify draft creation failed");

      await client.query(
        `
        UPDATE checkout_sessions
        SET shopify_draft_order_id = $1,
            updated_at = now()
        WHERE id = $2
        `,
        [draft.id, checkoutSessionId]
      );

      await client.query("COMMIT");
      return draft;
    }

    /* ==============================
       FINAL ORDER MODE
    ============================== */

    const orderPayload = {
      order: {
        email: s.email || undefined,
        customer,

        note_attributes: [
          {
            name: "wowwpe_checkout_session",
            value: checkoutSessionId,
          },
        ],

        inventory_behavior: "decrement_ignoring_policy",
        currency: s.currency,

        line_items: cartItems.map((i: any) => ({
          variant_id: Number(i.variant_id),
          quantity: Number(i.quantity),
        })),

        shipping_address: shippingAddress,

        shipping_lines: [
          {
            title: "Shipping",
            price: shipping,
          },
        ],

        transactions: [
          {
            kind: "sale",
            status: "success",
            amount: total,
            gateway: "Razorpay",
          },
        ],
      },
    };

    const resp = await withRetry(() => axios.post(
      `https://${s.shop}/admin/api/2025-01/orders.json`,
      orderPayload,
      {
        headers: {
          "X-Shopify-Access-Token": trimmedToken,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    ));

    const order = resp.data?.order;

    if (!order?.id) throw new Error("Shopify order creation failed");

    await client.query(
      `
      UPDATE checkout_sessions
      SET shopify_order_id = $1,
          updated_at = now()
      WHERE id = $2
      `,
      [order.id, checkoutSessionId]
    );

    await client.query("COMMIT");

    return order;
  } catch (err: any) {
    await client.query("ROLLBACK");

    if (err.response?.data) {
      console.error(
        "Shopify error body:",
        JSON.stringify(err.response.data, null, 2)
      );
    }

    throw err;
  } finally {
    client.release();
  }
}