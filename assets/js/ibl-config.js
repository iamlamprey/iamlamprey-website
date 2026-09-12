---
---
/*!
 * iamLamprey data layer — ibl-config.js
 *
 * config.json is the single source of truth for every commerce value on the
 * site: product name, price, sale price, countdown and Polar checkout link.
 * One fetch per page load, memoised, so the announcement bar, the product
 * block and any catalogue grid share the same request — and a sale created or
 * changed by the polar-discount Action shows up on the next page load with no
 * site rebuild.
 */
(function (root) {
  'use strict';

  /* Cache-busted: GitHub Pages serves assets with a ~10 minute max-age. */
  var CONFIG_URL = '{{ "/config.json" | relative_url }}?v=' + Date.now();

  /* The site root as this page sees it, so links written in config.json
     ("/instruments/") survive the project-page baseurl. */
  var SITE_ROOT = CONFIG_URL.replace(/[^/]*(\?.*)?$/, '');

  /* Australia/Brisbane is a fixed UTC+10 all year — no daylight saving. */
  var LOCAL_OFFSET = '+10:00';

  var pending = null;

  function money(value) {
    var amount = typeof value === 'number' ? value : parseFloat(value) || 0;
    return '$' + (Math.round(amount * 100) / 100).toFixed(2);
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  /* parses DD/MM/YYYY (Australia/Brisbane) into a fixed UTC instant */
  function parseDate(value, endOfDay) {
    var parts = String(value || '').split('/');
    if (parts.length !== 3) return null;

    var day = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var year = parseInt(parts[2], 10);
    if (!day || !month || !year) return null;

    var time = endOfDay ? '23:59:59' : '00:00:00';
    var date = new Date(year + '-' + pad2(month) + '-' + pad2(day) + 'T' + time + LOCAL_OFFSET);
    return isNaN(date.getTime()) ? null : date;
  }

  /* turns a link from config.json into an href that works under any baseurl */
  function resolve(link) {
    var value = String(link || '');
    if (!value) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf('//') === 0) return value;
    return SITE_ROOT + value.replace(/^\//, '');
  }

  function findItem(items, slug) {
    var list = items || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].slug === slug) return list[i];
    }
    return null;
  }

  function coversSlug(products, slug) {
    if (products === 'ALL') return true;
    if (Object.prototype.toString.call(products) === '[object Array]') {
      return products.indexOf(slug) !== -1;
    }
    return false;
  }

  function isOpen(window_, now) {
    if (!window_) return false;
    return now >= window_.start.getTime() && now <= window_.end.getTime();
  }

  /* start is 00:00:00 local on the start date, end is 23:59:59 local on the end date */
  function dateWindow(start, end) {
    var from = parseDate(start, false);
    var to = parseDate(end, true);
    if (!from || !to) return null;
    return { start: from, end: to };
  }

  /* the announcement carries no date window: text shows it, an empty text hides it */
  function announcementFor(config) {
    var announcement = config && config.announcement;
    if (!announcement || !announcement.text) return null;

    return { text: announcement.text, link: announcement.link || '' };
  }

  /* builds the resolved view of a config (or of a failed fetch) */
  function build(config) {
    var discount = (config && config.discount) || null;
    var window_ = discount ? dateWindow(discount.start, discount.end) : null;

    function item(slug) {
      return findItem(config && config.items, slug);
    }

    function saleActive(slug) {
      if (!window_ || !isOpen(window_, Date.now())) return false;
      return coversSlug(discount.products, slug);
    }

    function saleEnd(slug) {
      return saleActive(slug) ? window_.end : null;
    }

    return {
      config: config,
      item: item,
      discount: discount,
      saleActive: saleActive,
      saleEnd: saleEnd,
      announcement: announcementFor(config)
    };
  }

  /* resolves the memoised config — a null config on failure, never a rejection */
  function load() {
    if (pending) return pending;

    if (typeof root.fetch !== 'function') {
      pending = Promise.resolve(build(null));
      return pending;
    }

    pending = root.fetch(CONFIG_URL)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(build)
      .catch(function () {
        return build(null);
      });

    return pending;
  }

  root.IBLConfig = {
    load: load,
    money: money,
    parseDate: parseDate,
    resolve: resolve,
    covers: coversSlug
  };

  load(); // start the single request now so every consumer shares it
})(window);
