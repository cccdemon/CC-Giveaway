// ════════════════════════════════════════════════════════
// CHAOS CREW – Index JS
// ════════════════════════════════════════════════════════

// ── Clock ──────────────────────────────────────────────
function updateClock() {
  var now = new Date();
  var h = String(now.getHours()).padStart(2, '0');
  var m = String(now.getMinutes()).padStart(2, '0');
  var s = String(now.getSeconds()).padStart(2, '0');
  var el = document.getElementById('clock');
  if (el) el.textContent = h + ':' + m + ':' + s;
}
updateClock();
setInterval(updateClock, 1000);

// ── Health polling ─────────────────────────────────────
var SERVICE_IDS = ['bridge', 'giveaway'];

function setHealth(id, state, text) {
  var el = document.getElementById('h-' + id);
  if (!el) return;
  el.className = 'health-svc ' + state;
  el.innerHTML = '<div class="health-dot"></div>' + id.toUpperCase() + (text ? ' <span style="opacity:0.6;font-size:8px;">' + text + '</span>' : '');
}

function fetchHealth() {
  SERVICE_IDS.forEach(function(id) { setHealth(id, 'loading', ''); });
  fetch('/health')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var svcs = data.services || {};
      SERVICE_IDS.forEach(function(id) {
        var val = svcs[id];
        if (!val || val === 'ok') {
          setHealth(id, val ? 'ok' : 'error', '');
        } else if (val.startsWith('unreachable')) {
          setHealth(id, 'error', 'unreachable');
        } else {
          setHealth(id, 'error', val);
        }
      });
    })
    .catch(function() {
      SERVICE_IDS.forEach(function(id) { setHealth(id, 'error', 'unreachable'); });
    });
}

fetchHealth();
setInterval(fetchHealth, 30000);
