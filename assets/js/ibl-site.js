/*!
 * iamLamprey site chrome — ibl-site.js
 *
 * Announcement bar, customer-portal link and the mobile menu. Loaded on every
 * page; the announcement is only revealed when config.json carries non-empty
 * text, so an absent or emptied announcement never leaves an empty strip.
 */
(function () {
  'use strict';

  var GLITCH_CHARS = '01!@#$%^&*()_+-=[]{}|;:,.<>/?';
  var GLITCH_LENGTH = 40;

  function makeNoise(seed) {
    var state = Date.now() + seed + Math.random() * 99999;

    function random() {
      state = (state * 16807) % 2147483647;
      return (state - 1) / 2147483646;
    }

    var buffer = [];
    for (var i = 0; i < GLITCH_LENGTH; i++) {
      buffer.push(GLITCH_CHARS[Math.floor(random() * GLITCH_CHARS.length)]);
    }

    return { buffer: buffer, random: random };
  }

  function render(el, buffer, flash) {
    el.innerHTML = buffer.map(function (character, index) {
      return flash[index] ? '<span class="glitched">' + character + '</span>' : '<span>' + character + '</span>';
    }).join('');
  }

  function scramble(noise, el, interval) {
    if (!el) return;

    render(el, noise.buffer, {});

    setInterval(function () {
      var flash = {};
      var count = Math.floor(noise.random() * 2) + 2;
      for (var i = 0; i < count; i++) {
        var position = Math.floor(noise.random() * GLITCH_LENGTH);
        noise.buffer[position] = GLITCH_CHARS[Math.floor(noise.random() * GLITCH_CHARS.length)];
        flash[position] = true;
      }
      render(el, noise.buffer, flash);
    }, interval);
  }

  function startGlitch() {
    scramble(makeNoise(1), document.getElementById('iblAnnounceGlitchL'), 500);
    scramble(makeNoise(2), document.getElementById('iblAnnounceGlitchR'), 600);
  }

  function fillAnnouncement(data) {
    var bar = document.getElementById('iblAnnounceBar');
    if (!bar || !data.announcement) return;

    var text = document.getElementById('iblAnnounceText');
    var link = document.getElementById('iblAnnounceLink');
    if (!text) return;

    text.textContent = data.announcement.text;

    if (link && data.announcement.link) {
      link.setAttribute('href', IBLConfig.resolve(data.announcement.link));
      link.setAttribute('aria-label', data.announcement.text);
      link.hidden = false;
    }

    bar.hidden = false;
    startGlitch();
  }

  function applyPortal(data) {
    var portal = data.config && data.config.org && data.config.org.customerPortal;
    if (!portal) return;

    var links = document.querySelectorAll('[data-ibl-portal]');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('href', portal);
    }
  }

  function initMenu() {
    var navbar = document.querySelector('.ibl-navbar');
    var burger = document.querySelector('.ibl-navbar-masthead-burger');
    var overlay = document.getElementById('iblNavOverlay');
    var close = document.querySelector('.ibl-navbar-overlay-close');
    if (!navbar || !burger || !overlay || !close) return;

    function openMenu() {
      navbar.classList.add('ibl-open');
      document.body.classList.add('ibl-menu-open');
      burger.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
      navbar.classList.remove('ibl-open');
      document.body.classList.remove('ibl-menu-open');
      burger.setAttribute('aria-expanded', 'false');
    }

    burger.addEventListener('click', openMenu);
    close.addEventListener('click', closeMenu);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });

    var links = overlay.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', closeMenu);
    }

    window.addEventListener('resize', function () {
      if (window.innerWidth > 760) closeMenu();
    });
  }

  initMenu();

  IBLConfig.load().then(function (data) {
    fillAnnouncement(data);
    applyPortal(data);
  });
})();
