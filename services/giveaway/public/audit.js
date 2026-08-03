'use strict';

// ── Audit-Seite ───────────────────────────────────────────
// Eigene Seite, weil das Log im Dashboard nur ein 200-Zeilen-Fenster war und
// damit alles Aeltere unerreichbar. Hier wird serverseitig gefiltert, verdichtet
// und seitenweise nachgeladen. Geloescht wird nichts — Archiv ist eine Kopie.

var currentTeam = null;
var rows        = [];
var nextBefore  = null;
var loading     = false;
var privacyOn   = localStorage.getItem('cc_privacy') === '1';

function esc(s) {
  return (window.CC && CC.validate && typeof CC.validate.escHtml === 'function')
    ? CC.validate.escHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }

function fmtTs(iso) {
  var dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit',
                                      hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Teams ─────────────────────────────────────────────────
async function loadTeams() {
  try {
    var teams = await (await fetch('/admin/api/teams/mine')).json();
    var sel = document.getElementById('team-select');
    var owned = Array.isArray(teams) ? teams.filter(function(t){ return t.role === 'owner'; }) : [];
    if (!owned.length) {
      sel.innerHTML = '<option>— kein eigenes Team —</option>';
      document.getElementById('aud-list').innerHTML =
        '<div class="wsc-empty">Das Audit-Log sieht nur der Team-Owner.</div>';
      return;
    }
    sel.innerHTML = owned.map(function(t){
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + ' ★</option>';
    }).join('');
    currentTeam = owned[0].id;
    sel.value = currentTeam;
    loadStats();
    reload();
  } catch(e) {
    document.getElementById('aud-list').innerHTML =
      '<div class="wsc-empty">Teams laden fehlgeschlagen: ' + esc(e.message) + '</div>';
  }
}

function onTeamChange() {
  currentTeam = val('team-select');
  loadStats();
  reload();
}

// ── Kennzahlen + Filter-Vorschlaege ───────────────────────
async function loadStats() {
  if (!currentTeam) return;
  try {
    var s = await (await fetch('/giveaway/api/audit/stats?team=' + encodeURIComponent(currentTeam))).json();
    if (s.error) throw new Error(s.error);

    var by = {}; (s.byResult || []).forEach(function(r){ by[r.result] = r.n; });
    var span = (s.firstTs && s.lastTs)
      ? fmtTs(s.firstTs).slice(0, 8) + ' – ' + fmtTs(s.lastTs).slice(0, 8) : '–';
    document.getElementById('aud-kpis').innerHTML = [
      kpi('', s.total, 'EINTRÄGE GESAMT'),
      kpi('ok',     by.ok     || 0, 'OK'),
      kpi('denied', by.denied || 0, 'ABGELEHNT'),
      kpi('error',  by.error  || 0, 'FEHLER'),
      kpi('', span, 'ZEITRAUM'),
    ].join('');

    fillSelect('f-action', (s.byAction || []).reduce(function(acc, a){
      acc[a.action] = (acc[a.action] || 0) + a.n; return acc;
    }, {}), 'alle Aktionen');
    fillSelect('f-actor', (s.actors || []).reduce(function(acc, a){
      acc[a.actor] = a.n; return acc;
    }, {}), 'alle Actors');

    // Schnellfilter: die haeufigsten Aktionen als Chips.
    document.getElementById('aud-quick').innerHTML = (s.byAction || []).slice(0, 10).map(function(a){
      return '<button class="aud-chip" data-action="' + esc(a.action) + '" data-result="' + esc(a.result) + '">'
           + esc(a.action) + ' <span>' + a.n + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#aud-quick .aud-chip'), function(b){
      b.onclick = function(){
        document.getElementById('f-action').value = b.getAttribute('data-action');
        document.getElementById('f-result').value = b.getAttribute('data-result');
        reload();
      };
    });
  } catch(e) {
    document.getElementById('aud-kpis').innerHTML =
      '<div class="aud-kpi"><b>–</b><label>' + esc(e.message) + '</label></div>';
  }
}

function kpi(cls, v, label) {
  return '<div class="aud-kpi ' + cls + '"><b>' + esc(typeof v === 'number' ? v.toLocaleString('de-DE') : v)
       + '</b><label>' + label + '</label></div>';
}

function fillSelect(id, counts, allLabel) {
  var sel = document.getElementById(id);
  if (!sel) return;
  var keep = sel.value;
  var keys = Object.keys(counts).sort(function(a, b){ return counts[b] - counts[a]; });
  sel.innerHTML = '<option value="">' + allLabel + '</option>' + keys.map(function(k){
    return '<option value="' + esc(k) + '">' + esc(k) + ' (' + counts[k] + ')</option>';
  }).join('');
  sel.value = keep;
}

// ── Laden ─────────────────────────────────────────────────
function query(extra) {
  var p = new URLSearchParams();
  p.set('team', currentTeam);
  p.set('limit', '120');
  if (!document.getElementById('f-group').checked) p.set('group', '0');
  ['q', 'result', 'action', 'actor'].forEach(function(k){
    var v = val('f-' + k); if (v) p.set(k === 'q' ? 'q' : k, v);
  });
  // Ganzer Tag: bis-Datum bis 23:59:59, sonst fehlt der letzte Tag.
  if (val('f-from')) p.set('from', val('f-from') + 'T00:00:00');
  if (val('f-to'))   p.set('to',   val('f-to')   + 'T23:59:59');
  Object.keys(extra || {}).forEach(function(k){ p.set(k, extra[k]); });
  return p.toString();
}

function reload() { rows = []; nextBefore = null; load(); }

async function load() {
  if (!currentTeam || loading) return;
  loading = true;
  var listEl = document.getElementById('aud-list');
  if (!rows.length) listEl.innerHTML = '<div class="wsc-empty">Lade…</div>';
  try {
    var extra = nextBefore ? { before: nextBefore } : {};
    var d = await (await fetch('/giveaway/api/audit?' + query(extra))).json();
    if (d.error) throw new Error(d.error);
    rows = rows.concat(d.entries || []);
    nextBefore = d.nextBefore;
    render();
    document.getElementById('btn-more').style.display =
      (d.hasMore && d.nextBefore) ? '' : 'none';
    // Ehrlich sagen, wie tief geschaut wurde — sonst liest sich eine leere
    // Liste wie "nichts passiert", obwohl nur das Fenster zu klein war.
    document.getElementById('aud-info').textContent =
      rows.length + ' Zeilen angezeigt · ' + d.scanned.toLocaleString('de-DE')
      + ' Rohzeilen gelesen' + (d.hasMore ? ' (weitere vorhanden)' : ' (Ende erreicht)')
      + (d.grouped ? ' · verdichtet' : '');
  } catch(e) {
    listEl.innerHTML = '<div class="wsc-empty">Audit-Log nicht ladbar: ' + esc(e.message) + '</div>';
  } finally { loading = false; }
}

function loadMore() { load(); }

var _t = null;
function debouncedLoad() { clearTimeout(_t); _t = setTimeout(reload, 300); }

function resetFilters() {
  ['f-q', 'f-result', 'f-action', 'f-actor', 'f-from', 'f-to'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('f-group').checked = true;
  reload();
}

// ── Rendern ───────────────────────────────────────────────
function render() {
  var el = document.getElementById('aud-list');
  if (!rows.length) { el.innerHTML = '<div class="wsc-empty">Keine Einträge für diesen Filter</div>'; return; }
  el.innerHTML = rows.map(function(e, i){
    var cls  = e.result === 'ok' ? '' : (e.result === 'denied' ? 'denied' : 'err');
    var who  = privacyOn ? 'Admin' : esc(e.actor || '?');
    var tgt  = e.target ? ' → ' + esc(privacyOn ? 'Zuschauer' : e.target) : '';
    var many = e.n > 1;
    var when = many
      ? fmtTs(e.ts) + '<br>bis ' + fmtTs(e.ts_first)
      : fmtTs(e.ts);
    var meta = [];
    if (e.actor_ip && !privacyOn) meta.push('IP ' + esc(e.actor_ip));
    if (e.session_id) meta.push(esc(e.session_id));
    meta.push(many ? ('IDs ' + e.id_first + '–' + e.id) : ('ID ' + e.id));
    return '<div class="aud-row ' + cls + '" id="ar' + i + '">'
      + '<div class="aud-when">' + when + '</div>'
      + '<div class="aud-main" onclick="toggleDetail(' + i + ')">'
        + '<div class="aud-who"><b>' + who + '</b>' + tgt + '</div>'
        + '<div class="aud-sum">' + esc(CC.audit.summary(e)) + '</div>'
        + '<div class="aud-meta">' + meta.join(' · ') + '</div>'
        + '<div class="aud-detail">' + esc(JSON.stringify(e.detail || {}, null, 2)) + '</div>'
      + '</div>'
      + '<div class="aud-side">'
        + (many ? '<span class="aud-n">×' + e.n + '</span>' : '')
        + (e.result !== 'ok' ? '<span class="aud-res ' + cls + '">' + esc(e.result.toUpperCase()) + '</span>' : '')
      + '</div>'
    + '</div>';
  }).join('');
}

function toggleDetail(i) {
  var el = document.getElementById('ar' + i);
  if (el) el.classList.toggle('open');
}

// ── Export ────────────────────────────────────────────────
function downloadArchive() {
  if (!currentTeam) return;
  // Direkter Download: der Server baut das .tar.gz und protokolliert den Vorgang.
  window.location.href = '/giveaway/api/audit/archive?' + query({});
}

function exportCsv() {
  if (!rows.length) return;
  var head = ['Zeitpunkt','Bis','Anzahl','Actor','IP','Aktion','Ziel','Ergebnis','Session','Beschreibung','Details'];
  var cell = function(v){
    var s = (v === null || v === undefined) ? '' : String(v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var csv = '﻿' + [head.join(';')].concat(rows.map(function(e){
    return [e.ts, e.n > 1 ? e.ts_first : '', e.n, e.actor, e.actor_ip || '', e.action,
            e.target || '', e.result, e.session_id || '', CC.audit.summary(e),
            JSON.stringify(e.detail || {})].map(cell).join(';');
  })).join('\r\n');
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'audit-ansicht.csv';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

document.addEventListener('DOMContentLoaded', function(){
  if (privacyOn) document.body.classList.add('privacy');
  loadTeams();
});
