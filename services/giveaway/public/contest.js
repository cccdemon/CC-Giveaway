// ════════════════════════════════════════════════════════
// CHAOS CREW – Screenshot-Contest (CORE_ScreenshotContest, Phase 6)
// Einsenden + Voten, nur als eingeloggter Zuschauer (Twitch-Session).
// ════════════════════════════════════════════════════════

function esc(s) {
  return (window.CC && CC.validate) ? CC.validate.escHtml(s)
    : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

var ERRORS = {
  voting_not_open: 'Das Voting ist gerade nicht offen.',
  not_enough_watchtime: 'Du brauchst mehr Zuschauzeit, um mitzumachen.',
  not_following: 'Einsenden können nur Follower der Contest-Kanäle.',
  own_entry: 'Die eigene Einsendung kannst du nicht bewerten.',
  no_entry: 'Diese Einsendung gibt es nicht (mehr).',
  contest_closed: 'Der Contest ist geschlossen.',
  rate_limited: 'Langsam — eine Wertung pro Sekunde.',
  image_too_large: 'Bild zu groß (max. 2 MB).',
  bad_mime: 'Nur PNG, JPEG oder WebP.',
  banned: 'Du bist von diesem Giveaway ausgeschlossen.',
};

function load() {
  fetch('/giveaway/api/contest/state').then(function(r) {
    if (r.status === 401) { window.location.href = '/admin/login.html?next=/giveaway/contest.html'; return null; }
    return r.json();
  }).then(function(d) {
    if (!d) return;
    var host = document.getElementById('sc-body');
    if (d.error) { host.innerHTML = '<span class="sc-msg err">' + esc(d.error) + '</span>'; return; }
    if (!d.contests || !d.contests.length) {
      host.innerHTML = '<span class="sc-empty">Aktuell läuft kein Screenshot-Contest bei deinen Teams.</span>';
      return;
    }
    host.innerHTML = d.contests.map(renderContest).join('');
  }).catch(function(e) {
    document.getElementById('sc-body').innerHTML = '<span class="sc-msg err">' + esc(e.message) + '</span>';
  });
}

function renderContest(c) {
  var votingTxt = { open: 'Voting OFFEN', paused: 'Voting pausiert', closed: 'Voting geschlossen' }[c.voting] || c.voting;
  var head = '<div class="sc-team" id="ct-' + esc(c.teamId) + '"><h2>' + esc(c.teamId) + '</h2>'
    + '<div class="sc-state">' + votingTxt
    + (c.minWatch ? ' · Mindest-Zuschauzeit: ' + Math.round(c.minWatch / 60) + ' min (du: ' + Math.round(c.watchSec / 60) + ' min)' : '')
    + '</div>';

  var submit;
  if (!c.canSubmit) {
    submit = '<div class="sc-submit"><h3>Einsenden</h3><div class="sc-meta">'
      + (!c.followsHost ? 'Folge zuerst einem Contest-Kanal.' : 'Dir fehlt noch Zuschauzeit.') + '</div></div>';
  } else {
    var voteHint = c.myEntry && c.myEntry.votes > 0
      ? '<div class="sc-warn">⚠ Achtung: Beim Ersetzen verfallen die ' + c.myEntry.votes
        + ' bereits abgegebenen Stimmen für deinen aktuellen Screenshot!</div>' : '';
    submit = '<div class="sc-submit"><h3>' + (c.myEntry ? 'Deine Einsendung ersetzen' : 'Screenshot einsenden') + '</h3>'
      + (c.myEntry ? '<div class="sc-meta">Aktuell: „' + esc(c.myEntry.title || '—') + '" [' + esc(c.myEntry.status) + ', '
          + c.myEntry.votes + ' Stimmen]</div>' : '')
      + voteHint
      + '<div class="sc-row"><input type="text" id="title-' + esc(c.teamId) + '" placeholder="Titel (optional)" maxlength="100">'
      + '<input type="file" id="file-' + esc(c.teamId) + '" accept="image/png,image/jpeg,image/webp">'
      + '<button class="btn btn-gold btn-sm" onclick="submitEntry(\'' + esc(c.teamId) + '\',' + (c.myEntry ? c.myEntry.votes : 0) + ')">EINSENDEN</button></div>'
      + '<div class="sc-msg" id="smsg-' + esc(c.teamId) + '"></div>'
      + '<div class="sc-meta">Jede Einsendung wird vor der Freigabe vom Veranstalter geprüft.</div></div>';
  }

  var cards = (c.entries || []).filter(function(e){ return e.status === 'approved' || e.own; })
    .map(function(e){ return renderEntry(c, e); }).join('');
  return head + submit
    + '<div class="sc-grid">' + (cards || '<span class="sc-empty">Noch keine freigegebenen Einsendungen.</span>') + '</div>'
    + '</div>';
}

function renderEntry(c, e) {
  var voteRow = '';
  if (!e.own && e.status === 'approved') {
    if (c.voting === 'open' && c.canVote) {
      var btns = '';
      for (var i = 1; i <= 10; i++) {
        btns += '<button class="' + (e.myScore === i ? 'sel' : '') + '" onclick="vote(\'' + esc(c.teamId) + '\',' + e.entryId + ',' + i + ')">' + i + '</button>';
      }
      voteRow = '<div class="sc-votes">' + btns + '</div>';
    } else {
      voteRow = '<div class="sc-meta">' + (e.myScore ? 'Deine Wertung: ' + e.myScore : 'Voting derzeit nicht offen.') + '</div>';
    }
  }
  return '<div class="sc-card' + (e.own ? ' own' : '') + '">'
    + '<img src="/giveaway/api/contest/image/' + e.entryId + '" alt="" loading="lazy" onclick="window.open(this.src)">'
    + '<div class="sc-body"><h4>' + esc(e.title || 'Ohne Titel') + '</h4>'
    + '<div class="sc-meta">von ' + esc(e.username) + (e.own ? ' (du, Status: ' + esc(e.status) + ')' : '') + '</div>'
    + voteRow
    + '<div class="sc-msg" id="vmsg-' + e.entryId + '"></div>'
    + '</div></div>';
}

function submitEntry(teamId, existingVotes, forceConfirm) {
  var fileEl = document.getElementById('file-' + teamId);
  var msgEl  = document.getElementById('smsg-' + teamId);
  var file = fileEl && fileEl.files && fileEl.files[0];
  if (!file) { if (msgEl) { msgEl.className = 'sc-msg err'; msgEl.textContent = 'Bitte ein Bild wählen.'; } return; }
  // Warnung VOR dem Ersetzen: bereits abgegebene Stimmen verfallen.
  if (existingVotes > 0 && !forceConfirm && !confirm('Achtung: Deine bisherige Einsendung hat ' + existingVotes
      + ' Stimmen.\n\nBeim Ersetzen VERFALLEN diese Stimmen unwiderruflich.\n\nTrotzdem ersetzen?')) return;
  var reader = new FileReader();
  reader.onload = function() {
    var b64 = String(reader.result).split(',')[1] || '';
    fetch('/giveaway/api/contest/entry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: teamId, title: (document.getElementById('title-' + teamId) || {}).value || '',
                             mime: file.type, imageBase64: b64,
                             confirmReplace: existingVotes > 0 || !!forceConfirm }),
    }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
      .then(function(x) {
        if (!x.ok) {
          if (x.j.error === 'votes_would_be_lost') {   // Server-seitige Doppelsicherung
            if (confirm('Deine bisherige Einsendung hat ' + x.j.votes + ' Stimmen — beim Ersetzen verfallen sie. Fortfahren?')) {
              submitEntry(teamId, 0, true);
            }
            return;
          }
          if (msgEl) { msgEl.className = 'sc-msg err'; msgEl.textContent = ERRORS[x.j.error] || x.j.error; }
          return;
        }
        if (msgEl) { msgEl.className = 'sc-msg ok'; msgEl.textContent = 'Eingesendet ✅ — wartet auf Freigabe durch den Veranstalter.'; }
        setTimeout(load, 900);
      })
      .catch(function(e) { if (msgEl) { msgEl.className = 'sc-msg err'; msgEl.textContent = e.message; } });
  };
  reader.readAsDataURL(file);
}

function vote(teamId, entryId, score) {
  var el = document.getElementById('vmsg-' + entryId);
  fetch('/giveaway/api/contest/vote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: teamId, entryId: entryId, score: score }),
  }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(x) {
      if (!x.ok) { if (el) { el.className = 'sc-msg err'; el.textContent = ERRORS[x.j.error] || x.j.error; } return; }
      if (el) { el.className = 'sc-msg ok'; el.textContent = 'Wertung gespeichert: ' + score; }
      setTimeout(load, 600);
    })
    .catch(function(e) { if (el) { el.className = 'sc-msg err'; el.textContent = e.message; } });
}

load();
setInterval(load, 30000);
