/*!
 * iamLamprey subscription page — ibl-subscribed.js
 *
 * The page a confirmation link lands on, and one job: /confirm answers the click
 * with a 303 carrying one flag (?confirmed=1, ?expired=1 or ?confirm_error=1),
 * and this reveals the line that flag names and then clears it, so a reload does
 * not re-announce a subscription that was already confirmed.
 *
 * A link that never reached /confirm — a hand-typed URL, or one the Worker
 * answered before it had a flag to give — shows the expired line, which is the
 * only thing this page can say without one. It is the same line a stale or
 * forged link gets, deliberately: the visitor does the same thing about either.
 *
 * No fetch, no form and no token: /confirm is a GET the browser follows, so this
 * page posts nothing and only has a line to show.
 *
 * Loaded only when a page sets `subscribed: true` in its front matter.
 */
(function () {
  'use strict';

  var lines = {
    confirmed: document.getElementById('iblSubscribedConfirmed'),
    expired: document.getElementById('iblSubscribedExpired'),
    confirm_error: document.getElementById('iblSubscribedError')
  };

  function reveal(target) {
    for (var state in lines) {
      if (lines[state]) lines[state].hidden = lines[state] !== target;
    }
  }

  function flag(name) {
    return new RegExp('(?:^|[?&])' + name + '=1(?:&|$)').test(window.location.search);
  }

  var answered = false;

  for (var state in lines) {
    if (lines[state] && flag(state)) {
      reveal(lines[state]);
      answered = true;
    }
  }

  if (!answered) reveal(lines.expired);

  if (answered && window.history && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
})();
