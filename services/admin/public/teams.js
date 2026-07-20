'use strict';
// Multi-tenant teams UI. Talks to /admin/api/teams*.

var API = '/admin/api/teams';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
  return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
function setMsg(id, t, ok) { var el = document.getElementById(id); if (el) { el.textContent = t || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); } }
function inviteLink(code) { return location.origin + '/admin/join.html?code=' + encodeURIComponent(code); }

async function jfetch(url, opts) {
  var r = await fetch(url, opts);
  if (r.status === 401) { window.location.href = '/admin/login.html'; throw new Error('unauth'); }
  return r;
}

async function createTeam() {
  var name = document.getElementById('new-name').value.trim();
  if (!name) { setMsg('create-msg', 'Name fehlt', false); return; }
  try {
    var r = await jfetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name:name }) });
    var d = await r.json();
    if (r.ok) { setMsg('create-msg', 'Team angelegt: ' + d.name, true); document.getElementById('new-name').value=''; load(); }
    else setMsg('create-msg', 'Fehler: ' + (d.error||r.status), false);
  } catch(e){ if(e.message!=='unauth') setMsg('create-msg', e.message, false); }
}

async function joinByCode() {
  var code = document.getElementById('join-code').value.trim();
  if (!code) { setMsg('join-msg', 'Code fehlt', false); return; }
  try {
    var r = await jfetch(API + '/join', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code:code }) });
    var d = await r.json();
    if (r.ok) { setMsg('join-msg', 'Beigetreten!', true); document.getElementById('join-code').value=''; load(); }
    else setMsg('join-msg', d.error==='invalid_code' ? 'Ungültiger Code' : ('Fehler: '+(d.error||r.status)), false);
  } catch(e){ if(e.message!=='unauth') setMsg('join-msg', e.message, false); }
}

async function rotateInvite(id) {
  var r = await jfetch(API + '/' + id + '/invite', { method:'POST' });
  if (r.ok) load();
}
async function removeMember(id, login) {
  if (!confirm('„' + login + '" aus dem Team entfernen?')) return;
  var r = await jfetch(API + '/' + id + '/members/' + encodeURIComponent(login), { method:'DELETE' });
  if (r.ok) load();
}
function copyInvite(code) { navigator.clipboard && navigator.clipboard.writeText(inviteLink(code)); }

async function editImprint(id) {
  var box = document.getElementById('imprint-' + id);
  if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; }
  box.dataset.open = '1';
  box.innerHTML = '<div style="opacity:.6;font-size:12px;margin-top:8px">lädt…</div>';
  try {
    var d = await (await jfetch(API + '/' + id + '/imprint')).json();
    var missing = !d.imprint && !d.imprintUrl;
    box.innerHTML = '<div style="margin-top:10px">' +
      (missing ? '<div class="msg err" style="margin-bottom:6px">Pflichtangabe fehlt — ohne Impressum lässt sich kein Giveaway öffnen.</div>' : '') +
      '<div class="muted" style="font-size:12px;margin-bottom:4px">Entweder ein Link auf dein bestehendes Impressum …</div>' +
      '<input id="iu-'+id+'" value="'+esc(d.imprintUrl)+'" placeholder="https://dein-impressum.de" ' +
      'style="width:100%;background:#060a11;border:1px solid rgba(0,212,255,0.25);color:#c8dce8;border-radius:6px;padding:8px;font-size:12px;">' +
      '<div class="muted" style="font-size:12px;margin:8px 0 4px">… oder als Text (Markdown), der auf der Bedingungsseite erscheint:</div>' +
      '<textarea id="im-'+id+'" style="width:100%;height:170px;background:#060a11;border:1px solid rgba(0,212,255,0.25);color:#c8dce8;border-radius:6px;padding:10px;font-family:ui-monospace,monospace;font-size:12px;">'+
      esc(d.imprint)+'</textarea>' +
      '<div style="display:flex;gap:8px;margin-top:8px;align-items:center">' +
      '<button onclick="saveImprint(\''+id+'\')">Speichern</button>' +
      '<button class="ghost" onclick="editImprint(\''+id+'\')">Schließen</button>' +
      '<span class="msg" id="imsg-'+id+'"></span></div></div>';
  } catch(e){ if(e.message!=='unauth') box.innerHTML = '<div class="msg err">'+esc(e.message)+'</div>'; }
}

async function saveImprint(id) {
  var body = {
    imprint: document.getElementById('im-' + id).value,
    imprintUrl: document.getElementById('iu-' + id).value.trim(),
  };
  var m = document.getElementById('imsg-' + id);
  if (!body.imprint.trim() && !body.imprintUrl) {
    m.textContent = 'Mindestens Link oder Text angeben'; m.className = 'msg err'; return;
  }
  try {
    var r = await jfetch(API + '/' + id + '/imprint', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    var d = await r.json();
    if (r.ok) { m.textContent = d.unchanged ? 'Unverändert' : 'Gespeichert ✓'; m.className = 'msg ok'; }
    else { m.textContent = d.error || 'Fehler'; m.className = 'msg err'; }
  } catch(e){ if(e.message!=='unauth'){ m.textContent=e.message; m.className='msg err'; } }
}

async function editTerms(id) {
  var box = document.getElementById('terms-' + id);
  if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; }
  box.dataset.open = '1';
  box.innerHTML = '<div style="opacity:.6;font-size:12px;margin-top:8px">lädt…</div>';
  try {
    var d = await (await jfetch(API + '/' + id + '/terms')).json();
    box.innerHTML =
      '<div style="margin-top:10px">' +
      (d.isDefault ? '<div style="font-size:12px;opacity:.55;margin-bottom:6px">Noch keine eigenen Bedingungen — Standard-Vorlage als Entwurf geladen.</div>' : '') +
      '<textarea id="ta-'+id+'" style="width:100%;height:280px;background:#060a11;border:1px solid rgba(0,212,255,0.25);color:#c8dce8;border-radius:6px;padding:10px;font-family:ui-monospace,monospace;font-size:12px;">'+
      esc(d.terms)+'</textarea>' +
      '<input id="tnote-'+id+'" placeholder="Was hast du geändert? (erscheint öffentlich im Änderungsverlauf)" ' +
      'style="width:100%;margin-top:8px;background:#060a11;border:1px solid rgba(0,212,255,0.25);color:#c8dce8;border-radius:6px;padding:8px;font-size:12px;">' +
      '<div style="display:flex;gap:8px;margin-top:8px;align-items:center">' +
      '<button onclick="saveTerms(\''+id+'\')">Speichern</button>' +
      '<button class="ghost" onclick="editTerms(\''+id+'\')">Schließen</button>' +
      '<span class="muted" style="font-size:12px">Markdown erlaubt (# Überschrift, **fett**, - Liste)</span>' +
      '<span class="msg" id="tmsg-'+id+'"></span></div>' +
      '<div id="thist-'+id+'" style="margin-top:12px"></div></div>';
    loadTermsHistory(id);
  } catch(e){ if(e.message!=='unauth') box.innerHTML = '<div class="msg err">'+esc(e.message)+'</div>'; }
}

// Jede Fassung wird mit Zeitpunkt und betroffenen Abschnitten festgehalten -
// hier zur Kontrolle, oeffentlich unter /viewer/terms sichtbar.
async function loadTermsHistory(id) {
  var box = document.getElementById('thist-' + id);
  if (!box) return;
  try {
    var d = await (await jfetch(API + '/' + id + '/terms/history')).json();
    if (!d.history || !d.history.length) {
      box.innerHTML = '<div class="muted" style="font-size:12px">Noch keine Aenderungen erfasst.</div>';
      return;
    }
    box.innerHTML = '<div class="muted" style="font-size:12px;margin-bottom:4px">Aenderungsverlauf (oeffentlich sichtbar)</div>'
      + d.history.map(function(h) {
          var secs = (h.sections || []).map(function(x) { return esc(x.section) + ' (' + esc(x.kind) + ')'; }).join(', ');
          return '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">'
               + '<b>Fassung ' + esc(String(h.version)) + '</b> - ' + esc(new Date(h.created_at).toLocaleString('de-DE'))
               + ' - <span class="muted">' + esc(h.changed_by) + '</span>'
               + (h.note ? '<br>' + esc(h.note) : '')
               + (secs ? '<br><span class="muted">Betroffen: ' + secs + '</span>' : '')
               + '</div>';
        }).join('');
  } catch(e) { if (e.message !== 'unauth') box.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
}

async function saveTerms(id) {
  var val = document.getElementById('ta-' + id).value;
  var noteEl = document.getElementById('tnote-' + id);
  var note = noteEl ? noteEl.value.trim() : '';
  try {
    var r = await jfetch(API + '/' + id + '/terms', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ terms: val, note: note }) });
    var m = document.getElementById('tmsg-' + id);
    if (r.ok) {
      var body = await r.json();
      m.textContent = body.unchanged ? 'Unverändert — keine neue Fassung' : ('Gespeichert ✓ Fassung ' + body.version);
      m.className = 'msg ok';
      if (noteEl) noteEl.value = '';
      loadTermsHistory(id);
    }
    else { m.textContent = 'Fehler'; m.className = 'msg err'; }
  } catch(e){ if(e.message!=='unauth'){ var m=document.getElementById('tmsg-'+id); if(m){m.textContent=e.message;m.className='msg err';} } }
}

async function load() {
  var host = document.getElementById('teams');
  try {
    var mine = await (await jfetch(API + '/mine')).json();
    if (!mine.length) { host.innerHTML = '<div class="muted">Noch kein Team. Gründe eins oder tritt per Code bei.</div>'; return; }
    var details = await Promise.all(mine.map(function(t){ return jfetch(API + '/' + t.id).then(function(r){return r.json();}).catch(function(){return null;}); }));
    host.innerHTML = details.filter(Boolean).map(renderTeam).join('');
  } catch(e){ if(e.message!=='unauth') host.innerHTML = '<div class="msg err">'+esc(e.message)+'</div>'; }
}

function renderTeam(t) {
  var owner = t.you_owner;
  var members = (t.members||[]).map(function(m){
    var rm = (owner && m.role !== 'owner')
      ? '<button class="danger" onclick="removeMember(\''+t.id+'\',\''+esc(m.login)+'\')">entfernen</button>' : '';
    return '<div class="member"><span>'+esc(m.login)+' <span class="muted">('+esc(m.role)+')</span></span>'+rm+'</div>';
  }).join('');
  var invite = owner
    ? '<div class="invite"><input readonly value="'+esc(inviteLink(t.invite_code))+'" onclick="this.select()">'
      + '<button class="ghost" onclick="copyInvite(\''+esc(t.invite_code)+'\')">Kopieren</button>'
      + '<button class="ghost" onclick="rotateInvite(\''+t.id+'\')">Neu</button></div>'
    : '';
  var overlay = (owner && t.overlay_key)
    ? '<div class="invite" style="margin-top:10px"><input readonly value="'
      + esc(location.origin + '/giveaway/giveaway-overlay.html?team=' + t.id + '&key=' + t.overlay_key)
      + '" onclick="this.select()" title="OBS Browser Source">'
      + '<button class="ghost" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.previousElementSibling.value)">OBS-Overlay kopieren</button></div>'
    : '';
  var terms = '<div class="invite" style="margin-top:10px">'
    + '<a class="ghost" style="text-decoration:none;padding:8px 12px;border-radius:6px" href="/viewer/terms?team='+encodeURIComponent(t.id)+'" target="_blank">Teilnahmebedingungen ansehen</a>'
    + (owner ? '<button class="ghost" onclick="editTerms(\''+t.id+'\')">Bearbeiten</button>' : '')
    + (owner ? '<button class="ghost" onclick="editImprint(\''+t.id+'\')">Impressum (Pflicht)</button>' : '')
    + '</div><div id="terms-'+t.id+'"></div><div id="imprint-'+t.id+'"></div>';
  return '<div class="team"><div class="team-head"><span class="team-name">'+esc(t.name)+'</span>'
    + (owner?'<span class="badge">OWNER</span>':'') + '</div>'
    + '<div class="members">'+members+'</div>' + invite + overlay + terms + '</div>';
}

load();
