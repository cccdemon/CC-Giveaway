'use strict';

// ════════════════════════════════════════════════════════
// CORE_ScreenshotContest — Community-Wettbewerb (ARCHITEKTUR-CORES §5.4)
//
// Die Community sendet Screenshots ein (nur nachgewiesene Zuschauer:
// Follow + Mindest-Viewtime, EINE Einsendung pro Person, Freigabe durch
// den Veranstalter) und bewertet freigegebene Einsendungen mit 1–10.
// Wertung = PUNKTSUMME (Entscheidung §10.5). Eine Stimme je (Voter,
// Screenshot) — UNIQUE-Constraint; erneutes Voten überschreibt. Damit
// gilt strukturell: n angemeldete Voter → maximal n Votes je Screenshot.
//
// Der Gewinner ist deterministisch, läuft aber über die normale
// Engine-Ziehung: buildPool liefert NUR die Führenden mit weight 1.
// Ein eindeutiger Führender wird sicher „gezogen"; bei Punktgleichstand
// lost die Engine fair aus. Der Snapshot enthält das komplette Ranking.
// ════════════════════════════════════════════════════════

const VOTE_MIN = 1;
const VOTE_MAX = 10;
const MIN_WATCH_DEF = 600;        // 10 min Kampagnen-Viewtime für Einsenden/Voten
const IMAGE_MAX_BYTES = 7 * 1024 * 1024;   // Betreiber-Vorgabe: max. 7 MB
const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg']);   // nur JPG/PNG

function clampScore(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(VOTE_MIN, Math.min(VOTE_MAX, n));
}

// standings: [{ entryId, username, title, score, votes, status }]
// (score = SUM, votes = COUNT; nur approved). Pool = alle mit Höchst-Score
// und mindestens einer Stimme, Gewicht 1 (Gleichstand → Engine lost aus).
function buildPool(standings) {
  const ranked = (standings || []).filter(s => s.status === 'approved' && s.votes > 0);
  if (!ranked.length) return [];
  const top = Math.max(...ranked.map(s => s.score));
  return ranked.filter(s => s.score === top).map(s => ({
    username: s.username, weight: 1,
    meta: {
      username: s.username, entryId: s.entryId, title: s.title,
      // Panel-/Snapshot-kompatibel: Score in den Coin-Feldern
      totalCoins: s.score, coins: s.score, totalWatchSec: 0, watchSec: 0,
      msgs: s.votes, channelsQualified: 0, perChannel: {}, eligible: true,
    },
  }));
}

// url optional: Ansagen aus dem Server hängen den Link zur Contest-Seite an
// (ohne url bleiben die Texte byte-gleich — eingefrorene Tests).
function infoText({ url } = {}) {
  return '📸 SCREENSHOT-CONTEST! Sende deinen besten Screenshot ein und bewerte die '
       + 'Einsendungen der anderen mit 1–10 — auf der Contest-Seite (Login mit Twitch). '
       + 'Einsenden und Voten können nur echte Zuschauer. Die höchste Punktsumme gewinnt!'
       + (url ? ` → ${url}` : '');
}

// Eine Zeile für !los, wenn diese Instanz parallel zur Kampagne läuft.
function statusLine({ voting, url } = {}) {
  const link = url ? ` → ${url}` : '';
  if (voting === 'open') return '📸 Außerdem läuft ein Screenshot-Contest — das VOTING ist offen (Contest-Seite, Login mit Twitch).' + link;
  return '📸 Außerdem läuft ein Screenshot-Contest — Einsendungen auf der Contest-Seite (Login mit Twitch).' + link;
}

function winnerText({ winner, coins }) {
  return `📸 Contest-Sieger: @${winner} mit ${coins} Punkten — herzlichen Glückwunsch! 🎉`;
}

function emptyDrawText() {
  return '📸 Contest beendet — keine freigegebene Einsendung mit Stimmen, kein Sieger ermittelt.';
}

module.exports = {
  id:    'CORE_ScreenshotContest',
  label: 'Screenshot-Contest',
  accrual: 'none',   // kein Watchtime-Accrual; Schwellen lesen den Kampagnenstand

  config: {
    minWatchSec: { type: 'int', min: 0, max: 360000, def: MIN_WATCH_DEF,
                   label: 'Mindest-Zuschauzeit für Einsenden/Voten (s, 0 = aus)' },
  },

  VOTE_MIN, VOTE_MAX, IMAGE_MAX_BYTES, IMAGE_MIMES,
  clampScore,
  buildPool,
  infoText,
  statusLine,
  winnerText,
  emptyDrawText,

  // UI-Vertrag (P5): gemeinsame Oberflächen lesen NUR diese Deklaration.
  display: {
    css:        'core-contest',
    beta:       true,          // noch kaum im Livebetrieb erprobt — UI kennzeichnet das
    icon:       '📸',
    unit:       'Punkte',
    winnerStat: 'score',       // winner_coins = Punktsumme aus dem Voting
    drawKind:   'score',       // höchste Punktsumme gewinnt, Los nur bei Gleichstand
    emptyPool:  'Keine freigegebene Einsendung mit Stimmen — kein Sieger ermittelbar.',
    columns: [
      { key: 'title', label: 'Screenshot', mask: false },
      { key: 'score', label: 'Punkte',     mask: false },
      { key: 'votes', label: 'Stimmen',    mask: false },
    ],
    // Kachel-IDs aus der Panel-Registry (STAT_TILES in giveaway-admin.js).
    tiles: ['entryCount', 'approvedCount', 'voteSum', 'scoreSum'],
    panelCard: 'contest',   // Rail-Karte card-contest + Einsendungs-Loader
  },
};
