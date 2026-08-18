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
// EIN GIVEAWAY = EIN PREIS (Betreiber-Entscheidung 9.8.26): je Instanz gibt
// es genau einen offenen Preis; wer mehrere Preise verlosen will, startet
// mehrere Los-Giveaways parallel. Die Preis-Nummern bleiben team-weit
// eindeutig, die Zuordnung Preis → Instanz haengt an
// giveaway_prizes.session_id.
//
// Rechtliche Leitplanken (§5.2/§10.1): eingesetzt wird ausschließlich
// erspielte Zuschauzeit; kein Kauf, kein Barwert, kein Umtausch, keine
// Übertragung — die Buchungstypen dafür existieren nicht (credit.js).
//
// Der Core ist pur: Parsen, Pool-Bildung, Texte. Buchungen (Ledger,
// Wagers) führt die Engine aus.
// ════════════════════════════════════════════════════════

const WAGER_CMD_DEF = '!setzen';

// "!setzen <anzahl>" → { amount } | { help: true } | null.
// Seit "ein Giveaway = ein Preis" braucht der Befehl keine Preis-Nummer mehr:
// der Setz-Befehl selbst (per Instanz konfigurierbar, WebUI/gWagerCmd) waehlt
// das Los-Giveaway — er muss darum je Team eindeutig sein (wagerCmdTaken).
function parseWager(message, cmd) {
  const c = String(cmd || WAGER_CMD_DEF).toLowerCase();
  const words = String(message || '').trim().toLowerCase().split(/\s+/);
  if (!words.length || words[0] !== c) return null;
  if (words.length === 1) return { help: true };
  const amount = parseInt(words[1], 10);
  if (!Number.isFinite(amount) || amount < 0) return { help: true };
  return { amount };   // amount 0 = Rücknahme des kompletten Einsatzes
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
// prizes = offene Preise DIESES Los-Giveaways (ein Giveaway = ein Preis).
function helpText(cmd, prizes) {
  const p = prizes && prizes[0];
  return `🎟 Lose setzen: „${cmd} <anzahl>" — z.B. „${cmd} 2". `
       + (p ? `Preis: ${p.title}. ` : 'Aktuell kein offener Preis. ')
       + `Rücknahme bis zum Einsatz-Ende: „${cmd} 0".`;
}

function wagerOkText({ username, prizeTitle, amount, stake, balance }) {
  return `@${username} ✅ ${amount} Los${amount === 1 ? '' : 'e'} auf „${prizeTitle}" gesetzt `
       + `(dein Einsatz dort: ${stake}, Restguthaben: ${balance.toFixed(2)}).`;
}

function retractOkText({ username, prizeTitle, refunded, balance }) {
  return `@${username} ↩ Einsatz auf „${prizeTitle}" zurückgenommen (${refunded} zurück, Guthaben: ${balance.toFixed(2)}).`;
}

function wagerErrText(username, reason, extra = {}) {
  const msgs = {
    no_prize:      'diesen Preis gibt es nicht (oder er ist schon gezogen).',
    wager_closed:  'das Einsatz-Ende dieses Preises ist vorbei — Einsätze sind jetzt gebunden.',
    no_credit:     'nicht genug Guthaben. Guthaben entsteht aus Zuschauzeit (Stand: Setz-Seite).',
    nothing_to_refund: 'du hast auf diesen Preis nichts gesetzt.',
    not_registered: extra.keyword
      ? `du bist bei diesem Giveaway noch nicht angemeldet — schreib zuerst „${extra.keyword}" in den Chat.`
      : 'du bist bei diesem Giveaway noch nicht angemeldet — schreib zuerst das Teilnahme-Keyword in den Chat.',
  };
  return `@${username} ❌ ${msgs[reason] || 'Einsatz nicht möglich.'}`;
}

// url optional: Ansagen aus dem Server hängen den Link zur Setz-Seite an
// (ohne url bleiben die Texte byte-gleich — eingefrorene Tests).
function infoText({ cmd, url, keyword } = {}) {
  return `🎁 Los-Giveaway: Zuschauzeit wird zu Los-Guthaben.`
       + (keyword ? ` Mitmachen: schreib „${keyword}" in den Chat.` : '')
       + ` Setze deine Lose auf den Preis: „${cmd} <anzahl>". Gezogen wird gewichtet nach Einsatz — jedes Los kann gewinnen. Nach der Ziehung sind die Einsätze aller Teilnehmer dieses Preises verbraucht.`
       + (url ? ` Setz-Seite: ${url}` : '');
}

// Eine Zeile für !los, wenn diese Instanz parallel zur Kampagne läuft.
function statusLine({ cmd, url } = {}) {
  return `🎟 Außerdem läuft ein Los-Giveaway — Lose setzen mit „${cmd || WAGER_CMD_DEF} <anzahl>" oder auf der Setz-Seite.`
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

  // UI-Vertrag (P5): alles, was gemeinsame Oberflächen über diese Mechanik
  // wissen müssen — Panel, Overlay, Claim, Archiv und Statusseite lesen NUR
  // diese Deklaration statt auf Core-IDs zu verzweigen.
  display: {
    css:        'core-ticketbuy',
    beta:       true,          // noch kaum im Livebetrieb erprobt — UI kennzeichnet das
    icon:       '🎟',
    unit:       'Lose',        // Gewichtseinheit in Anzeigen
    winnerStat: 'stake',       // Bedeutung von winner_coins: Einsatz auf den Preis
    drawKind:   'perPrize',    // Ziehung je Preis, gewichtet nach Einsatz
    emptyPool:  'Keine Einsätze auf diesen Preis — niemand im Topf.',
    columns: [
      { key: 'stake',   label: 'Einsatz', mask: false },
      { key: 'balance', label: 'Guthaben', mask: false },
    ],
    // Kachel-IDs aus der Panel-Registry (STAT_TILES in giveaway-admin.js).
    tiles: ['accountCount', 'stakeSum', 'freeBalance', 'setterCount'],
    panelCard: 'ticketbuy',   // Rail-Karte card-ticketbuy + Preis-Loader
  },
};
