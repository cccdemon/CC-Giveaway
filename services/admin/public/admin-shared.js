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

// ── Navigation ────────────────────────────────────────
// Die Nav lebt in EINER Datei (/admin/nav.js) — Konfiguration, Rollenfilter,
// Aktivmarkierung, Mobile-Drawer und Tastaturbedienung inklusive. Vorher stand
// sie doppelt (hier und in der anderen Shared-Lib) und lief bereits auseinander.
// nav.js setzt CC.session/CC.isSuperadmin und feuert das Event 'cc:session'.
(function () {
  // Die Tests laden diese Lib in Node (kein document) — dort gibt es nichts zu tun.
  if (typeof document === 'undefined') return;
  if (document.querySelector('script[data-cc-nav]')) return;   // nur einmal laden
  var s = document.createElement('script');
  s.src = '/admin/nav.js';
  s.setAttribute('data-cc-nav', '1');
  (document.head || document.documentElement).appendChild(s);
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
  // Platz fuer die fixe Leiste reservieren (body.cc-has-dbg in rdoc.css) —
  // sonst verdeckt sie das Seitenende, sichtbar am Event-Log des Panels.
  document.body.classList.add('cc-has-dbg');

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
