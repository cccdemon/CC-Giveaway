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
  // cc-defs.js (services/giveaway/public/, als /giveaway/cc-defs.js geladen).
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

  // ── Audit: Aktion → deutscher Klartext ──────────────────
  // Liegt hier, weil Dashboard und Audit-Seite denselben Satz zeigen muessen.
  // Neue gw_cmd? Hier einen Fall ergaenzen, sonst steht nur der rohe Cmd-Name da.
  function num(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'string') return parseFloat(v.replace(/,/g, '.')) || 0;
    return parseFloat(v) || 0;
  }
  function durShort(s) {
    if (!s) return '0';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (Math.round((s / 3600) * 10) / 10).toString().replace(/\.0$/, '') + 'h';
  }
  function auditSummary(e) {
    var d = e.detail || {};
    switch (e.action) {
      case 'gw_add_ticket': return '+1 Coin (' + d.deltaSec + 's) auf ' + (d.channel || '?');
      case 'gw_sub_ticket': return '-1 Coin (' + d.deltaSec + 's) auf ' + (d.channel || '?');
      case 'gw_ban':        return 'gebannt (hatte ' + num(d.coinsAtBan).toFixed(2) + ' Punkte Kampagnenstand'
                                 + (d.wasEligible ? ', war im Lostopf' : '') + ')';
      case 'gw_unban':      return 'entbannt';
      case 'gw_set_multiplier':
        return d.factorAfter > 1
          ? 'Multiplier ×' + d.factorAfter + ' für ' + Math.round((d.seconds || 0) / 60) + ' min'
          : 'Multiplier aus';
      case 'gw_set_keyword':
        return 'Keyword "' + (d.keywordBefore || '–') + '" → "' + (d.keywordAfter || '–') + '"';
      case 'gw_set_stream_settings':
        return 'Follows ' + d.followMinBefore + '→' + d.followMinAfter
             + ', Coin-Basis ' + durShort(d.coinBaseSecBefore) + '→' + durShort(d.coinBaseSecAfter);
      case 'gw_draw_winner': {
        if (d.error)   return 'Ziehung fehlgeschlagen: ' + d.error;
        if (!d.winner) return 'Ziehung ohne Teilnehmer';
        // CORE-Einheit aus dem Audit-Detail (Altbestand ohne core = Kampagne).
        var stat;
        if (d.core === 'CORE_CurrentViewers')          stat = 'gleiche Chance, ' + d.eligibleCount + ' im Topf';
        else if (d.core === 'CORE_TicketBuy')          stat = num(d.winnerCoins).toFixed(0) + ' Lose gesetzt, ' + d.eligibleCount + ' Setzer';
        else if (d.core === 'CORE_ScreenshotContest')  stat = num(d.winnerCoins).toFixed(0) + ' Punkte (Voting), ' + d.eligibleCount + ' im Stechen';
        else                                           stat = num(d.winnerCoins).toFixed(2) + ' Coins von ' + d.eligibleCount + ' Teilnehmern';
        return (d.isTest ? 'TEST-' : '') + 'Ziehung: ' + d.winner + ' (' + stat + ')'
             + (d.rerollOf ? ' — Ersatz für Ziehung #' + d.rerollOf : '');
      }
      case 'gw_reset':  return 'RESET – ' + d.wipedParticipants + ' Teilnehmer / ' + d.wipedCoins + ' Punkte (Kampagnenstand) gelöscht';
      case 'gw_open':   return 'geöffnet (' + (d.sessionOpened || '?') + ')';
      case 'gw_close':  return 'geschlossen (' + (d.sessionClosed || '?') + ')';
      case 'gw_pause':  return 'pausiert';
      case 'gw_resume': return 'fortgesetzt';
      case 'auto_pause':  return 'Auto-Pause (alle Streams offline)';
      case 'auto_resume': return 'Auto-Resume (Stream online)';
      case 'auto_open':   return 'Auto-Open (Stream online)';
      case 'gw_set_chat_template':
        return (d.reset ? 'Chat-Ansage zurückgesetzt' : 'Chat-Ansage angepasst')
             + (d.key ? ' (' + d.core + '/' + d.key + ')' : '');
      case 'gw_reset_credit':
        return d.error ? 'Losanpassung blockiert (' + (d.openPrizes || '?') + ' offene Preise)'
                       : 'Losanpassung: ' + (d.users || 0) + ' Lose-Konten auf 0 (-' + (d.total || 0) + ' Lose)';
      case 'gw_gen_ingest_token': return d.rotated ? 'Ingest-Token rotiert' : 'Ingest-Token erstellt';
      case 'gw_verify_follows':   return 'Follow-Abgleich (Helix)';
      case 'gw_get_ai_settings':  return 'KI-Einstellungen gelesen';
      case 'audit_archive':       return 'Audit-Archiv erzeugt (' + (d.entries || 0) + ' Einträge)';
      case 'export':              return 'Backup exportiert';
      case 'import':              return 'Backup importiert';
      default: return e.action;
    }
  }

  global.CC = global.CC || {};
  global.CC.audit = { summary: auditSummary, durShort: durShort };
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
})(typeof window !== 'undefined' ? window : globalThis);   // globalThis: node --test kann CC.audit.summary prüfen

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
  if (typeof window === 'undefined' || typeof document === 'undefined') return;   // node --test: nur CC.* nutzbar
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
