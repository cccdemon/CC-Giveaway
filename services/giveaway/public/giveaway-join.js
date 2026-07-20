// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Join Animation (team+key, public /overlay-ws)
// Slides in a card per gw_join. URL:
//   /giveaway/giveaway-join.html?team=<id>&key=<overlay_key>[&test=1]
// ════════════════════════════════════════════════════════

var _q      = new URLSearchParams(location.search);
var OV_TEAM = _q.get('team') || '';
var OV_KEY  = _q.get('key')  || '';
var reduce  = matchMedia('(prefers-reduced-motion:reduce)').matches;

var STATUS = ['BETRITT DIE WARTESCHLANGE','MELDET SICH FREIWILLIG','NIMMT POSITION EIN',
  'REGISTRIERUNG LAEUFT','SLOT WIRD GESICHERT','ZUGANG BESTAETIGT','TICKET WIRD AUSGESTELLT','IDENTITAET VERIFIZIERT'];

var ws = null, wsRetry = 2000, lane, nr = 0, queue = [], playing = false;

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function pad(n) { var s = '' + n; while (s.length < 3) s = '0' + s; return s; }
function bar(n) { var f = Math.min(n, 16), s = '['; for (var i = 0; i < 16; i++) s += (i < f-1 ? '-' : i === f-1 ? '>' : '.'); return s + ']'; }

function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { ws = new WebSocket(proto + '//' + location.host + '/giveaway/overlay-ws'); }
  catch (e) { schedule(); return; }
  ws.onopen = function () { wsRetry = 2000; ws.send(JSON.stringify({ event: 'overlay_subscribe', teamId: OV_TEAM, key: OV_KEY })); };
  ws.onmessage = function (e) { var m = safeParse(e.data); if (m) handle(m); };
  ws.onclose = ws.onerror = function () { schedule(); };
}
function schedule() { setTimeout(connect, wsRetry); wsRetry = Math.min(wsRetry * 2, 15000); }

function handle(msg) { if (msg && msg.event === 'gw_join') enqueue(msg.user); }

function enqueue(name) { nr++; queue.push({ name: name, nr: nr }); if (!playing) play(); }
function play() { if (!queue.length) { playing = false; return; } playing = true; var it = queue.shift(); show(it.name, it.nr); }

function show(name, n) {
  lane = lane || document.getElementById('lane');
  var card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    '<div class="qnr">#' + pad(n) + '</div><div class="dv"></div>' +
    '<div class="txt"><div class="uname">' + esc(name) + '</div><div class="status" id="s' + n + '"></div></div>' +
    '<div class="qbar">' + bar(n) + '<span class="c">' + n + '</span></div>' +
    '<div class="badge">DABEI ✓</div><div class="drain"></div>';
  lane.appendChild(card);
  var txt = STATUS[Math.floor(Math.random() * STATUS.length)];
  setTimeout(function () { type(document.getElementById('s' + n), txt); }, 420);
  var hold = reduce ? 1400 : 4200;
  setTimeout(function () {
    card.classList.add('out');
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); play(); }, 340);
  }, hold);
}

function type(el, text) {
  if (!el) return;
  if (reduce) { el.innerHTML = text + '...'; return; }
  var i = 0;
  (function tick() {
    if (i <= text.length) { el.innerHTML = text.slice(0, i) + '<span class="cur"></span>'; i++; setTimeout(tick, 38); }
    else el.innerHTML = text + '...';
  })();
}

// Test: ?test=1
if (_q.get('test') === '1') {
  var TU = ['JerichoRamirez','x_jazzz_x','HEADWiG','HolderDiePolder','JustCallMeDeimos'], ti = 0;
  (function tn() { if (ti < TU.length) { enqueue(TU[ti++]); setTimeout(tn, 1800); } })();
}

connect();
