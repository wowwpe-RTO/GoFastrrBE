(async function () {
  console.log('🚀 Wowwpe script loaded');

  const shop = window.Shopify?.shop;

  async function startCheckout() {
    try {
      const res = await fetch('https://api.wowwpe.io/checkout/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shop,
          lineItems: [], // you’ll improve this later
        }),
      });

      const data = await res.json();

      if (data.checkoutSessionId) {
        window.location.href =
          'https://checkout.wowwpe.io/checkout?session=' +
          data.checkoutSessionId +
          '&shop=' +
          shop;
      }
    } catch (err) {
      console.error('Checkout error:', err);
    }
  }

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
