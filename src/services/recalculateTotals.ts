import { calculateShippingMethods } from "./shipping/shippingEngine";

export async function recalcTotals(
  client: any,
  checkoutSessionId: string
) {

  /* ===============================
     CALCULATE SUBTOTAL
  =============================== */

  const subtotalRes = await client.query(`
    SELECT COALESCE(SUM(unit_price_paise * quantity), 0) AS subtotal
    FROM checkout_line_items
    WHERE checkout_session_id = $1
  `, [checkoutSessionId]);

  const subtotal = Number(subtotalRes.rows[0].subtotal);

  /* ===============================
     GET SESSION DATA
  =============================== */

  const session = await client.query(`
    SELECT discount_amount, applied_coupon_code, shipping_address
    FROM checkout_sessions
    WHERE id = $1
  `, [checkoutSessionId]);

  const row = session.rows[0];

  let discount = Number(row?.discount_amount || 0);
  const appliedCouponCode: string | null = row?.applied_coupon_code || null;

  /* ===============================
     COUPON ELIGIBILITY RE-CHECK
     If cart quantity changes caused subtotal to fall below
     the coupon's min_order_amount, strip the coupon silently.
  =============================== */

  if (appliedCouponCode && discount > 0) {
    const couponRes = await client.query(
      `SELECT min_order_amount
       FROM coupons
       WHERE code = $1
         AND active = true
         AND (expires_at IS NULL OR expires_at > now())`,
      [appliedCouponCode]
    );

    const coupon = couponRes.rows[0];

    if (!coupon || subtotal < Number(coupon.min_order_amount || 0)) {
      discount = 0;

      await client.query(
        `UPDATE checkout_sessions
         SET discount_amount     = 0,
             applied_coupon_code = NULL,
             updated_at          = now()
         WHERE id = $1`,
        [checkoutSessionId]
      );
    }
  }

  /* ===============================
     PARSE POSTAL CODE
  =============================== */

  let postalCode: string | null = null;

  try {
    const addr = row?.shipping_address;

    if (addr) {
      const parsed =
        typeof addr === "string" ? JSON.parse(addr) : addr;
      postalCode = parsed?.postalCode || null;
    }
  } catch {
    console.error("Shipping address parse failed");
  }

  /* ===============================
     CALCULATE SHIPPING
  =============================== */

  const methods = calculateShippingMethods(subtotal, postalCode);
  const selected = methods?.[0];
  const shipping = selected?.pricePaise || 0;

  /* ===============================
     FINAL TOTAL — floored at 0
  =============================== */

  const total = Math.max(subtotal + shipping - discount, 0);

  await client.query(`
    UPDATE checkout_sessions
    SET subtotal_amount = $1::numeric,
        shipping_amount = $2::numeric,
        total_amount    = $3::numeric,
        updated_at      = now()
    WHERE id = $4
  `, [subtotal, shipping, total, checkoutSessionId]);
}