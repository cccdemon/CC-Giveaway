'use strict';

// ── Archiv vergangener Giveaways ──────────────────────────
// Ein Giveaway ist erst nachvollziehbar, wenn Ziehung, Teilnehmerstand und
// Protokoll nebeneinander liegen. Genau das zeigt diese Seite je Sitzung.
// Kontaktdaten des Gewinners liefert der Server nur an den Owner.

var currentTeam = null;
var sessions    = [];
var current     = null;
var privacyOn   = localStorage.getItem('cc_privacy') === '1';

function esc(s) {
  return (window.CC && CC.validate && typeof CC.validate.escHtml === 'function')
    ? CC.validate.escHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmt(iso, withTime) {
  if (!iso) return '–';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '–';
  return d.toLocaleString('de-DE', withTime === false
    ? { day: '2-digit', month: '2-digit', year: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function num(v) { return Number(v || 0); }
function mask(name) { return privacyOn ? 'Zuschauer' : esc(name || '–'); }
function dur(a, b) {
  if (!a || !b) return '–';
  var m = Math.round((new Date(b) - new Date(a)) / 60000);
  if (m < 60) return m + ' min';
  return (Math.round(m / 6) / 10).toString().replace(/\.0$/, '') + ' h';
}

async function loadTeams() {
  try {
    var teams = await (await fetch('/admin/api/teams/mine')).json();
    var sel = document.getElementById('team-select');
    if (!Array.isArray(teams) || !teams.length) {
      sel.innerHTML = '<option>— kein Team —</option>';
      document.getElementById('ar-list').innerHTML = '<div class="wsc-empty">Du bist in keinem Team.</div>';
      return;
    }
    sel.innerHTML = teams.map(function(t){
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + (t.role === 'owner' ? ' ★' : '') + '</option>';
    }).join('');
    currentTeam = teams[0].id;
    sel.value = currentTeam;
    loadList();
  } catch(e) {
    document.getElementById('ar-list').innerHTML = '<div class="wsc-empty">' + esc(e.message) + '</div>';
  }
}

function onTeamChange() {
  currentTeam = document.getElementById('team-select').value;
  current = null;
  document.getElementById('ar-detail').innerHTML = '<div class="wsc-empty">Links ein Giveaway wählen.</div>';
  loadList();
}

async function loadList() {
  try {
    var d = await (await fetch('/giveaway/api/archive?team=' + encodeURIComponent(currentTeam))).json();
    if (d.error) throw new Error(d.error);
    sessions = d.sessions || [];
    var el = document.getElementById('ar-list');
    if (!sessions.length) { el.innerHTML = '<div class="wsc-empty">Noch kein Giveaway gelaufen.</div>'; return; }
    el.innerHTML = sessions.map(function(s){
      var closed = !!s.closed_at;
      var chans = Array.isArray(s.channels) ? s.channels : [];
      return '<div class="ar-item" data-id="' + esc(s.id) + '">'
        + '<h4>' + fmt(s.opened_at, false) + (s.keyword ? ' · „' + esc(s.keyword) + '"' : '')
        + '<span class="badge ' + (closed ? 'closed' : 'open') + '">' + (closed ? 'ABGESCHLOSSEN' : 'LÄUFT') + '</span></h4>'
        + '<div class="sub">' + (chans.length ? esc(chans.join(', ')) : '–') + '<br>'
        + num(s.total_participants) + ' Teilnehmer · ' + num(s.total_coins).toFixed(2) + ' Punkte · '
        + num(s.draws) + ' Ziehung' + (num(s.draws) === 1 ? '' : 'en')
        + (num(s.test_draws) ? ' (+' + s.test_draws + ' Test)' : '')
        + (s.winners ? '<br>Gewinner: ' + mask(s.winners) : '')
        + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.ar-item'), function(it){
      it.onclick = function(){ openSession(it.getAttribute('data-id')); };
    });
  } catch(e) {
    document.getElementById('ar-list').innerHTML = '<div class="wsc-empty">' + esc(e.message) + '</div>';
  }
}

async function openSession(sid) {
  Array.prototype.forEach.call(document.querySelectorAll('.ar-item'), function(it){
    it.classList.toggle('active', it.getAttribute('data-id') === sid);
  });
  var el = document.getElementById('ar-detail');
  el.innerHTML = '<div class="wsc-empty">Lade…</div>';
  try {
    var d = await (await fetch('/giveaway/api/archive/' + encodeURIComponent(sid)
                             + '?team=' + encodeURIComponent(currentTeam))).json();
    if (d.error) throw new Error(d.error);
    current = d;
    renderDetail(sid, d);
  } catch(e) {
    el.innerHTML = '<div class="wsc-empty">' + esc(e.message) + '</div>';
  }
}

function renderDetail(sid, d) {
  var s = d.session || {};
  var chans = Array.isArray(s.channels) ? s.channels : [];
  var real = (d.draws || []).filter(function(x){ return !x.is_test; });
  var test = (d.draws || []).filter(function(x){ return x.is_test; });

  var kv = function(label, v) { return '<div><label>' + label + '</label>' + v + '</div>'; };

  var html = '<div class="ar-sec"><h3>SITZUNG</h3><div class="ar-kv">'
    + kv('ID', esc(sid))
    + kv('KEYWORD', s.keyword ? esc(s.keyword) : '–')
    + kv('KANÄLE', chans.length ? esc(chans.join(', ')) : '–')
    + kv('ERÖFFNET', fmt(s.opened_at))
    + kv('GESCHLOSSEN', s.closed_at ? fmt(s.closed_at) : 'läuft noch')
    + kv('DAUER', dur(s.opened_at, s.closed_at))
    + kv('TEILNEHMER', num(s.total_participants))
    + kv('PUNKTE GESAMT', num(s.total_coins).toFixed(2))
    + '</div></div>';

  // ── Ziehungen ──
  html += '<div class="ar-sec"><h3>ZIEHUNGEN (' + real.length
       + (test.length ? ' + ' + test.length + ' TEST' : '') + ')</h3>';
  if (!d.draws.length) html += '<div class="wsc-empty">Keine Ziehung erfolgt.</div>';
  else html += '<div class="ar-scroll"><table class="ar-tbl"><tr>'
    + '<th>#</th><th>Zeitpunkt</th><th>Gewinner</th><th>Punkte</th><th>Lostopf</th>'
    + '<th>Summe</th><th>Zufallswert</th><th>Preis</th><th>Art</th></tr>'
    + d.draws.map(function(x){
        return '<tr><td>' + x.draw_index + '</td><td>' + fmt(x.drawn_at) + '</td>'
          + '<td>' + mask(x.winner) + '</td><td>' + num(x.winner_coins).toFixed(2) + '</td>'
          + '<td>' + num(x.eligible_count) + '</td><td>' + num(x.total_coins).toFixed(2) + '</td>'
          + '<td>' + num(x.rand_value).toFixed(6) + '</td><td>' + esc(x.prize || '–') + '</td>'
          + '<td>' + (x.is_test ? 'TEST' : 'echt') + '</td></tr>';
      }).join('') + '</table></div>'
    + '<div class="ar-note" style="margin:6px 0 0">Der Zufallswert liegt zwischen 0 und der Punktesumme. '
    + 'Mit dem Snapshot im Export ist jede Ziehung nachrechenbar.</div>';
  html += '</div>';

  // ── Gewinnermeldung ──
  html += '<div class="ar-sec"><h3>GEWINNERMELDUNG</h3>';
  if (!d.claims.length) html += '<div class="wsc-empty">Keine Meldung angelegt (nur echte Ziehungen erzeugen eine).</div>';
  else html += d.claims.map(function(c){
    var st = c.status === 'claimed' ? '✓ gemeldet am ' + fmt(c.claimed_at)
           : (c.status === 'expired' ? '✗ Frist verstrichen' : '⏳ offen, Frist bis ' + fmt(c.deadline_at));
    var body = '<div class="ar-kv">'
      + '<div><label>GEWINNER</label>' + mask(c.winner) + '</div>'
      + '<div><label>STATUS</label>' + esc(st) + '</div>'
      + '<div><label>FRIST</label>' + fmt(c.deadline_at) + '</div>'
      + (c.terms_version ? '<div><label>TEILNAHMEBEDINGUNGEN</label>Version ' + c.terms_version + '</div>' : '')
      + '</div>';
    if (!d.contactVisible) {
      body += '<div class="ar-note" style="margin-top:8px">Kontaktdaten sieht nur der Team-Owner.</div>';
    } else if (c.purged_at) {
      body += '<div class="ar-note" style="margin-top:8px">Kontaktdaten am ' + fmt(c.purged_at)
            + ' fristgemäß gelöscht. Der Ziehungsnachweis bleibt vollständig.</div>';
    } else if (c.status === 'claimed') {
      body += '<div class="ar-pii" style="margin-top:9px">'
        + '<div class="warn">⚠ Personenbezogene Daten — automatische Löschung am ' + fmt(c.purge_at) + '</div>'
        + '<div class="ar-kv">'
        + '<div><label>NAME</label>' + esc(c.real_name || '–') + '</div>'
        + '<div><label>E-MAIL</label>' + esc(c.email || '–') + '</div>'
        + '<div><label>ANSCHRIFT</label>' + esc([c.street, [c.zip, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', ') || '–') + '</div>'
        + (c.note ? '<div><label>ANMERKUNG</label>' + esc(c.note) + '</div>' : '')
        + '</div></div>';
    }
    return body;
  }).join('');
  html += '</div>';

  // ── Teilnehmer ──
  html += '<div class="ar-sec"><h3>TEILNEHMERSTAND (' + d.participation.length + ' Kanal-Datensätze)</h3>';
  if (!d.participation.length) {
    html += '<div class="wsc-empty">Kein Snapshot vorhanden — Teilnahmedaten werden 90 Tage '
          + 'nach Abschluss gelöscht (Datenschutz).</div>';
  } else {
    html += '<div class="ar-scroll"><table class="ar-tbl"><tr>'
      + '<th>Zuschauer</th><th>Kanal</th><th>Zuschauzeit</th><th>Chat</th><th>Punkte</th><th>Folgt</th><th>Gültig</th></tr>'
      + d.participation.map(function(p){
          return '<tr><td>' + mask(p.username) + '</td><td>' + esc(p.channel) + '</td>'
            + '<td>' + Math.round(num(p.watch_sec) / 60) + ' min</td><td>' + num(p.msgs) + '</td>'
            + '<td>' + num(p.coins).toFixed(2) + '</td><td>' + (p.follows ? 'ja' : 'nein') + '</td>'
            + '<td>' + (p.valid ? 'ja' : 'nein') + '</td></tr>';
        }).join('') + '</table></div>';
  }
  html += '</div>';

  // ── Audit ──
  html += '<div class="ar-sec"><h3>PROTOKOLL DES ZEITRAUMS (' + d.audit.length + ')</h3>';
  if (!d.audit.length) html += '<div class="wsc-empty">Keine Einträge mit dieser Sitzungs-ID.</div>';
  else html += '<div class="ar-scroll"><table class="ar-tbl"><tr>'
    + '<th>Zeitpunkt</th><th>Actor</th><th>Aktion</th><th>Ergebnis</th></tr>'
    + d.audit.map(function(a){
        return '<tr><td>' + fmt(a.ts) + '</td><td>' + (privacyOn ? 'Admin' : esc(a.actor))
          + '</td><td>' + esc(CC.audit.summary(a)) + '</td><td>' + esc(a.result) + '</td></tr>';
      }).join('') + '</table></div>';
  html += '</div>';

  html += '<div class="ar-foot">'
    + (d.contactVisible
        ? '<button class="btn primary" onclick="exportSession(\'' + esc(sid) + '\')">ARCHIV (.tar.gz)</button>'
        : '<span class="ar-note">Den Export darf nur der Team-Owner ziehen.</span>')
    + '<a class="btn" href="/giveaway/audit.html">IM AUDIT-LOG ÖFFNEN</a>'
    + '</div>';

  document.getElementById('ar-detail').innerHTML = html;
}

function exportSession(sid) {
  window.location.href = '/giveaway/api/archive/' + encodeURIComponent(sid)
    + '/export?team=' + encodeURIComponent(currentTeam);
}

document.addEventListener('DOMContentLoaded', function(){
  if (privacyOn) document.body.classList.add('privacy');
  loadTeams();
});
