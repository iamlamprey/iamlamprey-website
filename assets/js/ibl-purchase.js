/*!
 * iamLamprey purchase reporting — ibl-purchase.js
 *
 * Loaded only by a page that sets `purchase: true` in its front matter, which
 * today is /thanks/ alone. Polar is the merchant of record, so the payment
 * happens on buy.polar.sh and the pixel never sees it: the Success URL carries
 * the checkout id Polar substituted into it, and this hands that id to the
 * Worker, which looks the order up through Polar's API and sends the server-side
 * Purchase. Both copies carry the same event_id — the Polar order id — which is
 * what makes Meta count the pair once.
 *
 * Consent gates both halves, so a buyer who declined produces nothing on either
 * side, and nothing here ever fires without a value: `value` and `currency` are
 * the two parameters Meta marks required for Purchase, and a valueless purchase
 * poisons the optimisation signal far worse than a missing one.
 */
(function () {
  'use strict';

  var FLAG_PREFIX = 'ibl-purchase-';

  function cookie(name) {
    var pairs = document.cookie ? document.cookie.split('; ') : [];

    for (var i = 0; i < pairs.length; i++) {
      var separator = pairs[i].indexOf('=');

      if (separator !== -1 && pairs[i].slice(0, separator) === name) {
        return decodeURIComponent(pairs[i].slice(separator + 1));
      }
    }

    return '';
  }

  // sessionStorage rather than localStorage: a reload of the confirmation page
  // must not report the order twice, and a fresh tab — a new session — may. Two
  // browser events carrying the same eventID are not guaranteed to collapse the
  // way a browser/server pair does, so the page has to deduplicate itself. The
  // flag is written only once the Worker has answered.
  function reported(checkoutId) {
    try {
      return window.sessionStorage.getItem(FLAG_PREFIX + checkoutId) === '1';
    } catch (error) {
      return false;
    }
  }

  function remember(checkoutId) {
    try {
      window.sessionStorage.setItem(FLAG_PREFIX + checkoutId, '1');
    } catch (error) {
      // a session store that refuses the write cannot deduplicate a reload; it is
      // not worth telling the buyer about
    }
  }

  // the browser half. iblTrack forwards its fourth argument untouched, which is
  // where the eventID that pairs this with the server's copy travels, and it
  // honours the same consent decision.
  function fire(record) {
    if (!window.iblTrack) return;

    window.iblTrack('Purchase', {
      value: record.value,
      currency: record.currency,
      content_ids: record.content_ids,
      content_type: 'product',
      num_items: 1
    }, { eventID: record.event_id });
  }

  function report(endpoint, checkoutId) {
    var fbp = cookie('_fbp');
    var fbc = cookie('_fbc');
    var body = { checkout_id: checkoutId, consent: true };

    // omitted rather than sent empty: an empty fbp/fbc is worse than none
    if (fbp) body.fbp = fbp;
    if (fbc) body.fbc = fbc;

    window.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        // 200 is the Worker's answer that it has decided: either the event is on
        // its way (ok: true) or there is nothing to report (ok: false — no paid
        // order, or a free one). Both are final, so both stop a reload resending.
        // Anything else is a failure, and a failure is worth retrying.
        return response.status === 200 ? response.json() : null;
      })
      .then(function (record) {
        if (!record) return;

        remember(checkoutId);

        if (record.ok === true) fire(record);
      })
      .catch(function () {
        // deliberately not remembered: a network failure, an unparseable reply
        // and a blocked Worker all leave the order reportable on the next load
      });
  }

  function run() {
    // the pixel and the server event are gated on the same decision, so a buyer
    // who declined reports nothing at all — the accepted trade-off
    if (window.iblConsent !== 'granted') return;

    var endpoint = document.querySelector('meta[name="ibl-purchase-endpoint"]');
    var checkoutId = new URLSearchParams(window.location.search).get('checkout_id') || '';

    // /thanks/ is reachable directly, and a visitor who typed it in has no order
    // to report and no id to look one up with
    if (!endpoint || !checkoutId || !window.fetch) return;
    if (reported(checkoutId)) return;

    report(endpoint.getAttribute('content'), checkoutId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
