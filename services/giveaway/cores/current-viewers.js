'use strict';

// ════════════════════════════════════════════════════════
// CORE_CurrentViewers — Sofortverlosung (docs/ARCHITEKTUR-CORES.md §5.3)
//
// Verlosung unter allen, die GERADE dabei sind. Anwesenheit weist das
// KEYWORD im offenen Fenster nach (Betreiber-Entscheidung 9.8.26) — nicht
// mehr der viewer_tick. Gegen Bots und reine Chat-Tabs stehen zwei
// Schwellen aus dem Kampagnenstand des Teams: bestätigter Follow auf einem
// Instanz-Kanal und Mindest-Viewtime (Default 10 Minuten).
//
// Hintergrund: die alte Regel (Keyword UND viewer_tick) hat am 9.8.26 eine
// Live-Verlosung gekippt, weil am Creator-PC keine Ticks liefen — 36
// Anmeldungen, 0 im Topf. viewer_tick bleibt als ANZEIGE (Spalte
// „Anwesend") und speist die Viewtime, entscheidet aber nicht mehr allein.
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

const MIN_WATCH_DEF = 600;    // 10 Minuten Zuschauzeit reichen zum Mitmachen

// input: [{ username, registered, banned, present, watchSec, follows, cfg }]
// present = viewer_tick innerhalb PRESENCE_TTL (nur Anzeige)
// watchSec/follows = Kampagnenstand des Teams auf den Instanz-Kanälen
// cfg = { minWatchSec, followRequired }
function aggregate({ username, registered, banned, present = false, watchSec = 0,
                     follows = false, cfg = {} }) {
  const minWatch = cfg.minWatchSec === undefined ? MIN_WATCH_DEF : cfg.minWatchSec;
  const needFollow = cfg.followRequired !== false;
  const watchOk  = watchSec >= minWatch;
  const followOk = !needFollow || follows;
  const eligible = registered && !banned && watchOk && followOk;
  return {
    username, registered, banned, present, eligible,
    watchOk, followOk, minWatchSec: minWatch,
    // Panel-/Snapshot-kompatible Felder (Coin-Spalten zeigen 0/1):
    weight: eligible ? 1 : 0,
    totalCoins: eligible ? 1 : 0, coins: eligible ? 1 : 0,
    totalWatchSec: watchSec, watchSec, msgs: 0,
    channelsQualified: follows ? 1 : 0, channelsFollowed: follows ? 1 : 0,
    followMin: needFollow ? 1 : 0, drawMinSec: 0, coinBaseSec: 0, perChannel: {},
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

function fmtMin(sec) {
  const m = Math.round((sec || 0) / 60);
  return m <= 1 ? '1 Minute' : `${m} Minuten`;
}

function infoText({ keyword, windowSec, minWatchSec = MIN_WATCH_DEF, followRequired = true }) {
  const kwTxt = keyword ? `"${keyword}"` : 'das Keyword';
  const bed = [];
  if (followRequired) bed.push('Follow');
  if (minWatchSec > 0) bed.push(`${fmtMin(minWatchSec)} Zuschauzeit`);
  return `⚡ SOFORTVERLOSUNG! Schreib jetzt ${kwTxt} in den Chat — das Anmeldefenster ist ${fmtWindow(windowSec)} offen.`
       + (bed.length ? ` Mitmachen kann, wer ${bed.join(' und ')} hat.` : ' Mitmachen kann jeder.')
       + ` Kein Sammeln, keine Vorleistung — die Ziehung macht der Streamer gleich live!`;
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
       + '(Keyword im Fenster geschrieben, dazu Follow und Mindest-Zuschauzeit). Keine Ziehung erfolgt.';
}

function winnerText({ winner }) {
  return `⚡ Sofortverlosung: @${winner} hat gewonnen — herzlichen Glückwunsch! 🎉`;
}

module.exports = {
  id:    'CORE_CurrentViewers',
  label: 'Sofortverlosung',
  accrual: 'none',   // kein Watchtime-/Chat-Bonus-Accrual für diese Instanzen

  config: {
    windowSec:   { type: 'int', min: 10, max: 3600, def: WINDOW_SEC_DEF, label: 'Fensterdauer (Sekunden)' },
    minWatchSec: { type: 'int', min: 0, max: 360000, def: MIN_WATCH_DEF,
                   label: 'Mindest-Zuschauzeit zum Mitmachen (Sekunden)' },
  },

  aggregate,
  buildPool,
  MIN_WATCH_DEF,
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
    emptyPool:  'Niemand erfüllt die Bedingungen — Keyword im Fenster, Follow und Mindest-Zuschauzeit.',
    columns: [
      { key: 'watchSec', label: 'Viewtime', mask: false },
      { key: 'followOk', label: 'Follow',   mask: false },
      { key: 'present',  label: 'Anwesend', mask: false },
      { key: 'eligible', label: 'Im Topf',  mask: false },
    ],
    // Kachel-IDs aus der Panel-Registry (STAT_TILES in giveaway-admin.js).
    tiles: ['registeredCount', 'presentCount', 'inPotCount'],
    panelCard: 'instant',   // Rail-Karte card-instant (CSS-Matrix via css)
  },
};
