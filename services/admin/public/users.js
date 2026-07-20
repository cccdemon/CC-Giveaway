'use strict';
// User management (superadmin). Talks to /admin/api/users.

var API = '/admin/api/users';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
  return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
}); }

function fmt(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '–'; }

function setMsg(id, text, ok) {
  var el = document.getElementById(id);
  el.textContent = text || '';
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function load() {
  try {
    var r = await fetch(API);
    if (r.status === 401) { window.location.href = '/admin/login.html'; return; }
    if (r.status === 403) { document.getElementById('rows').innerHTML =
      '<tr><td colspan="5" style="color:#ff5468">Nur superadmin darf Benutzer verwalten.</td></tr>'; return; }
    var users = await r.json();
    var rows = document.getElementById('rows');
    if (!users.length) { rows.innerHTML = '<tr><td colspan="5">keine Benutzer</td></tr>'; return; }
    rows.innerHTML = users.map(function(u) {
      return '<tr>' +
        '<td>' + esc(u.username) + '</td>' +
        '<td><span class="role ' + esc(u.role) + '">' + esc(u.role) + '</span></td>' +
        '<td>' + fmt(u.created_at) + '</td>' +
        '<td>' + fmt(u.last_login) + '</td>' +
        '<td><button class="danger" data-del="' + esc(u.username) + '">Löschen</button></td>' +
      '</tr>';
    }).join('');
    Array.prototype.forEach.call(rows.querySelectorAll('[data-del]'), function(b) {
      b.addEventListener('click', function() { del(b.getAttribute('data-del')); });
    });
  } catch (e) { setMsg('listMsg', 'Ladefehler: ' + e.message, false); }
}

async function del(username) {
  if (!confirm('Benutzer "' + username + '" löschen?')) return;
  try {
    var r = await fetch(API + '/' + encodeURIComponent(username), { method: 'DELETE' });
    var d = await r.json().catch(function(){ return {}; });
    if (r.ok) { setMsg('listMsg', 'Gelöscht: ' + username, true); load(); }
    else setMsg('listMsg', 'Fehler: ' + (d.error || r.status), false);
  } catch (e) { setMsg('listMsg', e.message, false); }
}

document.getElementById('addForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var body = {
    username: document.getElementById('nu').value,
    password: document.getElementById('np').value,
    role: document.getElementById('nr').value
  };
  try {
    var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var d = await r.json().catch(function(){ return {}; });
    if (r.ok) { setMsg('addMsg', 'Gespeichert: ' + d.user + ' (' + d.role + ')', true);
                document.getElementById('np').value = ''; load(); }
    else setMsg('addMsg', 'Fehler: ' + (d.error || r.status), false);
  } catch (ex) { setMsg('addMsg', ex.message, false); }
});

load();
