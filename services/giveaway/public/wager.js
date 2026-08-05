// ════════════════════════════════════════════════════════
// CHAOS CREW – Lose setzen (CORE_TicketBuy, Phase 4c)
// Nur der eingeloggte Zuschauer selbst — Identität aus der Twitch-Session.
// ════════════════════════════════════════════════════════

function esc(s) {
  return (window.CC && CC.validate) ? CC.validate.escHtml(s)
    : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtEnd(ts) {
  if (!ts) return 'offen bis zur Ziehung';
  var d = new Date(ts);
  return (d.getTime() < Date.now() ? 'Einsatz-Ende vorbei: ' : 'Einsatz-Ende: ')
       + d.toLocaleString('de-DE');
}

var ERRORS = {
  no_prize: 'Diesen Preis gibt es nicht (oder er ist schon gezogen).',
  wager_closed: 'Das Einsatz-Ende ist vorbei — der Einsatz ist gebunden.',
  no_credit: 'Nicht genug Guthaben.',
  nothing_to_refund: 'Auf diesen Preis hast du nichts gesetzt.',
  bad_request: 'Ungültige Eingabe.',
};

function load() {
  fetch('/giveaway/api/wager/state').then(function(r) {
    if (r.status === 401) { window.location.href = '/admin/login.html?next=/giveaway/wager.html'; return null; }
    return r.json();
  }).then(function(d) {
    if (!d) return;
    var host = document.getElementById('wg-body');
    if (d.error) { host.innerHTML = '<span class="wg-msg err">' + esc(d.error) + '</span>'; return; }
    if (!d.teams || !d.teams.length) {
      host.innerHTML = '<span class="wg-empty">Aktuell kein Los-Guthaben und keine offenen Preise. '
        + 'Guthaben entsteht durch Zuschauen, während ein Los-Giveaway läuft.</span>';
      return;
    }
    host.innerHTML = d.teams.map(renderTeam).join('');
  }).catch(function(e) {
    document.getElementById('wg-body').innerHTML = '<span class="wg-msg err">' + esc(e.message) + '</span>';
  });
}

function renderTeam(t) {
  var prizes = (t.prizes || []).map(function(p) { return renderPrize(t.teamId, p); }).join('')
            || '<span class="wg-empty">Keine offenen Preise.</span>';
  return '<div class="wg-team"><h2>' + esc(t.teamId) + '</h2>'
    + '<div class="wg-balance">Dein Guthaben: <b>' + Number(t.available).toFixed(2) + '</b> Lose</div>'
    + (t.wagerCmd ? '<div class="wg-cmd">Geht auch im Chat: „' + esc(t.wagerCmd)
        + ' &lt;preis-nr&gt; &lt;anzahl&gt;" · Rücknahme mit Anzahl 0.</div>' : '')
    + prizes + '</div>';
}

function renderPrize(teamId, p) {
  var drawn = p.status !== 'open';
  var own = Number(p.myStake) || 0;
  return '<div class="wg-prize' + (drawn ? ' drawn' : '') + '" id="prize-' + p.id + '">'
    + '<h3>#' + p.id + ' ' + esc(p.title) + '</h3>'
    + (p.description ? '<div class="wg-meta">' + esc(p.description) + '</div>' : '')
    + '<div class="wg-meta">' + esc(fmtEnd(p.wager_end)) + ' · Einsätze gesamt: '
    + Number(p.total_stake).toFixed(0) + (own ? ' · <span class="own">dein Einsatz: ' + own.toFixed(0) + '</span>' : '')
    + (drawn ? ' · GEZOGEN' : '') + '</div>'
    + (drawn ? '' :
        '<div class="wg-row">'
      + '<input type="number" min="1" step="1" value="1" id="amt-' + p.id + '">'
      + '<button class="btn btn-gold btn-sm" onclick="setWager(\'' + esc(teamId) + '\',' + p.id + ')">SETZEN</button>'
      + (own ? '<button class="btn btn-red btn-sm" onclick="retract(\'' + esc(teamId) + '\',' + p.id + ')">ZURÜCKNEHMEN</button>' : '')
      + '</div><div class="wg-msg" id="msg-' + p.id + '"></div>')
    + '</div>';
}

function post(teamId, prizeId, amount) {
  var el = document.getElementById('msg-' + prizeId);
  fetch('/giveaway/api/wager', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamId, prizeId: prizeId, amount: amount }),
  }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(x) {
      if (!x.ok) { if (el) { el.className = 'wg-msg err'; el.textContent = ERRORS[x.j.error] || x.j.error; } return; }
      if (el) {
        el.className = 'wg-msg ok';
        el.textContent = x.j.refunded !== undefined
          ? 'Einsatz zurückgenommen (+' + x.j.refunded + ').'
          : 'Gesetzt ✅ — dein Einsatz: ' + x.j.stake + ', Restguthaben: ' + Number(x.j.balance).toFixed(2);
      }
      setTimeout(load, 900);
    })
    .catch(function(e) { if (el) { el.className = 'wg-msg err'; el.textContent = e.message; } });
}

function setWager(teamId, prizeId) {
  var amt = parseInt((document.getElementById('amt-' + prizeId) || {}).value, 10);
  if (!Number.isFinite(amt) || amt < 1) return;
  post(teamId, prizeId, amt);
}

function retract(teamId, prizeId) {
  post(teamId, prizeId, 0);
}

load();
setInterval(load, 30000);
