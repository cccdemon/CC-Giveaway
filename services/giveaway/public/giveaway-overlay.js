// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Winner Overlay (team+key, public /overlay-ws)
// Winner-only: renders on gw_overlay, gold reveal + spark burst.
// URL: /giveaway/giveaway-overlay.html?team=<id>&key=<overlay_key>
// ════════════════════════════════════════════════════════

var _q      = new URLSearchParams(location.search);
var OV_TEAM = _q.get('team') || '';
var OV_KEY  = _q.get('key')  || '';
var reduce  = matchMedia('(prefers-reduced-motion:reduce)').matches;

var ws = null, wsRetry = 2000, hideTimer = null;

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { ws = new WebSocket(proto + '//' + location.host + '/giveaway/overlay-ws'); }
  catch (e) { schedule(); return; }
  ws.onopen = function () { wsRetry = 2000; ws.send(JSON.stringify({ event: 'overlay_subscribe', teamId: OV_TEAM, key: OV_KEY })); };
  ws.onmessage = function (e) { var m = safeParse(e.data); if (m) handle(m); };
  ws.onclose = ws.onerror = function () { schedule(); };
}
function schedule() { setTimeout(connect, wsRetry); wsRetry = Math.min(wsRetry * 2, 15000); }

function handle(msg) {
  if (!msg) return;
  if (msg.event === 'gw_overlay') {
    if (msg.winner) showWinner(msg.winner, msg.coins || 0);
    else hideWinner();
  }
}

function showWinner(name, tickets) {
  var wo = document.getElementById('winner');
  document.getElementById('ov-winner-name').textContent = String(name).toUpperCase();
  countTo(document.getElementById('ov-winner-tickets'), Math.round(parseFloat(tickets) || 0));
  wo.classList.add('show');
  burst();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hideWinner, 30000);
}
function hideWinner() { document.getElementById('winner').classList.remove('show'); }

function countTo(el, target) {
  if (!el) return;
  var suffix = ' Punkte';
  if (reduce) { el.innerHTML = target + suffix; return; }
  var start = performance.now(), dur = 900;
  (function step(t) {
    var p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3);
    el.innerHTML = Math.round(e * target) + suffix;
    if (p < 1) requestAnimationFrame(step);
  })(start);
}

// ── canvas: gold spark burst ──────────────────────────────
var cv = document.getElementById('fx'), ctx = cv.getContext('2d'), W, H, sparks = [];
function size() { W = cv.width = innerWidth * devicePixelRatio; H = cv.height = innerHeight * devicePixelRatio; }
addEventListener('resize', size); size();

function burst() {
  if (reduce) return;
  var cx = W * 0.5, cy = H * 0.46;
  for (var i = 0; i < 120; i++) {
    var a = Math.random() * Math.PI * 2, sp = (Math.random() * 7 + 2) * devicePixelRatio;
    sparks.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, life: 1, g: Math.random() < 0.5 });
  }
}
function loop() {
  ctx.clearRect(0, 0, W, H);
  for (var j = sparks.length - 1; j >= 0; j--) {
    var s = sparks[j];
    s.x += s.vx; s.y += s.vy; s.vy += 0.12 * devicePixelRatio; s.vx *= 0.985; s.life -= 0.016;
    if (s.life <= 0) { sparks.splice(j, 1); continue; }
    ctx.globalAlpha = Math.max(0, s.life);
    ctx.fillStyle = s.g ? '#f0a500' : '#ffe6a8';
    var r = 2.4 * devicePixelRatio * s.life;
    ctx.fillRect(s.x, s.y, r, r);
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(loop);
}
loop();

connect();
