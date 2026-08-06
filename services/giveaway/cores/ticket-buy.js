'use strict';

// ════════════════════════════════════════════════════════
// CORE_TicketBuy — Los-Einsatz auf Preise (docs/ARCHITEKTUR-CORES.md §5.2)
//
// Zuschauzeit erzeugt Guthaben wie gehabt (accrual 'watchtime'); beim
// Schließen der Instanz wird der erspielte Stand als `earn` ins team-weite
// credit_ledger gebucht (Entscheidung §10.1: Guthaben wandert). Gesetzt
// wird auf konkrete Preise (giveaway_prizes); jeder Einsatz ist bis zum
// Einsatz-Ende rücknehmbar, danach gebunden. Gezogen wird JE PREIS,
// gewichtet nach Einsatz — Lotterie, keine Auktion. Nach der Ziehung sind
// die Einsätze ALLER Setzer dieses Preises verbraucht (§5.2), sonst wäre
// Setzen risikolos.
//
// Rechtliche Leitplanken (§5.2/§10.1): eingesetzt wird ausschließlich
// erspielte Zuschauzeit; kein Kauf, kein Barwert, kein Umtausch, keine
// Übertragung — die Buchungstypen dafür existieren nicht (credit.js).
//
// Der Core ist pur: Parsen, Pool-Bildung, Texte. Buchungen (Ledger,
// Wagers) führt die Engine aus.
// ════════════════════════════════════════════════════════

const WAGER_CMD_DEF = '!setzen';

// "!setzen <preis-nr> <anzahl>" → { prizeId, amount } | { help: true } | null.
// Der Befehl selbst ist per Team/Instanz konfigurierbar (WebUI, gWagerCmd).
function parseWager(message, cmd) {
  const c = String(cmd || WAGER_CMD_DEF).toLowerCase();
  const words = String(message || '').trim().toLowerCase().split(/\s+/);
  if (!words.length || words[0] !== c) return null;
  if (words.length === 1) return { help: true };
  const prizeId = parseInt(words[1], 10);
  const amount  = words.length >= 3 ? parseInt(words[2], 10) : 1;
  if (!Number.isFinite(prizeId) || prizeId <= 0) return { help: true };
  if (!Number.isFinite(amount) || amount < 0)    return { help: true };
  return { prizeId, amount };   // amount 0 = Rücknahme des kompletten Einsatzes
}

// stakes: [{ username, stake }] (SUM je User, nur > 0) → Pool je Preis.
function buildPool(stakes) {
  return stakes
    .filter(s => s.stake > 0)
    .map(s => ({ username: s.username, weight: s.stake, meta: {
      username: s.username, totalCoins: s.stake, coins: s.stake,
      totalWatchSec: 0, channelsQualified: 0, perChannel: {}, eligible: true,
    } }));
}

// ── Chat-Texte ────────────────────────────────────────────
function helpText(cmd, prizes) {
  const list = (prizes || []).map(p => `#${p.id} ${p.title}`).join(' · ');
  return `🎟 Lose setzen: „${cmd} <preis-nr> <anzahl>" — z.B. „${cmd} ${prizes && prizes[0] ? prizes[0].id : 1} 2". `
       + (list ? `Preise: ${list}. ` : 'Aktuell keine offenen Preise. ')
       + `Rücknahme bis zum Einsatz-Ende: „${cmd} <preis-nr> 0".`;
}

function wagerOkText({ username, prizeTitle, amount, stake, balance }) {
  return `@${username} ✅ ${amount} Los${amount === 1 ? '' : 'e'} auf „${prizeTitle}" gesetzt `
       + `(dein Einsatz dort: ${stake}, Restguthaben: ${balance.toFixed(2)}).`;
}

function retractOkText({ username, prizeTitle, refunded, balance }) {
  return `@${username} ↩ Einsatz auf „${prizeTitle}" zurückgenommen (${refunded} zurück, Guthaben: ${balance.toFixed(2)}).`;
}

function wagerErrText(username, reason) {
  const msgs = {
    no_prize:      'diesen Preis gibt es nicht (oder er ist schon gezogen).',
    wager_closed:  'das Einsatz-Ende dieses Preises ist vorbei — Einsätze sind jetzt gebunden.',
    no_credit:     'nicht genug Guthaben. Guthaben entsteht aus Zuschauzeit (Stand: Setz-Seite).',
    nothing_to_refund: 'du hast auf diesen Preis nichts gesetzt.',
  };
  return `@${username} ❌ ${msgs[reason] || 'Einsatz nicht möglich.'}`;
}

// url optional: Ansagen aus dem Server hängen den Link zur Setz-Seite an
// (ohne url bleiben die Texte byte-gleich — eingefrorene Tests).
function infoText({ cmd, url } = {}) {
  return `🎁 Los-Giveaway: Zuschauzeit wird zu Los-Guthaben. Setze deine Lose gezielt auf Preise: „${cmd} <preis-nr> <anzahl>". Gezogen wird je Preis, gewichtet nach Einsatz — jedes Los kann gewinnen. Nach der Ziehung sind die Einsätze aller Teilnehmer dieses Preises verbraucht.`
       + (url ? ` Setz-Seite: ${url}` : '');
}

// Eine Zeile für !los, wenn diese Instanz parallel zur Kampagne läuft.
function statusLine({ cmd, url } = {}) {
  return `🎟 Außerdem läuft ein Los-Giveaway — Lose setzen mit „${cmd || WAGER_CMD_DEF} <preis-nr> <anzahl>" oder auf der Setz-Seite.`
       + (url ? ` → ${url}` : '');
}

function winnerText({ winner, prizeTitle }) {
  return `🎉 „${prizeTitle}": @${winner} gewinnt — herzlichen Glückwunsch! Die Einsätze aller Teilnehmer dieses Preises sind damit verbraucht.`;
}

module.exports = {
  id:    'CORE_TicketBuy',
  label: 'Los-Einsatz',
  accrual: 'watchtime',   // sammelt Zuschauzeit wie die Kampagne

  config: {
    wagerCmd: { type: 'string', def: WAGER_CMD_DEF, label: 'Chat-Befehl zum Setzen' },
  },

  parseWager,
  buildPool,
  helpText,
  wagerOkText,
  retractOkText,
  wagerErrText,
  infoText,
  statusLine,
  winnerText,

  display: {
    columns: [
      { key: 'stake',   label: 'Einsatz', mask: false },
      { key: 'balance', label: 'Guthaben', mask: false },
    ],
    tiles: ['totalStakes', 'eligibleCount'],
  },
};
