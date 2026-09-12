/*!
 * iamLamprey glitch line — ibl-glitch-line.js
 *
 * The flickering rows of static that frame /contact/. Each .ibl-glitch-line-screen
 * holds 85 mono characters that re-randomise every 700ms with a short flicker.
 * Loaded only when a page sets `glitch: true` in its front matter.
 */
(function () {
  'use strict';

  var screens = document.querySelectorAll('.ibl-glitch-line-screen');
  if (!screens.length) return;

  var LEN = 85;
  var CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;:,.<>?/\\~`';
  var CHURN = 0.18;

  function makeRand(seed) {
    var state = seed;

    return function rand() {
      state = (state * 16807) % 2147483647;
      return (state - 1) / 2147483646;
    };
  }

  function flicker(el) {
    el.classList.remove('flicker');
    void el.offsetWidth;
    el.classList.add('flicker');

    window.setTimeout(function () {
      el.classList.remove('flicker');
    }, 150);
  }

  function startLine(el) {
    var rand = makeRand(Date.now() + Math.random() * 99999);
    var buf = [];

    for (var i = 0; i < LEN; i++) buf.push(CHARS[Math.floor(rand() * CHARS.length)]);
    el.textContent = buf.join('');

    window.setInterval(function () {
      for (var i = 0; i < LEN; i++) {
        if (rand() < CHURN) buf[i] = CHARS[Math.floor(rand() * CHARS.length)];
      }
      el.textContent = buf.join('');
      flicker(el);
    }, 700);
  }

  for (var i = 0; i < screens.length; i++) startLine(screens[i]);
})();
