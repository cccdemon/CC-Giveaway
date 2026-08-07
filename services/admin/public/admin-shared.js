/**
 * RDOC Giveaway – Microservice Shared Lib
 * CC.validate + Navigation + Debug Console
 * Used by all admin pages across all services.
 */

// ── CC.validate ───────────────────────────────────────────
(function(global) {
  'use strict';

  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  var STR_RULES = {
    username: { maxLen:25, pattern:/^[a-zA-Z0-9_]{1,25}$/, clean:function(s){return s.replace(/[^a-zA-Z0-9_]/g,'').slice(0,25);} },
    keyword:  { maxLen:50, pattern:/^[^\x00-\x1F<>"'`\\]{1,50}$/, clean:function(s){return s.replace(/[\x00-\x1F<>"'`\\]/g,'').slice(0,50);} },
    display:  { maxLen:50, pattern:/^[^\x00-\x1F<>]{1,50}$/, clean:function(s){return s.replace(/[\x00-\x1F<>]/g,'').slice(0,50);} },
    wsEvent:  { maxLen:40, pattern:/^[a-z_:]{1,40}$/, clean:function(s){return s.replace(/[^a-z_:]/g,'').slice(0,40);} },
    host:     { maxLen:253, pattern:/^[a-zA-Z0-9.\-]{1,253}$/, clean:function(s){return s.replace(/[^a-zA-Z0-9.\-]/g,'').slice(0,253);} },
    port:     { maxLen:5, pattern:/^\d{1,5}$/, clean:function(s){var n=parseInt(s.replace(/\D/g,''));if(isNaN(n)||n<1||n>65535)return'9090';return String(n);} }
  };

  function sanitize(value, type) {
    if (value === null || value === undefined) return '';
    var s = String(value).trim();
    var rule = STR_RULES[type];
    if (!rule) return s.slice(0, 200);
    return rule.clean(s);
  }

  function validate(value, type) {
    if (value === null || value === undefined) return false;
    var s = String(value).trim();
    var rule = STR_RULES[type];
    if (!rule) return s.length > 0 && s.length <= 200;
    if (s.length === 0 || s.length > rule.maxLen) return false;
    return rule.pattern.test(s);
  }

  function sanitizeInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) return fallback !== undefined ? fallback : 0;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  }

  function sanitizeFloat(value, min, max, fallback) {
    var s = String(value).replace(/,/g, '.');
    var n = parseFloat(s);
    if (isNaN(n)) return fallback !== undefined ? fallback : 0;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  }

  var FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

  function safeJsonParse(str) {
    if (typeof str !== 'string') return null;
    var parsed;
    try { parsed = JSON.parse(str); } catch(e) { return null; }
    return deepFreeze(sanitizeObject(parsed, 0));
  }

  function sanitizeObject(obj, depth) {
    if (depth > 10) return null;
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.slice(0, 1000).map(function(item) { return sanitizeObject(item, depth + 1); });
    }
    var clean = Object.create(null);
    Object.keys(obj).forEach(function(key) {
      if (FORBIDDEN_KEYS.indexOf(key) !== -1) return;
      if (key.length > 200) return;
      clean[key] = sanitizeObject(obj[key], depth + 1);
    });
    return clean;
  }

  function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.getOwnPropertyNames(obj).forEach(function(name) { deepFreeze(obj[name]); });
    return Object.freeze(obj);
  }

  // Die Event-/Cmd-Whitelists liegen seit Phase 0 des Core-Umbaus NUR noch in
  // cc-defs.js beim giveaway-Service (über Caddy: /giveaway/cc-defs.js).
  // Die Seite muss cc-defs.js VOR dieser Datei einbinden. Fehlt CC.defs, wird
  // fail-closed jedes Payload blockiert statt still alles durchzulassen.
  function wsDefs() {
    return (global.CC && global.CC.defs) || null;
  }

  function validateWsPayload(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var defs = wsDefs();
    if (!defs) {
      console.error('[validate] cc-defs.js nicht geladen – WS Payload blockiert');
      return false;
    }
    var evt = obj.event;
    if (!evt || typeof evt !== 'string') return false;
    if (defs.ALLOWED_EVENTS.indexOf(evt) === -1) {
      console.warn('[validate] Unbekanntes WS Event blockiert:', evt);
      return false;
    }
    if (evt === 'gw_cmd') {
      if (!obj.cmd || defs.ALLOWED_CMDS.indexOf(obj.cmd) === -1) {
        console.warn('[validate] Unbekanntes cmd blockiert:', obj.cmd);
        return false;
      }
      if (obj.user && !validate(obj.user, 'username')) {
        console.warn('[validate] Ungültiger username blockiert:', obj.user);
        return false;
      }
      if (obj.keyword !== undefined) {
        obj = Object.assign({}, obj, { keyword: sanitize(obj.keyword, 'keyword') });
      }
    }
    return true;
  }

  function getInputVal(id, type, fallback) {
    var el = document.getElementById(id);
    if (!el) return fallback !== undefined ? fallback : '';
    var raw = el.value;
    if (type === 'int')   return sanitizeInt(raw, undefined, undefined, fallback);
    if (type === 'float') return sanitizeFloat(raw, undefined, undefined, fallback);
    if (type === 'port')  return sanitizeInt(raw, 1, 65535, 9090);
    return sanitize(raw, type || 'display');
  }

  function setHtml(el, html) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    el.innerHTML = html;
  }

  function setText(el, text) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    el.textContent = String(text === null || text === undefined ? '' : text);
  }

  function getUrlParam(name, type, fallback) {
    var params = new URLSearchParams(window.location.search);
    var raw    = params.get(name);
    if (raw === null) return fallback !== undefined ? fallback : '';
    if (type === 'int')  return sanitizeInt(raw, undefined, undefined, fallback);
    if (type === 'port') return sanitizeInt(raw, 1, 65535, 9090);
    if (type === 'host') return sanitize(raw, 'host');
    return sanitize(raw, type || 'display');
  }

  global.CC = global.CC || {};
  global.CC.validate = {
    escHtml:          escHtml,
    sanitize:         sanitize,
    validate:         validate,
    sanitizeInt:      sanitizeInt,
    sanitizeFloat:    sanitizeFloat,
    safeJsonParse:    safeJsonParse,
    validateWsPayload:validateWsPayload,
    getInputVal:      getInputVal,
    setHtml:          setHtml,
    setText:          setText,
    getUrlParam:      getUrlParam,
  };

  global.escHtml = escHtml;
})(window);

// ── Navigation ────────────────────────────────────────────
(function() {
  var JOIN_HREF = '/giveaway/giveaway-join.html?test=1';

  function e(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  var ICON = {
    grid:'<svg viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>',
    teams:'<svg viewBox="0 0 16 16" fill="none"><circle cx="5.5" cy="5" r="2.4" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="6" r="1.9" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 13c0-2 1.8-3.2 4-3.2s4 1.2 4 3.2M10 13c0-1.6 1-2.6 2.6-2.6s2.9 1 2.9 2.6" stroke="currentColor" stroke-width="1.3"/></svg>',
    tools:'<svg viewBox="0 0 16 16" fill="none"><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.2"/></svg>',
    obs:'<svg viewBox="0 0 16 16" fill="none"><rect x="1.5" y="3" width="13" height="9" rx="1.2" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="7.5" r="2.2" stroke="currentColor" stroke-width="1.3"/></svg>',
    logout:'<svg viewBox="0 0 16 16" fill="none"><path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6M10.5 11l3-3-3-3M13 8H6" stroke="currentColor" stroke-width="1.3"/></svg>'
  };
  var PRIMARY = [
    { href:'/giveaway/giveaway-admin.html', label:'DASHBOARD', icon:ICON.grid },
    { href:'/admin/teams.html',             label:'TEAMS',     icon:ICON.teams }
  ];
  var TOOLS = [
    { head:'Verwaltung' },
    { href:'/giveaway/archive.html', label:'Vergangene Giveaways', ic:'🗄' },
    { href:'/giveaway/claims.html', label:'Gewinn-Abwicklung', ic:'📬' },
    { href:'/giveaway/audit.html', label:'Audit-Log', ic:'🧾' },
    { href:'/giveaway/claim.html', label:'Gewinn melden', ic:'🏆' },
    { href:'/giveaway/wager.html', label:'Lose setzen', ic:'🎟' },
    { href:'/giveaway/contest.html', label:'Screenshot-Contest', ic:'📸' },
    { href:'/admin/platform.html', label:'Plattform-Verwaltung', ic:'🏛', admin:true },
    { href:'/admin/users.html', label:'Benutzer', ic:'👥', admin:true },
    { href:'/admin/datenschutz-admin.html', label:'Betroffenenrechte', ic:'🛡', admin:true },
    { href:'/admin/nutzungsbedingungen.html', label:'Nutzungsbedingungen', ic:'§' },
    { href:'/admin/meine-daten.html', label:'Meine Daten', ic:'🔎' },
    { href:'/admin/haftungsausschluss.html', label:'Haftungsausschluss', ic:'⚖' },
    { href:'/viewer/help',      label:'Anleitung', ic:'📖' },
    { href:'/admin/setup.html', label:'Setup-Guide', ic:'⚙' },
    { href:'/admin/changelog.html', label:'Änderungsprotokoll', ic:'📋' },
    { href:'/admin/roadmap.html', label:'Roadmap', ic:'🧭' },
    { head:'Diagnose', admin:true },
    { href:'/admin/giveaway-test.html',     label:'Test Console', ic:'▶', sub:'DEV', admin:true },
    { href:'/admin/tests/test-runner.html', label:'Test Suite',   ic:'✓', sub:'DEV', admin:true }
  ];
  var OBS = [
    { href:'/giveaway/giveaway-overlay.html', label:'Gewinner-Overlay', ic:'🎁' },
    { href:JOIN_HREF,                          label:'Join-Animation',   ic:'✨' }
  ];

  var cur = window.location.pathname.replace(/^\/+/, '');
  function isCur(h){ return cur === h.split('?')[0].replace(/^\//,''); }

  // Styles der Nav liegen zentral in /admin/rdoc.css (.gwnav*) — hier nur Markup.
  var prim = PRIMARY.map(function(p){
    return '<a class="gwnav-item'+(isCur(p.href)?' active':'')+'" href="'+p.href+'">'+p.icon+'<span class="lbl">'+e(p.label)+'</span></a>';
  }).join('');

  function menu(list, obs){
    return list.map(function(x){
      // admin:true → erst sichtbar, wenn /auth/me die Rolle superadmin meldet.
      var adm = x.admin ? ' gwnav-adminonly" style="display:none' : '';
      if(x.head) return '<div class="gwnav-head'+adm+'">'+e(x.head)+'</div>';
      if(obs) return '<div class="gwnav-obs"><a href="'+x.href+'" target="_blank" rel="noopener"><span class="ic">'+x.ic+'</span>'+e(x.label)+'</a><button class="gwnav-cpy" data-url="'+e(x.href)+'">URL</button></div>';
      return '<a class="gwnav-di'+adm+'" href="'+x.href+'"><span class="ic">'+x.ic+'</span>'+e(x.label)+(x.sub?'<span class="sub">'+e(x.sub)+'</span>':'')+'</a>';
    }).join('');
  }

  var nav = document.createElement('nav');
  nav.className = 'gwnav';
  nav.innerHTML =
    // RDOC-Signet (Micro-Cut, Minimum 24 px) + typografischer Projektname.
    '<a class="gwnav-brand" href="/admin/" aria-label="RDOC Giveaway"><svg width="24" height="24" viewBox="0 0 200 200" fill="none" role="img" aria-label="RDOC"><g transform="translate(-60 -60) scale(0.3125)"><path fill="var(--rdoc-accent,#C48A4A)" d="M528.748,192.439 A320 320 0 0 1 779.563,336.473 L679.227,402.295 A200 200 0 0 0 522.467,312.274 Z M796.445,365.402 A320 320 0 0 1 805.202,640.19 L695.251,592.119 A200 200 0 0 0 689.778,420.376 Z M790.196,670.136 A320 320 0 0 1 667.139,791.878 L608.962,686.924 A200 200 0 0 0 685.872,610.835 Z M444.124,680 L579.876,680 L631.874,808.699 A320 320 0 0 1 586.703,823.158 L575.497,776.485 A272 272 0 0 0 589.252,772.799 L573.612,720 L450.388,720 L434.748,772.799 A272 272 0 0 0 448.503,776.485 L437.297,823.158 A320 320 0 0 1 392.126,808.699 Z M356.861,791.878 A320 320 0 0 1 233.804,670.136 L338.128,610.835 A200 200 0 0 0 415.038,686.924 Z M218.798,640.19 A320 320 0 0 1 227.555,365.402 L334.222,420.376 A200 200 0 0 0 328.749,592.119 Z M244.437,336.473 A320 320 0 0 1 495.252,192.439 L501.533,312.274 A200 200 0 0 0 344.773,402.295 Z"/></g></svg><span class="brand-name">RDOC</span><b>GIVEAWAY</b></a>' +
    '<div class="gwnav-primary">' + prim +
      '<div class="gwnav-sep"></div>' +
      '<div class="gwnav-drop" data-drop="tools"><div class="gwnav-item">'+ICON.tools+'<span class="lbl">TOOLS</span><span class="gwnav-caret">▾</span></div><div class="gwnav-menu">'+menu(TOOLS,false)+'</div></div>' +
      '<div class="gwnav-drop" data-drop="obs"><div class="gwnav-item">'+ICON.obs+'<span class="lbl">OBS</span><span class="gwnav-caret">▾</span></div><div class="gwnav-menu">'+menu(OBS,true)+'</div></div>' +
    '</div>' +
    '<div class="gwnav-spacer"></div>' +
    '<div class="gwnav-right">' +
      '<div class="gwnav-user" id="gwnav-user" style="display:none"><div class="gwnav-av" id="gwnav-av">?</div><span class="gwnav-uname" id="gwnav-uname"></span></div>' +
      '<button class="gwnav-logout" id="gwnav-logout" title="Logout">'+ICON.logout+'</button>' +
    '</div>';

  nav.querySelectorAll('.gwnav-drop > .gwnav-item').forEach(function(h){
    h.addEventListener('click', function(ev){ ev.stopPropagation();
      var d = h.parentNode;
      nav.querySelectorAll('.gwnav-drop').forEach(function(o){ if(o!==d) o.classList.remove('open'); });
      d.classList.toggle('open');
    });
  });
  document.addEventListener('click', function(){ nav.querySelectorAll('.gwnav-drop').forEach(function(o){ o.classList.remove('open'); }); });

  nav.querySelectorAll('.gwnav-cpy').forEach(function(b){
    b.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation();
      var url = window.location.origin + b.getAttribute('data-url');
      var done = function(){ b.textContent='✓'; b.classList.add('ok'); setTimeout(function(){ b.textContent='URL'; b.classList.remove('ok'); },1100); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
      else done();
    });
  });

  nav.querySelector('#gwnav-logout').addEventListener('click', function(ev){ ev.preventDefault();
    fetch('/admin/auth/logout', { method:'POST' }).catch(function(){}).then(function(){ window.location.href='/admin/login.html'; });
  });

  // Theme-Umschalter (rdoc-theme.js muss im <head> geladen sein).
  if (window.RDOC && RDOC.mountToggle) {
    var navRight = nav.querySelector('.gwnav-right');
    var tbtn = RDOC.mountToggle(navRight);
    if (tbtn) navRight.insertBefore(tbtn, nav.querySelector('#gwnav-logout'));
  }

  var body = document.body || document.getElementsByTagName('body')[0];
  if (body) body.insertBefore(nav, body.firstChild);
  else document.addEventListener('DOMContentLoaded', function(){ document.body.insertBefore(nav, document.body.firstChild); });

  fetch('/admin/auth/me').then(function(r){ return r.ok ? r.json() : null; }).then(function(u){
    // Rolle fuer Seiten bereitstellen, die Elemente ausblenden muessen. Das ist
    // reine Anzeige-Logik — durchgesetzt wird der Zugriff in Caddy und im
    // admin-Service, nicht hier.
    window.CC = window.CC || {};
    CC.session = u || null;
    CC.isSuperadmin = !!(u && u.role === 'superadmin');
    document.documentElement.setAttribute('data-role', (u && u.role) || 'anon');
    document.dispatchEvent(new CustomEvent('cc:session', { detail: u || null }));

    var login = u && (u.user || u.login);
    if (!login) return;
    document.getElementById('gwnav-uname').textContent = login;
    document.getElementById('gwnav-av').textContent = String(login).charAt(0).toUpperCase();
    var el = document.getElementById('gwnav-user'); if (el) el.style.display = 'flex';
    if (CC.isSuperadmin) {
      nav.querySelectorAll('.gwnav-adminonly').forEach(function(n){ n.style.display = ''; });
    }
    showPlatformWarnings(nav);
  }).catch(function(){});

  // ── Verwarnungs-Banner ──────────────────────────────────
  // Unquittierte Verwarnungen der Plattform-Verwaltung, nicht-blockierend
  // (anders als das TOS-Overlay). Fehler werden still geschluckt — das
  // Banner darf keine Seite lahmlegen.
  function showPlatformWarnings(nav) {
    fetch('/admin/api/me/warnings').then(function(r){ return r.ok ? r.json() : null; }).then(function(list){
      if (!list || !list.length) return;
      // Styles: .gwwarn in /admin/rdoc.css
      var box = document.createElement('div');
      box.className = 'gwwarn';
      list.forEach(function(w){
        var row = document.createElement('div');
        row.className = 'row';
        var when = new Date(w.created_at).toLocaleDateString('de-DE');
        var scope = w.subject_type === 'team' && w.team_name ? ' (Team ' + w.team_name + ')' : '';
        var tx = document.createElement('span');
        tx.className = 'tx';
        tx.innerHTML = '<b>Verwarnung vom ' + e(when) + e(scope) + ':</b> ' + e(w.reason);
        var btn = document.createElement('button');
        btn.textContent = 'Zur Kenntnis genommen';
        btn.addEventListener('click', function(){
          fetch('/admin/api/me/warnings/' + w.id + '/ack', { method:'POST' })
            .catch(function(){})
            .then(function(){ row.remove(); if (!box.querySelector('.row')) box.remove(); });
        });
        row.appendChild(tx); row.appendChild(btn); box.appendChild(row);
      });
      nav.after(box);
    }).catch(function(){});
  }
})();

// ── Debug Console ─────────────────────────────────────────
(function() {
  var MAX_ENTRIES = 200;
  var entries     = [];
  var paused      = false;
  var filterText  = '';
  var consoleOpen = false;

  // Styles: .cc-dbg-* in /admin/rdoc.css
  var bar = document.createElement('div');
  bar.className = 'cc-dbg-bar';

  var handle = document.createElement('div');
  handle.className = 'cc-dbg-handle';
  handle.innerHTML =
    '<div class="cc-dbg-dot" id="cc-dbg-dot"></div>' +
    '<span class="cc-dbg-label">WEBSOCKET LOG</span>' +
    '<span class="cc-dbg-count" id="cc-dbg-count">0 Events</span>' +
    '<div class="cc-dbg-btns">' +
      '<button class="cc-dbg-btn" id="cc-dbg-pause">PAUSE</button>' +
      '<button class="cc-dbg-btn" id="cc-dbg-clear">CLEAR</button>' +
    '</div>';
  bar.appendChild(handle);

  var panel = document.createElement('div');
  panel.className = 'cc-dbg-panel';
  panel.id = 'cc-dbg-panel';
  panel.innerHTML =
    '<div class="cc-dbg-toolbar">' +
      '<input class="cc-dbg-filter" id="cc-dbg-filter" placeholder="Filter (event, cmd, user...)" type="text">' +
      '<span>Klick auf Zeile = Details</span>' +
    '</div>' +
    '<div class="cc-dbg-log" id="cc-dbg-log"></div>';
  bar.appendChild(panel);

  document.body.appendChild(bar);

  handle.addEventListener('click', function(e) {
    if (e.target.tagName === 'BUTTON') return;
    consoleOpen = !consoleOpen;
    panel.classList.toggle('open', consoleOpen);
    if (consoleOpen) renderAll();
  });

  document.getElementById('cc-dbg-pause').addEventListener('click', function() {
    paused = !paused;
    this.textContent = paused ? 'RESUME' : 'PAUSE';
    this.classList.toggle('active', paused);
  });

  document.getElementById('cc-dbg-clear').addEventListener('click', function() {
    entries = [];
    document.getElementById('cc-dbg-log').innerHTML = '';
    document.getElementById('cc-dbg-count').textContent = '0 Events';
  });

  document.getElementById('cc-dbg-filter').addEventListener('input', function() {
    filterText = this.value.toLowerCase();
    renderAll();
  });

  function addEntry(dir, data) {
    if (paused) return;
    var now = new Date();
    var ts  = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds()) +
              '.' + String(now.getMilliseconds()).padStart(3,'0').slice(0,2);
    var parsed = null, evtName = '', bodyStr = '';
    if (typeof data === 'string') { try { parsed = JSON.parse(data); } catch(e) { bodyStr = data; } }
    else if (typeof data === 'object') { parsed = data; }
    if (parsed) { evtName = parsed.event || parsed.cmd || parsed.type || parsed.request || ''; bodyStr = JSON.stringify(parsed); }
    var entry = { dir:dir, ts:ts, evt:evtName, body:bodyStr, raw:data };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    var dot = document.getElementById('cc-dbg-dot');
    if (dot) { dot.className = 'cc-dbg-dot ' + dir; setTimeout(function(){ dot.className = 'cc-dbg-dot'; }, 300); }
    var countEl = document.getElementById('cc-dbg-count');
    if (countEl) countEl.textContent = entries.length + ' Events';
    if (consoleOpen) renderEntry(entry, true);
  }

  function renderEntry(entry, append) {
    if (filterText && entry.body.toLowerCase().indexOf(filterText) === -1 &&
        entry.evt.toLowerCase().indexOf(filterText) === -1) return;
    var log = document.getElementById('cc-dbg-log');
    if (!log) return;
    var row = document.createElement('div');
    row.className = 'cc-dbg-entry';
    row.innerHTML =
      '<span class="cc-dbg-ts">' + entry.ts + '</span>' +
      '<span class="cc-dbg-dir ' + entry.dir + '">' +
        (entry.dir==='send'?'→':entry.dir==='recv'?'←':entry.dir==='err'?'✕':'·') +
      '</span>' +
      '<span class="cc-dbg-evt">' + esc(entry.evt||'–') + '</span>' +
      '<span class="cc-dbg-body ' + entry.dir + '-color">' + esc(entry.body) + '</span>';
    row.addEventListener('click', function() {
      this.classList.toggle('expanded');
      var b = this.querySelector('.cc-dbg-body');
      if (this.classList.contains('expanded')) {
        try { b.textContent = JSON.stringify(JSON.parse(entry.body), null, 2); } catch(e) { b.textContent = entry.body; }
        b.style.whiteSpace = 'pre'; b.style.overflow = 'auto'; b.style.maxHeight = '120px'; b.style.display = 'block';
      } else {
        b.textContent = entry.body; b.style.whiteSpace = 'nowrap'; b.style.overflow = 'hidden'; b.style.maxHeight = ''; b.style.display = '';
      }
    });
    if (append) { log.appendChild(row); log.scrollTop = log.scrollHeight; }
    else { log.insertBefore(row, log.firstChild); }
  }

  function renderAll() {
    var log = document.getElementById('cc-dbg-log');
    if (!log) return;
    log.innerHTML = '';
    entries.forEach(function(e) { renderEntry(e, true); });
  }

  var OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    addEntry('info', { event: 'ws:connect', url: url });
    var origSend = ws.send.bind(ws);
    ws.send = function(data) { addEntry('send', data); return origSend(data); };
    ws.addEventListener('message', function(e) { addEntry('recv', e.data); });
    ws.addEventListener('close', function(e) { addEntry('info', { event:'ws:close', code:e.code, url:url }); });
    ws.addEventListener('error', function() { addEntry('err', { event:'ws:error', url:url }); });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.OPEN       = OrigWS.OPEN;
  window.WebSocket.CLOSING    = OrigWS.CLOSING;
  window.WebSocket.CLOSED     = OrigWS.CLOSED;

  var origFetch = window.fetch;
  window.fetch = function(url, opts) {
    var method  = (opts && opts.method) || 'GET';
    var shortUrl = String(url).replace(window.location.origin, '');
    addEntry('send', { event:'http:'+method, url:shortUrl });
    return origFetch.apply(this, arguments).then(function(res) {
      var status = res.status;
      var clone  = res.clone();
      clone.text().then(function(body) {
        try { addEntry('recv', JSON.parse(body)); }
        catch(e) { addEntry('recv', { event:'http:response', status:status, url:shortUrl }); }
      });
      return res;
    }).catch(function(err) {
      addEntry('err', { event:'http:error', url:shortUrl, msg:err.message });
      throw err;
    });
  };

  document.addEventListener('click', function(e) {
    var el = e.target, maxDepth = 5;
    while (el && maxDepth-- > 0) {
      if (el.tagName==='BUTTON'||el.tagName==='A'||(el.getAttribute&&el.getAttribute('onclick'))) break;
      el = el.parentElement;
    }
    if (!el || maxDepth < 0) return;
    if (el.closest && el.closest('.cc-dbg-bar')) return;
    var info = { event:'ui:click' };
    if (el.id) info.id = el.id;
    var text = (el.textContent||'').trim().replace(/\s+/g,' ');
    if (text.length > 60) text = text.slice(0,57)+'...';
    if (text) info.label = text;
    var onclickAttr = el.getAttribute('onclick');
    if (onclickAttr) info.action = onclickAttr.replace(/\s+/g,' ').slice(0,120);
    if (el.tagName==='A'&&el.href) info.href = el.href.replace(window.location.origin,'');
    addEntry('info', info);
  }, true);

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  window.ccDebug = { log: addEntry };
})();

/* ── Zustimmung zu den Nutzungsbedingungen ──────────────────────────────────
   Blockierendes Overlay: ohne Zustimmung keine Nutzung. Der Server setzt die
   Regel zusaetzlich durch (HTTP 451) - dieses Overlay ist die Benutzerfuehrung,
   nicht die Absicherung. Bei einer neuen Fassung erscheint es erneut. */
(function () {
  var TOS_URL = '/admin/nutzungsbedingungen.html';

  // Styles: .cc-tos-* in /admin/rdoc.css
  function show(st) {
    var again = st.acceptedVersion > 0;
    var bd = document.createElement('div');
    bd.className = 'cc-tos-bd';
    bd.innerHTML =
      '<div class="cc-tos-bx" role="dialog" aria-modal="true">' +
        '<div class="cc-tos-hd">' +
          '<h2>Nutzungsbedingungen' + (again ? ' — neue Fassung' : '') + '</h2>' +
          '<p>' + (again
            ? 'Die Bedingungen haben sich geändert. Für die weitere Nutzung ist eine erneute Zustimmung nötig.'
            : 'Vor der ersten Nutzung als Veranstalter ist die Zustimmung erforderlich.') +
          '</p>' +
        '</div>' +
        '<div class="cc-tos-bd2">' +
          '<div class="cc-tos-key">' +
            '<b>Das Wichtigste:</b> Die Teilnahme an deinem Gewinnspiel muss für deine ' +
            'Zuschauer <b>immer kostenlos</b> sein. Verboten ist insbesondere:' +
            '<ul>' +
              '<li>Bits, Subs, Spenden oder Käufe als Voraussetzung der Teilnahme</li>' +
              '<li>Bits, Subs, Spenden oder Käufe als Vorteil bei den Losen</li>' +
              '<li>Geld, Krypto oder Wett-/Casinoguthaben als Gewinn</li>' +
              '<li>Werbung für Glücksspiel, Sportwetten oder Lootboxen</li>' +
            '</ul>' +
            '<div class="cc-tos-hint">Sobald eine Zahlung die ' +
            'Gewinnchance beeinflusst, wird aus dem Gewinnspiel Glücksspiel — das ist hier ' +
            'nicht erlaubt und kann strafbar sein.</div>' +
          '</div>' +
          '<div class="cc-tos-hint">Außerdem gilt: Du bist Veranstalter deines ' +
          'Gewinnspiels, nicht die Plattform. Du hinterlegst ein eigenes Impressum, stellst ' +
          'eigene Teilnahmebedingungen bereit und wickelst Gewinne selbst ab.</div>' +
          '<p style="margin-top:12px"><a class="cc-tos-lnk" href="' + TOS_URL + '" target="_blank" ' +
          'rel="noopener">Vollständige Nutzungsbedingungen lesen (Fassung ' + st.current + ') ↗</a></p>' +
        '</div>' +
        '<div class="cc-tos-ft">' +
          '<label class="cc-tos-ck"><input type="checkbox" id="cc-tos-ck">' +
          '<span>Ich habe die Nutzungsbedingungen gelesen und stimme ihnen zu. Ich bestätige, ' +
          'dass die Teilnahme an meinen Gewinnspielen kostenlos bleibt.</span></label>' +
          '<div class="cc-tos-row">' +
            '<button class="cc-tos-btn" id="cc-tos-ok" disabled>Zustimmen</button>' +
            '<button class="cc-tos-out" id="cc-tos-no">Abmelden</button>' +
            '<span class="cc-tos-msg" id="cc-tos-msg"></span>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bd);

    var ck = bd.querySelector('#cc-tos-ck'), ok = bd.querySelector('#cc-tos-ok');
    ck.addEventListener('change', function () { ok.disabled = !ck.checked; });
    bd.querySelector('#cc-tos-no').addEventListener('click', function () {
      fetch('/admin/auth/logout', { method: 'POST' }).then(function () {
        window.location.href = '/admin/login.html';
      });
    });
    ok.addEventListener('click', function () {
      ok.disabled = true;
      fetch('/admin/api/tos/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: st.current })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) { window.location.reload(); return; }
        bd.querySelector('#cc-tos-msg').textContent = (d && d.error) || 'Fehler';
        ok.disabled = false;
      }).catch(function (e) {
        bd.querySelector('#cc-tos-msg').textContent = e.message;
        ok.disabled = false;
      });
    });
  }

  function check() {
    fetch('/admin/api/tos/status').then(function (r) {
      if (r.status === 401) return null;   // nicht angemeldet - nichts zu tun
      return r.json();
    }).then(function (st) {
      // Ohne belastbare Fassungsnummer kein Overlay: eine Fehlerantwort hat
      // sonst kein `accepted`, das Overlay erschien trotz Zustimmung und der
      // Klick auf "Zustimmen" schickte `version: undefined` — was der Server
      // korrekt, aber fuer den Nutzer voellig unverstaendlich mit
      // "version_mismatch" quittierte.
      if (st && typeof st.current === 'number' && !st.accepted) show(st);
    }).catch(function () { /* Netzfehler blockiert die Seite nicht */ });
  }

  if (document.body) check();
  else document.addEventListener('DOMContentLoaded', check);
})();
