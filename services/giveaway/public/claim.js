'use strict';

// ── Gewinnermeldung ───────────────────────────────────────
// Die Seite liegt hinter dem Login: wer hier etwas eintraegt, ist als der
// Gewinner angemeldet. Ein Direktlink aus dem Chat fuehrt nur hierher, er
// berechtigt nicht — sonst koennte jeder Chat-Mitleser fremde Daten hinterlegen.

var claims = [];

function esc(s) {
  return (window.CC && CC.validate && typeof CC.validate.escHtml === 'function')
    ? CC.validate.escHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtDate(iso) {
  var d = new Date(iso);
  return isNaN(d.getTime()) ? '–' : d.toLocaleString('de-DE',
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function daysLeft(iso) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

async function load() {
  try {
    var d = await (await fetch('/giveaway/api/claim/mine')).json();
    if (d.error) throw new Error(d.error);
    claims = d.claims || [];
    render();
    document.getElementById('cl-priv').innerHTML =
      'Angemeldet als <b>' + esc(d.user) + '</b>. Welche Daten über dich gespeichert sind, siehst du unter '
      + '<a href="/admin/meine-daten.html">Meine Daten</a> — dort kannst du sie auch löschen lassen.';
  } catch(e) {
    document.getElementById('cl-list').innerHTML =
      '<div class="wsc-empty">Nicht ladbar: ' + esc(e.message) + '</div>';
  }
}

function render() {
  var el = document.getElementById('cl-list');
  if (!claims.length) {
    el.innerHTML = '<div class="wsc-empty">Für dich liegt gerade kein Gewinn zum Melden vor. '
                 + 'Sobald du gezogen wirst, erscheint er hier.</div>';
    return;
  }
  el.innerHTML = claims.map(function(c, i){ return card(c, i); }).join('');
}

function card(c, i) {
  var done    = c.status === 'claimed';
  var expired = c.status === 'expired' || (c.overdue && !done);
  var cls     = done ? 'done' : (expired ? 'expired' : '');
  var left    = daysLeft(c.deadline_at);

  // P4: Gewichtstext je Mechanik (Server liefert unit/drawKind je Claim).
  var statTxt;
  if (c.drawKind === 'equal')         statTxt = 'Sofortverlosung (gleiche Chance)';
  else if (c.drawKind === 'score')    statTxt = Number(c.winner_coins || 0).toFixed(0) + ' Punkte im Voting';
  else if (c.drawKind === 'perPrize') statTxt = Number(c.winner_coins || 0).toFixed(0) + ' ' + (c.unit || 'Lose') + ' gesetzt';
  else                                statTxt = Number(c.winner_coins || 0).toFixed(2) + ' ' + (c.unit || 'Punkte');
  var head = '<h3>' + esc(c.team_name || c.team_id) + (c.prize ? ' — ' + esc(c.prize) : '') + '</h3>'
    + '<div class="cl-meta">Gezogen am ' + fmtDate(c.drawn_at)
    + ' · ' + statTxt
    + ' · Meldefrist bis <span class="cl-deadline' + (expired ? ' over' : '') + '">'
    + fmtDate(c.deadline_at) + (done || expired ? '' : ' (noch ' + left + ' Tage)') + '</span></div>';

  if (done) {
    return '<div class="cl-card done">' + head
      + '<div class="cl-msg ok">✓ Gemeldet am ' + fmtDate(c.claimed_at) + '.</div>'
      + '<div class="cl-meta" style="margin-top:8px">Hinterlegt: ' + esc(c.real_name || '–')
      + ' · ' + esc(c.email || '–')
      + (c.city ? ' · ' + esc([c.zip, c.city, c.country].filter(Boolean).join(' ')) : '')
      + '<br>Automatische Löschung dieser Kontaktdaten: ' + fmtDate(c.purge_at) + '</div>'
    + '</div>';
  }
  if (c.status === 'replaced') {
    return '<div class="cl-card expired">' + head
      + '<div class="cl-msg err">Für diese Ziehung wurde ein Ersatzgewinner gezogen — '
      + 'dieser Gewinn kann nicht mehr gemeldet werden.</div></div>';
  }
  if (expired) {
    return '<div class="cl-card expired">' + head
      + '<div class="cl-msg err">Die Meldefrist ist abgelaufen. Melde dich beim Veranstalter, '
      + 'falls du das für einen Irrtum hältst.</div></div>';
  }

  var f = function(id, label, type, ph, wide) {
    return '<div class="cl-field' + (wide ? ' wide' : '') + '"><label for="' + id + i + '">' + label + '</label>'
      + (type === 'textarea'
          ? '<textarea id="' + id + i + '" placeholder="' + ph + '"></textarea>'
          : '<input type="' + type + '" id="' + id + i + '" placeholder="' + ph + '">')
      + '</div>';
  };
  return '<div class="cl-card">' + head
    + '<div class="cl-grid">'
      + f('real_name', 'NAME *',   'text',  'Vor- und Nachname', true)
      + f('email',     'E-MAIL *', 'email', 'fuer die Kontaktaufnahme', true)
      + f('street',    'STRASSE & NR.', 'text', 'nur bei Versand')
      + f('zip',       'PLZ',      'text',  '')
      + f('city',      'ORT',      'text',  '')
      + f('country',   'LAND',     'text',  'Deutschland')
      + f('note',      'ANMERKUNG', 'textarea', 'optional, z.B. Wunschgroesse', true)
    + '</div>'
    + '<label class="cl-consent"><input type="checkbox" id="terms' + i + '">'
      + '<span>Ich bestätige die <a href="/viewer/terms?team=' + encodeURIComponent(c.team_id)
      + '" target="_blank" rel="noopener">Teilnahmebedingungen</a> und bin damit einverstanden, dass '
      + 'diese Daten zur Zustellung des Gewinns verarbeitet und danach gelöscht werden.</span></label>'
    + '<button class="btn primary" onclick="submitClaim(' + i + ')">MELDUNG ABSCHICKEN</button>'
    + '<div class="cl-msg" id="msg' + i + '"></div>'
  + '</div>';
}

async function submitClaim(i) {
  var c = claims[i];
  var msg = document.getElementById('msg' + i);
  var get = function(id) { var el = document.getElementById(id + i); return el ? el.value.trim() : ''; };
  var body = {
    id: c.id,
    real_name: get('real_name'), email: get('email'), street: get('street'),
    zip: get('zip'), city: get('city'), country: get('country'), note: get('note'),
    acceptTerms: document.getElementById('terms' + i).checked,
  };
  msg.className = 'cl-msg';
  msg.textContent = 'Sende…';
  try {
    var r = await fetch('/giveaway/api/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
    msg.className = 'cl-msg ok';
    msg.textContent = '✓ Gemeldet. Der Veranstalter meldet sich bei dir.';
    load();
  } catch(e) {
    msg.className = 'cl-msg err';
    msg.textContent = e.message;
  }
}

document.addEventListener('DOMContentLoaded', load);
