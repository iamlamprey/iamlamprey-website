/*!
 * iamLamprey consent gate — ibl-consent.js
 *
 * The one decision the Meta pixel hangs on, and the reason the banner in
 * _includes/consent-banner.html exists. There is no front matter on this file,
 * so Jekyll does not process it and nothing is injected: the pixel's own global
 * — window.iblLoadPixel, defined in _includes/meta-pixel.html — is simply called
 * once the decision is granted. A browser with javascript off runs neither this
 * file nor the pixel, which is the same answer as a decline.
 *
 * The decision is the only thing stored: 'ibl-consent-v1' in localStorage, so a
 * later change to what is being consented to can be introduced under a new key
 * rather than being silently inherited by everyone who answered the old one.
 */
(function () {
  'use strict';

  var KEY = 'ibl-consent-v1';
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

  function run() {
    var banner = document.getElementById('ibl-consent');
    var state = storedState();

    // a decision on record is applied without the banner ever appearing
    if (state === GRANTED) {
      grant();
      return;
    }

    if (state === DENIED) {
      window.iblConsent = DENIED;
      return;
    }

    if (!banner) return;

    banner.hidden = false;

    banner.addEventListener('click', function (event) {
      var choice = event.target.closest ? event.target.closest('[data-ibl-consent]') : null;

      // a click on the banner's own link is a click on the banner, not an answer
      if (!choice) return;

      answer(choice.getAttribute('data-ibl-consent'), banner);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
