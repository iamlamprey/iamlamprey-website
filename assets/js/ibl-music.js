/*!
 * iamLamprey music screen — ibl-music.js
 *
 * The corrupted-signal screen on /music/: a buffer of noise in which song lyric
 * fragments briefly resolve, then decay back into static. Loaded only when a
 * page sets `music: true` in its front matter. No-op when the screen is absent.
 */
(function () {
  'use strict';

  var screen = document.getElementById('iblMusicScreen');
  var status = document.getElementById('iblMusicStatus');
  var dot = document.getElementById('iblMusicDot');
  if (!screen) return;

  var BUF_SIZE = 1200;

  var fragments = [
    'do I watch alone?',
    'i will make you believe',
    'best and better heads',
    'deep in the drowning mud',
    'stare into the sun',
    'the gallows? or the gun?',
    'we can do no wrong',
    'follow me underwater',
    'dead and dying',
    'in the gardens again',
    'paint a mess',
    'my frame, my bones',
    'pull the thread',
    'tired of it all',
    'awake again',
    'red herrings relay',
    'through the dissonance',
    'the forest thrives',
    'let me out',
    'are you hollow?',
    'you are irrelevant',
    'break me down',
    'i am your consequence',
    'hiding in the dark',
    'fear is your enemy',
    'i feel you fading',
    'my potential is wasted',
    'the twisted neurotic',
    'a wall of minds'
  ];

  var noiseChars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;:,.<>?/\\~`';

  function randNoise() {
    return noiseChars[Math.floor(Math.random() * noiseChars.length)];
  }

  var buf = [];

  function initBuf() {
    for (var i = 0; i < BUF_SIZE; i++) buf.push(randNoise());
  }

  function placeFragment(text) {

    // clears the previous fragment, then writes the new one in at random

    for (var i = 0; i < buf.length; i++) {
      if (typeof buf[i] === 'object') buf[i] = randNoise();
    }

    var chars = text.split('');
    var start = Math.floor(Math.random() * (BUF_SIZE - chars.length - 5)) + 2;
    for (var j = 0; j < chars.length; j++) {
      buf[start + j] = { c: chars[j] };
    }
  }

  function corruptBuf(steps) {

    // decays the buffer, wiping fragments faster than plain noise

    for (var s = 0; s < steps; s++) {
      for (var i = 0; i < buf.length; i++) {
        if (typeof buf[i] === 'object') {
          if (Math.random() < 0.35) buf[i] = randNoise();
        } else if (Math.random() < 0.12) {
          buf[i] = randNoise();
        }
      }
    }
  }

  function esc(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render() {
    var html = '';

    for (var i = 0; i < buf.length; i++) {
      if (typeof buf[i] === 'object') {
        html += '<span class="ibl-music-fragment">' + esc(buf[i].c) + '</span>';
      } else {
        html += esc(String(buf[i]));
      }
    }

    screen.innerHTML = html;
    screen.classList.remove('glitch');
    void screen.offsetWidth;
    screen.classList.add('glitch');

    window.setTimeout(function () {
      screen.classList.remove('glitch');
    }, 200);
  }

  function setStatus(text, color) {
    if (status) status.textContent = text;
    if (dot) dot.style.background = color;
  }

  initBuf();
  render();
  setStatus('listening for signal', '#555555');

  var lastIndex = -1;
  var fragShowing = false;

  window.setInterval(function () {
    if (fragShowing) {
      corruptBuf(3);
      fragShowing = false;
      render();
      setStatus('signal lost, rescanning', '#555555');
      window.setTimeout(function () {
        setStatus('listening for signal', '#cccccc');
      }, 300);
      return;
    }

    var fragIndex = Math.floor(Math.random() * fragments.length);
    while (fragIndex === lastIndex) {
      fragIndex = Math.floor(Math.random() * fragments.length);
    }
    lastIndex = fragIndex;

    placeFragment(fragments[fragIndex]);
    fragShowing = true;
    render();
    setStatus('fragment recovered', '#7ec8ff');

    window.setTimeout(function () {
      setStatus('decoding…', '#7ec8ff');
    }, 300);
  }, 900);
})();
