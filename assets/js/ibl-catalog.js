/*!
 * iamLamprey commerce renderer — ibl-catalog.js
 *
 * Everything that renders a price, a countdown or a checkout link. Values come
 * from config.json at runtime — no price, checkout URL or countdown is built
 * into the HTML. A block can name its own button with data-ibl-buy-label.
 *
 * Degraded state is deliberate: if config.json cannot be fetched we show no
 * price at all rather than a hardcoded one. A stale price is worse than no
 * price, and the real price is always confirmed on Polar's checkout page.
 */
(function () {
  'use strict';

  var UNAVAILABLE = 'Pricing unavailable \u2014 reload the page';

  /* the overlay theme comes from the page: Muzzle is light, everything else dark */
  var CHECKOUT_THEME = (document.body && document.body.getAttribute('data-ibl-checkout-theme')) || '';

  function show(el, on) {
    if (el) el.hidden = !on;
  }

  function priceLabel(value) {
    return value > 0 ? IBLConfig.money(value) : 'Free';
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function formatRemaining(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    var clock = pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
    var dayLabel = days === 1 ? '1 day' : days + ' days';
    return days > 0 ? dayLabel + ' ' + clock : clock;
  }

  /* urgency tiers for the sale timer, styled in site.css: blue by default,
     amber inside 5 days, orange inside 24 hours */
  var AMBER_WITHIN = 5 * 86400000;
  var ORANGE_WITHIN = 86400000;

  function drawTimer(el, remaining) {
    var tier = '';

    if (remaining < ORANGE_WITHIN) tier = 'ibl-sale-timer-orange';
    else if (remaining < AMBER_WITHIN) tier = 'ibl-sale-timer-amber';

    el.textContent = 'Ends in ' + formatRemaining(remaining);
    el.classList.remove('ibl-sale-timer-amber', 'ibl-sale-timer-orange');
    if (tier) el.classList.add(tier);
  }

  function withCode(url, code) {
    if (!code) return url;
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    return url + separator + 'discount_code=' + encodeURIComponent(code);
  }

  /* --- product block (data-ibl-product) --- */

  function renderProduct(el, data) {
    var slug = el.getAttribute('data-ibl-product');
    var item = data.item(slug);

    var nameEl = el.querySelector('.ibl-product-name');
    var rowEl = el.querySelector('.ibl-price-row');
    var priceEl = el.querySelector('.ibl-price');
    var oldEl = el.querySelector('.ibl-price-old');
    var chipEl = el.querySelector('.ibl-sale-chip');
    var timerEl = el.querySelector('.ibl-sale-timer');
    var noteEl = el.querySelector('.ibl-price-note');
    var buyEl = el.querySelector('.ibl-buy');

    if (!item) {
      /* never leave a stale price or countdown behind when config.json cannot be read */
      if (priceEl) priceEl.textContent = '';
      if (oldEl) oldEl.textContent = '';
      if (timerEl) timerEl.textContent = '';
      show(rowEl, false);
      show(timerEl, false);
      show(buyEl, false);
      show(noteEl, true);
      return;
    }

    var label = item.name || slug;
    var tagline = el.getAttribute('data-ibl-tagline') || '';
    var buyLabel = el.getAttribute('data-ibl-buy-label') || '';
    var base = typeof item.price === 'number' ? item.price : 0;
    var checkout = item.checkout ? IBLConfig.resolve(item.checkout) : '';
    var timer = null;

    if (nameEl && item.name) nameEl.textContent = tagline ? item.name + ' - ' + tagline : item.name;

    function stopTimer() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    function drawBuy(onSale) {
      if (!buyEl) return;

      if (!checkout) {
        buyEl.removeAttribute('href');
        buyEl.setAttribute('aria-disabled', 'true');
        buyEl.classList.add('ibl-buy-disabled');
        buyEl.textContent = 'Coming soon';
        show(buyEl, true);
        return;
      }

      buyEl.setAttribute('href', onSale ? withCode(checkout, data.discount.code) : checkout);
      buyEl.setAttribute('rel', 'noopener');
      /* the embed builds its URL from these at click time, so a later price
         change or discount code keeps working on a button bound once */
      buyEl.setAttribute('data-polar-checkout', '');
      if (CHECKOUT_THEME) buyEl.setAttribute('data-polar-checkout-theme', CHECKOUT_THEME);
      buyEl.classList.remove('ibl-buy-disabled');
      buyEl.removeAttribute('aria-disabled');
      /* a free item is a download, not a purchase; a block can override the
         label with data-ibl-buy-label */
      buyEl.textContent = buyLabel || (base > 0 ? 'Buy ' + label : 'Download');
      show(buyEl, true);
    }

    function drawBase() {
      stopTimer();
      show(rowEl, true);
      if (priceEl) priceEl.textContent = priceLabel(base);
      show(oldEl, false);
      show(chipEl, false);
      show(timerEl, false);
      if (timerEl) timerEl.textContent = '';
      drawBuy(false);
    }

    function drawSale() {
      var amount = Number(data.discount.amount) || 0;
      var end = data.saleEnd(slug);

      if (priceEl) priceEl.textContent = priceLabel(base * (1 - amount / 100));
      if (oldEl) {
        oldEl.textContent = IBLConfig.money(base);
        show(oldEl, base > 0);
      }
      if (chipEl) {
        chipEl.textContent = amount + '% off';
        show(chipEl, true);
      }
      show(rowEl, true);
      show(timerEl, true);
      drawBuy(true);

      function tick() {
        var remaining = end.getTime() - Date.now();
        if (remaining <= 0) {
          drawBase(); // the window closed while the page was open
          return;
        }
        if (timerEl) drawTimer(timerEl, remaining);
      }

      stopTimer();
      tick();
      timer = setInterval(tick, 1000);
    }

    show(noteEl, false);

    /* a free item is never on sale: there is nothing to discount, so no chip,
       countdown, struck-through price or discount code on its checkout link */
    if (base > 0 && data.saleActive(slug)) {
      drawSale();
    } else {
      drawBase();
    }
  }

  /* --- catalogue grid (data-ibl-catalog) --- */

  /* data-ibl-group names both the URL segment and the images/ directory a grid
     draws from, and an entry may alias its catalogue slug to the slug of the
     page it lives on: 'ambience-supporter-pack:ambiences' */

  function cardFor(item, data, group, key) {
    var listItem = document.createElement('li');
    var link = document.createElement('a');
    var art = document.createElement('span');
    var image = document.createElement('img');
    var info = document.createElement('span');
    var name = document.createElement('span');
    var price = document.createElement('span');
    var base = typeof item.price === 'number' ? item.price : 0;
    var onSale = base > 0 && data.saleActive(item.slug);

    link.className = 'ibl-card';
    link.setAttribute('href', IBLConfig.resolve('/' + group + '/' + key + '/'));

    art.className = 'ibl-card-art';
    image.setAttribute('src', IBLConfig.resolve('/images/' + group + '/' + key + '-cover.jpg'));
    image.setAttribute('alt', item.name + ' artwork');
    image.setAttribute('loading', 'lazy');
    art.appendChild(image);

    info.className = 'ibl-card-info';
    name.className = 'ibl-card-name';
    name.textContent = item.name;
    info.appendChild(name);

    if (onSale) {
      var old = document.createElement('span');
      old.className = 'ibl-card-price-old';
      old.textContent = IBLConfig.money(base);
      info.appendChild(old);
    }

    price.className = 'ibl-card-price';
    price.textContent = onSale
      ? priceLabel(base * (1 - (Number(data.discount.amount) || 0) / 100))
      : priceLabel(base);
    info.appendChild(price);

    link.appendChild(art);
    link.appendChild(info);
    listItem.appendChild(link);

    return listItem;
  }

  function showUnavailable(grid) {
    var note = document.createElement('p');
    note.className = 'ibl-price-note';
    note.textContent = UNAVAILABLE;

    show(grid, false);
    grid.parentNode.insertBefore(note, grid.nextSibling);
  }

  function renderCatalog(grid, data) {
    var slugs = (grid.getAttribute('data-ibl-slugs') || '').split(',');
    var group = grid.getAttribute('data-ibl-group') || 'instruments';
    var fragment = document.createDocumentFragment();
    var total = 0;

    if (!data.config) {
      showUnavailable(grid);
      return;
    }

    for (var i = 0; i < slugs.length; i++) {
      var parts = slugs[i].split(':');
      var slug = parts[0].trim();
      var key = (parts[1] || parts[0]).trim();
      if (!slug) continue;

      var item = data.item(slug);
      if (item) {
        /* the list value of the grid, for the pages that ask for it */
        total += typeof item.price === 'number' && item.price > 0 ? item.price : 0;
        fragment.appendChild(cardFor(item, data, group, key));
      }
    }

    if (!fragment.childNodes.length) {
      showUnavailable(grid);
      return;
    }

    grid.innerHTML = '';
    grid.appendChild(fragment);
    drawTotal(grid, total);
  }

  /* a grid can ask for the list value of its contents with
     data-ibl-total="total value", which reads "$420.00 total value" above the
     cards; the sum is of the shelf prices — what the set is worth, not what it
     costs today — and free items add nothing to it */

  function drawTotal(grid, total) {
    var label = grid.getAttribute('data-ibl-total');
    if (!label) return;

    var line = document.createElement('p');
    line.className = 'ibl-total-value';
    line.textContent = IBLConfig.money(total) + ' ' + label;
    grid.parentNode.insertBefore(line, grid);
  }

  /* the embed binds with a one-off query, so it has to run after the buttons
     exist — they are built from config.json, not the page's markup */
  function initCheckout() {
    if (window.Polar && window.Polar.EmbedCheckout) window.Polar.EmbedCheckout.init();
  }

  function run() {
    var blocks = document.querySelectorAll('[data-ibl-product]');
    var grids = document.querySelectorAll('[data-ibl-catalog]');
    if (!blocks.length && !grids.length) return;

    IBLConfig.load().then(function (data) {
      for (var i = 0; i < blocks.length; i++) renderProduct(blocks[i], data);
      for (var j = 0; j < grids.length; j++) renderCatalog(grids[j], data);
      initCheckout();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
