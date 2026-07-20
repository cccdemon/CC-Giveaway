// ════════════════════════════════════════════════════════
// CHAOS CREW v6 – Test Console JS
// Verbindet auf /giveaway/ws (via Caddy)
// Simuliert viewer_tick + chat_msg Events
// ════════════════════════════════════════════════════════

var SECS_PER_COIN = 7200;
var CHAT_BONUS    = 0.5;
var ws = null;
var wsRetry = 2000;
var wsRetryTimer = null;

// ── WebSocket ─────────────────────────────────────────────
function connectWS() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = proto + '//' + location.host + '/giveaway/ws';
  if (ws) { ws.onclose = null; ws.close(); }
  try {
    ws = new WebSocket(url);
    ws.onopen = function() {
      wsRetry = 2000;
      if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
      setStatus(true);
      log('Verbunden: ' + url, 'info');
      ws.send(JSON.stringify({ event: 'cc_identify', role: 'giveaway-test' }));
      send({ event: 'gw_get_all' });
    };
    ws.onmessage = function(e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch(x) { log('<- ' + e.data, 'recv'); return; }
      handleMsg(msg);
      log('<- ' + pretty(e.data), 'recv');
    };
    ws.onerror = function() { log('WebSocket Fehler', 'err'); };
    ws.onclose = function() {
      setStatus(false);
      log('Verbindung getrennt – reconnect in ' + (wsRetry / 1000) + 's', 'info');
      wsRetryTimer = setTimeout(connectWS, wsRetry);
      wsRetry = Math.min(wsRetry * 2, 15000);
    };
  } catch(e) { log('Fehler: ' + e.message, 'err'); }
}

function reconnect() {
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  connectWS();
}

function disconnect() {
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  setStatus(false);
}

function send(obj) {
  if (!ws || ws.readyState !== 1) { log('Nicht verbunden!', 'err'); return; }
  ws.send(JSON.stringify(obj));
  log('-> ' + pretty(JSON.stringify(obj)), 'send');
}

function handleMsg(msg) {
  if (msg.event === 'gw_data' && Array.isArray(msg.participants)) {
    showSummary(msg.participants);
  }
  if (msg.event === 'wt_update') {
    log('  ↳ ' + msg.user + ': ' + msg.watchSec + 's → ' + msg.coins + ' Coins', 'info');
  }
  if (msg.event === 'gw_join') {
    log('  ↳ Neuer Teilnehmer: ' + msg.user, 'info');
  }
}

// ── Giveaway ──────────────────────────────────────────────
function sendKeyword() {
  send({ event: 'gw_cmd', cmd: 'gw_set_keyword', keyword: document.getElementById('kw-input').value.trim() });
}

function gwReset() {
  if (!confirm('Giveaway wirklich zurücksetzen?')) return;
  send({ event: 'gw_cmd', cmd: 'gw_reset' });
}

// ── Viewer Tick simulieren ────────────────────────────────
function simTicks() {
  var user  = document.getElementById('tick-user').value.trim();
  var count = parseInt(document.getElementById('tick-count').value) || 1;
  if (!user) return;
  log('Tick-Sim: ' + count + 'x viewer_tick für ' + user + ' (+' + (count * 60) + 's)', 'info');
  var delay = 0;
  for (var i = 0; i < count; i++) {
    (function(d) {
      setTimeout(function() {
        send({ event: 'viewer_tick', user: user, ts: Math.floor(Date.now() / 1000) });
      }, d);
    })(delay);
    delay += 100;
  }
  setTimeout(function() { send({ event: 'gw_get_all' }); }, delay + 300);
}

function simTicks120() {
  document.getElementById('tick-count').value = '120';
  simTicks();
}

// ── Chat-Nachricht simulieren ─────────────────────────────
function simChatMsg() {
  var user = document.getElementById('chat-user').value.trim();
  var msg  = document.getElementById('chat-msg').value.trim();
  if (!user || !msg) return;
  send({ event: 'chat_msg', user: user, message: msg, ts: Math.floor(Date.now() / 1000) });
  setTimeout(function() { send({ event: 'gw_get_all' }); }, 500);
}

function simChatKeyword() {
  var user = document.getElementById('chat-user').value.trim();
  var kw   = document.getElementById('kw-input').value.trim() || '!mitmachen';
  if (!user) return;
  log('Keyword-Registrierung: ' + user + ' → "' + kw + '"', 'info');
  send({ event: 'chat_msg', user: user, message: kw, ts: Math.floor(Date.now() / 1000) });
  setTimeout(function() { send({ event: 'gw_get_all' }); }, 500);
}

// ── Tickets manuell ───────────────────────────────────────
function sendCmd(cmd, inputId) {
  var user = document.getElementById(inputId).value.trim();
  if (!user) return;
  send({ event: 'gw_cmd', cmd: cmd, user: user });
}

// ── Coin-Rechner ──────────────────────────────────────────
function calcCoins() {
  var sec   = parseInt(document.getElementById('calc-sec').value) || 0;
  var coins = Math.round((sec / SECS_PER_COIN) * 10000) / 10000;
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  document.getElementById('calc-result').textContent =
    coins + ' Coins (' + h + 'h ' + m + 'm)';
}

// ── Overlays ──────────────────────────────────────────────
function testWinner() {
  var name = document.getElementById('ov-winner').value.trim();
  if (!name) return;
  send({ event: 'gw_overlay', winner: name, coins: 1.5 });
}

// ── Stream Simulation ─────────────────────────────────────
function simStream() {
  var users = document.getElementById('sim-users').value
    .split(',').map(function(u) { return u.trim(); }).filter(Boolean);
  var ticks = parseInt(document.getElementById('sim-ticks').value) || 5;
  if (!users.length) return;

  log('--- Sim: ' + users.length + ' User × ' + ticks + ' Ticks ---', 'info');
  var delay = 0;

  setTimeout(function() { send({ event: 'gw_cmd', cmd: 'gw_open' }); }, delay);
  delay += 400;

  var kw = document.getElementById('kw-input').value.trim() || '!mitmachen';
  users.forEach(function(user) {
    (function(d) {
      setTimeout(function() {
        send({ event: 'chat_msg', user: user, message: kw, ts: Math.floor(Date.now() / 1000) });
      }, d);
    })(delay);
    delay += 150;
  });
  delay += 300;

  users.forEach(function(user) {
    for (var t = 0; t < ticks; t++) {
      (function(d) {
        setTimeout(function() {
          send({ event: 'viewer_tick', user: user, ts: Math.floor(Date.now() / 1000) });
        }, d);
      })(delay);
      delay += 100;
    }
  });

  setTimeout(function() {
    send({ event: 'gw_get_all' });
    log('--- Simulation abgeschlossen ---', 'info');
  }, delay + 400);
}

function simStreamWithChat() {
  var users = document.getElementById('sim-users').value
    .split(',').map(function(u) { return u.trim(); }).filter(Boolean);
  var ticks = parseInt(document.getElementById('sim-ticks').value) || 5;
  if (!users.length) return;

  log('--- Sim: ' + users.length + ' User × ' + ticks + ' Ticks + Chat ---', 'info');
  var delay = 0;

  setTimeout(function() { send({ event: 'gw_cmd', cmd: 'gw_open' }); }, delay);
  delay += 400;

  var kw = document.getElementById('kw-input').value.trim() || '!mitmachen';
  var chatMsgs = [
    'hallo wie geht es dir heute',
    'das ist ein toller stream hier',
    'ich freue mich dabei zu sein',
    'spannendes spiel heute abend',
    'grüße an alle zuschauer hier'
  ];

  users.forEach(function(user) {
    (function(d) {
      setTimeout(function() {
        send({ event: 'chat_msg', user: user, message: kw, ts: Math.floor(Date.now() / 1000) });
      }, d);
    })(delay);
    delay += 200;

    for (var t = 0; t < ticks; t++) {
      (function(d) {
        setTimeout(function() {
          send({ event: 'viewer_tick', user: user, ts: Math.floor(Date.now() / 1000) });
        }, d);
      })(delay);
      delay += 100;
    }

    for (var m = 0; m < 3; m++) {
      (function(d, mi) {
        setTimeout(function() {
          var msg = chatMsgs[mi % chatMsgs.length];
          send({ event: 'chat_msg', user: user, message: msg, ts: Math.floor(Date.now() / 1000) });
        }, d);
      })(delay, m);
      delay += 300;
    }
    delay += 200;
  });

  setTimeout(function() {
    send({ event: 'gw_get_all' });
    log('--- Simulation mit Chat abgeschlossen ---', 'info');
  }, delay + 400);
}

// ── Summary ───────────────────────────────────────────────
function showSummary(participants) {
  var active = participants.filter(function(p) { return !p.banned; });
  var total  = active.reduce(function(s, p) { return s + (parseFloat(p.coins) || 0); }, 0);
  log('SUMMARY: ' + active.length + ' Teilnehmer | ' + total.toFixed(4) + ' Coins gesamt', 'info');
  active.sort(function(a, b) { return (b.coins || 0) - (a.coins || 0); })
    .slice(0, 5).forEach(function(p, i) {
      var coins  = parseFloat(p.coins) || 0;
      var chance = total > 0 ? ((coins / total) * 100).toFixed(1) : '0.0';
      var sec    = parseInt(p.watchSec) || 0;
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      log('  #' + (i + 1) + ' ' + p.username +
          ': ' + coins.toFixed(4) + ' Coins (' + chance + '%) | ' +
          h + 'h ' + m + 'm', 'info');
    });
}

// ── Manuell ───────────────────────────────────────────────
function sendManual() {
  var raw = document.getElementById('manual-json').value.trim();
  try { send(JSON.parse(raw)); } catch(e) { log('Ungültiges JSON', 'err'); }
}

function formatJson() {
  try {
    var raw = document.getElementById('manual-json').value;
    document.getElementById('manual-json').value = JSON.stringify(JSON.parse(raw), null, 2);
  } catch(e) {}
}

// ── Utils ─────────────────────────────────────────────────
function setStatus(on) {
  var el = document.getElementById('status');
  el.className   = on ? 'on' : 'off';
  el.textContent = on ? 'ONLINE' : 'OFFLINE';
}

function pretty(json) {
  try { return JSON.stringify(JSON.parse(json)); } catch(e) { return json; }
}

function log(msg, type) {
  var el  = document.getElementById('log');
  var now = new Date();
  var ts  = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
  var div = document.createElement('div');
  div.innerHTML = '<span class="log-ts">[' + ts + ']</span>' +
                  '<span class="log-' + type + '">' + escHtml(msg) + '</span>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 500) el.removeChild(el.firstChild);
}

function clearLog() { document.getElementById('log').innerHTML = ''; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function pad2(n) { return n < 10 ? '0' + n : String(n); }

connectWS();
