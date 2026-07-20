/**
 * Chaos Crew – Microservice Shared Lib
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

  var ALLOWED_EVENTS = [
    'gw_get_all', 'gw_cmd', 'gw_overlay', 'gw_join',
    'gw_ack', 'gw_data', 'gw_status', 'gw_keyword',
    'gw_multiplier', 'wt_update',
    'chat_msg', 'viewer_tick',
    'cc_identify',
    'ws:connect', 'ws:close', 'http:GET', 'http:POST', 'http:PUT', 'http:DELETE', 'http:PATCH'
  ];

  var ALLOWED_CMDS = [
    'gw_open', 'gw_close', 'gw_reset', 'gw_pause', 'gw_resume',
    'gw_draw_winner',
    'gw_add_ticket', 'gw_sub_ticket',
    'gw_ban', 'gw_unban',
    'gw_set_keyword', 'gw_get_keyword',
    'gw_set_multiplier', 'gw_get_multiplier',
    'gw_set_stream_settings', 'gw_get_stream_settings',
    'gw_get_ai_settings', 'gw_set_ai_settings', 'gw_test_ai',
    'gw_get_channels', 'gw_verify_follows',
    'gw_gen_ingest_token', 'gw_get_ingest_tokens'
  ];

  function validateWsPayload(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var evt = obj.event;
    if (!evt || typeof evt !== 'string') return false;
    if (ALLOWED_EVENTS.indexOf(evt) === -1) {
      console.warn('[validate] Unbekanntes WS Event blockiert:', evt);
      return false;
    }
    if (evt === 'gw_cmd') {
      if (!obj.cmd || ALLOWED_CMDS.indexOf(obj.cmd) === -1) {
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
  var JOIN_HREF = '/giveaway/giveaway-join.html';   // admin-shared.js overrides with ?test=1

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
    { href:'/admin/users.html', label:'Benutzer', ic:'👥' },
    { href:'/viewer/help',      label:'Anleitung', ic:'📖' },
    { href:'/admin/setup.html', label:'Setup-Guide', ic:'⚙' },
    { head:'Diagnose' },
    { href:'/admin/giveaway-test.html',     label:'Test Console', ic:'▶', sub:'DEV' },
    { href:'/admin/tests/test-runner.html', label:'Test Suite',   ic:'✓', sub:'DEV' }
  ];
  var OBS = [
    { href:'/giveaway/giveaway-overlay.html', label:'Gewinner-Overlay', ic:'🎁' },
    { href:JOIN_HREF,                          label:'Join-Animation',   ic:'✨' }
  ];

  var cur = window.location.pathname.replace(/^\/+/, '');
  function isCur(h){ return cur === h.split('?')[0].replace(/^\//,''); }

  var css = [
    '.gwnav{--gc:#00d4ff;--gg:#f0a500;--gr:#ff4d6a;--gv:#9146ff;--gink:#cfe0ec;--gmut:rgba(200,220,232,.5);--gfai:rgba(200,220,232,.3);--gbg:#0a0e16;--gedge:rgba(0,212,255,.14);--gedge2:rgba(0,212,255,.3);display:flex;align-items:center;height:44px;padding:0 12px;gap:3px;position:sticky;top:0;z-index:900;background:linear-gradient(180deg,rgba(255,255,255,.015),transparent),var(--gbg);border-bottom:1px solid var(--gedge2);font-family:"Share Tech Mono",monospace;}',
    '.gwnav *{box-sizing:border-box;}',
    '.gwnav-brand{display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:2px;color:var(--gc);text-decoration:none;padding:0 12px 0 4px;margin-right:6px;white-space:nowrap;}',
    '.gwnav-brand b{color:var(--gink);font-weight:400;}.gwnav-brand:hover{color:#fff;}',
    '.gwnav-primary{display:flex;align-items:stretch;height:100%;gap:2px;}',
    '.gwnav-item{display:flex;align-items:center;gap:7px;height:100%;padding:0 14px;text-decoration:none;font-size:11px;letter-spacing:1.2px;color:var(--gfai);border:0;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;background:transparent;font-family:inherit;transition:color .14s,border-color .14s,background .14s;}',
    '.gwnav-item svg{width:14px;height:14px;opacity:.8;}',
    '.gwnav-item:hover{color:var(--gink);background:rgba(0,212,255,.04);}',
    '.gwnav-item.active{color:var(--gc);border-bottom-color:var(--gc);}',
    '.gwnav-caret{font-size:8px;opacity:.6;}',
    '.gwnav-sep{width:1px;height:20px;background:var(--gedge);margin:0 5px;align-self:center;}',
    '.gwnav-spacer{flex:1;}',
    '.gwnav-drop{position:relative;height:100%;}',
    '.gwnav-menu{position:absolute;top:calc(100% + 1px);left:0;min-width:214px;background:var(--gbg);border:1px solid var(--gedge2);border-radius:0 0 8px 8px;box-shadow:0 18px 40px -18px rgba(0,0,0,.9);padding:6px;display:none;flex-direction:column;gap:1px;z-index:60;}',
    '.gwnav-drop.open .gwnav-menu{display:flex;}',
    '.gwnav-drop.open>.gwnav-item{color:var(--gc);background:rgba(0,212,255,.06);}',
    '.gwnav-di{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:6px;text-decoration:none;color:var(--gmut);font-size:11px;letter-spacing:.6px;cursor:pointer;}',
    '.gwnav-di:hover{background:rgba(0,212,255,.08);color:var(--gink);}',
    '.gwnav-di .ic{width:15px;text-align:center;opacity:.75;flex-shrink:0;}',
    '.gwnav-di .sub{margin-left:auto;font-size:8px;letter-spacing:1px;color:var(--gfai);border:1px solid var(--gedge);border-radius:20px;padding:1px 7px;}',
    '.gwnav-head{font-size:8px;letter-spacing:2px;color:var(--gfai);text-transform:uppercase;padding:7px 11px 4px;}',
    '.gwnav-obs{display:flex;align-items:center;gap:8px;padding:7px 11px;border-radius:6px;}',
    '.gwnav-obs:hover{background:rgba(0,212,255,.06);}',
    '.gwnav-obs a{text-decoration:none;color:var(--gmut);font-size:11px;letter-spacing:.6px;display:flex;align-items:center;gap:9px;flex:1;}',
    '.gwnav-obs:hover a{color:var(--gink);}',
    '.gwnav-cpy{font-size:9px;color:var(--gfai);border:1px solid var(--gedge);border-radius:5px;padding:3px 8px;letter-spacing:1px;cursor:pointer;background:transparent;font-family:inherit;}',
    '.gwnav-cpy:hover{color:var(--gc);border-color:var(--gedge2);}.gwnav-cpy.ok{color:#22e07a;border-color:#22e07a;}',
    '.gwnav-right{display:flex;align-items:center;gap:9px;height:100%;}',
    '.gwnav-user{display:flex;align-items:center;gap:8px;padding:3px 6px 3px 3px;border-radius:20px;border:1px solid var(--gedge);}',
    '.gwnav-av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--gv),var(--gc));display:grid;place-items:center;font-family:"Rajdhani",sans-serif;font-weight:700;font-size:12px;color:#fff;}',
    '.gwnav-uname{font-size:11px;color:var(--gink);letter-spacing:.5px;}',
    '.gwnav-logout{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;border:1px solid rgba(255,77,106,.3);color:var(--gr);cursor:pointer;background:transparent;}',
    '.gwnav-logout:hover{background:rgba(255,77,106,.1);}.gwnav-logout svg{width:15px;height:15px;}',
    '@media(max-width:680px){.gwnav-item .lbl{display:none;}.gwnav-uname{display:none;}.gwnav-brand b{display:none;}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var prim = PRIMARY.map(function(p){
    return '<a class="gwnav-item'+(isCur(p.href)?' active':'')+'" href="'+p.href+'">'+p.icon+'<span class="lbl">'+e(p.label)+'</span></a>';
  }).join('');

  function menu(list, obs){
    return list.map(function(x){
      if(x.head) return '<div class="gwnav-head">'+e(x.head)+'</div>';
      if(obs) return '<div class="gwnav-obs"><a href="'+x.href+'" target="_blank" rel="noopener"><span class="ic">'+x.ic+'</span>'+e(x.label)+'</a><button class="gwnav-cpy" data-url="'+e(x.href)+'">URL</button></div>';
      return '<a class="gwnav-di" href="'+x.href+'"><span class="ic">'+x.ic+'</span>'+e(x.label)+(x.sub?'<span class="sub">'+e(x.sub)+'</span>':'')+'</a>';
    }).join('');
  }

  var nav = document.createElement('nav');
  nav.className = 'gwnav';
  nav.innerHTML =
    '<a class="gwnav-brand" href="/admin/"><svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M6 1L11 5.5V11H8V8H4V11H1V5.5L6 1Z" stroke="currentColor" stroke-width="1.2"/></svg>CHAOS<b>CREW</b></a>' +
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

  var body = document.body || document.getElementsByTagName('body')[0];
  if (body) body.insertBefore(nav, body.firstChild);
  else document.addEventListener('DOMContentLoaded', function(){ document.body.insertBefore(nav, document.body.firstChild); });

  fetch('/admin/auth/me').then(function(r){ return r.ok ? r.json() : null; }).then(function(u){
    var login = u && (u.user || u.login);
    if (!login) return;
    document.getElementById('gwnav-uname').textContent = login;
    document.getElementById('gwnav-av').textContent = String(login).charAt(0).toUpperCase();
    var el = document.getElementById('gwnav-user'); if (el) el.style.display = 'flex';
  }).catch(function(){});
})();

// ── Debug Console ─────────────────────────────────────────
(function() {
  var MAX_ENTRIES = 200;
  var entries     = [];
  var paused      = false;
  var filterText  = '';
  var consoleOpen = false;

  var style = document.createElement('style');
  style.textContent = [
    '.cc-dbg-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999;font-family:"Share Tech Mono",monospace;font-size:11px;}',
    '.cc-dbg-handle{background:#04060a;border-top:1px solid rgba(0,212,255,0.2);height:28px;display:flex;align-items:center;padding:0 12px;gap:10px;cursor:pointer;user-select:none;}',
    '.cc-dbg-handle:hover{background:#080e14;}',
    '.cc-dbg-label{color:rgba(0,212,255,0.6);letter-spacing:1.5px;font-size:10px;}',
    '.cc-dbg-dot{width:6px;height:6px;border-radius:50%;background:#333;flex-shrink:0;transition:background 0.2s;}',
    '.cc-dbg-dot.send{background:#00d4ff;} .cc-dbg-dot.recv{background:#00ff88;} .cc-dbg-dot.err{background:#ff4444;}',
    '.cc-dbg-count{color:rgba(200,220,232,0.3);font-size:9px;margin-left:auto;}',
    '.cc-dbg-btns{display:flex;gap:6px;margin-left:8px;}',
    '.cc-dbg-btn{background:transparent;border:1px solid rgba(0,212,255,0.2);color:rgba(200,220,232,0.5);font-family:"Share Tech Mono",monospace;font-size:9px;letter-spacing:1px;padding:2px 8px;cursor:pointer;transition:all 0.15s;}',
    '.cc-dbg-btn:hover{border-color:rgba(0,212,255,0.5);color:rgba(200,220,232,0.9);}',
    '.cc-dbg-btn.active{border-color:#ff4444;color:#ff4444;}',
    '.cc-dbg-panel{background:#04060a;border-top:1px solid rgba(0,212,255,0.15);height:240px;display:none;flex-direction:column;}',
    '.cc-dbg-panel.open{display:flex;}',
    '.cc-dbg-toolbar{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid rgba(0,212,255,0.08);flex-shrink:0;}',
    '.cc-dbg-filter{background:rgba(255,255,255,0.04);border:1px solid rgba(0,212,255,0.15);color:rgba(200,220,232,0.8);font-family:"Share Tech Mono",monospace;font-size:10px;padding:3px 8px;width:180px;outline:none;}',
    '.cc-dbg-filter:focus{border-color:rgba(0,212,255,0.4);}',
    '.cc-dbg-filter::placeholder{color:rgba(200,220,232,0.2);}',
    '.cc-dbg-log{flex:1;overflow-y:auto;padding:4px 0;}',
    '.cc-dbg-log::-webkit-scrollbar{width:3px;} .cc-dbg-log::-webkit-scrollbar-track{background:#04060a;} .cc-dbg-log::-webkit-scrollbar-thumb{background:rgba(0,212,255,0.2);}',
    '.cc-dbg-entry{display:flex;align-items:baseline;gap:8px;padding:2px 10px;border-bottom:1px solid rgba(255,255,255,0.02);cursor:pointer;}',
    '.cc-dbg-entry:hover{background:rgba(0,212,255,0.04);}',
    '.cc-dbg-entry.expanded .cc-dbg-body{white-space:pre;overflow-x:auto;}',
    '.cc-dbg-ts{color:rgba(200,220,232,0.25);font-size:9px;flex-shrink:0;min-width:65px;}',
    '.cc-dbg-dir{font-size:10px;flex-shrink:0;min-width:14px;}',
    '.cc-dbg-dir.send{color:rgba(0,212,255,0.7);} .cc-dbg-dir.recv{color:rgba(0,255,136,0.7);} .cc-dbg-dir.err{color:rgba(255,68,68,0.8);} .cc-dbg-dir.info{color:rgba(240,165,0,0.6);}',
    '.cc-dbg-evt{color:rgba(0,212,255,0.5);flex-shrink:0;min-width:120px;}',
    '.cc-dbg-body{color:rgba(200,220,232,0.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}',
    '.cc-dbg-body.send-color{color:rgba(0,212,255,0.55);} .cc-dbg-body.recv-color{color:rgba(0,255,136,0.55);} .cc-dbg-body.err-color{color:rgba(255,68,68,0.7);}',
  ].join('');
  document.head.appendChild(style);

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
      '<span style="color:rgba(200,220,232,0.2);font-size:9px;margin-left:auto;">Klick auf Zeile = Details</span>' +
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
