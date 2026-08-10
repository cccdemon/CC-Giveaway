'use strict';
// Betrieb & Diagnose (superadmin). Beantwortet drei Fragen ohne SSH:
// laufen die Dienste, kommen Zuschauer-Meldungen an, was ging zuletzt schief.
// Kein Streamermodus-Masking — die Seite ist superadmin-only.

var API = '/admin/api/platform';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
  return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
}); }
function fmt(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '–'; }
function setMsg(id, text) {
  var el = document.getElementById(id);
  if (el) { el.textContent = text || ''; el.className = 'msg err'; }
}
function fmtAgo(sec) {
  if (sec === null || sec === undefined) return 'noch nie';
  if (sec < 60) return 'vor ' + sec + ' s';
  if (sec < 3600) return 'vor ' + Math.round(sec / 60) + ' min';
  if (sec < 86400) return 'vor ' + Math.round(sec / 3600) + ' h';
  return 'vor ' + Math.round(sec / 86400) + ' Tagen';
}

async function jget(path, base) {
  var r = await fetch((base || API) + path);
  if (r.status === 401) { window.location.href = '/admin/login.html'; throw new Error('unauth'); }
  var j = await r.json().catch(function(){ return {}; });
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ── Dienste ───────────────────────────────────────────────
async function loadHealth() {
  var host = document.getElementById('health');
  try {
    // /health antwortet 503 bei "degraded" — der Körper ist trotzdem das Ergebnis.
    var r = await fetch('/health');
    var d = await r.json().catch(function(){ return null; });
    if (!d || !d.services) { host.textContent = 'Keine Antwort von /health (HTTP ' + r.status + ')'; return; }
    host.innerHTML = '<table><thead><tr><th>Dienst</th><th>Zustand</th></tr></thead><tbody>'
      + Object.keys(d.services).map(function(name) {
          var v = String(d.services[name]);
          var cls = v === 'ok' ? 'ok' : 'err';
          return '<tr><td class="mono">' + esc(name) + '</td><td><span class="badge ' + cls + '">'
               + esc(v) + '</span></td></tr>';
        }).join('')
      + '</tbody></table>';
  } catch (e) { host.textContent = 'Fehler: ' + e.message; }
}

// ── Ingest-Puls ───────────────────────────────────────────
async function loadIngest() {
  var host = document.getElementById('ingest');
  try {
    var d = await jget('/ingest');
    if (d.error) { setMsg('ingestMsg', d.error); }
    var teams = d.teams || [];
    if (!teams.length) { host.innerHTML = '<div class="detail">Kein Team mit eingerichteten Kanälen.</div>'; return; }
    host.innerHTML = '<table><thead><tr><th>Team</th><th>Kanal</th><th>Letzte Meldung</th>'
      + '<th>Anwesend</th><th>Zustand</th></tr></thead><tbody>'
      + teams.map(function(t) {
          return (t.channels || []).map(function(c, i) {
            // Drei Zustaende: Stoerfall (online, aber still), Stream offline
            // (normal, Streamerbot sendet dann nichts) und laufend.
            var cls = c.stale ? 'err' : (!c.online ? 'warn' : 'ok');
            var txt = c.stale ? 'STREAM ONLINE, KEINE MELDUNGEN'
                    : (!c.online ? 'STREAM OFFLINE' : 'LÄUFT');
            return '<tr>'
              + '<td>' + (i === 0 ? esc(t.teamName || t.teamId)
                  + (t.running ? ' <span class="detail">· ' + t.running + ' Giveaway(s)</span>' : '') : '') + '</td>'
              + '<td class="mono">' + esc(c.channel) + '</td>'
              + '<td>' + esc(fmtAgo(c.lastTickAgo)) + '</td>'
              + '<td>' + (c.present || 0) + '</td>'
              + '<td><span class="badge ' + cls + '">' + txt + '</span></td>'
              + '</tr>';
          }).join('');
        }).join('')
      + '</tbody></table>';
  } catch (e) { host.textContent = 'Fehler: ' + e.message; }
}

// ── Kennzahlen ────────────────────────────────────────────
var TILES = [
  { k: 'giveawaysOpen',  l: 'Laufende Giveaways' },
  { k: 'drawsWeek',      l: 'Ziehungen (7 Tage)' },
  { k: 'claimsOpen',     l: 'Offene Gewinnmeldungen' },
  { k: 'claimsOverdue',  l: 'Frist überschritten', warnIfPositive: true },
  { k: 'eventsDay',      l: 'Zeit-Buchungen (24 h)' },
  { k: 'wagersWeek',     l: 'Einsätze (7 Tage)' },
  { k: 'entriesWeek',    l: 'Einsendungen (7 Tage)' },
  { k: 'flagsWeek',      l: 'Auffälligkeiten (7 Tage)', warnIfPositive: true },
  { k: 'errorsDay',      l: 'Fehler (24 h)', errIfPositive: true },
  { k: 'deniedDay',      l: 'Ablehnungen (24 h)', warnIfPositive: true },
];

async function loadStats() {
  var host = document.getElementById('stats');
  try {
    var a = await jget('/activity');
    var s = await jget('/stats');
    var extra = [
      { v: s.teamsActive, l: 'Aktive Teams' },
      { v: s.streamers,   l: 'Streamer' },
      { v: s.viewers,     l: 'Zuschauer' },
    ];
    host.innerHTML = extra.map(function(t) {
      return '<div class="stat"><div class="v">' + (t.v === null || t.v === undefined ? '–' : t.v)
           + '</div><div class="l">' + esc(t.l) + '</div></div>';
    }).join('') + TILES.map(function(t) {
      var v = a[t.k];
      var cls = (v > 0 && t.errIfPositive) ? ' err' : (v > 0 && t.warnIfPositive) ? ' warn' : '';
      return '<div class="stat"><div class="v' + cls + '">' + (v === null || v === undefined ? '–' : v)
           + '</div><div class="l">' + esc(t.l) + '</div></div>';
    }).join('');
  } catch (e) { setMsg('statsMsg', 'Fehler: ' + e.message); }
}

// ── Fehler & Ablehnungen ──────────────────────────────────
var errResult = '';
function setFilter(v) {
  errResult = v;
  document.getElementById('errFilter').textContent = v || 'alle';
  loadErrors();
}

async function loadErrors() {
  var body = document.getElementById('errRows');
  try {
    var d = await jget('/errors?limit=80' + (errResult ? '&result=' + errResult : ''));
    var rows = d.rows || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" style="color:var(--rdoc-text-faint)">Nichts protokolliert.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function(r) {
      var det = r.detail ? JSON.stringify(r.detail) : '';
      if (det.length > 220) det = det.slice(0, 220) + '…';
      return '<tr>'
        + '<td class="mono">' + esc(fmt(r.ts)) + '</td>'
        + '<td>' + esc(r.team_name || r.team_id || '–') + '</td>'
        + '<td class="mono">' + esc(r.actor) + '</td>'
        + '<td class="mono">' + esc(r.action) + (r.target ? ' <span class="detail">→ ' + esc(r.target) + '</span>' : '') + '</td>'
        + '<td><span class="badge ' + (r.result === 'error' ? 'err' : 'warn') + '">' + esc(r.result) + '</span></td>'
        + '<td class="detail">' + esc(det) + '</td>'
        + '</tr>';
    }).join('');
  } catch (e) { setMsg('errMsg', 'Fehler: ' + e.message); }
}

// ── Rückmeldungen ───────────────────────────────
var KIND_LABEL = { bug: '🐛 Fehler', idea: '💡 Idee', question: '❓ Frage' };

async function loadFeedback() {
  var body = document.getElementById('fbRows');
  try {
    var d = await jget('/feedback?limit=60');
    if (d.error) setMsg('fbMsg', d.error);
    var rows = d.rows || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" style="color:var(--rdoc-text-faint)">Noch keine Rückmeldung.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function(r) {
      var txt = String(r.message || '');
      if (txt.length > 300) txt = txt.slice(0, 300) + '…';
      return '<tr>'
        + '<td class="mono">' + esc(fmt(r.ts)) + '</td>'
        + '<td class="mono">' + esc(r.login) + '</td>'
        + '<td>' + esc(KIND_LABEL[r.kind] || r.kind) + '</td>'
        + '<td class="mono">' + esc(r.page || '–') + '</td>'
        + '<td>' + esc(txt) + '</td>'
        + '<td><span class="badge ' + (r.delivered ? 'ok' : 'warn') + '">'
        + (r.delivered ? 'zugestellt' : 'nicht zugestellt') + '</span>'
        + (r.error ? '<div class="detail">' + esc(r.error) + '</div>' : '') + '</td>'
        + '</tr>';
    }).join('');
  } catch (e) { setMsg('fbMsg', 'Fehler: ' + e.message); }
}

// ── Streamerbot-Debugzeilen ───────────────────────────────
async function loadDebug() {
  var body = document.getElementById('dbgRows');
  try {
    var d = await jget('/debuglog?limit=60');
    if (d.error) setMsg('dbgMsg', d.error);
    var rows = d.rows || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" style="color:var(--rdoc-text-faint)">Keine Einträge.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function(r) {
      return '<tr>'
        + '<td class="mono">' + esc(fmt(r.ts)) + '</td>'
        + '<td class="mono">' + esc(r.source || '') + '</td>'
        + '<td class="mono">' + esc(r.stage || '') + '</td>'
        + '<td class="mono">' + esc(r.username || '') + '</td>'
        + '<td class="detail">' + esc(r.info || '') + '</td>'
        + '</tr>';
    }).join('');
  } catch (e) { setMsg('dbgMsg', 'Fehler: ' + e.message); }
}

function loadAll() {
  document.getElementById('stamp').textContent = 'Stand ' + new Date().toLocaleTimeString('de-DE');
  loadHealth(); loadIngest(); loadStats(); loadErrors(); loadFeedback(); loadDebug();
}

loadAll();
setInterval(loadAll, 60000);
