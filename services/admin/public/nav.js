// ── Hauptnavigation: EINZIGE Quelle für Admin- und Giveaway-Seiten ──────────
// Vorher stand dieselbe Nav zweimal (admin-shared.js und giveaway-shared.js)
// und lief bereits auseinander. Beide Libs laden jetzt diese Datei; wer einen
// Menüpunkt ändert, ändert ihn hier — und nur hier.
//
// Aufbau: SECTIONS ist die Menükonfiguration (Bereich → Ziele). Sichtbarkeit
// steuert `audience` ('all' | 'org' = Mitglied in mindestens einem Team | 'sa'
// = Superadmin), die aktive Markierung `href` + optionale `activePaths`.
// Durchgesetzt wird der Zugriff NIE hier, sondern in Caddy und im
// admin-Service — diese Datei entscheidet nur, was angezeigt wird.
(function (global) {
  'use strict';

  function e(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var ICON = {
    doc:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.8v3h3M6 8h4M6 10.5h4" stroke="currentColor" stroke-width="1.3"/></svg>',
    grid:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>',
    teams:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="5.5" cy="5" r="2.4" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="6" r="1.9" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 13c0-2 1.8-3.2 4-3.2s4 1.2 4 3.2M10 13c0-1.6 1-2.6 2.6-2.6s2.9 1 2.9 2.6" stroke="currentColor" stroke-width="1.3"/></svg>',
    ticket:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 6.4V4.2h12.4v2.2a1.6 1.6 0 0 0 0 3.2v2.2H1.8V9.6a1.6 1.6 0 0 0 0-3.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.4 4.2v7.6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="1.6 1.6"/></svg>',
    gear:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.2"/></svg>',
    logout:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6M10.5 11l3-3-3-3M13 8H6" stroke="currentColor" stroke-width="1.3"/></svg>',
    burger:'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
  };

  // pub:true = auch ohne Login erreichbar (Caddy-Whitelist). Ohne Session zeigt
  // die Nav ausschliesslich solche Ziele — sonst führte jeder Klick ins Login.
  var SECTIONS = [
    { id:'giveaways', label:'GIVEAWAYS', icon:ICON.grid, audience:'org', items:[
      { id:'gw-dash',    label:'Übersicht',         href:'/giveaway/giveaway-admin.html', ic:'🎁' },
      { id:'gw-claims',  label:'Gewinne abwickeln', href:'/giveaway/claims.html',  ic:'📬' },
      { id:'gw-archive', label:'Archiv',            href:'/giveaway/archive.html', ic:'🗄' },
      { id:'gw-audit',   label:'Protokoll',         href:'/giveaway/audit.html',   ic:'🧾' }
    ]},
    { id:'team', label:'TEAM', icon:ICON.teams, audience:'all', items:[
      { id:'tm-teams', label:'Meine Teams',            href:'/admin/teams.html', ic:'👥' },
      { id:'tm-setup', label:'Streamerbot einrichten', href:'/admin/setup.html', ic:'⚙', pub:true }
    ]},
    { id:'part', label:'TEILNEHMEN', icon:ICON.ticket, audience:'all', items:[
      { id:'pt-status',  label:'Meine Teilnahmen',   href:'/viewer/status', ic:'📊', pub:true,
        activePaths:['/admin/status.html'] },
      { id:'pt-claim',   label:'Gewinn melden',      href:'/giveaway/claim.html',   ic:'🏆' },
      { id:'pt-wager',   label:'Lose setzen',        href:'/giveaway/wager.html',   ic:'🎟' },
      { id:'pt-contest', label:'Screenshot-Contest', href:'/giveaway/contest.html', ic:'📸' },
      { id:'pt-data',    label:'Meine Daten',        href:'/admin/meine-daten.html', ic:'🔎' }
    ]},
    { id:'help', label:'HILFE', icon:ICON.doc, audience:'all', items:[
      { id:'hp-guide', label:'Anleitung',          href:'/viewer/help', ic:'📖', pub:true,
        activePaths:['/admin/help.html'] },
      { id:'hp-how',   label:'So funktioniert es', href:'/admin/funktionsweise.html', ic:'💡', pub:true },
      { id:'hp-fb',    label:'Fehler melden & Idee schicken', href:'/admin/feedback.html', ic:'🐛' },
      { id:'hp-doku',  label:'Technische Dokumentation', href:'/admin/doku.html', ic:'📐' },
      { head:'Rechtliches & Info' },
      { id:'hp-tos',  label:'Nutzungsbedingungen', href:'/admin/nutzungsbedingungen.html', ic:'§', pub:true },
      { id:'hp-priv', label:'Datenschutz',         href:'/admin/datenschutz.html', ic:'🔒', pub:true },
      { id:'hp-liab', label:'Haftungsausschluss',  href:'/admin/haftungsausschluss.html', ic:'⚖', pub:true },
      { id:'hp-imp',  label:'Impressum',           href:'/admin/impressum.html', ic:'🏢', pub:true },
      { id:'hp-chg',  label:'Änderungsprotokoll',  href:'/admin/changelog.html', ic:'📋', pub:true },
      { id:'hp-road', label:'Roadmap',             href:'/admin/roadmap.html', ic:'🧭', pub:true }
    ]},
    { id:'platform', label:'PLATTFORM', icon:ICON.gear, audience:'sa', items:[
      { id:'pf-platform', label:'Plattform-Verwaltung', href:'/admin/platform.html', ic:'🏛' },
      { id:'pf-betrieb',  label:'Betrieb & Diagnose',   href:'/admin/betrieb.html',  ic:'🩺' },
      { id:'pf-users',    label:'Benutzer',             href:'/admin/users.html',    ic:'👥' },
      { id:'pf-dsgvo',    label:'Betroffenenrechte',    href:'/admin/datenschutz-admin.html', ic:'🛡' },
      { head:'Diagnose' },
      { id:'pf-cc',    label:'Control Center', href:'/admin/', ic:'🎛', sub:'DEV',
        activePaths:['/admin/index.html'] },
      { id:'pf-test',  label:'Test Console',   href:'/admin/giveaway-test.html', ic:'▶', sub:'DEV' },
      { id:'pf-suite', label:'Test Suite',     href:'/admin/tests/test-runner.html', ic:'✓', sub:'DEV' }
    ]}
  ];

  // ── Pure Logik (ohne DOM) — direkt geprüft von tests/nav.test.js ──────────
  function normPath(p) {
    p = String(p || '').split('?')[0].split('#')[0];
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.length > 1 && p.slice(-1) === '/') p = p.slice(0, -1);
    return p;
  }

  function canSee(audience, session) {
    if (!session) return false;
    if (!audience || audience === 'all') return true;
    if (audience === 'org') return !!(session.teams > 0 || session.role === 'superadmin');
    if (audience === 'sa')  return session.role === 'superadmin';
    return true;
  }

  // Ohne Session bleiben nur pub-Ziele übrig. Gruppen-Überschriften ohne
  // folgende Einträge fallen mit weg (sonst leere Kopfzeilen im Menü).
  function visibleSections(sections, session) {
    var out = [];
    (sections || []).forEach(function (sec) {
      var secOk = session ? canSee(sec.audience, session)
                          : (sec.items || []).some(function (i) { return i.pub; });
      if (!secOk) return;
      var items = (sec.items || []).filter(function (it) {
        if (it.head) return true;
        if (!session) return !!it.pub;
        return canSee(it.audience || 'all', session);
      });
      var clean = [];
      items.forEach(function (it, i) {
        if (it.head) {
          var next = items[i + 1];
          if (!next || next.head) return;
        }
        clean.push(it);
      });
      if (!clean.filter(function (i) { return !i.head; }).length) return;
      out.push({ id: sec.id, label: sec.label, icon: sec.icon, items: clean });
    });
    return out;
  }

  function itemMatches(item, path) {
    var p = normPath(path);
    var cands = [item.href].concat(item.activePaths || []);
    for (var i = 0; i < cands.length; i++) {
      var c = normPath(cands[i]);
      if (c === p) return true;
      if (c.slice(-2) === '/*' && p.indexOf(c.slice(0, -1)) === 0) return true;
      // Verzeichnis-Ziel (/admin/) trifft auch dessen index.html
      if (c === '/admin' && p === '/admin/index.html') return true;
    }
    return false;
  }

  // {section, item} des aktiven Ziels — oder null bei unbekanntem Pfad.
  function activeFor(sections, path) {
    for (var s = 0; s < sections.length; s++) {
      var items = sections[s].items || [];
      for (var i = 0; i < items.length; i++) {
        if (!items[i].head && itemMatches(items[i], path)) {
          return { section: sections[s].id, item: items[i].id };
        }
      }
    }
    return null;
  }

  // Startseite je Rolle: Veranstalter ins Panel, alle anderen zu ihrer
  // Teilnahme-Übersicht. Brand-Link und Login-Redirect nutzen dieselbe Regel.
  function homeFor(session) {
    if (session && (session.teams > 0 || session.role === 'superadmin')) {
      return '/giveaway/giveaway-admin.html';
    }
    return '/viewer/status';
  }

  var API = { SECTIONS: SECTIONS, visibleSections: visibleSections, activeFor: activeFor,
              itemMatches: itemMatches, normPath: normPath, canSee: canSee, homeFor: homeFor };

  global.CC = global.CC || {};
  global.CC.navConfig = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

  // Node (Tests) hat kein document — ab hier ist alles Browser.
  if (typeof document === 'undefined') return;

  // ── Rendering ────────────────────────────────────────────────────────────
  var BRAND_SVG = '<svg width="24" height="24" viewBox="0 0 200 200" fill="none" role="img" aria-label="RDOC"><g transform="translate(-60 -60) scale(0.3125)"><path fill="var(--rdoc-accent,#C48A4A)" d="M528.748,192.439 A320 320 0 0 1 779.563,336.473 L679.227,402.295 A200 200 0 0 0 522.467,312.274 Z M796.445,365.402 A320 320 0 0 1 805.202,640.19 L695.251,592.119 A200 200 0 0 0 689.778,420.376 Z M790.196,670.136 A320 320 0 0 1 667.139,791.878 L608.962,686.924 A200 200 0 0 0 685.872,610.835 Z M444.124,680 L579.876,680 L631.874,808.699 A320 320 0 0 1 586.703,823.158 L575.497,776.485 A272 272 0 0 0 589.252,772.799 L573.612,720 L450.388,720 L434.748,772.799 A272 272 0 0 0 448.503,776.485 L437.297,823.158 A320 320 0 0 1 392.126,808.699 Z M356.861,791.878 A320 320 0 0 1 233.804,670.136 L338.128,610.835 A200 200 0 0 0 415.038,686.924 Z M218.798,640.19 A320 320 0 0 1 227.555,365.402 L334.222,420.376 A200 200 0 0 0 328.749,592.119 Z M244.437,336.473 A320 320 0 0 1 495.252,192.439 L501.533,312.274 A200 200 0 0 0 344.773,402.295 Z"/></g></svg>';

  function itemHtml(it, activeItem) {
    if (it.head) return '<div class="gwnav-head" role="presentation">' + e(it.head) + '</div>';
    var on = activeItem === it.id;
    return '<a class="gwnav-di' + (on ? ' active' : '') + '" role="menuitem" href="' + e(it.href) + '"'
      + (on ? ' aria-current="page"' : '') + '>'
      + '<span class="ic" aria-hidden="true">' + it.ic + '</span>' + e(it.label)
      + (it.sub ? '<span class="sub">' + e(it.sub) + '</span>' : '') + '</a>';
  }

  // Trigger ist ein echter <button> mit aria-expanded/-controls; der aktive
  // Bereich bekommt .active, damit der Standort auch bei zugeklapptem Menü
  // sichtbar bleibt (Befund P0 des UI-Reviews).
  function sectionHtml(sec, active) {
    var onSec = active && active.section === sec.id;
    var mid = 'gwnav-menu-' + sec.id;
    return '<div class="gwnav-drop" data-drop="' + e(sec.id) + '">'
      + '<button type="button" class="gwnav-item' + (onSec ? ' active' : '') + '"'
      + ' aria-expanded="false" aria-controls="' + mid + '" aria-haspopup="true">'
      + sec.icon + '<span class="lbl">' + e(sec.label) + '</span>'
      + '<span class="gwnav-caret" aria-hidden="true">▾</span></button>'
      + '<div class="gwnav-menu" id="' + mid + '" role="menu" aria-label="' + e(sec.label) + '">'
      + sec.items.map(function (it) { return itemHtml(it, active && active.item); }).join('')
      + '</div></div>';
  }

  var nav = document.createElement('nav');
  nav.className = 'gwnav';
  nav.setAttribute('aria-label', 'Hauptnavigation');

  function paint(session) {
    var secs = visibleSections(SECTIONS, session);
    var active = activeFor(secs, window.location.pathname);
    var home = homeFor(session);
    nav.innerHTML =
      '<a class="gwnav-brand" href="' + e(home) + '" aria-label="RDOC Giveaway — Startseite">'
        + BRAND_SVG + '<span class="brand-name">RDOC</span><b>GIVEAWAY</b></a>'
      + '<button type="button" class="gwnav-burger" id="gwnav-burger" aria-expanded="false"'
        + ' aria-controls="gwnav-primary" aria-label="Menü öffnen">' + ICON.burger + '</button>'
      + '<div class="gwnav-primary" id="gwnav-primary">'
        + secs.map(function (s) { return sectionHtml(s, active); }).join('')
      + '</div>'
      + '<div class="gwnav-spacer"></div>'
      + '<div class="gwnav-right">'
        + (session
            ? '<div class="gwnav-user" id="gwnav-user"><div class="gwnav-av" id="gwnav-av" aria-hidden="true">'
              + e(String(session.user || '?').charAt(0).toUpperCase()) + '</div>'
              + '<span class="gwnav-uname" id="gwnav-uname">' + e(session.user || '') + '</span></div>'
              + '<button class="gwnav-logout" id="gwnav-logout" title="Logout" aria-label="Abmelden">'
              + ICON.logout + '</button>'
            : '<a class="gwnav-di gwnav-login" href="/admin/login.html">Anmelden</a>')
      + '</div>';
    wire(session);
  }

  function menuItems(drop) {
    return Array.prototype.slice.call(drop.querySelectorAll('.gwnav-di'));
  }

  function closeAll(except) {
    nav.querySelectorAll('.gwnav-drop').forEach(function (d) {
      if (d === except) return;
      d.classList.remove('open');
      var b = d.querySelector('button');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  function wire(session) {
    nav.querySelectorAll('.gwnav-drop').forEach(function (drop) {
      var btn = drop.querySelector('button');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var willOpen = !drop.classList.contains('open');
        closeAll(drop);
        drop.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) { var f = menuItems(drop)[0]; if (f) f.focus(); }
      });
      // Escape schliesst und gibt den Fokus zurück; Pfeiltasten laufen durch
      // die Einträge (Menü-Muster, WAI-ARIA APG).
      drop.addEventListener('keydown', function (ev) {
        var items = menuItems(drop);
        var i = items.indexOf(document.activeElement);
        if (ev.key === 'Escape') {
          drop.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
          btn.focus(); ev.stopPropagation(); return;
        }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          if (!drop.classList.contains('open')) {
            drop.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
          }
          ev.preventDefault();
          var n = ev.key === 'ArrowDown' ? i + 1 : i - 1;
          if (n < 0) n = items.length - 1;
          if (n >= items.length) n = 0;
          if (items[n]) items[n].focus();
        }
      });
    });

    if (!wire.bound) {
      wire.bound = true;
      document.addEventListener('click', function () { closeAll(null); });
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' || !nav.classList.contains('mob-open')) return;
        nav.classList.remove('mob-open');
        var b = nav.querySelector('#gwnav-burger');
        if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
      });
    }

    var burger = nav.querySelector('#gwnav-burger');
    if (burger) {
      burger.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var open = !nav.classList.contains('mob-open');
        nav.classList.toggle('mob-open', open);
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
        burger.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
        if (open) { var f = nav.querySelector('.gwnav-primary button'); if (f) f.focus(); }
        else closeAll(null);
      });
    }
    var lo = nav.querySelector('#gwnav-logout');
    if (lo) lo.addEventListener('click', function (ev) {
      ev.preventDefault();
      fetch('/admin/auth/logout', { method: 'POST' }).catch(function () {})
        .then(function () { window.location.href = '/admin/login.html'; });
    });

    if (global.RDOC && RDOC.mountToggle) {
      var right = nav.querySelector('.gwnav-right');
      var tbtn = RDOC.mountToggle(right);
      if (tbtn) right.insertBefore(tbtn, right.firstChild);
    }
  }

  paint(null);   // sofort sichtbar (öffentliche Ziele), kein Layout-Sprung

  var body = document.body || document.getElementsByTagName('body')[0];
  if (body) body.insertBefore(nav, body.firstChild);
  else document.addEventListener('DOMContentLoaded', function () {
    document.body.insertBefore(nav, document.body.firstChild);
  });

  // Rolle nachladen und neu zeichnen. Zugriff wird serverseitig geprüft —
  // hier geht es nur darum, keine Ziele anzubieten, die ins Leere führen.
  fetch('/admin/auth/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (u) {
    global.CC = global.CC || {};
    CC.session = u || null;
    CC.isSuperadmin = !!(u && u.role === 'superadmin');
    document.documentElement.setAttribute('data-role', (u && u.role) || 'anon');
    document.dispatchEvent(new CustomEvent('cc:session', { detail: u || null }));
    if (u) paint(u);
    showPlatformWarnings();
  }).catch(function () {});

  // ── Verwarnungs-Banner ───────────────────────────────────────────────────
  // Unquittierte Verwarnungen der Plattform-Verwaltung, nicht-blockierend
  // (anders als das TOS-Overlay). Fehler werden still geschluckt — das Banner
  // darf keine Seite lahmlegen.
  function showPlatformWarnings() {
    fetch('/admin/api/me/warnings').then(function (r) { return r.ok ? r.json() : null; }).then(function (list) {
      if (!list || !list.length) return;
      var box = document.createElement('div');
      box.className = 'gwwarn';
      list.forEach(function (w) {
        var row = document.createElement('div');
        row.className = 'row';
        var when = new Date(w.created_at).toLocaleDateString('de-DE');
        var scope = w.subject_type === 'team' && w.team_name ? ' (Team ' + w.team_name + ')' : '';
        var tx = document.createElement('span');
        tx.className = 'tx';
        tx.innerHTML = '<b>Verwarnung vom ' + e(when) + e(scope) + ':</b> ' + e(w.reason);
        var btn = document.createElement('button');
        btn.textContent = 'Zur Kenntnis genommen';
        btn.addEventListener('click', function () {
          fetch('/admin/api/me/warnings/' + w.id + '/ack', { method: 'POST' })
            .catch(function () {})
            .then(function () { row.remove(); if (!box.querySelector('.row')) box.remove(); });
        });
        row.appendChild(tx); row.appendChild(btn); box.appendChild(row);
      });
      nav.after(box);
    }).catch(function () {});
  }
})(typeof window !== 'undefined' ? window : globalThis);
