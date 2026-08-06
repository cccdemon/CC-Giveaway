'use strict';

// ── Gewinn-Abwicklung (Inbox) ─────────────────────────────
// Operativer Blick auf draw_claims: Wer hat gewonnen, wer hat sich gemeldet,
// was ist zu tun. NUR Owner — hier stehen die einzigen Klardaten des Systems.
// status = was der Gewinner getan hat (pending/claimed/expired),
// handling = was der Veranstalter getan hat (contacted/shipped/done).

var currentTeam = null;
var claims      = [];
var filter      = 'todo';
var privacyOn   = localStorage.getItem('cc_privacy') === '1';

function esc(s) {
  return (window.CC && CC.validate && typeof CC.validate.escHtml === 'function')
    ? CC.validate.escHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmt(iso) {
  if (!iso) return '–';
  var d = new Date(iso);
  return isNaN(d.getTime()) ? '–'
    : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function mask(name) { return privacyOn ? 'Zuschauer' : esc(name || '–'); }

async function loadTeams() {
  try {
    var teams = await (await fetch('/admin/api/teams/mine')).json();
    var owned = (Array.isArray(teams) ? teams : []).filter(function(t){ return t.role === 'owner'; });
    var sel = document.getElementById('team-select');
    if (!owned.length) {
      sel.innerHTML = '<option>— kein eigenes Team —</option>';
      document.getElementById('cl-list').innerHTML =
        '<div class="wsc-empty">Die Gewinn-Abwicklung sieht nur der Team-Owner (Kontaktdaten).</div>';
      return;
    }
    sel.innerHTML = owned.map(function(t){
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + ' ★</option>';
    }).join('');
    currentTeam = owned[0].id;
    sel.value = currentTeam;
    load();
  } catch(e) {
    document.getElementById('cl-list').innerHTML = '<div class="wsc-empty">' + esc(e.message) + '</div>';
  }
}

function onTeamChange() {
  currentTeam = document.getElementById('team-select').value;
  load();
}

async function load() {
  try {
    var d = await (await fetch('/giveaway/api/claims?team=' + encodeURIComponent(currentTeam))).json();
    if (d.error) throw new Error(d.error);
    claims = d.claims || [];
    render();
  } catch(e) {
    document.getElementById('cl-list').innerHTML = '<div class="wsc-empty">' + esc(e.message) + '</div>';
  }
}

// „Zu tun" = alles, was noch Aufmerksamkeit braucht: Gewinner hat sich
// gemeldet, aber die Abwicklung ist nicht 'done' — oder die Frist läuft/lief.
function isTodo(c) {
  if (c.status === 'claimed') return c.handling !== 'done';
  return c.status === 'pending';   // wartet auf Gewinner (inkl. overdue)
}

var FILTERS = [
  { key: 'todo',    label: 'ZU TUN',            test: isTodo },
  { key: 'claimed', label: 'GEMELDET',          test: function(c){ return c.status === 'claimed'; } },
  { key: 'pending', label: 'WARTET AUF GEWINNER', test: function(c){ return c.status === 'pending' && !c.overdue; } },
  { key: 'overdue', label: 'FRIST ABGELAUFEN',  test: function(c){ return c.overdue || c.status === 'expired'; } },
  { key: 'all',     label: 'ALLE',              test: function(){ return true; } },
];

function render() {
  var fEl = document.getElementById('cl-filters');
  fEl.innerHTML = FILTERS.map(function(f){
    var n = claims.filter(f.test).length;
    return '<button class="cl-filter' + (filter === f.key ? ' active' : '') + '" onclick="setFilter(\'' + f.key + '\')">'
      + f.label + '<span class="n">' + n + '</span></button>';
  }).join('');

  var rows = claims.filter((FILTERS.find(function(f){ return f.key === filter; }) || FILTERS[0]).test);
  var el = document.getElementById('cl-list');
  if (!rows.length) { el.innerHTML = '<div class="wsc-empty">Nichts in dieser Ansicht.</div>'; return; }
  el.innerHTML = rows.map(renderItem).join('');
}

var HANDLING_LABEL = { contacted: 'KONTAKTIERT', shipped: 'VERSENDET', done: 'ERLEDIGT' };

function renderItem(c) {
  var stat = c.status === 'claimed'
             ? '<span class="cl-badge claimed">' + (c.claim_source === 'external' ? 'EXTERN GEMELDET' : 'GEMELDET') + '</span>'
           : c.status === 'expired' ? '<span class="cl-badge expired">VERFALLEN</span>'
           : c.overdue              ? '<span class="cl-badge expired">FRIST ABGELAUFEN</span>'
           :                          '<span class="cl-badge pending">WARTET AUF GEWINNER</span>';
  var hand = c.handling ? ' <span class="cl-badge h">' + (HANDLING_LABEL[c.handling] || esc(c.handling)) + '</span>' : '';
  var purged = c.purged_at ? ' <span class="cl-badge purged">KONTAKTDATEN GELÖSCHT</span>' : '';

  var html = '<div class="cl-item' + (c.overdue ? ' overdue' : '') + '">'
    + '<div class="cl-head"><span class="win">' + mask(c.winner) + '</span>'
    + (c.prize ? '<span class="prize">🎁 ' + esc(c.prize) + '</span>' : '')
    + stat + hand + purged + '</div>'
    + '<div class="cl-sub">Gezogen: ' + fmt(c.drawn_at)
    + ' · Meldefrist: ' + fmt(c.deadline_at)
    + (c.claimed_at ? ' · Gemeldet: ' + fmt(c.claimed_at) : '')
    + (c.handled_at ? ' · Stand gesetzt: ' + fmt(c.handled_at) + (c.handled_by ? ' von ' + esc(c.handled_by) : '') : '')
    + '</div>';

  if (c.status === 'claimed' && !c.purged_at && c.claim_source !== 'external') {
    html += '<div class="cl-contact"><span class="warn">KONTAKTDATEN — vertraulich, nur für den Versand</span>'
      + esc(c.real_name || '–') + ' · ' + esc(c.email || '–')
      + (c.street ? '<br>' + esc(c.street) + ', ' + esc(c.zip || '') + ' ' + esc(c.city || '') + (c.country ? ', ' + esc(c.country) : '') : '')
      + (c.note ? '<br>Hinweis: ' + esc(c.note) : '')
      + '</div>';
  }
  if (c.status === 'claimed' && c.claim_source === 'external') {
    html += '<div class="cl-sub">Meldung außerhalb der Plattform erfasst (z. B. WhatsApp/Discord) — keine Kontaktdaten gespeichert.</div>';
  }

  if (c.overdue || c.status === 'expired') {
    html += '<div class="cl-hint-red">Frist verstrichen ohne Meldung — Ersatz ziehst du im Dashboard mit ★ (neue Ziehung derselben Sitzung).</div>';
  }

  // Gewinner hat sich außerhalb der Plattform gemeldet → Owner erfasst das.
  if (c.status === 'pending' || c.status === 'expired') {
    html += '<div class="cl-actions">'
      + '<button class="btn btn-gold btn-sm" onclick="markExternal(' + c.id + ')" '
      + 'title="Der Gewinner hat sich z. B. per WhatsApp/Discord/live gemeldet — Frist gilt als erfüllt, danach Stand setzen (kontaktiert/versendet/erledigt)">'
      + '✔ EXTERN GEMELDET</button></div>';
  }

  if (c.status === 'claimed') {
    html += '<div class="cl-actions">';
    [['contacted', 'KONTAKTIERT'], ['shipped', 'VERSENDET'], ['done', 'ERLEDIGT']].forEach(function(h) {
      var active = c.handling === h[0];
      html += '<button class="btn btn-sm ' + (active ? 'btn-solid' : 'btn-cyan') + '" '
        + 'onclick="setHandling(' + c.id + ',\'' + h[0] + '\')">' + h[1] + '</button>';
    });
    if (!c.purged_at) {
      html += '<button class="btn btn-red btn-sm" onclick="purgeContact(' + c.id + ')">KONTAKTDATEN LÖSCHEN</button>';
    }
    html += '</div>';
  }
  return html + '</div>';
}

function setFilter(f) { filter = f; render(); }

async function markExternal(claimId) {
  if (!confirm('Meldung außerhalb der Plattform erfassen? Der Gewinn gilt damit als fristgerecht gemeldet '
    + '(Nachweis: „extern gemeldet" + Zeitpunkt). Danach den Abwicklungs-Stand setzen.')) return;
  try {
    var r = await (await fetch('/giveaway/api/claims/external', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, claimId: claimId }),
    })).json();
    if (r.error) throw new Error(r.error);
    load();
  } catch(e) { alert('Erfassen fehlgeschlagen: ' + e.message); }
}

async function setHandling(claimId, handling) {
  try {
    var r = await (await fetch('/giveaway/api/claims/handling', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, claimId: claimId, handling: handling }),
    })).json();
    if (r.error) throw new Error(r.error);
    load();
  } catch(e) { alert('Stand setzen fehlgeschlagen: ' + e.message); }
}

async function purgeContact(claimId) {
  if (!confirm('Kontaktdaten dieses Gewinners jetzt endgültig löschen? Der Ziehungsnachweis bleibt erhalten.')) return;
  try {
    var r = await (await fetch('/giveaway/api/claims/purge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: currentTeam, claimId: claimId }),
    })).json();
    if (r.error) throw new Error(r.error);
    load();
  } catch(e) { alert('Löschen fehlgeschlagen: ' + e.message); }
}

loadTeams();
