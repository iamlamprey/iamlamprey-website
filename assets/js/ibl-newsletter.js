/*!
 * iamLamprey newsletter form — ibl-newsletter.js
 *
 * The mailing-list form in the footer of every page, and the same partial again
 * in the block on /thanks/. Two jobs, the shape ibl-contact.js already uses:
 * without fetch() the Worker answers the plain post with a 303 to the page it
 * came from (?subscribed=1 or ?subscribe_error=1) and this reveals the matching
 * line; with fetch() the submit is intercepted, posted as FormData and answered
 * inline, so the visitor never leaves the page.
 *
 * Bound by class rather than id, because /thanks/ carries two of these and each
 * has to answer on its own. A flag in the query string belongs to the page, not
 * to one form, so the no-js round trip reveals its line on every instance —
 * which is why /subscribe uses its own flag pair rather than /contact/'s: the
 * footer form must not light up because a contact message was sent.
 *
 * The Worker requires a Turnstile token, so a submit waits for one rather than
 * posting without it — see waitForToken() below.
 *
 * Loaded on every page, unlike ibl-contact.js, because the form is site-wide.
 */
(function () {
  'use strict';

  var forms = document.querySelectorAll('.ibl-newsletter-form');
  var TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

  // the wait for a token the lazily-loaded widget has not filled in yet
  var TOKEN_FIELD = '[name="cf-turnstile-response"]';
  var TOKEN_INTERVAL = 100;
  var TOKEN_TIMEOUT = 4000;

  if (!forms.length) return;

  function lineOf(form, selector) {
    return form.querySelector(selector);
  }

  function reveal(form, target) {
    var sent = lineOf(form, '.ibl-newsletter-status');
    var failed = lineOf(form, '.ibl-newsletter-status-error');
    if (!sent || !failed || !target) return;

    sent.hidden = target !== sent;
    failed.hidden = target !== failed;
    target.hidden = false;
  }

  function loadTurnstile() {
    // a page that already carries it — the contact page does — must not get a
    // second copy
    if (document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile"]')) return;

    var script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    document.head.appendChild(script);
  }

  function tokenOf(form) {
    var field = form.querySelector(TOKEN_FIELD);

    return field && field.value ? field.value : '';
  }

  // the Worker rejects a submission carrying no token, so a submit that beats the
  // lazy load waits for one instead: the widget adds the response field as it
  // renders and fills it when the challenge completes, so an empty one is not a
  // token. A timeout ends on the error line rather than a request that is certain
  // to fail — a blocker that stops Turnstile altogether lands there too.
  function waitForToken(form, ready) {
    loadTurnstile();

    var waited = 0;

    (function poll() {
      if (tokenOf(form)) {
        ready(true);
        return;
      }

      waited += TOKEN_INTERVAL;

      if (waited >= TOKEN_TIMEOUT) {
        ready(false);
        return;
      }

      window.setTimeout(poll, TOKEN_INTERVAL);
    })();
  }

  function send(form, done) {
    window.fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { 'Accept': 'application/json' }
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return response.ok && !!data && data.ok === true;
        });
      })
      .catch(function () {
        return false; // an unreachable Worker or an unparseable reply is still a failure
      })
      .then(done);
  }

  function bind(form) {
    var button = lineOf(form, '.ibl-newsletter-submit');
    var sent = lineOf(form, '.ibl-newsletter-status');
    var error = lineOf(form, '.ibl-newsletter-status-error');

    // fetched on the first focus rather than loaded on every page for a footer
    // widget; waitForToken() repeats the load in case a submit beat the focus
    form.addEventListener('focusin', loadTurnstile, { once: true });

    // a browser without fetch keeps the native post
    if (!window.fetch || !window.FormData) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (button) button.disabled = true;
      if (sent) sent.hidden = true;
      if (error) error.hidden = true;

      waitForToken(form, function (ready) {
        if (!ready) {
          if (button) button.disabled = false;
          reveal(form, error);
          return;
        }

        send(form, function (ok) {
          if (button) button.disabled = false;
          reveal(form, ok ? sent : error);
          if (ok) form.reset();
        });
      });
    });
  }

  var query = window.location.search;
  var subscribed = /(?:^|[?&])subscribed=1(?:&|$)/.test(query);
  var failed = /(?:^|[?&])subscribe_error=1(?:&|$)/.test(query);

  // the no-js path lands back here with a flag in the query string
  if (subscribed || failed) {
    for (var index = 0; index < forms.length; index++) {
      reveal(forms[index], lineOf(forms[index], failed ? '.ibl-newsletter-status-error' : '.ibl-newsletter-status'));
    }

    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  }

  for (var slot = 0; slot < forms.length; slot++) {
    bind(forms[slot]);
  }
})();
