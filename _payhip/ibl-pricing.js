/*!
 * iamLamprey pricing module — ibl-pricing.js
 *
 * Canonical source: source/ibl-pricing.js
 * The exact contents of this file are inlined into each page so the embed
 * stays standalone. Keep these copies in sync:
 *   - source/instruments.html
 *   - source/master-bundle.html
 *   - source/plugins/altar.html
 *   - source/plugins/muzzle.html
 *   - source/sample-packs/supporter-bundle.html
 *
 * What it does: prices come from a static PRICES registry that mirrors
 * config.json. The old Payhip scrape/sale-detection/iframe logic has been
 * removed — Polar is the storefront and prices live in config.json. Each card
 * keeps its truthfully hardcoded default price; FREE cards are left untouched.
 * No "On sale" chips are rendered because Polar products are fixed-price.
 */
(function (root) {
  'use strict';

  /*
   * Static price registry: slug -> price (USD, dollars). Mirrors config.json —
   * keep it in sync by hand when prices change.
   */
  var PRICES = {
  /* BEGIN PRICES — mirrors config.json (keep in sync by hand) */
    'achromic': 40,
    'aetheric': 20,
    'atlas': 20,
    'blackout': 20,
    'blackout-2': 20,
    'bloom': 20,
    'cloudburst': 20,
    'cloudburst-acoustic': 20,
    'eidolon': 40,
    'found-keys': 20,
    'gloom': 40,
    'oracle-2': 40,
    'pdq-bass': 40,
    'prismatic': 20,
    'songbird': 0,
    'zephyr': 0,
    'tethys': 40,
    'HZtFg': 40,
    'master-bundle': 150,
    'supporter-bundle': 20,
    'ambience-supporter-pack': 10,
    'riser-supporter-pack': 10,
    'glitch-supporter-pack': 10,
    'sub-drop-supporter-pack': 10,
  /* END PRICES */
  };

  function money(n) {
    var v = (typeof n === 'number' ? n : parseFloat(n) || 0);
    return '$' + v.toFixed(2);
  }

  function setFirstTextNode(el, text) {
    if (!el) return;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node = walker.nextNode();
    if (node) node.textContent = text;
  }

  function resultFor(slug) {
    var p = PRICES[slug];
    return { price: typeof p === 'number' ? p : 0 };
  }

  function applyProduct(el, result) {
    if (!result) return;
    if (el.querySelector('.ibl-note') || el.querySelector('.ibl-free-label')) return; // FREE cards stay as-is
    var priceEl = el.querySelector('.ibl-price');
    var packPrice = el.querySelector('.ibl-altar-pack-price');
    var display = money(result.price);
    if (priceEl) priceEl.textContent = display;
    if (packPrice) packPrice.textContent = display;
  }

  function applyBundle(el, result) {
    if (!result) return;
    var bPrice = el.querySelector('.ibl-bundle-price');      // master-bundle.html pricing block
    var price = el.querySelector('.ibl-price');               // instruments.html bundle card
    var altarPrice = el.querySelector('.ibl-altar-price');    // altar.html bundle price row
    var name = el.querySelector('.ibl-altar-bundle-name');    // altar.html bundle card
    var btn = el.querySelector('.ibl-pack-buy-btn');          // supporter-bundle.html
    var priceLine = el.querySelector('.ibl-pack-price');
    var display = money(result.price);
    if (bPrice) bPrice.textContent = display;
    if (price) price.textContent = display;
    if (altarPrice) altarPrice.textContent = display;
    if (name) name.textContent = name.textContent.replace(/\$[\d.]+/, display);
    if (btn) btn.textContent = btn.textContent.replace(/-?\s*\$[\d.]+/, '- ' + display);
    if (priceLine) setFirstTextNode(priceLine, display);
  }

  function applyTotal(el, bySlug) {
    var sum = 0;
    Object.keys(bySlug).forEach(function (slug) {
      var r = bySlug[slug];
      if (r && r.price > 0) sum += r.price;
    });
    var label = el.textContent.replace(/^\$[\d.]+/, '').trim();
    el.textContent = money(sum) + (label ? ' ' + label : '');
  }

  function apply() {
    var productEls = Array.prototype.slice.call(document.querySelectorAll('[data-ibl-slug]'));
    var bundleEls = Array.prototype.slice.call(document.querySelectorAll('[data-ibl-bundle]'));
    var totalEls = Array.prototype.slice.call(document.querySelectorAll('[data-ibl-total-value]'));
    if (!productEls.length && !bundleEls.length) return;

    productEls.forEach(function (el) {
      applyProduct(el, resultFor(el.getAttribute('data-ibl-slug')));
    });
    bundleEls.forEach(function (el) {
      applyBundle(el, resultFor(el.getAttribute('data-ibl-bundle')));
    });
    // The total only counts individual products, never bundles.
    var bySlug = {};
    productEls.forEach(function (el) {
      var slug = el.getAttribute('data-ibl-slug');
      if (slug) bySlug[slug] = resultFor(slug);
    });
    totalEls.forEach(function (el) {
      applyTotal(el, bySlug);
    });
  }

  var api = {
    money: money,
    PRICES: PRICES,
    applyProduct: applyProduct,
    applyBundle: applyBundle,
    applyTotal: applyTotal
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply);
    } else {
      apply();
    }
  }
})(typeof window !== 'undefined' ? window : this);
