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
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

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

function infoText() {
  return '📸 SCREENSHOT-CONTEST! Sende deinen besten Screenshot ein und bewerte die '
       + 'Einsendungen der anderen mit 1–10 — auf der Contest-Seite (Login mit Twitch). '
       + 'Einsenden und Voten können nur echte Zuschauer. Die höchste Punktsumme gewinnt!';
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
  winnerText,
  emptyDrawText,

  display: {
    columns: [
      { key: 'title', label: 'Screenshot', mask: false },
      { key: 'score', label: 'Punkte',     mask: false },
      { key: 'votes', label: 'Stimmen',    mask: false },
    ],
    tiles: ['entryCount', 'voteCount'],
  },
};
