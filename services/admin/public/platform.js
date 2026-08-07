'use strict';
// Plattform-Verwaltung (superadmin). Spricht /admin/api/platform/*.
// Kein Streamermodus-Masking: die Seite ist superadmin-only und zeigt
// bewusst echte Logins und Teamnamen.

var API = '/admin/api/platform';

var ERR = {
  unauthenticated: 'Bitte einloggen.',
  forbidden: 'Nur Plattform-Administratoren.',
  not_found: 'Nicht gefunden.',
  reason_required: 'Bitte einen Grund angeben.',
  giveaway_open: 'Das Team hat ein laufendes Giveaway.',
  already_deactivated: 'Team ist bereits deaktiviert.',
  not_deactivated: 'Team ist nicht deaktiviert.',
  already_banned: 'Streamer ist bereits gesperrt.',
  not_banned: 'Streamer ist nicht gesperrt.',
  cannot_ban_self: 'Du kannst dich nicht selbst sperren.',
  cannot_ban_admin: 'Plattform-Administratoren lassen sich nicht sperren.',
  bad_id: 'Ungültige Kennung.',
  bad_login: 'Ungültiger Login.'
};
function errText(code, status) { return ERR[code] || ('Fehler: ' + (code || status)); }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
  return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
}); }
function fmt(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '–'; }
function setMsg(id, text, ok) {
  var el = document.getElementById(id);
  el.textContent = text || '';
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

var tData = {};   // team_id  -> Zeile
var sData = {};   // login    -> Zeile

async function jget(path) {
  var r = await fetch(API + path);
  if (r.status === 401) { window.location.href = '/admin/login.html'; throw new Error('unauth'); }
  if (r.status === 403) throw new Error('forbidden');
  if (!r.ok) throw new Error('http_' + r.status);
  return r.json();
}

async function jpost(path, body) {
  var r = await fetch(API + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  var d = await r.json().catch(function(){ return {}; });
  return { ok: r.ok, status: r.status, data: d };
}

// ── Statistik ─────────────────────────────────────────────
async function loadStats() {
  try {
    var s = await jget('/stats');
    ['teamsActive','teamsDeactivated','streamers','viewers','openGiveaways'].forEach(function(k) {
      document.getElementById('st-' + k).textContent = (s[k] == null ? '?' : s[k]);
    });
  } catch (e) {
    if (e.message === 'forbidden') { forbidden(); return; }
    setMsg('statsMsg', 'Ladefehler: ' + e.message, false);
  }
}

function forbidden() {
  ['teamRows','strRows'].forEach(function(id) {
    document.getElementById(id).innerHTML =
      '<tr><td colspan="7" style="color:var(--rdoc-error)">Nur Plattform-Administratoren.</td></tr>';
  });
  setMsg('statsMsg', 'Nur Plattform-Administratoren.', false);
}

// ── Inline-Aktionszeile (statt prompt/confirm) ────────────
// data-act am Button bestimmt die Aktion; die Zeile darunter fragt den Grund
// ab und bestätigt. Bei 409 giveaway_open erscheint die Force-Nachfrage.
function closeActRows(tbody) {
  Array.prototype.forEach.call(tbody.querySelectorAll('.actrow, .histrow'), function(tr) { tr.remove(); });
}

var ACT = {
  warnTeam:      { label: 'Team verwarnen',        needReason: true,  danger: false },
  deactivate:    { label: 'Team deaktivieren',     needReason: true,  danger: true },
  reactivate:    { label: 'Team reaktivieren',     needReason: false, danger: false },
  warnStreamer:  { label: 'Streamer verwarnen',    needReason: true,  danger: false },
  ban:           { label: 'Streamer sperren',      needReason: true,  danger: true },
  unban:         { label: 'Sperre aufheben',       needReason: false, danger: false }
};

function openActRow(btn, cols, submit) {
  var act = ACT[btn.getAttribute('data-act')];
  var tr = btn.closest('tr');
  var tbody = tr.parentNode;
  closeActRows(tbody);
  var row = document.createElement('tr');
  row.className = 'actrow';
  row.innerHTML = '<td colspan="' + cols + '"><div class="frm">' +
    '<span>' + esc(act.label) + ':</span>' +
    (act.needReason ? '<input type="text" maxlength="500" placeholder="Grund (Pflicht)">' :
                      '<input type="text" maxlength="500" placeholder="Grund (optional)">') +
    '<button class="go' + (act.danger ? ' danger' : '') + '" data-go>Bestätigen</button>' +
    '<button class="ghost" data-cancel>Abbrechen</button>' +
    '<span class="hint" data-hint></span>' +
    '</div></td>';
  tr.after(row);
  var input = row.querySelector('input');
  input.focus();
  row.querySelector('[data-cancel]').addEventListener('click', function() { row.remove(); });
  row.querySelector('[data-go]').addEventListener('click', function() {
    var reason = input.value.trim();
    if (act.needReason && !reason) { row.querySelector('[data-hint]').textContent = 'Grund fehlt.'; return; }
    submit(reason, row, false);
  });
}

// ── Teams ─────────────────────────────────────────────────
function teamStatus(t) {
  var b = [];
  b.push(t.deactivated_at ? '<span class="badge inaktiv">deaktiviert</span>'
                          : '<span class="badge aktiv">aktiv</span>');
  if (t.open_giveaway) b.push('<span class="badge live">Giveaway läuft</span>');
  return b.join(' ');
}

function renderTeams() {
  var q = document.getElementById('teamSearch').value.trim().toLowerCase();
  var rows = document.getElementById('teamRows');
  var list = Object.values(tData).filter(function(t) {
    if (!q) return true;
    return (t.name + ' ' + t.owner_login + ' ' + t.id).toLowerCase().indexOf(q) >= 0;
  });
  if (!list.length) { rows.innerHTML = '<tr><td colspan="7">keine Teams</td></tr>'; return; }
  rows.innerHTML = list.map(function(t) {
    return '<tr data-tid="' + esc(t.id) + '">' +
      '<td>' + esc(t.name) + '<br><span class="note">' + esc(t.id) + '</span></td>' +
      '<td>' + esc(t.owner_login) + '</td>' +
      '<td>' + t.members + '</td>' +
      '<td>' + fmt(t.created_at) + '</td>' +
      '<td>' + teamStatus(t) + '</td>' +
      '<td>' + (t.warnings_open
        ? '<span class="badge warn" data-hist="team" data-id="' + esc(t.id) + '">' + t.warnings_open + ' offen</span>'
        : '<span class="note" style="cursor:pointer" data-hist="team" data-id="' + esc(t.id) + '">Historie</span>') + '</td>' +
      '<td>' +
        '<button class="act" data-act="warnTeam" data-id="' + esc(t.id) + '">Verwarnen</button>' +
        (t.deactivated_at
          ? '<button class="act" data-act="reactivate" data-id="' + esc(t.id) + '">Reaktivieren</button>'
          : '<button class="act danger" data-act="deactivate" data-id="' + esc(t.id) + '">Deaktivieren</button>') +
      '</td></tr>';
  }).join('');
  wireActions(rows, doTeamAction, 7);
}

function doTeamAction(actName, id, reason, row, force) {
  var call;
  if (actName === 'warnTeam') call = jpost('/warn', { subjectType: 'team', subjectId: id, reason: reason });
  else if (actName === 'deactivate') call = jpost('/teams/' + encodeURIComponent(id) + '/deactivate', { reason: reason, force: !!force });
  else call = jpost('/teams/' + encodeURIComponent(id) + '/reactivate', { reason: reason });
  call.then(function(r) {
    if (r.ok) { setMsg('teamMsg', 'Erledigt.', true); loadTeams(); loadStats(); return; }
    if (r.data.error === 'giveaway_open' && actName === 'deactivate') {
      var hint = row.querySelector('[data-hint]');
      hint.innerHTML = 'Laufendes Giveaway erzwungen beenden? ';
      var fb = document.createElement('button');
      fb.className = 'go danger'; fb.textContent = 'Erzwingen';
      fb.addEventListener('click', function() { doTeamAction(actName, id, reason, row, true); });
      hint.appendChild(fb);
      return;
    }
    row.querySelector('[data-hint]').textContent = errText(r.data.error, r.status);
  }).catch(function(e) { setMsg('teamMsg', e.message, false); });
}

async function loadTeams() {
  try {
    var list = await jget('/teams');
    tData = {};
    list.forEach(function(t) { tData[t.id] = t; });
    renderTeams();
  } catch (e) {
    if (e.message === 'forbidden') return;   // forbidden() kam schon über stats
    setMsg('teamMsg', 'Ladefehler: ' + e.message, false);
  }
}

// ── Streamer ──────────────────────────────────────────────
function strStatus(s) {
  var b = [];
  if (s.is_platform_admin) b.push('<span class="badge admin">Admin</span>');
  b.push(s.banned_at
    ? '<span class="badge gesperrt" title="' + esc(s.banned_reason || '') + '">gesperrt</span>'
    : '<span class="badge aktiv">aktiv</span>');
  return b.join(' ');
}

function renderStreamers() {
  var q = document.getElementById('strSearch').value.trim().toLowerCase();
  var rows = document.getElementById('strRows');
  var list = Object.values(sData).filter(function(s) {
    if (!q) return true;
    return (s.login + ' ' + (s.display || '')).toLowerCase().indexOf(q) >= 0;
  });
  if (!list.length) { rows.innerHTML = '<tr><td colspan="6">keine Streamer</td></tr>'; return; }
  rows.innerHTML = list.map(function(s) {
    return '<tr data-login="' + esc(s.login) + '">' +
      '<td>' + esc(s.login) + (s.display && s.display !== s.login ? '<br><span class="note">' + esc(s.display) + '</span>' : '') + '</td>' +
      '<td>' + fmt(s.last_login) + '</td>' +
      '<td>' + s.owned_teams + '</td>' +
      '<td>' + strStatus(s) + '</td>' +
      '<td>' + (s.warnings_open
        ? '<span class="badge warn" data-hist="streamer" data-id="' + esc(s.login) + '">' + s.warnings_open + ' offen</span>'
        : '<span class="note" style="cursor:pointer" data-hist="streamer" data-id="' + esc(s.login) + '">Historie</span>') + '</td>' +
      '<td>' +
        '<button class="act" data-act="warnStreamer" data-id="' + esc(s.login) + '">Verwarnen</button>' +
        (s.banned_at
          ? '<button class="act" data-act="unban" data-id="' + esc(s.login) + '">Entsperren</button>'
          : (s.is_platform_admin ? '' :
             '<button class="act danger" data-act="ban" data-id="' + esc(s.login) + '">Sperren</button>')) +
      '</td></tr>';
  }).join('');
  wireActions(rows, doStrAction, 6);
}

function doStrAction(actName, login, reason, row) {
  var call;
  if (actName === 'warnStreamer') call = jpost('/warn', { subjectType: 'streamer', subjectId: login, reason: reason });
  else if (actName === 'ban') call = jpost('/streamers/' + encodeURIComponent(login) + '/ban', { reason: reason });
  else call = jpost('/streamers/' + encodeURIComponent(login) + '/unban', {});
  call.then(function(r) {
    if (r.ok) { setMsg('strMsg', 'Erledigt.', true); loadStreamers(); return; }
    row.querySelector('[data-hint]').textContent = errText(r.data.error, r.status);
  }).catch(function(e) { setMsg('strMsg', e.message, false); });
}

async function loadStreamers() {
  try {
    var list = await jget('/streamers');
    sData = {};
    list.forEach(function(s) { sData[s.login] = s; });
    renderStreamers();
  } catch (e) {
    if (e.message === 'forbidden') return;
    setMsg('strMsg', 'Ladefehler: ' + e.message, false);
  }
}

// ── Verdrahtung: Aktions-Buttons + Verwarnungs-Historie ───
function wireActions(tbody, doAction, cols) {
  Array.prototype.forEach.call(tbody.querySelectorAll('[data-act]'), function(b) {
    b.addEventListener('click', function() {
      openActRow(b, cols, function(reason, row, force) {
        doAction(b.getAttribute('data-act'), b.getAttribute('data-id'), reason, row, force);
      });
    });
  });
  Array.prototype.forEach.call(tbody.querySelectorAll('[data-hist]'), function(el) {
    el.addEventListener('click', function() { showHistory(el, cols); });
  });
}

async function showHistory(el, cols) {
  var tr = el.closest('tr');
  var tbody = tr.parentNode;
  closeActRows(tbody);
  try {
    var list = await jget('/warnings?type=' + encodeURIComponent(el.getAttribute('data-hist')) +
                          '&id=' + encodeURIComponent(el.getAttribute('data-id')));
    var row = document.createElement('tr');
    row.className = 'histrow';
    row.innerHTML = '<td colspan="' + cols + '">' + (list.length
      ? list.map(function(w) {
          return '<div><span class="h1">' + fmt(w.created_at) + ': ' + esc(w.reason) + '</span> ' +
                 '<span class="h2">(von ' + esc(w.created_by) + ', ' +
                 (w.acknowledged_at ? 'quittiert ' + fmt(w.acknowledged_at) : 'offen') + ')</span></div>';
        }).join('')
      : '<span class="h2">Keine Verwarnungen.</span>') + '</td>';
    tr.after(row);
  } catch (e) { /* Historie ist Komfort, Fehler nicht fatal */ }
}

document.getElementById('teamSearch').addEventListener('input', renderTeams);
document.getElementById('strSearch').addEventListener('input', renderStreamers);

loadStats();
loadTeams();
loadStreamers();
