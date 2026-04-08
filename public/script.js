(async function () {
  console.log('🚀 Wowwpe script loaded');

  const shop = window.Shopify?.shop;

  /**
   * ========================================
   * 🔥 MODAL (ADD THIS — TOP LEVEL)
   * ========================================
   */
  function openWowwpeModal(sessionId, shop) {
    console.log('🧩 Opening Wowwpe modal');

    // Overlay
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.4)';
    overlay.style.zIndex = '2147483646';

    // Modal container
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.width = '90%';
    modal.style.maxWidth = '1000px';
    modal.style.height = '90%';
    modal.style.background = '#fff';
    modal.style.borderRadius = '12px';
    modal.style.overflow = 'hidden';
    modal.style.zIndex = '2147483647';
    modal.style.boxShadow = '0 20px 60px rgba(0,0,0,0.3)';

    // Iframe
    const iframe = document.createElement('iframe');
    iframe.src = `https://checkout.wowwpe.io/checkout?session=${sessionId}&shop=${shop}`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';

    modal.appendChild(iframe);
    document.body.appendChild(overlay);
    document.body.appendChild(modal);

    // Close on overlay click
    overlay.onclick = () => {
      modal.remove();
      overlay.remove();
    };
  }

  /**
   * ========================================
   * 🚀 START CHECKOUT
   * ========================================
   */
  async function startCheckout() {
    try {
      console.log('🔥 START CHECKOUT');

      const cartRes = await fetch('/cart.js');
      const cart = await cartRes.json();

      console.log('🛒 CART:', cart);

      const lineItems = cart.items.map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
        unit_price_paise: item.price,
      }));

      console.log('📦 LINE ITEMS:', lineItems);

      if (!lineItems.length) {
        console.warn('⚠️ Cart is empty');
        return;
      }

      const res = await fetch('https://api.wowwpe.io/checkout/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop, lineItems }),
      });

      console.log('🌍 RESPONSE STATUS:', res.status);

      const data = await res.json();

      console.log('✅ RESPONSE DATA:', data);

      if (data.checkoutSessionId) {
        console.log('🎯 OPENING MODAL INSTEAD OF REDIRECT');

        // ✅ THIS IS THE KEY CHANGE
        openWowwpeModal(data.checkoutSessionId, shop);
      } else {
        console.error('❌ No session returned');
      }
    } catch (err) {
      console.error('❌ Checkout error:', err);
    }
  }

  /**
   * ========================================
   * 🧠 CLICK INTERCEPT (STRONG)
   * ========================================
   */
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
        text.includes('buy it now') ||
        btn.className?.toLowerCase().includes('buy') ||
        btn.innerText?.includes('Buy it now');

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
  );

  /**
   * ========================================
   * 🧠 FORM INTERCEPT
   * ========================================
   */
  document.addEventListener(
    'submit',
    function (e) {
      const form = e.target;

      if (form.action && form.action.includes('/checkout')) {
        console.log('🚀 FORM INTERCEPT');

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        startCheckout();
      }
    },
    true,
  );

  /**
   * ========================================
   * 🧠 NAVIGATION BLOCK
   * ========================================
   */
  const originalAssign = window.location.assign;

  window.location.assign = function (url) {
    if (url.includes('/checkout')) {
      console.log('🚀 BLOCKED NAVIGATION TO SHOPIFY CHECKOUT');

      startCheckout();
      return;
    }

    return originalAssign.call(this, url);
  };

  /**
   * ========================================
   * 🧠 LINK INTERCEPT
   * ========================================
   */
  document.addEventListener(
    'click',
    function (e) {
      const link = e.target.closest('a');

      if (!link) return;

      if (link.href && link.href.includes('/checkout')) {
        console.log('🚀 LINK CHECKOUT INTERCEPT');

        e.preventDefault();
        startCheckout();
      }
    },
    true,
  );
})();
