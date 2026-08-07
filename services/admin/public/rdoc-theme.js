'use strict';
// RDOC Giveaway: Theme-Umschaltung (dunkel Default, hell per Wahl oder System).
// Blockierend im <head> laden, damit die Seite nicht im falschen Schema aufblitzt.
// localStorage['rdoc-theme'] = 'light' | 'dark'; fehlt der Wert, gilt die
// Systempräferenz (prefers-color-scheme). OBS-Overlays laden dieses Script nicht.
(function () {
  var KEY = 'rdoc-theme';

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; }
    catch (e) { return null; }
  }
  function systemTheme() {
    try { return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function effective() { return stored() || systemTheme(); }

  function applyMeta(theme) {
    // theme-color der Browser-UI folgt dem wirksamen Schema.
    var color = theme === 'light' ? '#F2F2F0' : '#121416';
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
  }

  function apply() {
    var s = stored();
    if (s) document.documentElement.setAttribute('data-theme', s);
    else document.documentElement.removeAttribute('data-theme');
    applyMeta(effective());
  }

  var SUN = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4" stroke="currentColor" stroke-width="1.3"/></svg>';
  var MOON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7Z" stroke="currentColor" stroke-width="1.3"/></svg>';

  window.RDOC = {
    theme: effective,
    setTheme: function (t) {
      try {
        if (t === 'light' || t === 'dark') localStorage.setItem(KEY, t);
        else localStorage.removeItem(KEY);
      } catch (e) {}
      apply();
      document.dispatchEvent(new CustomEvent('rdoc:theme', { detail: effective() }));
    },
    // Umschalter-Knopf in ein Element rendern (Nav, Seitenkopf).
    mountToggle: function (parent) {
      if (!parent) return null;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gwnav-theme';
      b.setAttribute('aria-label', 'Design wechseln');
      function paint() {
        b.innerHTML = effective() === 'light' ? MOON : SUN;
        b.title = effective() === 'light' ? 'Dunkles Design' : 'Helles Design';
      }
      b.addEventListener('click', function () {
        window.RDOC.setTheme(effective() === 'light' ? 'dark' : 'light');
        paint();
      });
      paint();
      parent.appendChild(b);
      return b;
    }
  };

  apply();
  // Systemwechsel live folgen, solange der Nutzer nichts festgelegt hat.
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
      if (!stored()) apply();
    });
  } catch (e) {}
})();
