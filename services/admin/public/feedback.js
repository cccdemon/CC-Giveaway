'use strict';
// Fehler/Idee an das Betreiberteam. Der Text geht an /admin/api/feedback,
// von dort in die Datenbank und in den Discord-Kanal des Teams.

var fbKind = 'bug';

document.getElementById('kinds').addEventListener('click', function (ev) {
  var card = ev.target.closest('.kind');
  if (!card) return;
  fbKind = card.getAttribute('data-kind');
  Array.prototype.forEach.call(document.querySelectorAll('.kind'), function (c) {
    c.classList.toggle('sel', c === card);
  });
});

document.getElementById('fb-msg').addEventListener('input', function () {
  document.getElementById('fb-count').textContent = this.value.length;
});

// Vorbelegung: von welcher Seite kommt die Person? Hilft beim Zuordnen.
(function () {
  var ref = document.referrer || '';
  var el = document.getElementById('fb-page');
  if (!el || !ref) return;
  try {
    var u = new URL(ref);
    if (u.host === window.location.host) el.value = u.pathname;
  } catch (e) { /* egal */ }
})();

var ERR = {
  unauthenticated: 'Bitte zuerst einloggen.',
  bad_kind: 'Bitte oben auswählen, worum es geht.',
  too_short: 'Bitte schreib ein paar Sätze mehr — mindestens 10 Zeichen.',
  rate_limited: 'Eine Meldung pro Minute. Kurz warten, dann erneut abschicken.',
};

function setOut(text, ok) {
  var el = document.getElementById('fb-msgout');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function sendFeedback() {
  var btn = document.getElementById('fb-send');
  var msg = document.getElementById('fb-msg').value.trim();
  var page = document.getElementById('fb-page').value.trim();
  if (msg.length < 10) { setOut(ERR.too_short, false); return; }
  btn.disabled = true;
  setOut('Wird gesendet …', true);
  try {
    var r = await fetch('/admin/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: fbKind, message: msg, page: page }),
    });
    if (r.status === 401) { window.location.href = '/admin/login.html'; return; }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { setOut(ERR[j.error] || ('Fehler: ' + (j.error || r.status)), false); btn.disabled = false; return; }
    document.getElementById('fb-msg').value = '';
    document.getElementById('fb-count').textContent = '0';
    setOut(j.delivered
      ? 'Danke! Deine Meldung ist beim Betreiberteam angekommen.'
      : 'Danke! Gespeichert — die Weiterleitung an Discord klemmt gerade, das Team sieht sie trotzdem.', true);
  } catch (e) {
    setOut('Fehler: ' + e.message, false);
  }
  setTimeout(function () { btn.disabled = false; }, 3000);
}
