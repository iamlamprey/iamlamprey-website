/*!
 * iamLamprey rating form — ibl-review.js
 *
 * The page a purchase email lands on, with three jobs:
 *
 * without fetch() the Worker answers the post with a 303 back to this page
 * (?rated=1, ?used=1 or ?rated=0), and this reveals the matching line and clears
 * the flags so a reload does not re-announce a rating already made; with fetch()
 * the same answers arrive inline and the visitor never leaves the page. The stars
 * only choose a rating, and Submit is what posts it: a click on a label runs its
 * handlers before the label's activation checks its radio, so the instant post
 * this used to make carried no rating at all and came back invalid. The radios
 * are a required group, which is what stops an empty submit leaving the browser.
 *
 * The one thing javascript is genuinely needed for is the token. A static page
 * cannot read its own query string, and the token only ever arrives in the email
 * link, so with none the form is hidden — there is nothing it could post — and
 * the page says where the link is instead.
 *
 * Loaded only when a page sets `review: true` in its front matter.
 */
(function () {
  'use strict';

  var form = document.querySelector('.ibl-review-form');
  if (!form) return;

  var tokenInput = document.getElementById('iblReviewToken');
  var inline = !!window.fetch && !!window.FormData;
  var posting = false; // one post at a time, so a double click on Submit cannot post twice
  var lines = {
    rated: document.getElementById('iblReviewRated'),
    used: document.getElementById('iblReviewUsed'),
    invalid: document.getElementById('iblReviewError'),
    open: document.getElementById('iblReviewOpen') // no token at all, so no form to use
  };

  function reveal(target) {
    for (var state in lines) {
      if (lines[state]) lines[state].hidden = lines[state] !== target;
    }
  }

  function flag(name) {
    return new RegExp('(?:^|[?&])' + name + '=1(?:&|$)').test(window.location.search);
  }

  var token = (/[?&]t=([0-9a-f]{64})/.exec(window.location.search) || [])[1] || '';
  var rejected = /(?:^|[?&])rated=0(?:&|$)/.test(window.location.search);
  var answered = flag('rated') || flag('used') || rejected;

  if (token) {
    tokenInput.value = token;
  } else {
    form.hidden = true;
    reveal(lines.open);
  }

  // the no-js round trip landed back here with a flag in the query string
  if (flag('rated') || flag('used')) {
    form.hidden = true;
    reveal(flag('rated') ? lines.rated : lines.used);
  } else if (rejected) {
    reveal(lines.invalid); // the form stays: a submission that failed on the way is worth retrying
  }

  if (answered && window.history && window.history.replaceState) {
    // the flags go, the token stays, so a reload still has something to post
    window.history.replaceState(null, '', window.location.pathname + (token ? '?t=' + token : '') + window.location.hash);
  }

  function post() {
    if (posting) return; // the second half of a double click lands here while the first is in flight
    posting = true;

    var button = form.querySelector('.ibl-review-submit');

    if (button) button.disabled = true;
    reveal(null);

    window.fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { 'Accept': 'application/json' }
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return (data && data.state) || 'invalid';
        });
      })
      .catch(function () {
        return 'invalid'; // an unreachable Worker or an unparseable reply is still a failure
      })
      .then(function (state) {
        posting = false;

        if (button) button.disabled = false;

        // the token is spent once the Worker has seen it, whatever it answered
        if (state !== 'invalid') form.hidden = true;
        reveal(lines[state] || lines.invalid);
      });
  }

  form.addEventListener('submit', function (event) {
    if (!inline) return; // a browser without fetch keeps the native post

    event.preventDefault();
    post();
  });
})();
