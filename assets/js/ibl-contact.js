/*!
 * iamLamprey contact form — ibl-contact.js
 *
 * Two jobs. Without fetch(): the Worker answers the plain post with a 303 to
 * /contact/?sent=1 (or ?error=1), and this reveals the matching line and clears
 * the query string so a refresh does not re-announce it. With fetch(): the submit
 * is intercepted, posted as JSON and answered inline, so the visitor never leaves
 * the page. Loaded only when a page sets `contact: true` in its front matter.
 */
(function () {
  'use strict';

  var sentLine = document.getElementById('iblContactSent');
  var errorLine = document.getElementById('iblContactError');

  function reveal(line) {
    if (!line) return null;

    if (sentLine) sentLine.hidden = line !== sentLine;
    if (errorLine) errorLine.hidden = line !== errorLine;
    line.hidden = false;

    return line;
  }

  var query = window.location.search;
  var sent = /(?:^|[?&])sent=1(?:&|$)/.test(query);
  var failed = /(?:^|[?&])error=1(?:&|$)/.test(query);

  // the no-js path lands back here with a flag in the query string
  if (sent || failed) {
    reveal(sent ? sentLine : errorLine);

    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  }

  var form = document.querySelector('.ibl-contact-form');

  // a browser without fetch keeps the native post
  if (!form || !window.fetch || !window.FormData) return;

  form.addEventListener('submit', function (event) {
    var button = form.querySelector('.ibl-contact-submit');

    event.preventDefault();
    if (button) button.disabled = true;
    if (sentLine) sentLine.hidden = true;
    if (errorLine) errorLine.hidden = true;

    window.fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { 'Accept': 'application/json' }
    })
      .then(function (response) {
        return response.json().then(function (data) {
          // `success` is Web3Forms' spelling of the same flag — see Plan B in the README
          return response.ok && !!data && (data.ok === true || data.success === true);
        });
      })
      .catch(function () {
        return false; // an unreachable Worker or an unparseable reply is still a failure
      })
      .then(function (ok) {
        if (button) button.disabled = false;
        reveal(ok ? sentLine : errorLine);
        if (ok) form.reset();
      });
  });
})();
