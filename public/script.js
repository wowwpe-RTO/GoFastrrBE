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

  // Intercept checkout buttons
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('button, a');
    if (!btn) return;

    const text = btn.innerText?.toLowerCase() || '';

    console.log('Clicked:', text, btn);

    // ✅ DO NOT TOUCH add to cart
    if (text.includes('add to cart')) {
      return;
    }

    // ✅ HANDLE checkout buttons ONLY
    const isCheckout =
      text.includes('check out') ||
      text.includes('checkout') ||
      btn.name === 'checkout' ||
      btn.id?.toLowerCase().includes('checkout') ||
      btn.getAttribute('formaction')?.includes('/checkout') ||
      btn.href?.includes('/checkout');

    // ✅ HANDLE buy it now
    const isBuyNow =
      text.includes('buy it now') ||
      btn.getAttribute('data-testid')?.includes('buy-now');

    if (isCheckout || isBuyNow) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      console.log('🚀 WOWWPE INTERCEPT');

      startCheckout();
    }
  });
})();
