/*!
 * iamLamprey site chrome — ibl-site.js
 *
 * Announcement bar, the per-product rating's star fill, customer-portal link
 * and the mobile menu. Loaded on every page; the announcement is only revealed
 * when config.json carries a usable value, so an absent or emptied entry never
 * leaves an empty strip. The rating itself is server-rendered from
 * _data/ratings.yml, so only the fill layer's width needs the DOM: if this file
 * never runs, the value, the caption and five hollow stars are still there.
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

  /* the fill is measured by the star's area, not its width: covering 40% of
     the glyph's width only fills about a fifth of it, which reads as an empty
     star. these are the offsets (of a 26-unit slot, 5% apart) at which the
     star in _includes/product-rating.html is 0%, 5% ... 100% covered */
  var STAR_AREA = [2, 5.93, 7.03, 7.73, 8.40, 9.10, 9.79, 10.40, 10.97, 11.50, 12.00, 12.50, 13.03, 13.60, 14.21, 14.90, 15.60, 16.27, 16.97, 18.07, 22];

  /* the offset into a star's 26-unit slot that covers "part" of it */
  function starFill(part) {
    var position = part * (STAR_AREA.length - 1);
    var low = Math.floor(position);
    var high = Math.min(low + 1, STAR_AREA.length - 1);

    return STAR_AREA[low] + (STAR_AREA[high] - STAR_AREA[low]) * (position - low);
  }

  /* the per-product rating is server-rendered from _data/ratings.yml, so all
     that is left for the DOM is clipping the fill layer to the average the
     wrapper carries: the value, the caption and the outline are markup */
  function fillRating() {
    var root = document.getElementById('iblRating');
    if (!root) return;

    var average = parseFloat(root.getAttribute('data-ibl-average'));
    if (!isFinite(average) || average < 0 || average > 5) return;

    var fill = document.getElementById('iblRatingFill');
    var whole = Math.floor(average);
    var part = average - whole;
    var edge = whole * 26 + (part ? starFill(part) : 0);

    /* the row is 128 units of five 26-unit stars, so the fill runs past the
       last star's ink and is capped at the whole row */
    if (fill) fill.style.width = Math.min(edge / 128 * 100, 100) + '%';
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
  /* the script is deferred, so the DOM is parsed and the fill needs no fetch */
  fillRating();

  IBLConfig.load().then(function (data) {
    fillAnnouncement(data);
    applyPortal(data);
  });
})();
