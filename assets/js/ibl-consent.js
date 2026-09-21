/*!
 * iamLamprey consent — ibl-consent.js
 *
 * The two paths the Meta pixel hangs on, and the reason both banners in
 * _includes/consent-banner.html exist. There is no front matter on this file, so
 * Jekyll does not process it and nothing is injected: the pixel's own global —
 * window.iblLoadPixel, defined in _includes/meta-pixel.html — is simply called
 * once the browser is cleared to be tracked. A browser with javascript off runs
 * neither this file nor the pixel, which is the same answer as a decline.
 *
 * A visitor in a country whose law requires prior consent gets the gate: the
 * Accept/Decline banner, and no pixel until Accept. Everyone else gets the
 * dismissible notice with the pixel loading behind it. window.iblGeo — the regime
 * request meta-pixel.html starts in the head — is what tells the two apart, and
 * anything other than an explicit 'not_required' is read as the gated answer.
 *
 * The two records live under different keys because they are different things.
 * 'ibl-consent-v1' is the decision the pixel hangs on, and a new version of it is
 * how a later change to what is being consented to is introduced rather than
 * everyone who answered the old one inheriting it. 'ibl-notice-v1' is only that
 * the notice was dismissed — and, since only a visitor outside a consent country
 * is ever shown it, that dismissal is also the record that this browser needs no
 * /geo round trip on a later visit. A notice is not a consent, so it does not
 * belong in the key that describes one.
 */
(function () {
  'use strict';

  var KEY = 'ibl-consent-v1';
  var NOTICE_KEY = 'ibl-notice-v1';
  var GRANTED = 'granted';
  var DENIED = 'denied';

  // storage can be refused — private mode, or a browser set that way — and a
  // decision that cannot be read is no decision: the banner is shown again
  // rather than the pixel firing on an answer nobody remembers giving
  function storedState() {
    try {
      var stored = window.localStorage.getItem(KEY);

      return stored === GRANTED || stored === DENIED ? stored : '';
    } catch (error) {
      return '';
    }
  }

  function remember(state) {
    try {
      window.localStorage.setItem(KEY, state);
    } catch (error) {
      // the decision still applies to this page; it just will not survive the reload
    }
  }

  function grant() {
    window.iblConsent = GRANTED;

    if (window.iblLoadPixel) window.iblLoadPixel();
  }

  function answer(state, banner) {
    remember(state);
    banner.hidden = true;

    if (state === GRANTED) grant();
    else window.iblConsent = DENIED;
  }

  // the non-EU notice was dismissed on an earlier visit, which is also the record
  // that this browser was not in a consent country — so the pixel loads as it did
  // then, with no /geo round trip and nothing to show
  function noticeSeen() {
    try {
      return window.localStorage.getItem(NOTICE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function rememberNotice() {
    try {
      window.localStorage.setItem(NOTICE_KEY, '1');
    } catch (error) {
      // the notice reappears next visit; it is a notice, so that is only a nuisance
    }
  }

  // the regime comes from the Worker, so it is waited on rather than guessed at.
  // A promise that is missing, rejected or resolves to anything unexpected is
  // read as the gated answer — the same direction the Worker itself fails in.
  function askRegime(done) {
    var asked = window.iblGeo;

    if (!asked || typeof asked.then !== 'function') {
      done('required');
      return;
    }

    asked.then(
      function (regime) { done(regime === 'not_required' ? 'not_required' : 'required'); },
      function () { done('required'); }
    );
  }

  function showNotice(notice) {
    notice.hidden = false;

    notice.addEventListener('click', function (event) {
      var close = event.target.closest ? event.target.closest('[data-ibl-notice]') : null;

      // only the × dismisses: a click on the notice's own text is not an answer
      if (!close) return;

      rememberNotice();
      notice.hidden = true;
    });
  }

  function run() {
    var banner = document.getElementById('ibl-consent');
    var notice = document.getElementById('ibl-notice');
    var state = storedState();

    // a decision on record is applied without either banner appearing
    if (state === GRANTED) {
      grant();
      return;
    }

    if (state === DENIED) {
      window.iblConsent = DENIED;
      return;
    }

    // the dismissal is the record that this browser was outside a consent country
    if (noticeSeen()) {
      grant();
      return;
    }

    askRegime(function (regime) {
      // a notice that is not in the markup is not a reason to track: without
      // somewhere to disclose, the gated path is the only one left
      if (regime === 'not_required' && notice) {
        grant();
        showNotice(notice);
        return;
      }

      if (!banner) return;

      banner.hidden = false;

      banner.addEventListener('click', function (event) {
        var choice = event.target.closest ? event.target.closest('[data-ibl-consent]') : null;

        // a click on the banner's own text is a click on the banner, not an answer
        if (!choice) return;

        answer(choice.getAttribute('data-ibl-consent'), banner);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
