/*!
 * iamLamprey instrument tabs — ibl-tabs.js
 *
 * Rhapsody / Kontakt tab switching for instrument pages. Loaded only when the
 * page uses layout: product. No-op when the page has no tab bar.
 */
(function () {
  'use strict';

  var buttons = document.querySelectorAll('.ibl-tab-btn');
  var panels = document.querySelectorAll('.ibl-tab-panel');
  if (!buttons.length) return;

  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      var target = this.getAttribute('data-tab');

      for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('active');
      for (var k = 0; k < panels.length; k++) panels[k].classList.remove('active');

      this.classList.add('active');
      var panel = document.getElementById('tab-' + target);
      if (panel) panel.classList.add('active');
    });
  }
})();
