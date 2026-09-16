/*!
 * iamLamprey site chrome — ibl-site.js
 *
 * Announcement bar, the per-product rating's baseline and its live figures,
 * customer-portal link and the mobile menu. Loaded on every page; the
 * announcement is only revealed when config.json carries a usable value, so an
 * absent or emptied entry never leaves an empty strip. The rating's baseline is
 * server-rendered from _data/ratings.yml; if this file never runs, that figure,
 * the caption and five hollow stars are still there.
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

  /* the fill layer is clipped to the average the wrapper carries, which is the
     build's baseline until liveRating writes the blended figure into it: the
     value, the caption and the outline are markup either way */
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

  /* the live half of the rating, and the only place the two halves are blended:
     the wrapper carries the baseline the build rendered, this fetches the
     product's own figures from the Worker, writes the blend back into the same
     attributes and re-clips the fill. Only a product page carries the wrapper,
     so nothing else fetches anything, and every failure is silent — the
     baseline is already on screen and stays there. The endpoint's own
     five-minute cache is what keeps a browse cheap: no timeout, no retry and
     nothing remembered between pages */
  function liveRating() {
    var root = document.getElementById('iblRating');
    if (!root) return;

    var endpoint = root.getAttribute('data-ibl-ratings');
    var slug = root.getAttribute('data-ibl-slug');
    if (!endpoint || !slug) return;

    var hasBaseline = root.hasAttribute('data-ibl-count');
    var baseCount = hasBaseline ? Number(root.getAttribute('data-ibl-count')) : 0;
    var baseAverage = hasBaseline ? parseFloat(root.getAttribute('data-ibl-average')) : 0;

    fetch(endpoint, { headers: { 'Accept': 'application/json' } }).then(function (response) {
      return response.json();
    }).then(function (data) {
      var live = data && data.product && data.product[slug];

      /* no row for this slug is not a failure: the product simply has no live
         ratings yet, so the baseline stands as the build rendered it */
      if (!live) return;

      /* the response is somebody else's to shape, so a row that is not two
         numbers is not a figure: the baseline stands rather than the badge
         printing NaN */
      var liveCount = Number(live.count);
      var liveAverage = Number(live.average);
      if (!isFinite(liveCount) || !isFinite(liveAverage)) return;

      var count = baseCount + liveCount;
      if (!count) return;

      var total = (hasBaseline ? baseAverage * baseCount : 0) + liveAverage * liveCount;
      var average = total / count;

      /* the gate is the blended average, compared before any rounding: a 3.96
         figure is below 4.0 however it would print */
      if (average < 4) {
        root.hidden = true;
        return;
      }

      /* four places because this is the attribute the fill reads — parseFloat
         treats 5 and 5.0 alike, so the cap is the only thing that matters here */
      root.setAttribute('data-ibl-average', Math.round(average * 10000) / 10000);

      var value = document.getElementById('iblRatingValue');
      var caption = document.getElementById('iblRatingCount');
      var stars = document.getElementById('iblRatingStars');

      /* toFixed(1) prints 5.0 rather than 5, which is what Liquid's `round: 1`
         prints too: the fetched figure reads like the rendered one */
      if (value) value.textContent = average.toFixed(1);
      if (caption) caption.textContent = count === 1 ? '(1 rating)' : '(' + count + ' ratings)';
      if (stars) stars.setAttribute('aria-label', 'Rated ' + average.toFixed(1) + ' out of 5');

      root.hidden = false;
      fillRating(); /* the average is set, so this is the figure that gets clipped */
    }).catch(function () {
      /* offline, blocked or a 503: the server-rendered figure stays as it is */
    });
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

  /* the live half is a fetch, so it upgrades the rendered figure when — and
     only when — it lands */
  liveRating();

  IBLConfig.load().then(function (data) {
    fillAnnouncement(data);
    applyPortal(data);
  });
})();
