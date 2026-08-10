// ════════════════════════════════════════════════════════
// RDOC GIVEAWAY – Giveaway Admin JS (microservice)
// WS: /giveaway/ws  API: /api/...
// ════════════════════════════════════════════════════════

function parseDec(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') return parseFloat(v.replace(/,/g, '.')) || 0;
  return parseFloat(v) || 0;
}

// ── State ─────────────────────────────────────────────────
let currentTeam  = null;
// Phase 2d: gewähltes Giveaway. null = Kampagne (Primary); sonst die
// Session-ID einer Zusatz-Instanz. Diese Cmds wirken auf die Auswahl:
let currentGiveaway = null;
let giveawayList    = [];
const GID_CMDS = { gw_pause:1, gw_resume:1, gw_set_multiplier:1, gw_get_multiplier:1, gw_draw_winner:1,
                   gw_set_keyword:1, gw_get_keyword:1 };
const TEAM_EVENTS = { gw_cmd:1, gw_get_all:1, gw_overlay:1, viewer_tick:1, chat_msg:1, time_cmd:1 };
let participants = {};
let gwChannels   = [];
let gwIsOpen     = false;
let gwPaused     = false;
// Spalten je Mechanik: Instanz-Cores liefern in gw_data ihre Spalten
// (CORE.display.columns); null = Standard-Layout der Kampagne.
let gwCore        = null;
let gwCoreMeta    = null;   // P5: Anzeige-Vertrag des gewählten Cores (unit, drawKind, …)
let gwSession     = null;   // Session-ID der Kampagne (auch nach dem Schließen)
let gwDisplayCols = null;
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
let lastDraw     = null;   // P6: {drawId, prizeId, giveawayId} der letzten Ziehung — Basis der Ersatzziehung
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
  // Auswahl einer Zusatz-Instanz: betroffene Cmds + Datenabruf zielen auf sie.
  if (currentGiveaway) {
    if (obj.event === 'gw_get_all') obj.giveawayId = currentGiveaway;
    if (obj.event === 'gw_cmd' && GID_CMDS[obj.cmd]) obj.giveawayId = currentGiveaway;
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
  currentGiveaway = null;
  giveawayList = [];
  participants = {};
  log('Team gewechselt: ' + currentTeam, 'cyan');
  refresh();
}

// ── Phase 2d: Giveaway-Auswahl (Kampagne / Zusatz-Instanzen) ──
function onGiveawayChange() {
  var sel = document.getElementById('gw-select');
  if (!sel) return;
  campaignDrill = sel.value === '__campaign__';
  currentGiveaway = (sel.value && !campaignDrill) ? sel.value : null;
  participants = {};
  var btn = document.getElementById('gw-close-inst');
  if (btn) btn.style.display = currentGiveaway ? '' : 'none';
  updateTicketBuyButtons();
  log(currentGiveaway ? 'Instanz gewählt: ' + currentGiveaway
                     : (campaignDrill ? 'Kampagne gewählt' : 'Übersicht'), 'cyan');
  updateMainView();
  requestData();
  loadKeyword();   // Keyword-Box zeigt das Keyword der Auswahl
}

// Übersicht statt Teilnehmertabelle: ohne gewählte Instanz zeigt die
// Hauptfläche die laufenden Giveaways als Kacheln. Klick wählt aus; die
// Kampagne selbst öffnet ihre Teilnehmerliste (campaignDrill).
var campaignDrill = false;

function updateMainView() {
  var ov  = document.getElementById('gw-overview');
  var tbl = document.getElementById('gw-table-wrap') || document.querySelector('.gw-table-wrap');
  var back = document.getElementById('ov-back');
  var srch = document.getElementById('search');
  var lbl  = document.getElementById('main-label');
  var showOverview = !currentGiveaway && !campaignDrill;
  if (ov)  ov.style.display  = showOverview ? '' : 'none';
  if (tbl) tbl.style.display = showOverview ? 'none' : '';
  if (back) back.style.display = (!currentGiveaway && campaignDrill) ? '' : 'none';
  if (srch) srch.style.display = showOverview ? 'none' : '';
  if (lbl) lbl.innerHTML = showOverview
    ? 'LAUFENDE GIVEAWAYS'
    : 'TEILNEHMER <em id="list-count">' + (Object.keys(participants).length) + '</em>';
  if (showOverview) renderOverview();
  updateTicketBuyButtons();   // setzt ov-mode/Core-Klassen + Aktionsknoepfe
}

function gwShowOverview() {
  campaignDrill = false;
  currentGiveaway = null;
  var sel = document.getElementById('gw-select'); if (sel) sel.value = '';
  updateMainView();
  requestData();
}

function gwPickGiveaway(gid) {
  var sel = document.getElementById('gw-select');
  if (sel) sel.value = gid || '__campaign__';   // leer = Kampagne (Primary)
  onGiveawayChange();
}

function ovStateOf(g) {
  if (g.closed) return { cls: 'closed', txt: 'GESCHLOSSEN · ZIEHEN' };
  if (g.paused) return { cls: 'pause',  txt: 'PAUSIERT' };
  return { cls: 'run', txt: 'LÄUFT' };
}

function renderOverview() {
  var host = document.getElementById('gw-overview');
  if (!host) return;
  var list = giveawayList.slice();
  if (!list.length) {
    host.innerHTML = '<div class="ov-empty">Kein Giveaway aktiv. Mit ＋ oben startest du eins '
      + '(Kampagne, Sofortverlosung, Los-Giveaway oder Screenshot-Contest).</div>';
    return;
  }
  host.innerHTML = list.map(function(g) {
    var st = ovStateOf(g);
    var icon = g.coreIcon || (g.primary ? '📈' : '🎁');
    var title = g.primary ? 'Kampagne'
              : (g.name || (g.keyword ? '„' + g.keyword + '"' : (g.coreLabel || 'Giveaway')));
    var sub = [];
    if (!g.primary && g.coreLabel) sub.push(g.coreLabel);
    if (g.keyword && !g.primary && g.name) sub.push('„' + g.keyword + '"');
    if (g.primary && g.keyword) sub.push('Keyword „' + g.keyword + '"');
    if (Array.isArray(g.channels) && g.channels.length) sub.push(g.channels.join(', '));
    var start = fmtGwStart(g.startedAt);
    if (start) sub.push('seit ' + start);
    return '<div class="ov-card" onclick="gwPickGiveaway(\'' + esc(g.primary ? '' : g.gid) + '\')">'
      + '<div class="ov-top"><span class="ov-ic">' + esc(icon) + '</span>' + esc(title) + '</div>'
      + '<div class="ov-num">' + (g.participants !== undefined && g.participants !== null ? g.participants : '–')
      + ' <span class="ov-sub">Teilnehmer</span></div>'
      + (g.prize ? '<div class="ov-sub">🎁 ' + esc(g.prize)
                   + (g.sponsor ? ' · ' + esc(g.sponsor) : '') + '</div>' : '')
      + (sub.length ? '<div class="ov-sub">' + esc(sub.join(' · ')) + '</div>' : '')
      + '<div class="ov-state ' + st.cls + '">' + st.txt + '</div>'
      + '</div>';
  }).join('');
}

// Typ-spezifische Buttons nur bei passender Instanz-Auswahl zeigen —
// und das Layout dem Core anpassen (CSS-Matrix im <style> der Seite):
// nur die Felder sichtbar, die für DIESES Giveaway gelten.
// P5: Label/Icon/CSS kommen aus dem Core-Vertrag über gw_list_giveaways
// (g.coreLabel/coreIcon/coreCss); die Tabellen hier sind nur noch Fallback
// für Antworten alter Serverstände.
var CORE_CSS = { CORE_CurrentViewers: 'core-instant', CORE_TicketBuy: 'core-ticketbuy',
                 CORE_ScreenshotContest: 'core-contest', CORE_WatchtimeChatActivity: 'core-watchtime' };
function selectedCore() {
  var g = giveawayList.find(function(x){ return x.gid === currentGiveaway; });
  return g ? g.core : null;   // null = Kampagne
}
function selectedGiveaway() {
  return giveawayList.find(function(x){ return x.gid === currentGiveaway; }) || null;
}
// P5: Rail-Karten-Loader je panelCard aus dem Core-Vertrag — neuer Core
// deklariert display.panelCard und (falls die Karte Daten lädt) einen
// Eintrag hier; updateTicketBuyButtons verzweigt nicht mehr auf Core-IDs.
var PANEL_CARD_LOADERS = {
  ticketbuy: function(){ tbLoadPrizes(); },
  contest:   function(){ scLoadEntries(); },
  instant:   null,   // card-instant lebt allein von gw_data/Fenster-Acks
};
var PANEL_CARD_FALLBACK = { CORE_TicketBuy: 'ticketbuy', CORE_ScreenshotContest: 'contest',
                            CORE_CurrentViewers: 'instant' };
function updateTicketBuyButtons() {
  var core = selectedCore();
  var g = selectedGiveaway();
  var app = document.querySelector('.gw-app');
  if (app) {
    // ov-mode = Uebersicht (kein Giveaway gewaehlt): Rail und Aktionsleiste
    // bleiben leer, es gibt nichts zu steuern.
    app.className = 'gw-app' + (currentGiveaway
      ? ' core-inst ' + ((g && g.coreCss) || CORE_CSS[core] || '') : '')
      + ((!currentGiveaway && !campaignDrill) ? ' ov-mode' : '');
  }
  // Typ-Karte in der Rail mit Daten füllen (panelCard aus dem Core-Vertrag)
  var card = g && g.corePanelCard !== undefined ? g.corePanelCard : PANEL_CARD_FALLBACK[core];
  if (card && PANEL_CARD_LOADERS[card]) PANEL_CARD_LOADERS[card]();
  updateActionButtons();
}

// Klartext-Bezeichnung einer Instanz für Bestätigungen/Logs — die rohe
// sess_-ID hat schon zu versehentlichem Schließen der falschen Instanz
// geführt (Audit 6.8., zwei close_instance in 18 s).
var CORE_LABEL = { CORE_CurrentViewers: 'Sofortverlosung', CORE_TicketBuy: 'Los-Giveaway',
                   CORE_ScreenshotContest: 'Screenshot-Contest' };
function instanceLabel(gid) {
  var g = giveawayList.find(function(x){ return x.gid === gid; });
  if (!g) return gid;
  return (g.coreLabel || CORE_LABEL[g.core] || 'Zusatz-Giveaway')
    + (g.name ? ' „' + g.name + '"' : '')
    + ' (' + String(gid).replace(/^sess_/, '#') + ')';
}

// SCHLIESSEN wirkt auf die Auswahl: Kampagne oder gewählte Zusatz-Instanz.
// Ingest-Puls: ohne viewer_tick meldet Streamerbot keine Zuschauer, damit
// ist bei der Sofortverlosung NIEMAND anwesend und die Ziehung liefe leer.
// Genau das ist am 9.8.26 live passiert — darum steht die Warnung oben,
// nicht im Event-Log.
function renderIngestWarn(pulse) {
  var el = document.getElementById('ingest-warn');
  if (!el) return;
  if (!Array.isArray(pulse) || !pulse.length) { el.style.display = 'none'; return; }
  var dead = pulse.filter(function(p){ return p.stale; });
  if (!dead.length) { el.style.display = 'none'; return; }
  var names = dead.map(function(p){
    return esc(p.channel || '?') + (p.lastTickAgo === null ? ' (noch nie)' : ' (' + fmtDurShort(p.lastTickAgo) + ' still)');
  }).join(', ');
  el.innerHTML = '⚠ Keine Zuschauer-Meldungen von: ' + names
    + ' — Streamerbot-Aktion <b>GW_ViewerTick</b> prüfen. Ohne diese Meldungen ist niemand „anwesend": '
    + 'die Sofortverlosung zieht ins Leere, Zuschauzeit zählt nicht.';
  el.style.display = '';
}

function gwCloseSmart() {
  if (!currentGiveaway) { gwClose(); return; }
  // Zwei Schritte: SCHLIESSEN beendet nur Sammeln/Anmelden — der Topf bleibt,
  // damit danach gezogen werden kann. AUFRÄUMEN wirft ihn weg.
  var g = selectedGiveaway();
  if (g && g.closed) {
    var reg = Object.keys(participants).filter(function(k){ return participants[k].registered; }).length;
    var warn = (reg && !lastWinner)
      ? '\n\nACHTUNG: ' + reg + ' Teilnehmer im Topf und noch kein Gewinner gezogen.'
        + ' Nach dem Aufräumen ist der Topf weg (der Nachweis bleibt im Archiv).'
      : '';
    if (!confirm(instanceLabel(currentGiveaway) + ' aufräumen und aus der Liste entfernen?' + warn)) return;
  } else if (!confirm(instanceLabel(currentGiveaway)
      + ' schließen? Sammeln/Anmelden endet, der Topf bleibt — danach ziehen (★).')) {
    return;
  }
  send({ event: 'gw_cmd', cmd: 'gw_close_instance', giveawayId: currentGiveaway });
}

// ── Zuschauer-Seite: Link kopieren / im Chat ansagen ─────
function copyViewerLink(kind, btn) {
  var url = window.location.origin + '/viewer/' + kind;
  var done = function() {
    log('Link kopiert: ' + url, 'cyan');
    if (btn) { var t = btn.textContent; btn.textContent = '✓ KOPIERT'; setTimeout(function(){ btn.textContent = t; }, 1200); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
  else done();
}

function gwAnnouncePage() {
  if (!currentGiveaway) { log('Keine Instanz gewählt', 'red'); return; }
  send({ event: 'gw_cmd', cmd: 'gw_announce_page', giveawayId: currentGiveaway });
}

// ── Los-Giveaway-Karte (rechte Rail) ─────────────────────
function tbSetWagerCmd() {
  var cmd = (document.getElementById('tb-wagercmd').value.trim() || '!setzen').toLowerCase();
  send({ event: 'gw_cmd', cmd: 'gw_set_wager_cmd', giveawayId: currentGiveaway, command: cmd });
}

// Formular dient Anlegen UND Korrigieren (kein prompt() — Panel-Konvention).
var tbEditPrizeId = null;
var tbPrizes = [];

function tbAddPrize() {
  var title = document.getElementById('tb-prize-title').value.trim();
  if (!title) { log('Preis braucht einen Titel', 'red'); return; }
  var mins = CC.validate.sanitizeInt(document.getElementById('tb-prize-end').value, 0, 20160, 0);
  var sponsor = (document.getElementById('tb-prize-sponsor') || {}).value || '';
  var desc = (document.getElementById('tb-prize-desc') || {}).value || '';
  if (tbEditPrizeId) {
    send({ event: 'gw_cmd', cmd: 'gw_edit_prize', giveawayId: currentGiveaway, prizeId: tbEditPrizeId,
           title: title, sponsor: sponsor, description: desc, wagerEndMinutes: mins });
  } else {
    send({ event: 'gw_cmd', cmd: 'gw_add_prize', giveawayId: currentGiveaway, title: title, wagerEndMinutes: mins,
           sponsor: sponsor, description: desc });
  }
  tbCancelEdit({ keepImage: true });   // Bild wartet auf das Ack (prizeId)
}

// ── Preis-Bild: Datei wartet im Formular, Upload erst nach dem Ack
// (erst dann gibt es die prizeId). Entfernen = leerer Upload.
var tbPendingImage = null;
var tbRemoveImage  = false;

function tbImageChanged() {
  var f = (document.getElementById('tb-prize-image') || {}).files;
  tbPendingImage = (f && f.length) ? f[0] : null;
  if (tbPendingImage) tbRemoveImage = false;
}

function tbMarkRemoveImage() {
  tbRemoveImage = true; tbPendingImage = null;
  var fi = document.getElementById('tb-prize-image'); if (fi) fi.value = '';
  var rm = document.getElementById('tb-prize-image-remove'); if (rm) rm.style.display = 'none';
  log('Bild wird beim Speichern entfernt', 'gold');
}

function tbHandleImageAfterSave(prizeId) {
  if (!prizeId || !currentTeam) return;
  if (tbRemoveImage) {
    tbRemoveImage = false;
    fetch('/giveaway/api/prize/image', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, prizeId: prizeId, imageBase64: '' }) })
      .then(function(r) {
        if (r.ok) { log('Preis-Bild entfernt', 'gold'); tbLoadPrizes(); }
        else log('Bild entfernen fehlgeschlagen', 'red');
      })
      .catch(function(e) { log('Bild entfernen fehlgeschlagen: ' + e.message, 'red'); });
    return;
  }
  if (!tbPendingImage) return;
  var file = tbPendingImage;
  tbPendingImage = null;
  var fi = document.getElementById('tb-prize-image'); if (fi) fi.value = '';
  if (file.size > 7 * 1024 * 1024) { log('Bild zu groß (max 7 MB)', 'red'); return; }
  var rd = new FileReader();
  rd.onload = function() {
    var b64 = String(rd.result).split(',')[1] || '';
    fetch('/giveaway/api/prize/image', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, prizeId: prizeId, mime: file.type, imageBase64: b64 }) })
      .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
      .then(function(x) {
        if (x.ok) { log('Preis-Bild gespeichert', 'gold'); tbLoadPrizes(); }
        else log('Bild-Upload fehlgeschlagen: ' + (x.j.error || '?'), 'red');
      })
      .catch(function(e) { log('Bild-Upload fehlgeschlagen: ' + e.message, 'red'); });
  };
  rd.readAsDataURL(file);
}

function tbEditPrize(prizeId) {
  var p = tbPrizes.find(function(x){ return x.id === prizeId; });
  if (!p) return;
  tbEditPrizeId = prizeId;
  document.getElementById('tb-prize-title').value = p.title || '';
  var sp = document.getElementById('tb-prize-sponsor'); if (sp) sp.value = p.sponsor || '';
  var de = document.getElementById('tb-prize-desc'); if (de) de.value = p.description || '';
  var rm = document.getElementById('tb-prize-image-remove'); if (rm) rm.style.display = p.has_image ? '' : 'none';
  // Einsatz-Ende: Restminuten vorbelegen (0 = offen lassen / entfernen).
  var endEl = document.getElementById('tb-prize-end');
  if (endEl) endEl.value = p.wager_end
    ? Math.max(0, Math.round((new Date(p.wager_end).getTime() - Date.now()) / 60000)) : 0;
  document.getElementById('tb-prize-form-title').textContent = 'PREIS #' + prizeId + ' KORRIGIEREN';
  document.getElementById('tb-prize-save').textContent = 'SPEICHERN';
  document.getElementById('tb-prize-cancel-edit').style.display = '';
  tbUpdatePrizeForm();          // Korrektur darf tippen, auch bei offenem Preis
  document.getElementById('tb-prize-title').focus();
}

function tbCancelEdit(opts) {
  tbEditPrizeId = null;
  document.getElementById('tb-prize-title').value = '';
  var sp = document.getElementById('tb-prize-sponsor'); if (sp) sp.value = '';
  var de = document.getElementById('tb-prize-desc'); if (de) de.value = '';
  var rm = document.getElementById('tb-prize-image-remove'); if (rm) rm.style.display = 'none';
  if (!(opts && opts.keepImage)) {
    tbPendingImage = null; tbRemoveImage = false;
    var fi = document.getElementById('tb-prize-image'); if (fi) fi.value = '';
  }
  var endEl = document.getElementById('tb-prize-end'); if (endEl) endEl.value = 0;
  document.getElementById('tb-prize-form-title').textContent = 'NEUER PREIS';
  document.getElementById('tb-prize-save').textContent = 'ANLEGEN';
  document.getElementById('tb-prize-cancel-edit').style.display = 'none';
  tbUpdatePrizeForm();
}

function tbCancelPrize(prizeId) {
  if (!confirm('Preis #' + prizeId + ' stornieren? Alle gesetzten Lose werden den Teilnehmern zurückgebucht.')) return;
  send({ event: 'gw_cmd', cmd: 'gw_cancel_prize', giveawayId: currentGiveaway, prizeId: prizeId });
}

function tbLoadPrizes() { send({ event: 'gw_cmd', cmd: 'gw_list_prizes', giveawayId: currentGiveaway }); }

// Ein Los-Giveaway verlost genau EINEN Preis. Solange einer offen ist,
// ist das Formular zu — fuer einen weiteren Preis startet man ein zweites
// Los-Giveaway (der Server lehnt den zweiten Preis ohnehin ab).
function tbUpdatePrizeForm() {
  var openCount = tbPrizes.filter(function(p){ return p.status === 'open'; }).length;
  var blocked = openCount > 0 && !tbEditPrizeId;
  var save = document.getElementById('tb-prize-save');
  if (save) {
    save.disabled = blocked;
    save.title = blocked ? 'Dieses Los-Giveaway hat schon einen Preis — fuer einen weiteren ein zweites Los-Giveaway starten (＋ oben).' : '';
  }
  ['tb-prize-title','tb-prize-sponsor','tb-prize-desc','tb-prize-end','tb-prize-image'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.disabled = blocked;
  });
  var t = document.getElementById('tb-prize-form-title');
  if (t && !tbEditPrizeId) t.textContent = blocked ? 'PREIS VERGEBEN — WEITERER PREIS = WEITERES LOS-GIVEAWAY' : 'NEUER PREIS';
}

var TB_STATUS_LABEL = { drawn: 'gezogen', cancelled: 'storniert' };
function renderPrizes(prizes) {
  tbPrizes = prizes || [];
  var host = document.getElementById('tb-prizes');
  if (!host) return;
  tbUpdatePrizeForm();
  if (!prizes || !prizes.length) { host.innerHTML = '<div class="wsc-empty">Noch kein Preis eingetragen.</div>'; return; }
  host.innerHTML = prizes.map(function(p) {
    return '<div class="tb-prize"><span class="t" title="' + esc(p.sponsor ? 'bereitgestellt von ' + p.sponsor : '') + '">#'
      + p.id + ' ' + esc(p.title)
      + (p.has_image && p.image_token ? ' <span title="Bild vorhanden" style="cursor:pointer" onclick="window.open(\'/giveaway/api/prize/image/' + esc(p.image_token) + '\')">🖼</span>' : '')
      + (p.sponsor ? ' <span style="opacity:.55">· ' + esc(p.sponsor) + '</span>' : '') + '</span>'
      + '<span class="s">' + Number(p.total_stake).toFixed(0) + ' 🎟</span>'
      + (p.status === 'open'
          ? '<button class="btn btn-cyan btn-sm btn-mini" onclick="tbEditPrize(' + p.id + ')" title="Titel/Sponsor/Einsatz-Ende korrigieren">✎</button>'
            + '<button class="btn btn-red btn-sm btn-mini" onclick="tbCancelPrize(' + p.id + ')" title="Stornieren — Einsätze werden zurückgebucht">✖</button>'
            + '<button class="btn btn-solid btn-sm" onclick="tbDrawPrize(' + p.id + ')">★ ZIEHEN</button>'
          : '<span class="cfg-hint">' + (TB_STATUS_LABEL[p.status] || esc(p.status)) + '</span>')
      + '</div>';
  }).join('');
}

function tbDrawPrize(prizeId) {
  if (!confirm('Preis #' + prizeId + ' jetzt ziehen? Danach sind alle Einsätze dieses Preises gebunden.')) return;
  send({ event: 'gw_cmd', cmd: 'gw_draw_winner', giveawayId: currentGiveaway, prizeId: prizeId, prize: '' });
}

// ── Contest-Karte (rechte Rail) ──────────────────────────
function scVoting(action) {
  send({ event: 'gw_cmd', cmd: 'gw_contest_voting', giveawayId: currentGiveaway, action: action });
}

function scLoadEntries() { send({ event: 'gw_cmd', cmd: 'gw_list_entries', giveawayId: currentGiveaway }); }

// Direkteinstieg in die Bildadministration: Contest-Instanz auswählen,
// Einsendungen laden, zur Contest-Karte scrollen.
function gotoContestReview() {
  var g = giveawayList.find(function(x){ return !x.primary && x.core === 'CORE_ScreenshotContest'; });
  if (!g) { log('Kein laufender Screenshot-Contest', 'red'); return; }
  var sel = document.getElementById('gw-select');
  if (sel && sel.value !== g.gid) { sel.value = g.gid; onGiveawayChange(); }
  else if (currentGiveaway !== g.gid) { currentGiveaway = g.gid; requestData(); }
  scLoadEntries();
  var card = document.getElementById('card-contest');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scReview(entryId, decision) {
  send({ event: 'gw_cmd', cmd: 'gw_review_entry', entryId: entryId, decision: decision });
}

// Endgültig löschen (Owner): für Schrott/rechtswidrige Inhalte — Reject
// sperrt nur die Anzeige, das Bild bliebe gespeichert.
var scEntries = [];
function scDeleteEntry(entryId) {
  var en = scEntries.find(function(x){ return x.entryId === entryId; }) || {};
  // Streamermodus: auch im confirm() nur das Pseudonym zeigen.
  var shown = en.username ? maskName((en.username || '').toLowerCase(), en.username) : '';
  if (!confirm('Einsendung #' + entryId + (shown ? ' von „' + shown + '"' : '')
      + ' ENDGÜLTIG löschen?\n\nDas Bild wird gelöscht, abgegebene Stimmen verfallen. '
      + 'Für unpassende, aber harmlose Bilder reicht Ablehnen (✗).')) return;
  send({ event: 'gw_cmd', cmd: 'gw_delete_entry', entryId: entryId });
}

var SC_VOTING_LABEL = { open: 'OFFEN', paused: 'PAUSIERT', closed: 'GESCHLOSSEN' };
var SC_STATUS_TEXT = { pending: 'WARTET AUF FREIGABE', approved: 'FREIGEGEBEN', rejected: 'ABGELEHNT' };
function renderEntries(msg) {
  var badge = document.getElementById('sc-voting-state');
  if (badge) badge.textContent = SC_VOTING_LABEL[msg.voting] || msg.voting || '?';
  var host = document.getElementById('sc-entries');
  if (!host) return;
  var entries = msg.entries || [];
  scEntries = entries;
  if (!entries.length) { host.innerHTML = '<div class="wsc-empty">Noch keine Einsendungen.</div>'; return; }
  host.innerHTML = entries.map(function(en) {
    var name = maskName(en.username, en.username);
    var img = '/giveaway/api/contest/image/' + esc(en.imageToken || '');
    return '<div class="sc-entry">'
      + '<img class="sc-thumb" src="' + img + '" alt="" loading="lazy" title="Bild in voller Größe ansehen" '
      + 'onclick="window.open(this.src)">'
      + '<div class="sc-info">'
      + '<span class="t st-' + esc(en.status) + '">#' + en.entryId + ' ' + esc(en.title || '—') + '</span>'
      + '<span class="sc-by">von <b>' + esc(name) + '</b> · ' + (SC_STATUS_TEXT[en.status] || esc(en.status))
      + ' · ' + en.score + ' Pkt / ' + en.votes + ' Stimmen</span>'
      + '</div>'
      + (en.status === 'pending'
          ? '<button class="btn btn-green btn-sm" onclick="scReview(' + en.entryId + ',\'approve\')" title="Freigeben">✓</button>'
            + '<button class="btn btn-red btn-sm" onclick="scReview(' + en.entryId + ',\'reject\')" title="Ablehnen (Bild bleibt gesperrt gespeichert)">✗</button>'
          : en.status === 'approved'
          ? '<button class="btn btn-red btn-sm" onclick="scReview(' + en.entryId + ',\'reject\')" title="Freigabe zurückziehen (Bild wieder sperren)">✗</button>'
          : '<button class="btn btn-green btn-sm" onclick="scReview(' + en.entryId + ',\'approve\')" title="Doch freigeben">✓</button>')
      + '<button class="btn btn-red btn-sm btn-mini" onclick="scDeleteEntry(' + en.entryId + ')" title="ENDGÜLTIG löschen (Bild weg, Stimmen verfallen)">🗑</button>'
      + '</div>';
  }).join('');
}


// Startzeit kompakt: heute nur Uhrzeit, sonst Tag.Monat + Uhrzeit.
function fmtGwStart(ts) {
  var d = new Date(ts);
  if (!ts || isNaN(d.getTime())) return '';
  var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === new Date().toDateString() ? hm
       : d.getDate() + '.' + (d.getMonth() + 1) + '. ' + hm;
}

function renderGiveawaySelect() {
  var sel = document.getElementById('gw-select');
  if (!sel) return;
  // Leere Auswahl = Übersicht (Kacheln, leere Rail). Eine laufende Kampagne
  // ist ein eigener Eintrag — nur dann gibt es auch Kampagnen-Bedienung.
  var opts = ['<option value="">— ÜBERSICHT —</option>'];
  var prim = giveawayList.find(function(x){ return x.primary; });
  if (prim) {
    var pmeta = [];
    if (prim.participants !== undefined && prim.participants !== null) pmeta.push(prim.participants + ' TN');
    if (prim.keyword) pmeta.push('„' + prim.keyword + '"');
    opts.push('<option value="__campaign__">📈 Kampagne'
      + (pmeta.length ? ' (' + esc(pmeta.join(' · ')) + ')' : '')
      + (prim.paused ? ' ⏸' : '') + '</option>');
  }
  var CORE_ICON = { CORE_CurrentViewers: '⚡ ', CORE_TicketBuy: '🎟 ', CORE_ScreenshotContest: '📸 ' };
  giveawayList.forEach(function(g) {
    if (g.primary) return;   // Kampagne ist die leere Auswahl
    var meta = [];
    if (g.participants !== undefined && g.participants !== null) meta.push(g.participants + ' TN');
    var start = fmtGwStart(g.startedAt);
    if (start) meta.push('seit ' + start);
    var label = (g.coreIcon ? g.coreIcon + ' ' : (CORE_ICON[g.core] || ''))
              + (g.name ? g.name + ' ' : (g.keyword ? '„' + g.keyword + '" ' : ''))
              + g.gid.replace(/^sess_/, '#')
              + (meta.length ? ' (' + meta.join(' · ') + ')' : '')
              + (g.closed ? ' — GESCHLOSSEN, ziehen!' : (g.paused ? ' ⏸' : ''));
    opts.push('<option value="' + esc(g.gid) + '">' + esc(label) + '</option>');
  });
  sel.innerHTML = opts.join('');
  // Bild-Review-Button nur zeigen, wenn ein Screenshot-Contest läuft —
  // Direkteinstieg in die Moderation, ohne erst das Dropdown zu suchen.
  var rvBtn = document.getElementById('btn-contest-review');
  if (rvBtn) rvBtn.style.display =
    giveawayList.some(function(g){ return !g.primary && g.core === 'CORE_ScreenshotContest'; }) ? '' : 'none';
  // Auswahl halten; aufgeraeumte Instanz → zurueck in die Übersicht.
  if (currentGiveaway && !giveawayList.some(function(g){ return g.gid === currentGiveaway && !g.primary; })) {
    currentGiveaway = null;
    campaignDrill = false;
    var btn = document.getElementById('gw-close-inst');
    if (btn) btn.style.display = 'none';
    requestData();
  }
  // Kampagne geschlossen/zurueckgesetzt → der Eintrag ist weg, ab in die Übersicht.
  if (campaignDrill && !prim) campaignDrill = false;
  sel.value = currentGiveaway || (campaignDrill ? '__campaign__' : '');
  updateTicketBuyButtons();
}

// ── Instanz-Assistent (Modal statt prompt()-Kette) ────────
// Typ-Karte wählen → nur die Felder dieses Cores → starten.
var iwType = null;
var IW_TYPES = {
  campaign:  { core: null,                      fields: { keyword: true } },
  instant:   { core: 'CORE_CurrentViewers',     fields: { keyword: true, window: true, minwatch: true } },
  ticketbuy: { core: 'CORE_TicketBuy',          fields: { wagercmd: true } },
  contest:   { core: 'CORE_ScreenshotContest',  fields: { minwatch: true } },
};

function openInstance() {
  iwType = null;
  iwDraftId = null;
  document.querySelectorAll('.iw-card').forEach(function(c){ c.classList.remove('sel'); });
  document.getElementById('iw-fields').style.display = 'none';
  document.getElementById('iw-err').textContent = '';
  // Kanal-Chips aus den Team-Kanälen (leer lassen = alle)
  var chips = document.getElementById('iw-channels');
  chips.innerHTML = (gwChannels || []).map(function(ch){
    return '<label class="iw-chip"><input type="checkbox" value="' + esc(ch) + '">' + esc(ch) + '</label>';
  }).join('') || '<span class="hint">Kanäle laden … (Team-Kanäle erscheinen nach dem ersten Datenabruf)</span>';
  // Kanalauswahl ändert die Teilnehmer-Vorschau → neu rechnen.
  Array.prototype.forEach.call(chips.querySelectorAll('input'), function(cb){ cb.onchange = iwPreflight; });
  var pf = document.getElementById('iw-preflight'); if (pf) pf.textContent = '';
  iwSetPrizeRows([]);   // frisches Modal = keine Preis-Zeilen aus der letzten Sitzung
  document.getElementById('iw-overlay').style.display = 'flex';
}

function iwClose() {
  document.getElementById('iw-overlay').style.display = 'none';
}

function iwSelect(type) {
  iwType = type;
  document.querySelectorAll('.iw-card').forEach(function(c){
    c.classList.toggle('sel', c.getAttribute('data-type') === type);
  });
  var f = IW_TYPES[type].fields;
  var showPrize = type !== 'ticketbuy';   // Los-Giveaway: Gewinne = einzelne Preise
  document.getElementById('iw-f-prize').style.display   = showPrize ? '' : 'none';
  document.getElementById('iw-f-sponsor').style.display = showPrize ? '' : 'none';
  document.getElementById('iw-f-name').style.display    = type !== 'campaign' ? '' : 'none';
  document.getElementById('iw-f-keyword').style.display  = f.keyword  ? '' : 'none';
  document.getElementById('iw-f-window').style.display   = f.window   ? '' : 'none';
  document.getElementById('iw-f-announce').style.display = f.window   ? '' : 'none';   // nur Sofortverlosung
  document.getElementById('iw-f-wagercmd').style.display = f.wagercmd ? '' : 'none';
  document.getElementById('iw-f-minwatch').style.display = f.minwatch ? '' : 'none';
  var mwh = document.getElementById('iw-minwatch-hint');
  if (mwh) mwh.textContent = type === 'instant'
    ? 'Schwelle zum Mitmachen, zusätzlich zu Keyword und Follow. Gezählt wird die Zuschauzeit aus der Kampagne dieses Teams — läuft keine Kampagne, hier 0 eintragen.'
    : 'Für Einsenden und Bewerten. 0 = aus — hält Vote-Bots draußen.';
  var fp = document.getElementById('iw-f-prizes');
  if (fp) fp.style.display = type === 'ticketbuy' ? '' : 'none';   // P6: Preise im Entwurf
  // Los-Giveaway frisch gewählt: eine leere Preis-Zeile als Einstieg.
  if (type === 'ticketbuy' && !document.querySelector('#iw-prize-list .iw-prize-row')) iwAddPrizeRow();
  if (f.keyword) {
    document.getElementById('iw-keyword-label').textContent = type === 'instant' ? 'Keyword (Pflicht)' : 'Keyword (optional)';
    document.getElementById('iw-keyword-hint').textContent = type === 'instant'
      ? 'Wer es im Zeitfenster schreibt und zuschaut, ist im Topf.'
      : 'Zuschauer melden sich damit im Chat an. Leer = ohne Chat-Anmeldung.';
  }
  document.getElementById('iw-err').textContent = '';
  document.getElementById('iw-fields').style.display = '';
  var first = f.keyword ? 'iw-keyword' : f.wagercmd ? 'iw-wagercmd' : 'iw-minwatch';
  var el = document.getElementById(first); if (el) el.focus();
  iwPreflight();   // P6: Teilnehmer-Vorschau für den gewählten Typ
}

// P6: Teilnehmer-Vorschau — Server zählt, wer die Bedingungen der gewählten
// Mechanik JETZT erfüllen würde (Antwort: gw_ack type=preflight).
function iwPreflight() {
  if (!iwType) return;
  var el = document.getElementById('iw-preflight');
  if (el) el.textContent = 'Prüfe Teilnehmer-Vorschau …';
  var t = IW_TYPES[iwType];
  var picked = Array.prototype.slice.call(document.querySelectorAll('#iw-channels input:checked')).map(function(c){ return c.value; });
  var msg = { event: 'gw_cmd', cmd: 'gw_preflight',
              core: t.core || 'CORE_WatchtimeChatActivity' };
  if (picked.length) msg.channels = picked;
  if (t.fields.minwatch) msg.minWatchSec = CC.validate.sanitizeInt(document.getElementById('iw-minwatch').value, 0, 6000, 10) * 60;
  send(msg);
}
function renderPreflight(msg) {
  var el = document.getElementById('iw-preflight');
  if (!el || document.getElementById('iw-overlay').style.display === 'none') return;
  var n = msg.count || 0;
  var txt = { present:  n + ' Zuschauer erfüllen Follow + Mindest-Zuschauzeit und könnten sich per Keyword anmelden.',
              credit:   n + ' Zuschauer haben Los-Guthaben (> 0) und könnten sofort setzen.',
              contest:  n + ' Zuschauer erfüllen Follow + Mindest-Zuschauzeit fürs Einsenden schon jetzt.',
              campaign: n + ' Zuschauer erfüllen Follows (≥' + (msg.followMin != null ? msg.followMin : '?')
                          + ') + Mindest-Viewtime schon jetzt (Anmeldung per Keyword kommt noch dazu).' };
  el.innerHTML = '👥 ' + esc(txt[msg.basis] || (n + ' Zuschauer würden die Bedingungen erfüllen.'))
    + ' <a href="#" onclick="iwPreflight();return false;" style="color:inherit">neu prüfen</a>';
}

// ── P6: Preis-Zeilen im Modal (Titel / Sponsor / Einsatz-Ende) ──
function iwAddPrizeRow(vals) {
  var host = document.getElementById('iw-prize-list');
  if (!host || host.children.length >= 20) return;
  var row = document.createElement('div');
  row.className = 'iw-prize-row';
  row.innerHTML =
      '<input type="text" class="pr-title" maxlength="100" placeholder="Was wird verlost? (z.B. Game-Key)">'
    + '<input type="text" class="pr-sponsor" maxlength="100" placeholder="Sponsor (optional)">'
    + '<input type="number" class="pr-min" min="0" max="10080" placeholder="Min." title="Einsatz-Ende in Minuten ab Start — leer/0 = offen bis zur Ziehung">'
    + '<button type="button" class="btn btn-red btn-sm" title="Preis entfernen">✖</button>';
  row.querySelector('button').onclick = function(){ row.remove(); };
  if (vals) {
    row.querySelector('.pr-title').value   = vals.title || '';
    row.querySelector('.pr-sponsor').value = vals.sponsor || '';
    if (vals.wagerEndMinutes) row.querySelector('.pr-min').value = vals.wagerEndMinutes;
  }
  host.appendChild(row);
  if (!vals) row.querySelector('.pr-title').focus();
}
// Ein Giveaway = ein Preis: genau eine Zeile, immer vorhanden.
function iwSetPrizeRows(prizes) {
  var host = document.getElementById('iw-prize-list');
  if (!host) return;
  host.innerHTML = '';
  iwAddPrizeRow((prizes || [])[0] || null);
}
function iwCollectPrizeRows() {
  var out = [];
  Array.prototype.forEach.call(document.querySelectorAll('#iw-prize-list .iw-prize-row'), function(row){
    var title = row.querySelector('.pr-title').value.trim().slice(0, 100);
    if (!title) return;
    out.push({ title: title,
               sponsor: row.querySelector('.pr-sponsor').value.trim().slice(0, 100),
               wagerEndMinutes: Math.max(0, parseInt(row.querySelector('.pr-min').value, 10) || 0) });
  });
  return out.slice(0, 1);   // ein Giveaway verlost genau einen Preis
}

// Formularstand einsammeln + validieren — gemeinsame Basis für „starten"
// und „als Entwurf speichern". null = Validierung fehlgeschlagen (Meldung
// steht dann in #iw-err).
function iwCollect() {
  if (!iwType) return null;
  var t = IW_TYPES[iwType];
  var err = document.getElementById('iw-err');
  var payload = { keyword: '' };
  if (t.core) payload.core = t.core;

  // Gewinn ist Pflicht — ausser beim Los-Giveaway (Preise = Gewinne).
  if (iwType !== 'ticketbuy') {
    payload.prize = document.getElementById('iw-prize').value.trim();
    payload.sponsor = document.getElementById('iw-sponsor').value.trim();
    if (!payload.prize) {
      err.textContent = 'Bitte eintragen, was verlost wird (Gewinn).';
      document.getElementById('iw-prize').focus();
      return null;
    }
  }

  if (t.fields.keyword) {
    payload.keyword = CC.validate.sanitize(document.getElementById('iw-keyword').value, 'keyword').trim();
    if (iwType === 'instant' && !payload.keyword) {
      err.textContent = 'Die Sofortverlosung braucht ein Keyword — ohne Anmeldung kein Teilnehmer.';
      document.getElementById('iw-keyword').focus();
      return null;
    }
  }
  if (t.fields.window) {
    payload.windowSec = Math.round(CC.validate.sanitizeFloat(document.getElementById('iw-window').value, 0, 60, 1) * 60);
    payload.announce  = !!document.getElementById('iw-announce').checked;
  }
  if (t.fields.wagercmd) payload.wagerCmd  = (document.getElementById('iw-wagercmd').value.trim() || '!setzen').toLowerCase();
  if (t.fields.minwatch) payload.minWatchSec = CC.validate.sanitizeInt(document.getElementById('iw-minwatch').value, 0, 6000, 10) * 60;
  // P6: Preise (nur Los-Giveaway) aus den Eingabezeilen des Modals.
  if (iwType === 'ticketbuy') {
    var prizes = iwCollectPrizeRows();
    if (prizes.length) payload.prizes = prizes;
  }

  var picked = Array.prototype.slice.call(document.querySelectorAll('#iw-channels input:checked')).map(function(c){ return c.value; });
  if (picked.length) payload.channels = picked;
  if (iwType !== 'campaign') {
    var iName = (document.getElementById('iw-name') || {}).value || '';
    if (iName.trim()) payload.name = iName.trim();
  }
  return payload;
}

function iwStart() {
  var payload = iwCollect();
  if (!payload) return;
  payload.event = 'gw_cmd';
  payload.cmd = 'gw_open_instance';
  if (iwDraftId) payload.draftId = iwDraftId;   // Server räumt den Entwurf nach dem Start ab
  send(payload);
  iwClose();
  log('Instanz wird gestartet …', 'cyan');
}

// ── Entwürfe: vorbereiten ohne zu starten ────────────────
var iwDraftId = null;   // gesetzt, wenn das Modal einen Entwurf bearbeitet

function iwSaveDraft() {
  var payload = iwCollect();
  if (!payload) return;
  var config = Object.assign({}, payload, { type: iwType });
  delete config.core;
  send({ event: 'gw_cmd', cmd: 'gw_save_draft', draftId: iwDraftId || undefined, config: config });
  iwClose();
}

var drafts = [];
function loadDrafts() { send({ event: 'gw_cmd', cmd: 'gw_list_drafts' }); }

var DRAFT_ICON = { campaign: '📊', instant: '⚡', ticketbuy: '🎟', contest: '📸' };
function renderDrafts() {
  var card = document.getElementById('card-drafts');
  var host = document.getElementById('draft-list');
  if (!card || !host) return;
  card.style.display = drafts.length ? '' : 'none';
  host.innerHTML = drafts.map(function(d){
    var c = d.config || {};
    var label = (DRAFT_ICON[c.type] || '🎁') + ' ' + esc(c.name || c.prize || c.keyword || ('Entwurf #' + d.id));
    return '<div class="tb-prize"><span class="t" title="' + esc((c.prize || '') + (c.sponsor ? ' — ' + c.sponsor : '')) + '">'
      + label + '</span>'
      + '<button class="btn btn-cyan btn-sm btn-mini" onclick="draftEdit(' + d.id + ')" title="Im Modal bearbeiten">✎</button>'
      + '<button class="btn btn-red btn-sm btn-mini" onclick="draftDelete(' + d.id + ')" title="Entwurf löschen">✖</button>'
      + '<button class="btn btn-solid btn-sm" onclick="draftStart(' + d.id + ')" title="Jetzt starten">▶ START</button>'
      + '</div>';
  }).join('') || '<div class="wsc-empty">Keine Entwürfe.</div>';
}

function draftStart(id) {
  var d = drafts.find(function(x){ return x.id === id; });
  if (!d) return;
  var c = d.config || {};
  var t = IW_TYPES[c.type] || IW_TYPES.campaign;
  var payload = Object.assign({ event: 'gw_cmd', cmd: 'gw_open_instance', draftId: id }, c);
  delete payload.type;
  if (t.core) payload.core = t.core; else delete payload.core;
  send(payload);
  log('Entwurf wird gestartet …', 'cyan');
}

function draftEdit(id) {
  var d = drafts.find(function(x){ return x.id === id; });
  if (!d) return;
  var c = d.config || {};
  openInstance();
  iwDraftId = id;
  iwSelect(c.type || 'campaign');
  var set = function(elId, v) { var el = document.getElementById(elId); if (el) el.value = v; };
  set('iw-prize', c.prize || '');
  set('iw-sponsor', c.sponsor || '');
  set('iw-name', c.name || '');
  set('iw-keyword', c.keyword || '');
  set('iw-window', c.windowSec ? Math.round(c.windowSec / 60 * 10) / 10 : 1);
  set('iw-wagercmd', c.wagerCmd || '');
  set('iw-minwatch', c.minWatchSec ? Math.round(c.minWatchSec / 60) : 10);
  iwSetPrizeRows(Array.isArray(c.prizes) ? c.prizes : []);
  var ann = document.getElementById('iw-announce'); if (ann) ann.checked = c.announce !== false;
  Array.prototype.forEach.call(document.querySelectorAll('#iw-channels input'), function(cb){
    cb.checked = Array.isArray(c.channels) && c.channels.indexOf(cb.value) >= 0;
  });
}

function draftDelete(id) {
  if (!confirm('Entwurf #' + id + ' löschen?')) return;
  send({ event: 'gw_cmd', cmd: 'gw_delete_draft', draftId: id });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('iw-overlay').style.display !== 'none') iwClose();
});
document.getElementById('iw-overlay').addEventListener('click', function(e) {
  if (e.target === this) iwClose();
});

// ── Sofortverlosung: Anmeldefenster (Ziehung macht der Streamer mit ★) ──
function cvOpenWindow() {
  // UI rechnet in Minuten, die API in Sekunden.
  var mins = CC.validate.sanitizeFloat(document.getElementById('cv-window').value, 0.5, 60, 1);
  cvLockUntil = Date.now() + 5000;   // sperren, bis der Server-Stand (windowEndsAt) da ist
  var btn = document.getElementById('cv-open-btn');
  if (btn) btn.disabled = true;
  send({ event: 'gw_cmd', cmd: 'gw_instant_window', giveawayId: currentGiveaway, windowSec: Math.round(mins * 60) });
}
var cvLockUntil = 0;

// Chat-Ansagen der Sofortverlosung an/aus (Karte). Kurze lokale Sperre,
// damit der Sekunden-Refresh den Klick nicht sofort überschreibt.
var cvAnnLockUntil = 0;
function cvToggleAnnounce() {
  var cb = document.getElementById('cv-announce');
  if (!cb || !currentGiveaway) return;
  cvAnnLockUntil = Date.now() + 3000;
  send({ event: 'gw_cmd', cmd: 'gw_set_announce', giveawayId: currentGiveaway, on: !!cb.checked });
  log('Chat-Ansagen der Sofortverlosung: ' + (cb.checked ? 'AN' : 'AUS'), 'cyan');
}

function cvUpdateState() {
  var badge = document.getElementById('cv-state');
  if (!badge) return;
  var g = giveawayList.find(function(x){ return x.gid === currentGiveaway; });
  var now = Math.floor(Date.now() / 1000);
  var open = !!(g && g.windowEndsAt && g.windowEndsAt > now);
  if (open) {
    var rest = g.windowEndsAt - now;
    badge.textContent = 'OFFEN · noch ' + (rest >= 60
      ? Math.floor(rest / 60) + ':' + String(rest % 60).padStart(2, '0') + ' min'
      : rest + 's');
  } else {
    badge.textContent = 'ZU';
  }
  // Kein Doppel-Öffnen: Button gesperrt, solange das Fenster läuft
  // (plus kurze lokale Sperre, bis der Server-Stand eingetroffen ist).
  var btn = document.getElementById('cv-open-btn');
  if (btn) btn.disabled = open || Date.now() < cvLockUntil;
  var ann = document.getElementById('cv-announce');
  if (ann && g && Date.now() >= cvAnnLockUntil) ann.checked = g.announce !== false;
}
setInterval(cvUpdateState, 1000);

function closeInstance() {
  if (!currentGiveaway) { log('Keine Instanz gewählt', 'red'); return; }
  if (!confirm(instanceLabel(currentGiveaway) + ' wirklich schließen?')) return;
  send({ event: 'gw_cmd', cmd: 'gw_close_instance', giveawayId: currentGiveaway });
}

function refresh() { requestData(); loadKeyword(); loadHistory(); loadAudit(); loadClaims(); loadDrafts(); }

// ── Gewinn-Abwicklung (Rail-Karte, nur Owner) ─────────────
// BEWUSST nicht im 10s-Poll: jeder /api/claims-Abruf wird auditiert
// (claims_inbox_view) — Polling würde das Protokoll fluten. Laden bei
// Connect/Team-Wechsel, nach einer Ziehung und per ↻.
var clClaims = [];
async function loadClaims() {
  var card = document.getElementById('card-claims');
  if (!card || !currentTeam) return;
  try {
    var r = await fetch('/giveaway/api/claims?team=' + encodeURIComponent(currentTeam));
    if (r.status === 403) { card.style.display = 'none'; return; }   // kein Owner
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    clClaims = d.claims || [];
    renderClaimsCard();
  } catch(e) { log('Gewinn-Abwicklung: ' + e.message, 'red'); }
}

function renderClaimsCard() {
  var card = document.getElementById('card-claims');
  var host = document.getElementById('cl-card-list');
  var badge = document.getElementById('cl-open-count');
  if (!card || !host) return;
  card.style.display = '';
  var todo = clClaims.filter(function(c){
    return c.status === 'claimed' ? c.handling !== 'done' : c.status === 'pending';
  });
  if (badge) badge.textContent = todo.length ? todo.length + ' OFFEN' : 'NICHTS OFFEN';
  if (!todo.length) { host.innerHTML = '<div class="wsc-empty">Alles abgewickelt.</div>'; return; }
  host.innerHTML = todo.slice(0, 6).map(function(c){
    var key = (c.winner || '').toLowerCase();
    var stat = c.status === 'claimed'
      ? (c.claim_source === 'external' ? 'extern gemeldet' : 'gemeldet')
      : (c.overdue ? 'FRIST ABGELAUFEN' : 'wartet auf Meldung');
    var btns = c.status === 'claimed'
      ? '<button class="btn btn-cyan btn-sm btn-mini" onclick="clAct(' + c.id + ',\'contacted\')" title="Als kontaktiert markieren">✉</button>'
        + '<button class="btn btn-gold btn-sm btn-mini" onclick="clAct(' + c.id + ',\'shipped\')" title="Als versendet markieren">📦</button>'
        + '<button class="btn btn-green btn-sm btn-mini" onclick="clAct(' + c.id + ',\'done\')" title="Abwicklung erledigt">✓</button>'
      : '<button class="btn btn-gold btn-sm btn-mini" onclick="clExternal(' + c.id + ')" '
        + 'title="Gewinner hat sich außerhalb der Plattform gemeldet (z. B. WhatsApp) — Frist gilt als erfüllt">✔ EXTERN</button>';
    return '<div class="tb-prize"><span class="t">'
      + esc(maskName(key, c.winner)) + (c.prize ? ' <span style="opacity:.55">· ' + esc(c.prize) + '</span>' : '')
      + '</span><span class="s" style="font-size:10px">' + esc(stat)
      + (c.handling && c.handling !== 'done' ? ' · ' + esc(c.handling === 'contacted' ? 'kontaktiert' : 'versendet') : '')
      + '</span>' + btns + '</div>';
  }).join('') + (todo.length > 6 ? '<div class="cfg-hint">+' + (todo.length - 6) + ' weitere auf der Abwicklungs-Seite.</div>' : '');
}

async function clAct(claimId, handling) {
  try {
    var r = await (await fetch('/giveaway/api/claims/handling', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, claimId: claimId, handling: handling }),
    })).json();
    if (r.error) throw new Error(r.error);
    log('Abwicklung: Stand „' + handling + '" gesetzt', 'gold');
    loadClaims();
  } catch(e) { log('Stand setzen fehlgeschlagen: ' + e.message, 'red'); }
}

async function clExternal(claimId) {
  if (!confirm('Meldung außerhalb der Plattform erfassen (z. B. WhatsApp)? '
    + 'Der Gewinn gilt damit als fristgerecht gemeldet.')) return;
  try {
    var r = await (await fetch('/giveaway/api/claims/external', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, claimId: claimId }),
    })).json();
    if (r.error) throw new Error(r.error);
    log('Externe Meldung erfasst', 'gold');
    loadClaims();
  } catch(e) { log('Erfassen fehlgeschlagen: ' + e.message, 'red'); }
}

function requestData() {
  send({ event: 'gw_get_all' });
  send({ event: 'gw_cmd', cmd: 'gw_list_giveaways' });
  send({ event: 'gw_cmd', cmd: 'gw_get_multiplier' });
  send({ event: 'gw_cmd', cmd: 'gw_get_stream_settings', giveawayId: currentGiveaway });
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
      // Antwort für ein anderes als das gewählte Giveaway → veraltet, ignorieren.
      if ((msg.giveawayId || null) !== currentGiveaway) break;
      participants = {};
      gwIsOpen = !!msg.open;
      gwPaused = !!msg.paused;
      gwCore = msg.core || null;
      gwSession = msg.session || null;   // Kampagne: Ziehen bleibt bis zum Reset moeglich
      gwCoreMeta = msg.coreMeta || null;   // P5: kompletter Anzeige-Vertrag des Cores
      gwDisplayCols = (Array.isArray(msg.display) && msg.display.length) ? msg.display : null;
      if (Array.isArray(msg.channels)) gwChannels = msg.channels;
      renderIngestWarn(msg.ingestPulse);
      (msg.participants || []).forEach(p => {
        const key = (p.username || '').toLowerCase();
        // Core-Felder (present/stake/balance/score/…) mitnehmen, die
        // Standard-Felder normalisiert obendrauf.
        participants[key] = Object.assign({}, p, {
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
        });
        if (Number.isFinite(parseInt(p.drawMinSec))) gwDrawMinSec = parseInt(p.drawMinSec);
        if (Number.isFinite(parseInt(p.followMin)))  gwFollowMin  = parseInt(p.followMin);
      });
      updateGwStatus();
      renderHead();
      renderTable();
      updateStats();
      updateMainView();     // Uebersicht/Tabelle passend zur Auswahl
      break;

    case 'gw_status':
      // Broadcast betrifft die Kampagne — bei gewählter Instanz nicht anwenden.
      if (currentGiveaway) { liveRefresh(); break; }
      gwPaused = msg.status === 'paused';
      gwIsOpen = msg.status === 'open' || msg.status === 'paused';
      updateGwStatus();
      break;

    case 'gw_ack': {
      log(`ACK: ${msg.type} -> ${msg.user || msg.keyword || msg.winner || msg.channel || ''}`, 'cyan');
      // Startwarnungen blockieren nicht (z. B. verdaechtige "[ ... ]" in den
      // eigenen Bedingungen). Echte Vorlagen-Platzhalter "{{ ... }}" kommen
      // weiterhin als open_blocked.
      if (msg.warnings && msg.warnings.length) {
        msg.warnings.forEach(function(w){ log('Startwarnung: ' + w, 'gold'); });
      }
      // Read-only Antworten (NIE requestData → sonst Endlosschleife)
      if (msg.type === 'giveaways')     { giveawayList = msg.giveaways || []; renderGiveawaySelect(); updateMainView(); break; }
      if (msg.type === 'drafts')        { drafts = msg.drafts || []; renderDrafts(); break; }
      if (msg.type === 'preflight')     { renderPreflight(msg); break; }
      if (msg.type === 'entries')       { renderEntries(msg); break; }
      if (msg.type === 'prizes') {
        // Antwort einer anderen Auswahl verwerfen (mehrere Los-Giveaways moeglich).
        if (msg.giveawayId !== undefined && (msg.giveawayId || null) !== currentGiveaway) break;
        renderPrizes(msg.prizes || []); break;
      }
      if (msg.type === 'instant_window') {
        log('Anmeldefenster offen: ' + msg.windowSec + 's', 'gold');
        renderIngestWarn(msg.ingestPulse);
        if (msg.ingestStale && msg.ingestStale.length) {
          alert('Fenster ist offen — ABER von ' + msg.ingestStale.join(', ')
              + ' kommen keine Zuschauer-Meldungen.\n\nOhne sie gilt niemand als anwesend und die Ziehung bleibt leer.'
              + '\nStreamerbot-Aktion GW_ViewerTick auf diesem Kanal prüfen.');
        }
        liveRefresh(); break;
      }
      if (msg.type === 'announce_set')   { liveRefresh(); break; }
      if (msg.type === 'instant_window_closed') {
        log('Anmeldefenster zu — ' + msg.eligible + ' im Topf'
            + (msg.registered !== undefined ? ' (' + msg.registered + ' angemeldet)' : '') + '. Ziehen mit ★', 'gold');
        renderIngestWarn(msg.ingestPulse);
        liveRefresh(); break;
      }
      if (msg.type === 'channels')      { ingestChannels = msg.channels || []; renderIngest(); break; }
      if (msg.type === 'ingest_tokens') { ingestTokens = {}; (msg.tokens || []).forEach(t => ingestTokens[t.channel] = t.token); renderIngest(); break; }
      if (msg.type === 'ingest_token')  { ingestTokens[msg.channel] = msg.token; renderIngest(); break; }
      if (msg.type === 'stream_settings') {
        // Geltungsbereich anzeigen: eigene Werte des laufenden Giveaways
        // oder Team-Vorgaben für den nächsten Start.
        var scEl = document.getElementById('settings-scope');
        if (scEl) scEl.textContent = (msg.scope && msg.scope !== 'defaults') ? 'DIESES GIVEAWAY' : 'VORGABEN';
        var shEl = document.getElementById('settings-scope-hint');
        if (shEl) shEl.textContent = (msg.scope && msg.scope !== 'defaults')
          ? 'Gilt NUR für das laufende Giveaway (wirkt sofort). Die Vorgaben für künftige Giveaways änderst du bei geschlossenem Giveaway.'
          : 'Vorgaben — gelten für das NÄCHSTE Giveaway. Beim Start bekommt jedes Giveaway eine eigene Kopie.';
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
      if (msg.type === 'open_warnings') break;   // schon oben protokolliert
      if (msg.type === 'open_blocked') { log(msg.error || 'Öffnen blockiert', 'red'); alert(msg.error || 'Öffnen blockiert'); break; }
      if (msg.type === 'ai_rotated')  { log('Master-Schlüssel rotiert: ' + msg.reencrypted + ' Keys neu verschlüsselt'
                                            + (msg.unreadable ? ', ' + msg.unreadable + ' unlesbar' : ''), 'gold'); break; }
      if (msg.type === 'ai_test') {
        if (!msg.ok) log('KI-Test fehlgeschlagen: ' + (msg.error || '?') + ' – Wortregel greift', 'red');
        else log('KI-Test ok (' + msg.source + '): "' + msg.sample + '" -> ' + (msg.meaningful ? 'sinnvoll' : 'nicht sinnvoll'), 'cyan');
        break;
      }
      if (msg.type === 'keyword') {
        if ((msg.giveawayId || null) !== currentGiveaway) break;   // stale Antwort anderer Auswahl
        const kw = msg.keyword || '';
        document.getElementById('kw-current').textContent = kw || '- (deaktiviert)';
        document.getElementById('kw-input').value = kw;
        break;
      }
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
      if (msg.type === 'instance_opened') { log('Zusatz-Giveaway gestartet: ' + (msg.giveawayId || '?')
            + (msg.keyword ? ' (Keyword „' + msg.keyword + '")' : '')
            + (msg.wagerCmd ? ' (Setzen: „' + msg.wagerCmd + '")' : ''), 'gold'); loadDrafts(); }
      if (msg.type === 'draft_saved')   { log('Entwurf #' + msg.draftId + ' gespeichert — Start per ▶ in der Karte VORBEREITETE GIVEAWAYS', 'gold'); loadDrafts(); }
      if (msg.type === 'draft_deleted') { log('Entwurf #' + msg.draftId + ' gelöscht', 'gold'); loadDrafts(); }
      if (msg.type === 'prize_added')   { log('Preis #' + msg.prizeId + ' angelegt: „' + (msg.title || '') + '"', 'gold'); tbHandleImageAfterSave(msg.prizeId); tbLoadPrizes(); }
      if (msg.type === 'prize_edited')  { log('Preis #' + msg.prizeId + ' korrigiert', 'gold'); tbHandleImageAfterSave(msg.prizeId); tbLoadPrizes(); }
      if (msg.type === 'prize_cancelled') { log('Preis #' + msg.prizeId + ' storniert — ' + (msg.refundedUsers || 0) + ' Einsätze zurückgebucht', 'gold'); tbLoadPrizes(); }
      if (msg.type === 'page_announced') log('Zuschauer-Link im Chat angesagt', 'gold');
      if (msg.type === 'wager_cmd_set') log('Setz-Befehl geändert: „' + (msg.command || '') + '"', 'gold');
      if (msg.type === 'contest_voting') log('Contest-Voting: ' + (msg.voting || '?'), 'gold');
      if (msg.type === 'entry_reviewed') { log('Einsendung #' + msg.entryId + ' → ' + (msg.decision === 'approve' ? 'FREIGEGEBEN' : 'abgelehnt'), 'gold'); scLoadEntries(); }
      if (msg.type === 'entry_deleted')  { log('Einsendung #' + msg.entryId + ' von „' + maskName((msg.username || '').toLowerCase(), msg.username || '?') + '" endgültig gelöscht', 'gold'); scLoadEntries(); }
      if (msg.type === 'instance_closed') { log('Instanz geschlossen: ' + instanceLabel(msg.giveawayId || '?')
            + ' — jetzt ziehen (★), danach AUFRÄUMEN', 'gold'); }
      if (msg.type === 'instance_cleaned') { log('Instanz aufgeräumt: ' + instanceLabel(msg.giveawayId || '?')
            + ' — Nachweis unter Tools → 🗄 Vergangene Giveaways', 'gold'); }
      if (msg.type === 'instance_paused')  log('Instanz pausiert: '   + (msg.giveawayId || '?'), 'gold');
      if (msg.type === 'instance_resumed') log('Instanz läuft weiter: ' + (msg.giveawayId || '?'), 'cyan');
      if (msg.type === 'winner_drawn') {
        lastDraw = { drawId: msg.drawId, prizeId: msg.prizeId || null, giveawayId: currentGiveaway };
        showWinnerAnimation(msg.winner, msg.watchSec, msg.coins, msg.prize, msg); loadHistory(); loadClaims();
      }
      if (msg.type === 'no_winner') {
        var nw = msg.message || 'Niemand im Lostopf — kein Gewinner ermittelbar.';
        if (msg.registered !== undefined) {
          nw += '\n\nAngemeldet: ' + msg.registered + ' · davon anwesend: ' + (msg.present || 0);
          if (msg.ingestStale && msg.ingestStale.length) {
            nw += '\nKeine Zuschauer-Meldungen von: ' + msg.ingestStale.join(', ')
                + ' — Streamerbot-Aktion GW_ViewerTick prüft die Anwesenheit.';
          }
        }
        log(nw.replace(/\n/g, ' | '), 'red');
        alert(nw);
      }
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
  send({ event: 'gw_cmd', cmd: 'gw_set_stream_settings', giveawayId: currentGiveaway,
         autoPause: ap, autoResume: ar, followMin: fm, drawMinHours: dm,
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
    el.style.color = 'var(--rdoc-text-muted)';
    return;
  }
  el.style.color = 'var(--rdoc-text)';
  let left = secondsLeft;
  const render = () => {
    const m = Math.floor(left / 60), s = left % 60;
    el.textContent = `${factor}× · ${m}:${String(s).padStart(2, '0')}`;
    if (left <= 0) { clearInterval(_multTimer); _multTimer = null; el.textContent = '1× (aus)'; el.style.color = 'var(--rdoc-text-muted)'; }
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
// OPEN/CLOSE gelten der Kampagne — bei gewählter Zusatz-Instanz blocken,
// deren Lebenszyklus läuft über ＋/✕ (gw_open_instance/gw_close_instance).
function gwOpen()   { if (currentGiveaway) { log('Instanz gewählt — Kampagne öffnen erst nach Wechsel auf „Kampagne"', 'red'); return; }
                      // Gewinn ist Pflicht (Server prüft ebenfalls); Sponsor optional.
                      var oPrize = (document.getElementById('prize-input') || {}).value || '';
                      if (!oPrize.trim()) { log('Bitte zuerst den Gewinn eintragen (Feld links)', 'red');
                                            var pi = document.getElementById('prize-input'); if (pi) pi.focus(); return; }
                      // Kein optimistisches Setzen: der Server bestätigt per
                      // gw_status/gw_data — sonst zeigt das Panel bei Ablehnung
                      // (fehlende TOS, fehlender Gewinn) einen falschen Zustand.
                      send({ event:'gw_cmd', cmd:'gw_open', prize: oPrize.trim(),
                             sponsor: ((document.getElementById('sponsor-input') || {}).value || '').trim() });
                      liveRefresh(); }
function gwClose()  { if (currentGiveaway) { log('Instanz gewählt — zum Schließen der Instanz ✕ benutzen', 'red'); return; }
                      send({ event:'gw_cmd', cmd:'gw_close'  }); liveRefresh(); }
// PAUSE/RESUME tragen die giveawayId (GID_CMDS) und wirken auf die Auswahl.
function gwPause()  { send({ event:'gw_cmd', cmd:'gw_pause'  }); liveRefresh(); }
function gwResume() { send({ event:'gw_cmd', cmd:'gw_resume' }); liveRefresh(); }

function updateGwStatus() {
  const el = document.getElementById('gw-txt');
  if (!gwIsOpen)      { el.textContent='CLOSED';   el.className='state-chip closed'; }
  else if (gwPaused)  { el.textContent='PAUSIERT'; el.className='state-chip paused'; }
  else                { el.textContent='OPEN';     el.className='state-chip open'; }
  updateActionButtons();
}

// Zustandsmaschine der Hauptaktionen: nur gültige Übergänge sind klickbar.
// Kampagne: Zustand aus gwIsOpen/gwPaused; Instanz: aus giveawayList
// (gelistete Instanzen sind offen, paused steht am Eintrag).
function updateActionButtons() {
  var open = gwIsOpen, paused = gwPaused, closedPending = false;
  if (currentGiveaway) {
    var g = giveawayList.find(function(x){ return x.gid === currentGiveaway && !x.primary; });
    closedPending = !!(g && g.closed);          // geschlossen, aber noch nicht aufgeraeumt
    open = !!g && !closedPending;
    paused = !!(g && g.paused);
  }
  var set = function(id, enabled) { var b = document.getElementById(id); if (b) b.disabled = !enabled; };
  set('btn-open',   !currentGiveaway && !open);
  set('btn-pause',  open && !paused);
  set('btn-resume', open && paused);
  set('btn-close',  open || closedPending);
  // Reihenfolge: schliessen -> ziehen -> aufraeumen. Nach dem Schliessen
  // bleibt der Topf stehen, das Ziehen muss also weiter gehen.
  // Kampagne: nach dem SCHLIESSEN bleibt die Sitzung bis zum Reset stehen,
  // also bleibt auch das Ziehen moeglich (Reihenfolge schliessen -> ziehen).
  set('btn-draw',   open || closedPending || (!currentGiveaway && !!gwSession));
  var cb = document.getElementById('btn-close');
  if (cb) {
    cb.textContent = closedPending ? 'AUFRÄUMEN' : 'SCHLIESSEN';
    cb.title = closedPending
      ? 'Giveaway ist geschlossen — entfernt es nach der Ziehung aus der Liste'
      : 'Sammeln/Anmelden beenden. Gezogen wird danach.';
  }
  // Beschriftung folgt dem Ziehungs-Modus des Cores (drawKind aus dem Vertrag).
  var db = document.getElementById('btn-draw');
  if (db) {
    var per = isPerPrize();
    db.textContent = per ? '★ ZIEHEN (JE PREIS)' : '★ GEWINNER ZIEHEN';
    db.title = per ? 'Los-Giveaway: jeder Preis wird einzeln gezogen — fuehrt zur Preis-Karte'
                   : 'Gewinner aus dem Lostopf ziehen';
  }
}

// Zieht dieser Core je Preis? drawKind kommt aus dem CORE-Vertrag, die
// Core-ID ist nur Fallback fuer alte Serverstaende.
function isPerPrize() {
  var sg = selectedGiveaway();
  return (sg && sg.drawKind === 'perPrize') || selectedCore() === 'CORE_TicketBuy';
}
// ★ beim Los-Giveaway: Preis-Karte zeigen und hervorheben, nichts ziehen.
function gotoPrizeCard() {
  var card = document.getElementById('card-ticketbuy');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('card-flash');
  void card.offsetWidth;              // Reflow, damit die Animation neu startet
  card.classList.add('card-flash');
  setTimeout(function(){ card.classList.remove('card-flash'); }, 2600);
  var open = tbPrizes.filter(function(p){ return p.status === 'open'; }).length;
  log(open ? 'Los-Giveaway: ★ ZIEHEN je Preis in der Preis-Karte (' + open + ' offen)'
           : 'Los-Giveaway: kein offener Preis — erst einen Preis anlegen', 'gold');
}

function drawWinner() {
  // Ziehung je Preis (drawKind perPrize): es gibt keinen einen Topf, also
  // fuehrt ★ zur Preis-Karte statt zu ziehen. Gezogen wird dort je Preis —
  // von Hand, wie ueberall sonst auch.
  if (isPerPrize()) { gotoPrizeCard(); return; }
  var el = document.getElementById('prize-input');
  send({ event:'gw_cmd', cmd:'gw_draw_winner', prize: el ? el.value.trim() : '' });
}

// P4: CORE-spezifische Gewinneranzeige. `sem` sind die semantischen Felder
// der Ziehung (core, unit, winnerStat, drawKind, votes) aus dem Server-Ack.
function winnerStatText(coins, watchSec, sem) {
  const unit = sem && sem.unit !== undefined ? sem.unit : 'Punkte';
  const kind = (sem && sem.drawKind) || 'weighted';
  if (kind === 'equal')   return 'Gleiche Chance für alle · ' + ((sem && sem.eligibleCount) || '?') + ' im Topf';
  if (kind === 'score')   return parseDec(coins).toFixed(0) + ' Punkte aus ' + ((sem && sem.votes) || 0) + ' Stimmen';
  if (kind === 'perPrize') return parseDec(coins).toFixed(0) + ' ' + (unit || 'Lose') + ' auf diesen Preis gesetzt'
                                + ((sem && sem.eligibleCount) ? ' · ' + sem.eligibleCount + ' Setzer' : '');
  return parseDec(coins).toFixed(2) + ' ' + (unit || 'Punkte') + ' // ' + fmtTime(watchSec || 0);
}
function showWinnerAnimation(winnerName, watchSec, coins, prize, sem) {
  // Flacker-Kandidaten = alle nicht gebannten Teilnehmer der aktuellen
  // Anzeige. coins>0 gilt nur für gewichtete Mechaniken — bei Sofort-
  // verlosung/Contest hätte der Filter fast alle ausgeschlossen.
  const kind = (sem && sem.drawKind) || 'weighted';
  const names = Object.keys(participants).filter(k => !participants[k].banned
    && (kind === 'weighted' || kind === 'perPrize' ? participants[k].coins > 0 : true));
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
      const statTxt = winnerStatText(coins, watchSec, sem);
      document.getElementById('w-info').textContent = statTxt + prizeTxt;
      renderTable(winnerName);
      log(`GEWINNER: ${winnerName} (${statTxt})${prize ? ' – Preis: ' + prize : ''}`, 'gold');
    }
  }, 75);
}

// P6: Ersatzziehung — verknüpft mit der letzten Ziehung (reroll_of), mit
// Grund und standardmäßigem Ausschluss des bisherigen Gewinners. Ohne
// bekannte letzte Ziehung bleibt es eine normale Neuziehung.
function reroll() {
  if (!lastDraw || !lastDraw.drawId) { drawWinner(); return; }
  var f = document.getElementById('reroll-form');
  if (f) f.style.display = '';
}
function rerollConfirm() {
  if (!lastDraw || !lastDraw.drawId) return;
  var reason = (document.getElementById('reroll-reason') || {}).value || '';
  var cmd = { event: 'gw_cmd', cmd: 'gw_draw_winner', rerollOf: lastDraw.drawId,
              reason: reason.trim() };
  if (lastDraw.giveawayId) cmd.giveawayId = lastDraw.giveawayId;
  if (lastDraw.prizeId)    cmd.prizeId    = lastDraw.prizeId;
  send(cmd);
  var f = document.getElementById('reroll-form');
  if (f) f.style.display = 'none';
  log('Ersatzziehung angefordert (Ursprung #' + lastDraw.drawId + ', bisheriger Gewinner ausgeschlossen)', 'gold');
}
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
  // Instanz mit eigener Spaltendeklaration (Sofortverlosung/Los/Contest):
  // Spalten kommen vom Core statt der Coin-/Viewtime-Spalten der Kampagne.
  if (gwDisplayCols) {
    row.innerHTML =
      `<th class="num" onclick="sortBy('rank')">#</th>`
      + `<th onclick="sortBy('name')">NAME</th>`
      + gwDisplayCols.map(c =>
          `<th class="num" onclick="sortBy('${esc(c.key)}')">${esc(String(c.label || c.key).toUpperCase())}</th>`).join('')
      + `<th class="num">AKTIONEN</th>`;
    return;
  }
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

// ── Hilfemodus: Erklärungen an den Bedienelementen ────────
// Quelle der Texte sind data-help-Attribute im HTML — sie beschreiben die
// AKTUELLE Implementation (bei Verhaltensänderungen mitpflegen!). Für
// Zeilen-Layouts (cmdbar/actionstrip) landet die Notiz DANACH, sonst im
// Element. Volle Doku: /admin/funktionsweise.html (öffentlich).
var helpOn = localStorage.getItem('cc_help') === '1';
function toggleHelp() {
  helpOn = !helpOn;
  localStorage.setItem('cc_help', helpOn ? '1' : '0');
  applyHelp();
  log(helpOn ? 'Hilfemodus AN — Erklärungen eingeblendet' : 'Hilfemodus AUS', 'gold');
}
function applyHelp() {
  var badge = document.getElementById('help-badge');
  if (badge) {
    badge.className = 'ws-badge priv ' + (helpOn ? 'on' : 'off');
    badge.textContent = '？ HILFE: ' + (helpOn ? 'AN' : 'AUS');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.help-note'), function(n){ n.remove(); });
  if (!helpOn) return;
  Array.prototype.forEach.call(document.querySelectorAll('[data-help]'), function(el){
    var n = document.createElement('div');
    n.className = 'help-note';
    n.textContent = el.getAttribute('data-help');
    if (el.classList.contains('cmdbar') || el.classList.contains('actionstrip')) {
      el.parentNode.insertBefore(n, el.nextSibling);
    } else {
      el.appendChild(n);
    }
  });
  // Kopf-Hinweis mit Link zur vollen Doku.
  var app = document.querySelector('.gw-app');
  if (app) {
    var top = document.createElement('div');
    top.className = 'help-note';
    top.innerHTML = 'Hilfemodus aktiv — Erklärungen stehen an jedem Bereich, Details je Knopf im Maus-Tooltip. '
      + 'Die komplette Funktionsweise (alle Mechaniken, Fairness, Nachweis): '
      + '<a href="/admin/funktionsweise.html" target="_blank" rel="noopener">So funktioniert\'s</a>.';
    app.insertBefore(top, app.firstChild);
  }
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

// Zellwert einer Core-Spalte: Booleans als Häkchen, Zahlen kompakt,
// Contest-Status auf Deutsch.
var COL_STATUS_LABEL = { pending: 'WARTET', approved: 'FREIGEGEBEN', rejected: 'ABGELEHNT' };
function fmtColVal(v) {
  if (v === true) return '&#10003;';
  if (v === false || v === undefined || v === null || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return esc(COL_STATUS_LABEL[v] || String(v));
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
  if (gwDisplayCols) {
    // Core-Spalten: keine Coin-Badges, Aktionen nur BAN (+1/-1 sind
    // Kampagnen-Coins und haben hier keine Wirkung).
    document.getElementById('tbl').innerHTML = entries.map(([key,p],i) => `
      <tr class="${p.banned?'banned':''} ${p.eligible?'eligible':''} ${key===hlKey?'winner-row':''}">
        <td class="rank">${i+1}</td>
        <td class="name">${esc(maskName(key, p.display||key))}${p.banned?' <span style="color:var(--rdoc-error);font-size:10px;">[BAN]</span>':''}</td>
        ${gwDisplayCols.map(c => `<td class="tickets">${fmtColVal(p[c.key])}</td>`).join('')}
        <td style="display:flex;gap:4px;justify-content:flex-end;">
          <button class="mini-btn ban" onclick="toggleBan('${esc(key)}')">${p.banned?'UN':'BAN'}</button>
        </td>
      </tr>`).join('');
    return;
  }
  document.getElementById('tbl').innerHTML = entries.map(([key,p],i) => `
    <tr class="${p.banned?'banned':''} ${p.eligible?'eligible':(isPending(p)?'pending':'')} ${key===hlKey?'winner-row':''}">
      <td class="rank">${i+1}</td>
      <td class="name">${esc(maskName(key, p.display||key))}${statusBadge(p)}${p.banned?' <span style="color:var(--rdoc-error);font-size:10px;">[BAN]</span>':''}${(p.flags&&p.flags.length)?` <span title="${esc(p.flags.map(f=>f.reason+' x'+f.count).join(', '))}" style="color:var(--rdoc-warning);font-size:11px;cursor:help;">&#9888;${p.flags.length}</span>`:''}</td>
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
// Kacheln in der Command-Bar je Mechanik: die Coin-/Msg-Zahlen der Kampagne
// sagen bei Sofortverlosung/Los-Giveaway/Contest nichts aus.
function statTile(t) {
  return '<div class="stat ' + (t.cls || '') + '"' + (t.title ? ' title="' + esc(t.title) + '"' : '') + '>'
    + '<span>' + esc(String(t.v)) + '</span><label>' + esc(t.l) + '</label></div>';
}
function fmtStatNum(n) { return ((Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '')) || '0'; }

// P5: Kachel-Registry — jeder Core deklariert in display.tiles nur noch die
// IDs; die Berechnung steht genau einmal hier. Neuer Core = IDs auswählen
// (oder eine neue Kachel hier ergänzen), keine Verzweigung in updateStats.
var STAT_TILES = {
  registeredCount: function(a){ return { v: a.filter(function(p){return p.registered;}).length, l: 'ANGEMELDET', title: 'Keyword im Anmeldefenster geschrieben' }; },
  presentCount:    function(a){ return { v: a.filter(function(p){return p.present;}).length, l: 'ANWESEND', cls: 'plain', title: 'Gerade als Zuschauer gemeldet (viewer_tick)' }; },
  inPotCount:      function(a){ return { v: a.filter(function(p){return p.eligible;}).length, l: 'IM TOPF', cls: 'green', title: 'Angemeldet + anwesend — Stand jetzt in der Ziehung' }; },
  accountCount:    function(a){ return { v: a.length, l: 'KONTEN', title: 'Zuschauer mit Guthaben oder Einsatz' }; },
  stakeSum:        function(a){ return { v: fmtStatNum(a.reduce(function(s,p){return s+(parseFloat(p.stake)||0);},0)), l: 'GESETZTE LOSE', cls: 'gold' }; },
  freeBalance:     function(a){ return { v: fmtStatNum(a.reduce(function(s,p){return s+(parseFloat(p.balance)||0);},0)), l: 'FREIES GUTHABEN', cls: 'plain', title: 'Ledger-Saldo (ohne live erspielten Stand der laufenden Instanz)' }; },
  setterCount:     function(a){ return { v: a.filter(function(p){return p.eligible;}).length, l: 'SETZER', cls: 'green', title: 'Mindestens 1 Los gesetzt' }; },
  entryCount:      function(a){ return { v: a.length, l: 'EINSENDUNGEN' }; },
  approvedCount:   function(a){ return { v: a.filter(function(p){return p.status==='approved';}).length, l: 'FREIGEGEBEN', cls: 'green' }; },
  voteSum:         function(a){ return { v: a.reduce(function(s,p){return s+(parseInt(p.votes)||0);},0), l: 'STIMMEN', cls: 'plain' }; },
  scoreSum:        function(a){ return { v: a.reduce(function(s,p){return s+(parseInt(p.score)||0);},0), l: 'PUNKTE', cls: 'gold' }; },
};

function updateStats() {
  const host = document.getElementById('cb-stats');
  if (!host) return;
  const active = Object.values(participants).filter(p=>!p.banned);
  let tiles;
  const tileIds = gwCoreMeta && Array.isArray(gwCoreMeta.tiles) ? gwCoreMeta.tiles : null;
  if (tileIds && tileIds.length) {
    tiles = tileIds.map(function(id){ return STAT_TILES[id] ? STAT_TILES[id](active) : null; })
                   .filter(Boolean);
  } else {
    // Kampagne (Watchtime): unverändertes Layout.
    const elig    = active.filter(p => p.eligible).length;
    const pending = active.filter(isPending).length;
    const noKey   = active.filter(p => !p.registered && (p.coins||0) >= 1).length;
    tiles = [
      { v: active.length, l: 'CREW' },
      { v: (active.reduce((s,p)=>s+(parseFloat(p.coins)||0),0).toFixed(4).replace(/\.?0+$/,'')) || '0', l: 'COINS', cls: 'gold' },
      { v: active.reduce((s,p)=>s+(parseInt(p.msgs)||0),0), l: 'MSGS', cls: 'plain' },
      { v: pending ? (elig + '+' + pending) : elig,
        l: pending ? 'LOSTOPF + VORGEMERKT' : 'IM LOSTOPF (≥1 COIN)', cls: 'green',
        title: `${elig} im Lostopf (Keyword + ≥${gwFollowMin} Follows + ≥1 Coin)\n`
             + `${pending} vorgemerkt (Keyword da, Bedingung offen)\n`
             + `${noKey} hätten ≥1 Coin, aber kein Keyword\n`
             + `1 Coin = ${fmtDurShort(gwDrawMinSec)} Viewtime` },
    ];
  }
  host.innerHTML = tiles.map(statTile).join('');
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
    if (msg.enabled && msg.hasKey) { st.textContent = 'AKTIV'; st.style.color = 'var(--rdoc-success)'; }
    else if (msg.enabled) { st.textContent = 'KEIN KEY'; st.style.color = 'var(--rdoc-error)'; }
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
    hint.style.color = msg.source === 'live' ? 'var(--rdoc-success)' : 'var(--rdoc-warning)';
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

// Freitext für die Liste. Die Fallunterscheidung steht in giveaway-shared.js,
// damit Dashboard und Audit-Seite nicht auseinanderlaufen.
function auditSummary(e) { return CC.audit.summary(e); }

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
    // Der Server fasst direkt aufeinanderfolgende identische Eintraege zusammen.
    const rep  = e.n > 1 ? ' <span style="color:var(--rdoc-warning)">×' + e.n + '</span>' : '';
    return '<div class="audit-row ' + cls + '">'
      + '<div class="audit-head"><b>' + who + '</b>' + tgt + rep
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
    const prize = d.prize ? '🎁 ' + esc(d.prize) : '<span style="color:var(--rdoc-text-muted)">— kein Preis —</span>';
    const test  = d.is_test ? ' <span style="color:var(--rdoc-warning);font-size:9px;">TEST</span>' : '';
    return '<div class="hist-row" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;">' +
        '<strong>' + esc(d.winner) + test + '</strong>' +
        '<span style="color:var(--rdoc-text-muted);font-size:10px;white-space:nowrap;">' + when + '</span>' +
      '</div>' +
      '<div style="font-size:12px;">' + prize + '</div>' +
      '<div style="color:var(--rdoc-text-muted);font-size:10px;">' + histStatLine(d) + '</div>' +
    '</div>';
  }).join('');
}

// P4: Statistikzeile je Ziehung, CORE-korrekt beschriftet (Server liefert
// unit/drawKind je Zeile aus dem Core-Vertrag; alte Zeilen ohne core →
// Standard "Punkte, gewichtet").
function histStatLine(d) {
  const n = (d.eligible_count || 0);
  if (d.drawKind === 'equal')    return n + ' im Topf · gleiche Chance';
  if (d.drawKind === 'score')    return parseDec(d.winner_coins).toFixed(0) + ' Punkte (Voting) · ' + n + ' im Stechen';
  if (d.drawKind === 'perPrize') return parseDec(d.winner_coins).toFixed(0) + ' ' + (d.unit || 'Lose') + ' gesetzt · ' + n + ' Setzer';
  return parseDec(d.winner_coins).toFixed(2) + ' ' + (d.unit || 'Punkte') + ' · ' + n + ' Teilnehmer';
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
  // Nenner ist der Lostopf, nicht die Crew: nur `eligible` (Keyword + Follow-Gate
  // + ≥1 Coin) wird gezogen, also auch nur darüber die Chance. Nicht Zugelassene
  // stehen mit ihren Coins in der Liste, aber mit 0 %.
  const total = active.reduce((s,p) => s + (p.eligible ? (p.coins||0) : 0), 0);
  const rows = [['Username','Coins','Watchtime (s)','Watchtime','Zugelassen','Gewinnchance %']];
  active.sort((a,b) => b.coins - a.coins).forEach(p => {
    const chance = (p.eligible && total > 0) ? ((p.coins / total) * 100).toFixed(2) : '0.00';
    rows.push([p.display, parseDec(p.coins).toFixed(2), p.watchSec, fmtTime(p.watchSec),
               p.eligible ? 'ja' : 'nein', chance]);
  });
  const csv = rows.map(r => r.join(';')).join('\n');
  dlFile('giveaway_export.csv', csv, 'text/csv;charset=utf-8');
  log('CSV exportiert (' + active.length + ' Teilnehmer)', 'cyan');
}

function exportChances() {
  // Nur der echte Lostopf — `eligible` deckt bereits !banned und ≥1 Coin mit ab.
  const active = Object.values(participants).filter(p => p.eligible);
  if (!active.length) { log('Keine zugelassenen Teilnehmer', 'red'); return; }
  const total = active.reduce((s,p) => s + p.coins, 0);
  const sep = '-'.repeat(48);
  let txt = 'RDOC GIVEAWAY - GEWINNCHANCEN\n';
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
  updateStats();                // Kacheln sofort zeigen (Nullstand, Kampagnen-Layout)
  applyHelp();                  // Hilfemodus-Zustand aus localStorage
  updateMainView();             // Start ohne Auswahl = Uebersicht, Rail leer
  connectWS();
  log('Admin-Panel gestartet', 'cyan');
  if (privacyOn) log('Streamermodus aktiv (gespeichert)', 'gold');
}
