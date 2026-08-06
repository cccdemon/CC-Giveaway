'use strict';

// ════════════════════════════════════════════════════════
// CORE_CurrentViewers — Sofortverlosung (docs/ARCHITEKTUR-CORES.md §5.3)
//
// Verlosung unter allen, die GERADE zuschauen: Keyword im Zeitfenster
// geschrieben UND als anwesend gemeldet. Anwesenheit kommt ausschließlich
// aus viewer_tick (chLastTick) — Chat allein reicht nicht, sonst zählen
// Bots und Leute mit offenem Chat-Tab als Zuschauer.
//
// Kein Guthaben, kein Coin-Konto: Gewicht = 1 für alle Berechtigten.
// Kein Watchtime-Accrual (accrual:'none') — Tick und Chat-Bonus der
// Engine lassen diese Instanzen aus. Das Zeitfenster ist NUR die
// Anmeldephase (auch mehrere Fenster nacheinander; Teilnehmer bleiben
// angemeldet). Der Watcher schließt abgelaufene Fenster mit Ansage —
// DIE ZIEHUNG MACHT DER STREAMER MANUELL (★ im Panel);
// Zufall/Snapshot/Protokoll bleiben Engine.
// ════════════════════════════════════════════════════════

const WINDOW_SEC_DEF = 60;

// input: [{ username, registered, banned, present }]
// present = viewer_tick innerhalb PRESENCE_TTL auf einem Instanz-Kanal.
function aggregate({ username, registered, banned, present }) {
  const eligible = registered && !banned && present;
  return {
    username, registered, banned, present, eligible,
    // Panel-/Snapshot-kompatible Felder (Coin-Spalten zeigen 0/1):
    weight: eligible ? 1 : 0,
    totalCoins: eligible ? 1 : 0, coins: eligible ? 1 : 0,
    totalWatchSec: 0, watchSec: 0, msgs: 0,
    channelsQualified: present ? 1 : 0, channelsFollowed: present ? 1 : 0,
    followMin: 0, drawMinSec: 0, coinBaseSec: 0, perChannel: {},
  };
}

function buildPool(participants) {
  return participants
    .filter(p => p.eligible)
    .map(p => ({ username: p.username, weight: 1, meta: p }));
}

function fmtWindow(sec) {
  const s = Math.round(sec || WINDOW_SEC_DEF);
  if (s < 120) return `${s} Sekunden`;
  return s % 60 === 0 ? `${s / 60} Minuten`
       : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} Minuten`;
}

function infoText({ keyword, windowSec }) {
  const kwTxt = keyword ? `"${keyword}"` : 'das Keyword';
  return `⚡ SOFORTVERLOSUNG! Schreib jetzt ${kwTxt} in den Chat — das Anmeldefenster ist ${fmtWindow(windowSec)} offen. Mitmachen kann, wer gerade zuschaut. Kein Sammeln, keine Vorleistung — die Ziehung macht der Streamer gleich live!`;
}

function prepText({ keyword }) {
  const kwTxt = keyword ? `"${keyword}"` : 'das Keyword';
  return `⚡ Gleich startet eine SOFORTVERLOSUNG — halte dich bereit, ${kwTxt} zu schreiben, sobald das Anmeldefenster öffnet!`;
}

// Eine Zeile für !los, wenn diese Instanz parallel zur Kampagne läuft.
function statusLine({ keyword, secondsLeft }) {
  const kwTxt = keyword ? `"${keyword}"` : 'das Keyword';
  if (secondsLeft > 0) return `⚡ Sofortverlosung: Anmeldefenster OFFEN — schreib ${kwTxt} (noch ${fmtWindow(secondsLeft)}).`;
  return '⚡ Außerdem läuft eine Sofortverlosung — das nächste Anmeldefenster wird angesagt.';
}

function emptyDrawText() {
  return '⚡ Sofortverlosung abgebrochen — niemand war teilnahmeberechtigt '
       + '(Keyword geschrieben UND als Zuschauer gemeldet). Keine Ziehung erfolgt.';
}

function winnerText({ winner }) {
  return `⚡ Sofortverlosung: @${winner} hat gewonnen — herzlichen Glückwunsch! 🎉`;
}

module.exports = {
  id:    'CORE_CurrentViewers',
  label: 'Sofortverlosung',
  accrual: 'none',   // kein Watchtime-/Chat-Bonus-Accrual für diese Instanzen

  config: {
    windowSec: { type: 'int', min: 10, max: 3600, def: WINDOW_SEC_DEF, label: 'Fensterdauer (Sekunden)' },
  },

  aggregate,
  buildPool,
  infoText,
  prepText,
  statusLine,
  emptyDrawText,
  winnerText,

  // UI-Vertrag (P5): gemeinsame Oberflächen lesen NUR diese Deklaration.
  display: {
    css:        'core-instant',
    icon:       '⚡',
    unit:       null,          // keine Gewichtseinheit — alle gleich
    winnerStat: null,          // winner_coins hat hier keine Aussage
    drawKind:   'equal',       // gleiche Chance für alle Berechtigten
    emptyPool:  'Niemand angemeldet und anwesend — kein Teilnehmer im Topf.',
    columns: [
      { key: 'present',  label: 'Anwesend', mask: false },
      { key: 'eligible', label: 'Im Topf',  mask: false },
    ],
    // Kachel-IDs aus der Panel-Registry (STAT_TILES in giveaway-admin.js).
    tiles: ['registeredCount', 'presentCount', 'inPotCount'],
    panelCard: 'instant',   // Rail-Karte card-instant (CSS-Matrix via css)
  },
};
