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
    else setMsg('join-msg',
      d.error==='invalid_code' ? 'Ungültiger Code'
      : d.error==='invites_disabled' ? 'Einladungen sind für dieses Team gerade deaktiviert'
      : d.error==='team_deactivated' ? 'Dieses Team ist deaktiviert'
      : ('Fehler: '+(d.error||r.status)), false);
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

// ── Team-Verwaltung (Issue #1): verlassen, umbenennen, übertragen,
// Einladungen pausieren, Kanal ändern, deaktivieren/reaktivieren ──
var TM_ERR = {
  giveaway_open: 'Nicht möglich, solange ein Giveaway läuft — erst schließen.',
  channel_taken: 'Diesen Kanal nutzt schon ein anderes Mitglied.',
  channel_invalid: 'Ungültiger Kanalname (a-z, 0-9, _, min. 3 Zeichen).',
  target_tos_missing: 'Der neue Owner muss zuerst den aktuellen Nutzungsbedingungen zustimmen (einloggen → Zustimmung).',
  not_a_member: 'Kein Mitglied dieses Teams.',
  owner_must_transfer: 'Als Owner erst die Eigentümerschaft übertragen.',
  confirm_mismatch: 'Teamname stimmt nicht überein — nichts passiert.',
  already_deactivated: 'Team ist bereits deaktiviert.',
  not_deactivated: 'Team ist nicht deaktiviert.',
  name_required: 'Name fehlt.',
};
function tmMsg(id, text, ok) {
  var el = document.getElementById('tm-msg-' + id);
  if (el) { el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
}
async function tmCall(id, url, opts, okText) {
  try {
    var r = await jfetch(url, opts);
    var d = await r.json().catch(function(){ return {}; });
    if (r.ok) { tmMsg(id, okText, true); load(); return true; }
    if (r.status === 451) { tmMsg(id, 'Bitte zuerst den Nutzungsbedingungen zustimmen (neu einloggen).', false); return false; }
    tmMsg(id, TM_ERR[d.error] || ('Fehler: ' + (d.error || r.status)), false);
    return false;
  } catch(e) { if (e.message !== 'unauth') tmMsg(id, e.message, false); return false; }
}

// Team-Daten je id (aus load()) — onclick-Handler bekommen NUR die id;
// Namen o.ä. gehören nicht in Attribut-Strings (Quote-Injection).
var tmData = {};

function leaveTeam(id) {
  var name = (tmData[id] && tmData[id].name) || id;
  if (!confirm('Team „' + name + '" wirklich verlassen? Dein Ingest-Token wird widerrufen.')) return;
  tmCall(id, API + '/' + id + '/leave', { method:'POST' }, 'Team verlassen.');
}

function renameTeam(id) {
  var name = (document.getElementById('rn-' + id) || {}).value || '';
  if (!name.trim()) { tmMsg(id, 'Name fehlt.', false); return; }
  tmCall(id, API + '/' + id + '/name',
    { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: name.trim() }) },
    'Umbenannt.');
}

function transferTeam(id) {
  var sel = document.getElementById('tr-' + id);
  var to = sel && sel.value;
  if (!to) { tmMsg(id, 'Mitglied auswählen.', false); return; }
  if (!confirm('Eigentümerschaft an „' + to + '" übertragen? Du wirst normales Mitglied; '
    + 'Veranstalter-Pflichten (Impressum, Nutzungsbedingungen) gehen auf „' + to + '" über.')) return;
  tmCall(id, API + '/' + id + '/transfer',
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to: to }) },
    'Übertragen — „' + to + '" ist jetzt Owner.');
}

function toggleInvites(id, enable) {
  tmCall(id, API + '/' + id + '/invites',
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: enable }) },
    enable ? 'Einladungen aktiv.' : 'Einladungen pausiert.');
}

function changeChannel(id) {
  var ch = ((document.getElementById('ch-' + id) || {}).value || '').trim().toLowerCase();
  if (!ch) { tmMsg(id, 'Kanal fehlt.', false); return; }
  if (!confirm('Eigenen Kanal auf „' + ch + '" ändern? Der alte Ingest-Token wird widerrufen — '
    + 'danach im Dashboard einen neuen Token erzeugen und in Streamerbot eintragen.')) return;
  tmCall(id, API + '/' + id + '/channel',
    { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ channel: ch }) },
    'Kanal geändert — neuen Ingest-Token im Dashboard erzeugen.');
}

function deactivateTeam(id) {
  var confirmName = (document.getElementById('deact-' + id) || {}).value || '';
  if (!confirmName.trim()) { tmMsg(id, 'Zur Bestätigung den Teamnamen eintippen.', false); return; }
  if (!confirm('Team wirklich deaktivieren? Alle Live-Daten (Zuschauzeiten, Anmeldungen) und '
    + 'Ingest-Tokens werden gelöscht. Ziehungsnachweise bleiben. Reaktivieren ist möglich.')) return;
  tmCall(id, API + '/' + id + '/deactivate',
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ confirmName: confirmName.trim() }) },
    'Team deaktiviert.');
}

function reactivateTeam(id) {
  tmCall(id, API + '/' + id + '/reactivate', { method:'POST' },
    'Team reaktiviert — Ingest-Tokens im Dashboard neu erzeugen.');
}

function renderMgmt(t) {
  var owner = t.you_owner;
  var inputStyle = 'background:var(--rdoc-bg);border:1px solid var(--rdoc-line-on-surface);color:var(--rdoc-text);border-radius:6px;padding:8px;font-size:12px;';
  var html = '<div style="margin-top:12px;border-top:1px solid var(--rdoc-border);padding-top:10px">'
    + '<div class="lk-sub">Verwaltung</div>';
  if (t.deactivated_at) {
    html += '<div class="msg err" style="margin-bottom:6px">Deaktiviert seit '
      + esc(new Date(t.deactivated_at).toLocaleString('de-DE'))
      + ' — es lassen sich keine Giveaways mehr öffnen.</div>'
      + (owner ? '<button onclick="reactivateTeam(\'' + t.id + '\')">Team reaktivieren</button>' : '');
    return html + '<span class="msg" id="tm-msg-' + t.id + '"></span></div>';
  }
  var me = (t.members || []).filter(function(m){ return m.login === t.you; })[0] || {};
  html += '<div class="invite"><input id="ch-' + t.id + '" value="' + esc(me.channel || '') + '" maxlength="25" style="' + inputStyle + '" title="Dein Twitch-Kanal in diesem Team">'
    + '<button class="ghost" onclick="changeChannel(\'' + t.id + '\')">Eigenen Kanal ändern</button></div>'
    + '<div class="muted" style="font-size:11px;margin:2px 0 8px">Nur ohne laufendes Giveaway. Der alte Ingest-Token wird widerrufen.</div>';
  if (owner) {
    var candidates = (t.members || []).filter(function(m){ return m.role !== 'owner'; });
    html += '<div class="invite"><input id="rn-' + t.id + '" value="' + esc(t.name) + '" maxlength="60" style="' + inputStyle + '">'
      + '<button class="ghost" onclick="renameTeam(\'' + t.id + '\')">Umbenennen</button></div>';
    html += '<div class="invite" style="margin-top:6px">'
      + '<select id="tr-' + t.id + '" style="' + inputStyle + '">'
      + '<option value="">— Mitglied wählen —</option>'
      + candidates.map(function(m){ return '<option value="' + esc(m.login) + '">' + esc(m.login) + '</option>'; }).join('')
      + '</select>'
      + '<button class="ghost" onclick="transferTeam(\'' + t.id + '\')"' + (candidates.length ? '' : ' disabled title="Keine weiteren Mitglieder"') + '>Eigentümerschaft übertragen</button></div>';
    html += '<div class="invite" style="margin-top:6px">'
      + '<button class="ghost" onclick="toggleInvites(\'' + t.id + '\',' + (t.invites_disabled ? 'true' : 'false') + ')">'
      + (t.invites_disabled ? 'Einladungen aktivieren' : 'Einladungen pausieren') + '</button>'
      + (t.invites_disabled ? '<span class="muted" style="font-size:11px">Beitritt per Code ist gerade abgeschaltet.</span>' : '')
      + '</div>';
    html += '<div class="invite" style="margin-top:10px"><input id="deact-' + t.id + '" placeholder="Teamname zur Bestätigung" style="' + inputStyle + '">'
      + '<button class="danger" onclick="deactivateTeam(\'' + t.id + '\')">Team deaktivieren</button></div>'
      + '<div class="muted" style="font-size:11px;margin-top:2px">Löscht Live-Daten und Tokens; Ziehungsnachweise und Protokolle bleiben. Reaktivieren möglich.</div>';
  } else {
    html += '<div class="invite" style="margin-top:6px"><button class="danger" onclick="leaveTeam(\'' + esc(t.id) + '\')">Team verlassen</button></div>';
  }
  return html + '<span class="msg" id="tm-msg-' + t.id + '"></span></div>';
}

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
      'style="width:100%;background:var(--rdoc-bg);border:1px solid var(--rdoc-line-on-surface);color:var(--rdoc-text);border-radius:6px;padding:8px;font-size:12px;">' +
      '<div class="muted" style="font-size:12px;margin:8px 0 4px">… oder als Text (Markdown), der auf der Bedingungsseite erscheint:</div>' +
      '<textarea id="im-'+id+'" style="width:100%;height:170px;background:var(--rdoc-bg);border:1px solid var(--rdoc-line-on-surface);color:var(--rdoc-text);border-radius:6px;padding:10px;font-family:var(--rdoc-font-mono);font-size:12px;">'+
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
      '<textarea id="ta-'+id+'" style="width:100%;height:280px;background:var(--rdoc-bg);border:1px solid var(--rdoc-line-on-surface);color:var(--rdoc-text);border-radius:6px;padding:10px;font-family:var(--rdoc-font-mono);font-size:12px;">'+
      esc(d.terms)+'</textarea>' +
      '<input id="tnote-'+id+'" placeholder="Was hast du geändert? (erscheint öffentlich im Änderungsverlauf)" ' +
      'style="width:100%;margin-top:8px;background:var(--rdoc-bg);border:1px solid var(--rdoc-line-on-surface);color:var(--rdoc-text);border-radius:6px;padding:8px;font-size:12px;">' +
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
          return '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--rdoc-border)">'
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
    // Oeffentliche Team-Daten dazu: daraus ergibt sich, ob das Impressum des
    // Veranstalters hinterlegt ist - ohne das laesst sich kein Giveaway oeffnen.
    var pub = await Promise.all(mine.map(function(t){
      return fetch('/admin/pub/team/' + encodeURIComponent(t.id))
        .then(function(r){ return r.json(); }).catch(function(){ return null; });
    }));
    tmData = {};
    details.filter(Boolean).forEach(function(t){ tmData[t.id] = t; });
    host.innerHTML = details.filter(Boolean).map(function(t, i) {
      return renderTeam(Object.assign({}, t, { pub: pub[i] || null }));
    }).join('');
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
    + (owner?'<span class="badge">OWNER</span>':'')
    + (t.deactivated_at?'<span class="badge" style="background:var(--rdoc-tint-error);color:var(--rdoc-error)">DEAKTIVIERT</span>':'') + '</div>'
    + '<div class="members">'+members+'</div>'
    + (t.deactivated_at ? '' : invite + overlay) + terms
    + renderMgmt(t)
    + legalLinks(t) + '</div>';
}

// Alle Adressen, die zu einem Giveaway gehoeren - zum Verlinken im
// Twitch-Panel, im Chat oder in der Videobeschreibung. Streamer muessen diese
// Angaben zugaenglich machen; sie hier zu suchen darf nicht die Huerde sein.
function legalLinks(t) {
  var base = location.origin;
  var hasImprint = !!(t.pub && (String(t.pub.imprint || '').trim() || String(t.pub.imprintUrl || '').trim()));
  var termsUrl = base + '/viewer/terms?team=' + encodeURIComponent(t.id);

  var own = [
    { label: 'Teilnahmebedingungen', url: termsUrl,
      hint: 'Enthaelt auch dein Impressum als Veranstalter. Diesen Link im Twitch-Panel verlinken.' },
    { label: 'Teilnehmer-Anleitung', url: base + '/viewer/help',
      hint: 'Erklaert Zuschauern, wie Lose entstehen.' },
    { label: 'Mein Status (Zuschauer)', url: base + '/viewer/status',
      hint: 'Zuschauer sehen dort ihre eigene Zuschauzeit und Lose.' }
  ];
  var platform = [
    { label: 'Impressum der Plattform', url: base + '/admin/impressum.html' },
    { label: 'Datenschutzerklaerung',   url: base + '/admin/datenschutz.html' },
    { label: 'Haftungsausschluss',      url: base + '/admin/haftungsausschluss.html' },
    { label: 'Nutzungsbedingungen',     url: base + '/admin/nutzungsbedingungen.html' },
    { label: 'Meine Daten (Auskunft/Loeschung)', url: base + '/admin/meine-daten.html' }
  ];

  function row(l) {
    return '<div class="lk-row">'
      + '<a class="lk-name" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'
      + '<input class="lk-url" readonly value="' + esc(l.url) + '" onclick="this.select()">'
      + '<button class="ghost lk-cp" onclick="copyLink(this)">Kopieren</button>'
      + (l.hint ? '<div class="lk-hint">' + esc(l.hint) + '</div>' : '')
      + '</div>';
  }

  var warn = hasImprint ? ''
    : '<div class="lk-warn">Kein Impressum als Veranstalter hinterlegt. Solange es fehlt, '
      + 'laesst sich kein Giveaway oeffnen — trage es oben unter „Impressum (Pflicht)“ ein.</div>';

  return '<div class="links">'
    + '<div class="lk-head">Links zu diesem Giveaway</div>'
    + warn
    + '<div class="lk-sub">Dein Gewinnspiel</div>' + own.map(row).join('')
    + '<div class="lk-sub">Plattform</div>' + platform.map(row).join('')
    + '<button class="ghost lk-all" onclick="copyAllLinks(\'' + t.id + '\')">Alle Links als Textblock kopieren</button>'
    + '<span class="msg" id="lk-msg-' + t.id + '"></span>'
    + '</div>';
}

function copyLink(btn) {
  var input = btn.parentElement.querySelector('.lk-url');
  if (navigator.clipboard) navigator.clipboard.writeText(input.value);
  var old = btn.textContent;
  btn.textContent = 'kopiert';
  setTimeout(function(){ btn.textContent = old; }, 1200);
}

function copyAllLinks(teamId) {
  var host = document.getElementById('lk-msg-' + teamId);
  var box  = host.parentElement;
  var txt  = Array.prototype.map.call(box.querySelectorAll('.lk-row'), function(r) {
    return r.querySelector('.lk-name').textContent + ': ' + r.querySelector('.lk-url').value;
  }).join('\n');
  if (navigator.clipboard) navigator.clipboard.writeText(txt);
  host.textContent = 'In die Zwischenablage kopiert';
  host.className = 'msg ok';
  setTimeout(function(){ host.textContent = ''; }, 2500);
}

load();
