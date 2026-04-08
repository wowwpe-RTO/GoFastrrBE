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

    if (
      btn.innerText.toLowerCase().includes('checkout') ||
      btn.href?.includes('/checkout')
    ) {
      e.preventDefault();
      startCheckout();
    }
  });
})();
