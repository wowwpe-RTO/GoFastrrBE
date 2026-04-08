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

    // Overlay (transparent blur effect)
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(0,0,0,0.25)'; // lighter
    overlay.style.backdropFilter = 'blur(4px)';
    overlay.style.zIndex = '2147483646';

    // Modal container (FULL VIEWPORT FEEL)
    // const modal = document.createElement('div');
    // modal.style.position = 'fixed';
    // modal.style.top = '0';
    // modal.style.left = '0';
    // modal.style.width = '100vw';
    // modal.style.height = '100vh';
    // modal.style.display = 'flex';
    // modal.style.alignItems = 'center';
    // modal.style.justifyContent = 'center';
    // modal.style.zIndex = '2147483647';

    // Inner frame (this is your "card")
    const container = document.createElement('div');
    container.style.width = '95%';
    container.style.height = '95%';
    container.style.maxWidth = '1200px';
    container.style.borderRadius = '16px';
    container.style.overflow = 'hidden';
    container.style.background = '#fff';
    container.style.boxShadow = '0 30px 80px rgba(0,0,0,0.4)';

    // iframe
    const iframe = document.createElement('iframe');
    iframe.src = `https://checkout.wowwpe.io/checkout?session=${sessionId}&shop=${shop}`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';

    container.appendChild(iframe);
    modal.appendChild(container);

    document.body.appendChild(overlay);
    document.body.appendChild(modal);

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
