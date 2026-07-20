// ════════════════════════════════════════════════════════
// CHAOS CREW – Giveaway Admin JS (microservice)
// WS: /giveaway/ws  API: /api/...
// ════════════════════════════════════════════════════════

function parseDec(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') return parseFloat(v.replace(/,/g, '.')) || 0;
  return parseFloat(v) || 0;
}

// ── State ─────────────────────────────────────────────────
let currentTeam  = null;
const TEAM_EVENTS = { gw_cmd:1, gw_get_all:1, gw_overlay:1, viewer_tick:1, chat_msg:1, time_cmd:1 };
let participants = {};
let gwChannels   = [];
let gwIsOpen     = false;
let gwPaused     = false;
// Streamermodus: Zuschauernamen + Ingest-Tokens werden maskiert, damit das Panel
// live gezeigt werden kann. Nur Anzeige — COPY kopiert weiterhin den echten Wert.
let privacyOn    = localStorage.getItem('cc_privacy') === '1';
let gwDrawMinSec = 7200;   // Viewtime-Schwelle für den Lostopf (vom Server, gw_data)
let gwFollowMin  = 2;
let sortField    = 'coins';
let sortDir      = -1;
let gwWs         = null;
let gwWsRetry    = 1000;
let gwWsReconnectTimer = null;
let lastWinner   = null;
let historyDraws = [];

function esc(s) {
  return (window.CC && CC.validate && typeof CC.validate.escHtml === 'function')
    ? CC.validate.escHtml(s)
    : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── WebSocket ─────────────────────────────────────────────
function reconnect() {
  if (gwWsReconnectTimer) { clearTimeout(gwWsReconnectTimer); gwWsReconnectTimer = null; }
  if (gwWs) { gwWs.onclose = null; gwWs.close(); }
  connectWS();
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { gwWs = new WebSocket(`${proto}//${location.host}/giveaway/ws`); }
  catch(e) { scheduleReconnect(); return; }

  gwWs.onopen = () => {
    setBadge(true);
    gwWsRetry = 1000;
    log('WebSocket verbunden', 'cyan');
    send({ event: 'cc_identify', role: 'giveaway-admin' });
    loadTeams();
  };
  gwWs.onmessage = (e) => { const msg = CC.validate.safeJsonParse(e.data); if (msg) handle(msg); };
  gwWs.onclose = gwWs.onerror = () => { setBadge(false); scheduleReconnect(); };
}

function scheduleReconnect() {
  if (gwWsReconnectTimer) return;
  gwWsReconnectTimer = setTimeout(function() {
    gwWsReconnectTimer = null;
    connectWS();
  }, gwWsRetry);
  gwWsRetry = Math.min(gwWsRetry * 2, 15000);
}

function setBadge(on) {
  const el = document.getElementById('ws-badge');
  if (!el) return;
  el.className  = 'ws-badge ' + (on ? 'on' : 'off');
  el.textContent = on ? 'WS: ONLINE' : 'WS: OFFLINE';
}

function send(obj) {
  if (obj && TEAM_EVENTS[obj.event]) {
    if (!currentTeam) { log('Kein Team gewählt', 'red'); return; }
    obj.teamId = currentTeam;
  }
  if (!CC.validate.validateWsPayload(obj)) { log('Payload blockiert: ' + JSON.stringify(obj).slice(0,60), 'red'); return; }
  if (gwWs && gwWs.readyState === 1) gwWs.send(JSON.stringify(obj));
  else log('WS nicht verbunden', 'red');
}

async function loadTeams() {
  try {
    var teams = await (await fetch('/admin/api/teams/mine')).json();
    var sel = document.getElementById('team-select');
    if (!Array.isArray(teams) || !teams.length) {
      if (sel) sel.innerHTML = '<option>— kein Team —</option>';
      log('Du bist in keinem Team. Lege unter MEINE TEAMS eins an.', 'gold');
      return;
    }
    if (sel) {
      sel.innerHTML = teams.map(function(t){ return '<option value="'+esc(t.id)+'">'+esc(t.name)+(t.role==='owner'?' ★':'')+'</option>'; }).join('');
      if (!currentTeam || !teams.some(function(t){return t.id===currentTeam;})) currentTeam = teams[0].id;
      sel.value = currentTeam;
    } else if (!currentTeam) { currentTeam = teams[0].id; }
    refresh();
  } catch(e) { log('Teams laden fehlgeschlagen: ' + e.message, 'red'); }
}

function onTeamChange() {
  var sel = document.getElementById('team-select');
  if (!sel) return;
  currentTeam = sel.value;
  participants = {};
  log('Team gewechselt: ' + currentTeam, 'cyan');
  refresh();
}

function refresh() { requestData(); loadKeyword(); loadHistory(); loadAudit(); }

function requestData() {
  send({ event: 'gw_get_all' });
  send({ event: 'gw_cmd', cmd: 'gw_get_multiplier' });
  send({ event: 'gw_cmd', cmd: 'gw_get_stream_settings' });
  send({ event: 'gw_cmd', cmd: 'gw_get_channels' });
  send({ event: 'gw_cmd', cmd: 'gw_get_ingest_tokens' });
  send({ event: 'gw_cmd', cmd: 'gw_get_ai_settings' });
}

setInterval(() => { if (gwWs && gwWs.readyState === 1) requestData(); }, 10000);

// Debounced live refresh — coalesces bursts of wt_update/gw_join into
// one data pull so the table/stats update in ~1s without a page reload.
let _liveRefreshT = null;
function liveRefresh() {
  if (_liveRefreshT) return;
  _liveRefreshT = setTimeout(() => { _liveRefreshT = null; requestData(); }, 800);
}

// ── Message Handler ───────────────────────────────────────
function handle(msg) {
  switch(msg.event) {
    case 'gw_data':
      participants = {};
      gwIsOpen = !!msg.open;
      gwPaused = !!msg.paused;
      if (Array.isArray(msg.channels)) gwChannels = msg.channels;
      (msg.participants || []).forEach(p => {
        const key = (p.username || '').toLowerCase();
        participants[key] = {
          display:  p.username || key,
          watchSec: parseInt(p.watchSec) || 0,
          msgs:     parseInt(p.msgs) || 0,
          coins:    parseDec(p.coins),
          banned:   !!p.banned,
          flags:    Array.isArray(p.flags) ? p.flags : [],
          perChannel: p.perChannel || {},
          eligible:   !!p.eligible,
          registered: !!p.registered,
          follows:    parseInt(p.channelsFollowed) || 0
        };
        if (Number.isFinite(parseInt(p.drawMinSec))) gwDrawMinSec = parseInt(p.drawMinSec);
        if (Number.isFinite(parseInt(p.followMin)))  gwFollowMin  = parseInt(p.followMin);
      });
      updateGwStatus();
      renderHead();
      renderTable();
      updateStats();
      break;

    case 'gw_status':
      gwPaused = msg.status === 'paused';
      gwIsOpen = msg.status === 'open' || msg.status === 'paused';
      updateGwStatus();
      break;

    case 'gw_ack': {
      log(`ACK: ${msg.type} -> ${msg.user || msg.keyword || msg.winner || msg.channel || ''}`, 'cyan');
      // Read-only Antworten (NIE requestData → sonst Endlosschleife)
      if (msg.type === 'channels')      { ingestChannels = msg.channels || []; renderIngest(); break; }
      if (msg.type === 'ingest_tokens') { ingestTokens = {}; (msg.tokens || []).forEach(t => ingestTokens[t.channel] = t.token); renderIngest(); break; }
      if (msg.type === 'ingest_token')  { ingestTokens[msg.channel] = msg.token; renderIngest(); break; }
      if (msg.type === 'stream_settings') {
        var apEl = document.getElementById('cfg-auto-pause');  if (apEl) apEl.checked = !!msg.autoPause;
        var arEl = document.getElementById('cfg-auto-resume'); if (arEl) arEl.checked = !!msg.autoResume;
        var fmEl = document.getElementById('cfg-follow-min');  if (fmEl && msg.followMin !== undefined) fmEl.value = msg.followMin;
        var dmEl = document.getElementById('cfg-draw-min');    if (dmEl && msg.drawMinHours !== undefined) dmEl.value = msg.drawMinHours;
        var cwEl = document.getElementById('cfg-chat-words'); if (cwEl && msg.chatMinWords !== undefined) cwEl.value = msg.chatMinWords;
        var cbEl = document.getElementById('cfg-chat-bonus'); if (cbEl && msg.chatBonusSec !== undefined) cbEl.value = msg.chatBonusSec;
        var ccEl = document.getElementById('cfg-chat-cool');  if (ccEl && msg.chatCooldown !== undefined) ccEl.value = msg.chatCooldown;
        if (msg.followMin !== undefined)    gwFollowMin  = parseInt(msg.followMin) || 0;
        if (msg.drawMinHours !== undefined) gwDrawMinSec = Math.round(parseFloat(msg.drawMinHours) * 3600) || 0;
        updateStats(); renderTable();
        break;
      }
      if (msg.type === 'ai_settings') { applyAiSettings(msg); break; }
      if (msg.type === 'ai_models')   { applyAiModels(msg); break; }
      if (msg.type === 'ai_error')    { log('KI: ' + (msg.error || '?'), 'red'); break; }
      if (msg.type === 'open_blocked') { log(msg.error || 'Öffnen blockiert', 'red'); alert(msg.error || 'Öffnen blockiert'); break; }
      if (msg.type === 'ai_rotated')  { log('Master-Schlüssel rotiert: ' + msg.reencrypted + ' Keys neu verschlüsselt'
                                            + (msg.unreadable ? ', ' + msg.unreadable + ' unlesbar' : ''), 'gold'); break; }
      if (msg.type === 'ai_test') {
        if (!msg.ok) log('KI-Test fehlgeschlagen: ' + (msg.error || '?') + ' – Wortregel greift', 'red');
        else log('KI-Test ok (' + msg.source + '): "' + msg.sample + '" -> ' + (msg.meaningful ? 'sinnvoll' : 'nicht sinnvoll'), 'cyan');
        break;
      }
      if (msg.type === 'keyword') { const kw = msg.keyword || ''; document.getElementById('kw-current').textContent = kw || '- (deaktiviert)'; document.getElementById('kw-input').value = kw; break; }
      // Mutations
      if (msg.type === 'keyword_set') {
        const kw = msg.keyword || '';
        document.getElementById('kw-current').textContent = kw || '- (deaktiviert)';
        document.getElementById('kw-input').value = kw;
      }
      if (msg.type === 'follows_verified') {
        var uv = (msg.unverified||[]).length ? ' | unverifiziert: ' + msg.unverified.join(',') : '';
        log('Follows geprüft: ' + (msg.verified||[]).length + ' Kanäle, ' + (msg.mismatches||0) + ' Änderungen' + uv, uv ? 'gold' : 'cyan');
      }
      if (msg.type === 'winner_drawn') { showWinnerAnimation(msg.winner, msg.watchSec, msg.coins, msg.prize); loadHistory(); }
      if (msg.type === 'no_winner') log('Keine Teilnehmer mit Coins im Pool!', 'red');
      if (msg.type === 'draw_error') log('ZIEHUNG FEHLGESCHLAGEN: ' + (msg.error || '?') + ' – nichts gespeichert, bitte erneut ziehen', 'red');
      if (msg.type === 'cmd_error') log('BEFEHL FEHLGESCHLAGEN (' + (msg.cmd || '?') + '): ' + (msg.error || '?'), 'red');
      loadAudit();          // jede Mutation erzeugt einen Audit-Eintrag
      requestData();
      break;
    }

    case 'gw_multiplier':
      updateMultiplierUI(parseFloat(msg.factor) || 1, parseInt(msg.secondsLeft) || 0);
      break;

    case 'gw_join':
      if (msg.user) log('Neuer Teilnehmer: ' + msg.user, 'cyan');
      liveRefresh();
      break;

    case 'wt_update':
      liveRefresh();
      break;
  }
}

// ── Viewtime-Multiplier ───────────────────────────────────
function startMultiplier() {
  const factor  = CC.validate.sanitizeInt(document.getElementById('mult-factor').value, 1, 10, 2);
  const minutes = CC.validate.sanitizeInt(document.getElementById('mult-minutes').value, 1, 1440, 15);
  send({ event: 'gw_cmd', cmd: 'gw_set_multiplier', factor: factor, minutes: minutes });
  log(`Viewtime-Boost ${factor}× für ${minutes} min`, 'cyan');
}

function stopMultiplier() {
  send({ event: 'gw_cmd', cmd: 'gw_set_multiplier', factor: 1, minutes: 0 });
  log('Viewtime-Boost gestoppt', 'gold');
}

// ── Auto-Steuerung (Stream on/off → pause/resume) ─────────
function saveStreamSettings() {
  var ap = !!(document.getElementById('cfg-auto-pause')  || {}).checked;
  var ar = !!(document.getElementById('cfg-auto-resume') || {}).checked;
  var fm = CC.validate.sanitizeInt((document.getElementById('cfg-follow-min') || {}).value, 0, 10, 2);
  var dmRaw = parseFloat((document.getElementById('cfg-draw-min') || {}).value);
  var dm = isFinite(dmRaw) && dmRaw >= 0.05 ? Math.min(100, dmRaw) : 2;
  var num = function(id, def) { var v = parseFloat((document.getElementById(id) || {}).value); return isFinite(v) ? v : def; };
  send({ event: 'gw_cmd', cmd: 'gw_set_stream_settings', autoPause: ap, autoResume: ar, followMin: fm, drawMinHours: dm,
         chatMinWords: num('cfg-chat-words', 4), chatBonusSec: num('cfg-chat-bonus', 2), chatCooldown: num('cfg-chat-cool', 10) });
  log('Einstellungen: folge≥' + fm + ' · Pause=' + ap + ' Start=' + ar, 'cyan');
}

let _multTimer = null;
function updateMultiplierUI(factor, secondsLeft) {
  const el = document.getElementById('mult-status');
  if (!el) return;
  if (_multTimer) { clearInterval(_multTimer); _multTimer = null; }
  if (factor <= 1 || secondsLeft <= 0) {
    el.textContent = '1× (aus)';
    el.style.color = 'var(--dim)';
    return;
  }
  el.style.color = 'var(--cyan)';
  let left = secondsLeft;
  const render = () => {
    const m = Math.floor(left / 60), s = left % 60;
    el.textContent = `${factor}× · ${m}:${String(s).padStart(2, '0')}`;
    if (left <= 0) { clearInterval(_multTimer); _multTimer = null; el.textContent = '1× (aus)'; el.style.color = 'var(--dim)'; }
    left--;
  };
  render();
  _multTimer = setInterval(render, 1000);
}

// ── Stream-Verbindungen (Ingest-Token) ────────────────────
var ingestChannels = [];
var ingestTokens = {};

function ingestUrl() { return 'wss://' + location.host + '/ingest'; }

// Copy any string to clipboard, flash the triggering button.
function copyVal(val, btn) {
  var done = function () {
    if (!btn) return;
    var old = btn.textContent; btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1100);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(val).then(done).catch(function () { legacyCopy(val); done(); });
  } else { legacyCopy(val); done(); }
}
function legacyCopy(val) {
  var t = document.createElement('textarea'); t.value = val;
  t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t);
  t.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(t);
}

// One "copy field": readonly value + copy button. `code`=monospace styling.
function copyField(val, code) {
  var safe = esc(val);
  return '<div class="cf">'
    + '<input class="cf-val' + (code ? ' mono' : '') + '" readonly value="' + safe + '" onclick="this.select()">'
    + '<button class="btn btn-cyan btn-sm cf-btn" onclick="copyVal(' + "'" + jsStr(val) + "'" + ',this)">COPY</button>'
    + '</div>';
}
function jsStr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function renderIngest() {
  var el = document.getElementById('ingest-list');
  if (!el) return;
  var url = ingestUrl();
  var chans = ingestChannels.length ? ingestChannels : Object.keys(ingestTokens);

  // ── Step 1: WebSocket-Client-Endpoint ──
  var html = ''
    + '<div class="ig-step"><div class="ig-step-h"><span class="ig-num">1</span>Streamerbot → Settings → WebSocket <b>Client</b> → Add</div>'
    + '<div class="ig-lbl">Endpoint</div>' + copyField(url, true)
    + '<div class="ig-hint">Auto Connect ✓ · Reconnect ✓ · TLS 1.2 ✓ — <b>kein</b> ws:// selbst tippen, volle URL einfügen.</div>'
    + '</div>';

  // ── Step 2: Token je Kanal ──
  html += '<div class="ig-step"><div class="ig-step-h"><span class="ig-num">2</span>Kanal-Token als globale Variable setzen</div>'
    + '<div class="ig-lbl">Variablen-Name (persistent!)</div>' + copyField('cc_ingest_token', true);

  if (!chans.length) {
    html += '<div class="wsc-empty" style="margin-top:8px">Keine Kanäle konfiguriert</div>';
  } else {
    html += chans.map(function (ch) {
      var tok = ingestTokens[ch];
      var body = tok
        ? '<div class="ig-lbl">Token · ' + esc(ch) + '</div>'
          + '<div class="cf">'
          + '<input class="cf-val mono" readonly value="' + esc(maskToken(tok)) + '"'
          + (privacyOn ? '' : ' onclick="this.select()"') + '>'
          + '<button class="btn btn-cyan btn-sm cf-btn" onclick="copyVal(' + "'" + jsStr(tok) + "'" + ',this)">COPY</button>'
          + '<button class="btn btn-gold btn-sm" onclick="genIngestToken(\'' + jsStr(ch) + '\')">NEU</button>'
          + '</div>'
        : '<div class="ig-lbl">' + esc(ch) + '</div>'
          + '<div class="cf"><span class="cf-val" style="opacity:.5;padding:6px 8px">kein Token</span>'
          + '<button class="btn btn-cyan btn-sm" onclick="genIngestToken(\'' + jsStr(ch) + '\')">GENERIEREN</button></div>';
      return '<div class="ig-chan">' + body + '</div>';
    }).join('');
  }
  html += '<div class="ig-hint">Variable muss <b>persistent</b> sein (sonst findet die Action sie nicht). NEU rotiert den Token → danach im Streamerbot neu einfügen.</div></div>';

  // ── Step 3: Trigger ──
  html += '<div class="ig-step"><div class="ig-step-h"><span class="ig-num">3</span>Action-Trigger prüfen</div>'
    + '<div class="ig-hint"><code>CC_IngestConnect</code> muss am Trigger <b>Core → WebSocket Client → Connected</b> hängen — sonst wird der Token nie gesendet und der Kanal bleibt <b>Closed</b>.</div></div>';

  el.innerHTML = html;
}

function genIngestToken(ch) {
  send({ event: 'gw_cmd', cmd: 'gw_gen_ingest_token', channel: ch });
  log('Ingest-Token für ' + ch + ' generiert', 'cyan');
}

// ── Giveaway Controls ─────────────────────────────────────
function gwOpen()   { send({ event:'gw_cmd', cmd:'gw_open'   }); gwIsOpen=true; gwPaused=false; updateGwStatus(); log('Giveaway geoeffnet','cyan'); }
function gwClose()  { send({ event:'gw_cmd', cmd:'gw_close'  }); gwIsOpen=false; gwPaused=false; updateGwStatus(); log('Giveaway geschlossen','gold'); }
function gwPause()  { send({ event:'gw_cmd', cmd:'gw_pause'  }); gwPaused=true;  updateGwStatus(); log('Giveaway pausiert','gold'); }
function gwResume() { send({ event:'gw_cmd', cmd:'gw_resume' }); gwPaused=false; gwIsOpen=true; updateGwStatus(); log('Giveaway fortgesetzt','cyan'); }

function updateGwStatus() {
  const el = document.getElementById('gw-txt');
  if (!gwIsOpen)      { el.textContent='CLOSED';   el.className='state-chip closed'; }
  else if (gwPaused)  { el.textContent='PAUSIERT'; el.className='state-chip paused'; }
  else                { el.textContent='OPEN';     el.className='state-chip open'; }
}

function drawWinner() {
  var el = document.getElementById('prize-input');
  var prize = el ? el.value.trim() : '';
  send({ event:'gw_cmd', cmd:'gw_draw_winner', prize: prize });
}

function showWinnerAnimation(winnerName, watchSec, coins, prize) {
  const names = Object.keys(participants).filter(k => !participants[k].banned && participants[k].coins > 0);
  if (!names.length) names.push(winnerName);
  let flashes = 0;
  document.getElementById('winner-card').style.display = 'block';
  const interval = setInterval(() => {
    const tmp = names[Math.floor(Math.random()*names.length)];
    document.getElementById('w-name').textContent = (participants[tmp]?.display||tmp).toUpperCase();
    if (++flashes >= 14) {
      clearInterval(interval);
      lastWinner = winnerName;
      document.getElementById('w-name').textContent = winnerName.toUpperCase();
      const prizeTxt = prize ? ` // 🎁 ${prize}` : '';
      document.getElementById('w-info').textContent = `${parseDec(coins).toFixed(2)} Coins // ${fmtTime(watchSec||0)}${prizeTxt}`;
      renderTable(winnerName);
      log(`GEWINNER: ${winnerName} (${parseDec(coins).toFixed(2)} Coins)${prize ? ' – Preis: ' + prize : ''}`, 'gold');
    }
  }, 75);
}

function reroll()      { drawWinner(); }
function clearWinner() { lastWinner=null; document.getElementById('winner-card').style.display='none'; clearOverlay(); }

// ── Manual Actions ────────────────────────────────────────
function manualAdd() {
  const name = CC.validate.sanitize(document.getElementById('m-name').value, 'username');
  const amt  = CC.validate.sanitizeInt(document.getElementById('m-amount').value, 1, 100, 1);
  if (!name) return;
  for (let i=0; i<amt; i++) send({ event:'gw_cmd', cmd:'gw_add_ticket', user:name });
  log(`+${amt} Ticket(s) -> ${name}`, 'cyan');
  setTimeout(requestData, 300);
}

function manualSub() {
  const name = CC.validate.sanitize(document.getElementById('m-name').value, 'username');
  const amt  = CC.validate.sanitizeInt(document.getElementById('m-amount').value, 1, 100, 1);
  if (!name) return;
  for (let i=0; i<amt; i++) send({ event:'gw_cmd', cmd:'gw_sub_ticket', user:name });
  log(`-${amt} Ticket(s) -> ${name}`, 'gold');
  setTimeout(requestData, 300);
}

function addTicketTo(key)   { send({ event:'gw_cmd', cmd:'gw_add_ticket', user:key }); log(`+1 -> ${key}`,'cyan'); setTimeout(requestData,300); }
function subTicketFrom(key) { send({ event:'gw_cmd', cmd:'gw_sub_ticket', user:key }); log(`-1 -> ${key}`,'gold'); setTimeout(requestData,300); }

function toggleBan(key) {
  const banned = participants[key]?.banned;
  send({ event:'gw_cmd', cmd: banned ? 'gw_unban' : 'gw_ban', user:key });
  log(`${banned?'UNBAN':'BAN'}: ${key}`, banned?'gold':'red');
  setTimeout(requestData, 300);
}

function resetAll() {
  if (!confirm('ALLE Giveaway-Daten loeschen? Nicht rueckgaengig!')) return;
  send({ event:'gw_cmd', cmd:'gw_reset' });
  participants={}; gwIsOpen=false; lastWinner=null;
  document.getElementById('winner-card').style.display = 'none';
  updateGwStatus(); renderTable(); updateStats(); clearOverlay();
  log('RESET – alle Daten geloescht', 'red');
}

// ── Keyword ───────────────────────────────────────────────
function setKeyword() {
  const kw = CC.validate.sanitize(document.getElementById('kw-input').value, 'keyword');
  send({ event:'gw_cmd', cmd:'gw_set_keyword', keyword: kw });
  log(`Keyword gesetzt: "${kw}"`, 'cyan');
}

function clearKeyword() {
  send({ event:'gw_cmd', cmd:'gw_set_keyword', keyword: '' });
  document.getElementById('kw-input').value = '';
  document.getElementById('kw-current').textContent = '- (deaktiviert)';
  log('Keyword deaktiviert', 'gold');
}

function loadKeyword() { send({ event:'gw_cmd', cmd:'gw_get_keyword' }); }

// ── Table ─────────────────────────────────────────────────
// Kopfzeile dynamisch: #, NAME, COINS, [pro Kanal], TOTAL VIEWTIME, AKTIONEN.
function renderHead() {
  const row = document.getElementById('thead-row');
  if (!row) return;
  const chCols = gwChannels.map(ch =>
    `<th class="num" title="Viewtime auf ${esc(ch)}">${esc(ch)}</th>`).join('');
  row.innerHTML =
    `<th class="num" onclick="sortBy('rank')">#</th>`
    + `<th onclick="sortBy('name')">NAME</th>`
    + `<th class="num sorted" onclick="sortBy('coins')">COINS</th>`
    + chCols
    + `<th class="num" onclick="sortBy('watchSec')">TOTAL VIEWTIME</th>`
    + `<th class="num">AKTIONEN</th>`;
}

// ── Streamermodus ─────────────────────────────────────────
// Ersetzt Zuschauernamen durch stabile Pseudonyme und blendet Tokens aus.
// Die echten Werte bleiben im Speicher — Aktionen (+1/BAN/Suche) arbeiten
// weiter mit dem echten Key, nur die Darstellung ändert sich.
function togglePrivacy() {
  privacyOn = !privacyOn;
  localStorage.setItem('cc_privacy', privacyOn ? '1' : '0');
  applyPrivacy();
  log(privacyOn ? 'Streamermodus AN – Namen & Tokens maskiert' : 'Streamermodus AUS', 'gold');
}

function applyPrivacy() {
  document.body.classList.toggle('privacy', privacyOn);
  const b = document.getElementById('privacy-badge');
  if (b) {
    b.className = 'ws-badge priv ' + (privacyOn ? 'on' : 'off');
    b.innerHTML = (privacyOn ? '&#128064;' : '&#128065;') + ' STREAMERMODUS: ' + (privacyOn ? 'AN' : 'AUS');
  }
  if (document.getElementById('tbl'))         renderTable();
  if (document.getElementById('ingest-list')) renderIngest();
  if (document.getElementById('audit-list'))  renderAudit();
}

// Pseudonym bleibt gleich, egal wie sortiert/gefiltert wird: Position in der
// alphabetisch sortierten Gesamtliste.
function maskName(key, fallback) {
  if (!privacyOn) return fallback;
  const all = Object.keys(participants).sort();
  const i = all.indexOf(key);
  return 'Zuschauer ' + String(i < 0 ? 0 : i + 1).padStart(2, '0');
}

function maskToken(tok) { return privacyOn ? '•'.repeat(Math.min(32, String(tok).length)) : tok; }

// Vorgemerkt = Keyword ist drin (bleibt dauerhaft), aber die Lostopf-Bedingungen
// sind noch nicht erfüllt. Sobald der Coin voll ist, rutscht er ohne weiteres
// Zutun in den Lostopf — das Keyword muss nicht erneut geschrieben werden.
function isPending(p) { return p.registered && !p.banned && !p.eligible; }

function statusBadge(p) {
  if (p.eligible) {
    const t = `Im Lostopf: angemeldet, folgt ${p.follows}/${gwFollowMin}, ≥1 Coin (${fmtDurShort(gwDrawMinSec)})`;
    return ` <span class="elig-badge" title="${esc(t)}">&#9679; LOSTOPF</span>`;
  }
  if (!isPending(p)) return '';
  const missing = [];
  if (p.follows < gwFollowMin)      missing.push(`Follows ${p.follows}/${gwFollowMin}`);
  if ((p.coins || 0) < 1)           missing.push(`noch ${fmtTime(Math.max(0, gwDrawMinSec - (p.watchSec||0)))} bis 1 Coin`);
  const t = `Vorgemerkt (angemeldet). Fehlt: ${missing.join(' + ') || '—'}. Keyword muss nicht erneut geschrieben werden.`;
  return ` <span class="pend-badge" title="${esc(t)}">&#9675; VORGEMERKT</span>`;
}

function renderTable(hlKey=null) {
  const search = document.getElementById('search').value.toLowerCase();
  const entries = Object.entries(participants)
    .filter(([k,p]) => !search || k.includes(search) || (p.display||'').toLowerCase().includes(search))
    .sort(([,a],[,b]) => {
      if (sortField === 'rank') return 0;
      const av = sortField==='name' ? (a.display||'').toLowerCase() : (a[sortField]||0);
      const bv = sortField==='name' ? (b.display||'').toLowerCase() : (b[sortField]||0);
      return sortDir * (av<bv?-1:av>bv?1:0);
    });

  document.getElementById('list-count').textContent = entries.length;
  document.getElementById('tbl').innerHTML = entries.map(([key,p],i) => `
    <tr class="${p.banned?'banned':''} ${p.eligible?'eligible':(isPending(p)?'pending':'')} ${key===hlKey?'winner-row':''}">
      <td class="rank">${i+1}</td>
      <td class="name">${esc(maskName(key, p.display||key))}${statusBadge(p)}${p.banned?' <span style="color:var(--red);font-size:10px;">[BAN]</span>':''}${(p.flags&&p.flags.length)?` <span title="${esc(p.flags.map(f=>f.reason+' x'+f.count).join(', '))}" style="color:var(--gold);font-size:11px;cursor:help;">&#9888;${p.flags.length}</span>`:''}</td>
      <td class="tickets">${parseDec(p.coins).toFixed(2)}</td>
      ${gwChannels.map(ch => `<td class="watchtime pc">${fmtTime((p.perChannel && p.perChannel[ch] && p.perChannel[ch].watchSec) || 0)}</td>`).join('')}
      <td class="watchtime total">${fmtTime(p.watchSec)}</td>
      <td style="display:flex;gap:4px;justify-content:flex-end;">
        <button class="mini-btn add" onclick="addTicketTo('${esc(key)}')">+1</button>
        <button class="mini-btn sub" onclick="subTicketFrom('${esc(key)}')">-1</button>
        <button class="mini-btn ban" onclick="toggleBan('${esc(key)}')">${p.banned?'UN':'BAN'}</button>
      </td>
    </tr>`).join('');
}

function sortBy(f) {
  if (sortField===f) sortDir*=-1; else { sortField=f; sortDir=f==='name'?1:-1; }
  renderTable();
}

// ── Stats & Overlay ───────────────────────────────────────
function updateStats() {
  const active = Object.values(participants).filter(p=>!p.banned);
  document.getElementById('s-total').textContent   = active.length;
  document.getElementById('s-tickets').textContent = active.reduce((s,p)=>s+(parseFloat(p.coins)||0),0).toFixed(4).replace(/\.?0+$/,'');
  document.getElementById('s-msgs').textContent    = active.reduce((s,p)=>s+(parseInt(p.msgs)||0),0);
  // Berechtigte = Server-Flag `eligible` (Keyword + Follow-Gate + ≥drawMinSec Viewtime)
  const elig    = active.filter(p => p.eligible).length;
  const pending = active.filter(isPending).length;
  const noKey   = active.filter(p => !p.registered && (p.coins||0) >= 1).length;
  document.getElementById('s-eligible').textContent = pending ? `${elig}+${pending}` : String(elig);
  document.getElementById('s-eligible-lbl').textContent = pending ? 'LOSTOPF + VORGEMERKT' : 'IM LOSTOPF (≥1 COIN)';
  document.getElementById('s-eligible-box').title =
    `${elig} im Lostopf (Keyword + ≥${gwFollowMin} Follows + ≥1 Coin)\n`
    + `${pending} vorgemerkt (Keyword da, Bedingung offen)\n`
    + `${noKey} hätten ≥1 Coin, aber kein Keyword\n`
    + `1 Coin = ${fmtDurShort(gwDrawMinSec)} Viewtime`;
}

// OBS-Overlay (giveaway-overlay.html) ist winner-only. Der Server broadcastet
// den Gewinner bei der Ziehung selbst; hier nur das explizite Leeren.
function clearOverlay() {
  send({ event: 'gw_overlay', winner: null });
}

function verifyFollows() {
  log('Prüfe Follows via Helix …', 'cyan');
  send({ event: 'gw_cmd', cmd: 'gw_verify_follows' });
}

// ── Chat-KI ───────────────────────────────────────────────
let aiProviders = [];
let aiModels = [];
let aiCurrentModel = '';

function applyAiSettings(msg) {
  if (Array.isArray(msg.providers) && msg.providers.length) aiProviders = msg.providers;
  var sel = document.getElementById('cfg-ai-provider');
  if (sel && aiProviders.length) {
    sel.innerHTML = aiProviders.map(function(p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>';
    }).join('');
    if (msg.provider) sel.value = msg.provider;
  }
  var en = document.getElementById('cfg-ai-enabled'); if (en) en.checked = !!msg.enabled;
  if (msg.model !== undefined) aiCurrentModel = msg.model || '';
  // Ohne geladene Liste die bekannten Modelle des Anbieters zeigen -
  // eine leere Auswahl waere schlimmer als eine unvollstaendige.
  if (!aiModels.length) {
    var p = aiProviders.filter(function(x) { return x.id === (msg.provider || 'anthropic'); })[0];
    if (p && p.knownModels) aiModels = p.knownModels;
  }
  renderAiModels();
  var key = document.getElementById('cfg-ai-key');
  if (key) key.placeholder = msg.hasKey ? '******** (hinterlegt - leer lassen zum Behalten, "-" zum Loeschen)' : 'API-Key eintragen';
  var st = document.getElementById('ai-state');
  if (st) {
    if (msg.enabled && msg.hasKey) { st.textContent = 'AKTIV'; st.style.color = 'var(--green)'; }
    else if (msg.enabled) { st.textContent = 'KEIN KEY'; st.style.color = 'var(--red)'; }
    else { st.textContent = 'AUS'; st.style.color = ''; }
  }
}

function renderAiModels() {
  var sel = document.getElementById('cfg-ai-model-sel');
  if (!sel) return;
  var known = aiModels.some(function(m) { return m.id === aiCurrentModel; });
  var opts = aiModels.map(function(m) {
    return '<option value="' + esc(m.id) + '">' + esc(m.label || m.id) + '</option>';
  });
  // Ein gespeichertes Modell, das nicht in der Liste steht, darf nicht
  // stillschweigend verschwinden - sonst aendert ein Neuladen die Config.
  if (aiCurrentModel && !known) {
    opts.unshift('<option value="' + esc(aiCurrentModel) + '">' + esc(aiCurrentModel) + ' (gespeichert)</option>');
  }
  opts.push('<option value="__custom">- eigene Modell-ID ...</option>');
  sel.innerHTML = opts.join('');
  sel.value = aiCurrentModel || (aiModels[0] || {}).id || '__custom';
  toggleCustomModelRow(sel.value === '__custom');
}

function toggleCustomModelRow(on) {
  var row = document.getElementById('ai-model-custom-row');
  if (row) row.style.display = on ? '' : 'none';
}

function onAiModelChange() {
  var sel = document.getElementById('cfg-ai-model-sel');
  if (!sel) return;
  if (sel.value === '__custom') { toggleCustomModelRow(true); return; }
  toggleCustomModelRow(false);
  aiCurrentModel = sel.value;
  saveAiSettings();
}

function loadAiModels() {
  var sel = document.getElementById('cfg-ai-provider');
  log('Frage Modelle beim Anbieter ab ...', 'cyan');
  send({ event: 'gw_cmd', cmd: 'gw_list_ai_models', provider: (sel || {}).value || 'anthropic' });
}

function applyAiModels(msg) {
  aiModels = Array.isArray(msg.models) ? msg.models : [];
  renderAiModels();
  var hint = document.getElementById('ai-model-src');
  if (hint) {
    hint.textContent = msg.source === 'live'
      ? aiModels.length + ' Modelle beim Anbieter abgefragt'
      : 'Anbieterliste nicht abrufbar (' + (msg.error || '?') + ') - zeige bekannte Modelle';
    hint.style.color = msg.source === 'live' ? 'var(--green)' : 'var(--gold)';
  }
}

function onAiProviderChange() {
  // Anbieterwechsel: alte Modell-Liste ist wertlos, Default des neuen setzen.
  var sel = document.getElementById('cfg-ai-provider');
  var p = aiProviders.filter(function(x) { return x.id === (sel || {}).value; })[0];
  aiModels = (p && p.knownModels) ? p.knownModels : [];
  aiCurrentModel = p ? p.defaultModel : '';
  renderAiModels();
  saveAiSettings();
  loadAiModels();
}

function currentAiModel() {
  var sel = document.getElementById('cfg-ai-model-sel');
  if (sel && sel.value && sel.value !== '__custom') return sel.value;
  return ((document.getElementById('cfg-ai-model') || {}).value || '').trim();
}

function saveAiSettings(withKey) {
  var keyEl = document.getElementById('cfg-ai-key');
  var payload = {
    event: 'gw_cmd', cmd: 'gw_set_ai_settings',
    enabled:  (document.getElementById('cfg-ai-enabled') || {}).checked ? 1 : 0,
    provider: (document.getElementById('cfg-ai-provider') || {}).value || 'anthropic',
    model:    currentAiModel(),
  };
  if (withKey && keyEl && keyEl.value.trim()) { payload.apiKey = keyEl.value.trim(); keyEl.value = ''; }
  send(payload);
  log('KI-Einstellungen gespeichert' + (payload.apiKey ? ' (Key ersetzt)' : ''), 'cyan');
}

function rotateAiSecret() {
  var warn = 'Master-Schlüssel neu erzeugen?\n\n'
           + 'Alle hinterlegten API-Keys werden damit neu verschlüsselt. '
           + 'Das läuft in einer Transaktion — schlägt es fehl, bleibt alles wie es war.';
  if (!confirm(warn)) return;
  send({ event: 'gw_cmd', cmd: 'gw_rotate_ai_secret' });
}

function testAi() {
  log('Teste KI …', 'cyan');
  send({ event: 'gw_cmd', cmd: 'gw_test_ai' });
}

// ── Datensicherung: Export / Import ───────────────────────
let restoreMode = 'merge';

function backupExport(withHistory) {
  if (!currentTeam) { log('Kein Team gewählt', 'red'); return; }
  const url = '/giveaway/api/export?team=' + encodeURIComponent(currentTeam) + (withHistory ? '&full=1' : '');
  fetch(url)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      dlFile('giveaway_backup_' + stamp + '.json', JSON.stringify(d, null, 2), 'application/json');
      log('Backup erstellt: ' + d.participants.length + ' Teilnehmer' + (withHistory ? ' + Historie' : ''), 'cyan');
    })
    .catch(e => log('Backup fehlgeschlagen: ' + e.message, 'red'));
}

function pickRestore(mode) {
  if (!currentTeam) { log('Kein Team gewählt', 'red'); return; }
  restoreMode = mode;
  const el = document.getElementById('restore-file');
  if (el) { el.value = ''; el.click(); }
}

function backupImport(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { log('Backup nicht lesbar: ' + e.message, 'red'); return; }

    const n = Array.isArray(data.participants) ? data.participants.length : 0;
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('de-DE') : 'unbekannt';
    const warn = restoreMode === 'replace'
      ? 'ERSETZEN: Der aktuelle Stand wird komplett gelöscht und durch das Backup ersetzt.\n\n'
      : 'ADDIEREN: Viewtime und Nachrichten aus dem Backup werden auf den aktuellen Stand aufaddiert.\n\n';
    if (!confirm(warn + 'Backup vom ' + when + ' mit ' + n + ' Teilnehmern einspielen?')) {
      log('Restore abgebrochen', 'gold');
      return;
    }

    let url = '/giveaway/api/import?team=' + encodeURIComponent(currentTeam) + '&mode=' + restoreMode;
    if (restoreMode === 'replace') url += '&confirm=replace';
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(r => r.json().then(b => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!ok) throw new Error(b.error || 'unbekannt');
        log('Restore ok (' + b.mode + '): ' + b.users + ' Teilnehmer, vorher ' + b.participantsBefore, 'cyan');
        refresh();
      })
      .catch(e => log('Restore fehlgeschlagen: ' + e.message, 'red'));
  };
  reader.readAsText(file);
}

// ── Audit-Log ─────────────────────────────────────────────
let auditRows = [];

function loadAudit() {
  if (!currentTeam) return;
  fetch('/giveaway/api/audit?limit=200&team=' + encodeURIComponent(currentTeam))
    .then(function(r) { return r.json(); })
    .then(function(d) { auditRows = (d && Array.isArray(d.entries)) ? d.entries : []; renderAudit(); })
    .catch(function() {
      const el = document.getElementById('audit-list');
      if (el) el.innerHTML = '<div class="wsc-empty">Audit-Log nicht ladbar</div>';
    });
}

// Freitext für die Liste: nur die Felder, die für den Menschen zählen.
function auditSummary(e) {
  const d = e.detail || {};
  switch (e.action) {
    case 'gw_add_ticket': return `+1 Coin (${d.deltaSec}s) auf ${d.channel || '?'}`;
    case 'gw_sub_ticket': return `-1 Coin (${d.deltaSec}s) auf ${d.channel || '?'}`;
    case 'gw_ban':        return `gebannt (hatte ${parseDec(d.coinsAtBan).toFixed(2)} Coins${d.wasEligible ? ', war im Lostopf' : ''})`;
    case 'gw_unban':      return 'entbannt';
    case 'gw_set_multiplier':
      return d.factorAfter > 1 ? `Multiplier ×${d.factorAfter} für ${Math.round((d.seconds||0)/60)} min`
                               : 'Multiplier aus';
    case 'gw_set_keyword': return `Keyword "${d.keywordBefore || '–'}" → "${d.keywordAfter || '–'}"`;
    case 'gw_set_stream_settings':
      return `Follows ${d.followMinBefore}→${d.followMinAfter}, Coin-Basis ${fmtDurShort(d.coinBaseSecBefore)}→${fmtDurShort(d.coinBaseSecAfter)}`;
    case 'gw_draw_winner':
      if (d.error) return 'Ziehung fehlgeschlagen: ' + d.error;
      if (!d.winner) return 'Ziehung ohne Teilnehmer';
      return `${d.isTest ? 'TEST-' : ''}Ziehung: ${d.winner} (${parseDec(d.winnerCoins).toFixed(2)} Coins von ${d.eligibleCount} Teilnehmern)`;
    case 'gw_reset':
      return `RESET – ${d.wipedParticipants} Teilnehmer / ${d.wipedCoins} Coins gelöscht`;
    case 'gw_open':   return `geöffnet (${d.sessionOpened || '?'})`;
    case 'gw_close':  return `geschlossen (${d.sessionClosed || '?'})`;
    case 'gw_pause':  return 'pausiert';
    case 'gw_resume': return 'fortgesetzt';
    case 'auto_pause':  return 'Auto-Pause (alle Streams offline)';
    case 'auto_resume': return 'Auto-Resume (Stream online)';
    case 'auto_open':   return 'Auto-Open (Stream online)';
    case 'gw_gen_ingest_token': return d.rotated ? 'Ingest-Token rotiert' : 'Ingest-Token erstellt';
    case 'gw_verify_follows':   return 'Follow-Abgleich (Helix)';
    default: return e.action;
  }
}

function renderAudit() {
  const el = document.getElementById('audit-list');
  if (!el) return;
  const f = (document.getElementById('audit-filter') || {}).value || '';
  const q = f.toLowerCase();
  const rows = auditRows.filter(e => !q
    || (e.actor || '').toLowerCase().includes(q)
    || (e.target || '').toLowerCase().includes(q)
    || (e.action || '').toLowerCase().includes(q));
  if (!rows.length) { el.innerHTML = '<div class="wsc-empty">Keine Einträge</div>'; return; }
  el.innerHTML = rows.map(e => {
    const when = fmtDrawDate(e.ts);
    const who  = privacyOn ? 'Admin' : esc(e.actor || '?');
    const tgt  = e.target ? ' → ' + esc(privacyOn ? 'Zuschauer' : e.target) : '';
    const cls  = e.result === 'ok' ? '' : (e.result === 'denied' ? 'denied' : 'err');
    return '<div class="audit-row ' + cls + '">'
      + '<div class="audit-head"><b>' + who + '</b>' + tgt
      + '<span class="audit-ts">' + when + '</span></div>'
      + '<div class="audit-sum">' + esc(auditSummary(e)) + '</div>'
      + (e.result !== 'ok' ? '<div class="audit-flag">' + esc(e.result.toUpperCase()) + '</div>' : '')
      + '</div>';
  }).join('');
}

function exportAudit() {
  if (!auditRows.length) { log('Audit-Log leer', 'red'); return; }
  const rows = [['Zeitpunkt','Actor','IP','Aktion','Ziel','Ergebnis','Details']];
  auditRows.forEach(e => rows.push([
    e.ts, e.actor || '', e.actor_ip || '', e.action, e.target || '', e.result,
    JSON.stringify(e.detail || {}).replace(/;/g, ','),
  ]));
  dlFile('audit_log.csv', rows.map(r => r.join(';')).join('\n'), 'text/csv;charset=utf-8');
  log('Audit-Log exportiert (' + auditRows.length + ' Einträge)', 'cyan');
}

// ── Gewinner-Historie ─────────────────────────────────────
function loadHistory() {
  if (!currentTeam) return;
  fetch('/giveaway/api/draws?limit=50&team=' + encodeURIComponent(currentTeam))
    .then(function(r) { return r.json(); })
    .then(function(rows) { historyDraws = Array.isArray(rows) ? rows : []; renderHistory(); })
    .catch(function() {
      const el = document.getElementById('history-list');
      if (el) el.innerHTML = '<div class="wsc-empty">Historie nicht ladbar</div>';
    });
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  const showTests = !!document.getElementById('hist-show-tests') && document.getElementById('hist-show-tests').checked;
  const rows = historyDraws.filter(function(d) { return showTests || !d.is_test; });
  if (!rows.length) { el.innerHTML = '<div class="wsc-empty">Noch keine Ziehungen</div>'; return; }
  el.innerHTML = rows.map(function(d) {
    const when  = fmtDrawDate(d.drawn_at);
    const prize = d.prize ? '🎁 ' + esc(d.prize) : '<span style="color:var(--dim)">— kein Preis —</span>';
    const test  = d.is_test ? ' <span style="color:var(--gold);font-size:9px;">TEST</span>' : '';
    return '<div class="hist-row" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;">' +
        '<strong>' + esc(d.winner) + test + '</strong>' +
        '<span style="color:var(--dim);font-size:10px;white-space:nowrap;">' + when + '</span>' +
      '</div>' +
      '<div style="font-size:12px;">' + prize + '</div>' +
      '<div style="color:var(--dim);font-size:10px;">' +
        parseDec(d.winner_coins).toFixed(2) + ' Coins · ' + (d.eligible_count || 0) + ' Teilnehmer' +
      '</div>' +
    '</div>';
  }).join('');
}

function fmtDrawDate(iso) {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Export ────────────────────────────────────────────────
function exportCSV() {
  const active = Object.values(participants).filter(p => !p.banned);
  if (!active.length) { log('Keine Daten zum Exportieren', 'red'); return; }
  const total = active.reduce((s,p) => s + (p.coins||0), 0);
  const rows = [['Username','Coins','Watchtime (s)','Watchtime','Gewinnchance %']];
  active.sort((a,b) => b.coins - a.coins).forEach(p => {
    const chance = total > 0 ? ((p.coins / total) * 100).toFixed(2) : '0.00';
    rows.push([p.display, parseDec(p.coins).toFixed(2), p.watchSec, fmtTime(p.watchSec), chance]);
  });
  const csv = rows.map(r => r.join(';')).join('\n');
  dlFile('giveaway_export.csv', csv, 'text/csv;charset=utf-8');
  log('CSV exportiert (' + active.length + ' Teilnehmer)', 'cyan');
}

function exportChances() {
  const active = Object.values(participants).filter(p => !p.banned && p.coins > 0);
  if (!active.length) { log('Keine Teilnehmer mit Tickets', 'red'); return; }
  const total = active.reduce((s,p) => s + p.coins, 0);
  const sep = '-'.repeat(48);
  let txt = 'CHAOS CREW - GIVEAWAY GEWINNCHANCEN\n';
  txt += 'Stand: ' + new Date().toLocaleString('de-DE') + '\n';
  txt += 'Gesamt-Tickets: ' + total + '\n' + sep + '\n';
  txt += 'Platz '.padEnd(6) + 'Username'.padEnd(22) + 'Tickets'.padEnd(10) + 'Chance\n' + sep + '\n';
  active.sort((a,b) => b.coins - a.coins).forEach((p, i) => {
    const chance = ((p.coins / total) * 100).toFixed(2);
    txt += String(i+1).padEnd(6) + (p.display||'').padEnd(22) + String(p.coins).padEnd(10) + chance + '%\n';
  });
  dlFile('gewinnchancen.txt', txt, 'text/plain;charset=utf-8');
  log('Gewinnchancen exportiert (' + active.length + ' Teilnehmer)', 'gold');
}

function dlFile(name, content, mime) {
  const blob = new Blob(['\uFEFF' + content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

// ── Utils ─────────────────────────────────────────────────
function fmtTime(s) {
  if (!s) return '0:00:00';
  return `${Math.floor(s/3600)}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// Kurzform für Labels: 7200 -> "2h", 5400 -> "1.5h", 1800 -> "30m"
function fmtDurShort(s) {
  if (!s) return '0';
  if (s < 3600) return `${Math.round(s/60)}m`;
  const h = s/3600;
  return `${(Math.round(h*10)/10).toString().replace(/\.0$/,'')}h`;
}

function log(msg, type='') {
  const el = document.getElementById('log');
  const t  = new Date();
  const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
  const e  = document.createElement('div');
  e.className = `log-e ${type}`;
  e.textContent = `[${ts}] ${msg}`;
  if (el) {
    el.insertBefore(e, el.firstChild);
    while (el.children.length > 80) el.removeChild(el.lastChild);
  }
}

function clearLog() {
  const el = document.getElementById('log');
  if (el) el.innerHTML = '';
}

// ── Init ──────────────────────────────────────────────────
if (!window._sfUnitTests) {
  applyPrivacy();               // vor connectWS: Zustand steht, bevor Daten kommen
  connectWS();
  log('Admin-Panel gestartet', 'cyan');
  if (privacyOn) log('Streamermodus aktiv (gespeichert)', 'gold');
}
