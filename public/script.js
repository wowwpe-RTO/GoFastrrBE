(async function () {
  console.log('🚀 Wowwpe script loaded');

  const shop = window.Shopify?.shop;

  async function startCheckout() {
    try {
      console.log('🔥 START CHECKOUT');

      const shop = window.Shopify?.shop;

      const cartRes = await fetch('/cart.js');
      const cart = await cartRes.json();

      console.log('🛒 CART:', cart);

      const lineItems = cart.items.map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
        unit_price_paise: item.price,
      }));

      console.log('📦 LINE ITEMS:', lineItems);

      const res = await fetch('https://api.wowwpe.io/checkout/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop, lineItems }),
      });

      console.log('🌍 RESPONSE STATUS:', res.status);

      const data = await res.json();

      console.log('✅ RESPONSE DATA:', data);

      if (data.checkoutSessionId) {
        const url =
          'https://checkout.wowwpe.io/checkout?session=' +
          data.checkoutSessionId +
          '&shop=' +
          shop;

        console.log('➡️ REDIRECTING TO:', url);

        window.location.href = url;
      } else {
        console.error('❌ No session returned');
      }
    } catch (err) {
      console.error('❌ Checkout error:', err);
    }
  }

  // Intercept checkout buttons
  document.addEventListener(
    'click',
    function (e) {
      const btn = e.target.closest('button, a');

      if (!btn) return;

      const text = btn.innerText?.toLowerCase() || '';

      const isCheckout =
        text.includes('checkout') ||
        btn.name === 'checkout' ||
        btn.id?.includes('checkout');

      const isBuyNow =
        text.includes('buy it now') || btn.innerText?.includes('Buy it now');

      if (isCheckout || isBuyNow) {
        console.log('🚀 HARD INTERCEPT', btn);

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        startCheckout();

        return false;
      }
    },
    true,
  ); // 👈 CAPTURE PHASE (VERY IMPORTANT)

  document.addEventListener('submit', function (e) {
    const form = e.target;

    console.log('FORM SUBMIT:', form);

    if (form.action && form.action.includes('/checkout')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      console.log('🚀 FORM INTERCEPT');

      startCheckout();
    }
  });

  const originalAssign = window.location.assign;

  window.location.assign = function (url) {
    if (url.includes('/checkout')) {
      console.log('🚀 BLOCKED NAVIGATION TO SHOPIFY CHECKOUT');

      startCheckout();
      return;
    }

    return originalAssign.call(this, url);
  };

  document.addEventListener(
    'click',
    function (e) {
      const link = e.target.closest('a');

      if (!link) return;

      if (link.href.includes('/checkout')) {
        e.preventDefault();

        console.log('🚀 LINK CHECKOUT INTERCEPT');

        startCheckout();
      }
    },
    true,
  );
})();
