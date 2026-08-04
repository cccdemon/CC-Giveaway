'use strict';

// ════════════════════════════════════════════════════════
// CORE_WatchtimeChatActivity — die heutige Mechanik hinter dem Core-Vertrag
// (docs/ARCHITEKTUR-CORES.md, Abschnitt 4/5.1, Phase 1).
//
// Ein Core entscheidet ausschließlich, wie aus Ereignissen ein Gewicht wird
// und wer teilnahmeberechtigt ist. Er ist PUR: keine Redis-, PG- oder
// Netz-Zugriffe — die Engine (watchtime.js) sammelt die Rohdaten und ruft
// die Regelfunktionen hier. Dadurch bleibt der Umbau verhaltensneutral:
// die Formeln sind unverändert hierher verschoben, nicht neu geschrieben.
//
// Noch in der Engine (folgt mit ctx.kv in späteren Phase-1-Schritten):
// Konfigurations-Accessoren, Chat-Cooldown, Multiplier-State, chat-ai-Aufruf.
// ════════════════════════════════════════════════════════

// Defaults der Mechanik — vorher Konstanten in watchtime.js.
const SECS_PER_COIN  = 7200; // 1 Coin = 2h Viewtime (per Team überschreibbar)
const CHAT_BONUS_SEC = 2;    // sinnvolle Chatnachricht (>3 Wörter) = +2s Viewtime
const CHAT_COOLDOWN  = 10;
const CHAT_MIN_WORDS = 4;    // >3 Wörter
const MIN_CHANNELS   = 2;    // wie vielen Kanälen man folgen muss
const JOIN_MIN_COINS = 1;    // Lostopf ab ≥1 Coin

function countWords(msg) {
  let count = 0, inWord = false;
  for (const ch of msg) {
    if (ch === ' ' || ch === '\t') { inWord = false; }
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// Coin-Basis ist per-Team konfigurierbar; SECS_PER_COIN ist nur Fallback.
function coinsFromSec(watchSec, baseSec) {
  const base = (Number.isFinite(baseSec) && baseSec > 0) ? baseSec : SECS_PER_COIN;
  return Math.round((watchSec / base) * 10000) / 10000;
}

// Sinnhaftigkeit einer Chatnachricht: KI-Urteil wenn vorhanden, sonst
// (und bei jedem KI-Fehler → aiVerdict.meaningful null) die Wortregel.
// Formel unverändert aus handleChatMessage übernommen.
function chatMeaningful({ message, minWords, aiVerdict }) {
  const byWords = countWords(message) >= minWords;
  let meaningful = byWords, judgedBy = 'words';
  if (aiVerdict && aiVerdict.meaningful !== null && aiVerdict.meaningful !== undefined) {
    meaningful = aiVerdict.meaningful;
    judgedBy = aiVerdict.source === 'cache' ? 'ai_cache' : 'ai';
  }
  return { meaningful, judgedBy };
}

// ── Die zentrale Regelfunktion (vorher getUserAggregate) ──
// input: { username, perChannelRaw: {ch: {watchSec, msgs, follows(bool)}},
//          registered, banned, cfg: {coinBaseSec, followMin} }
// Rückgabeform ist byte-gleich zum alten getUserAggregate — Panel, !los,
// Statusseite und Ziehung lesen sie unverändert.
function aggregate({ username, perChannelRaw, registered, banned, cfg }) {
  const base = cfg.coinBaseSec;
  const perChannel = {};
  let totalWatch = 0, totalMsgs = 0, followed = 0;
  for (const [ch, raw] of Object.entries(perChannelRaw)) {
    const watchSec = raw.watchSec;
    const msgs     = raw.msgs;
    const follows  = raw.follows;
    const coins    = coinsFromSec(watchSec, base);
    perChannel[ch] = { watchSec, coins, msgs, follows };
    totalWatch += watchSec; totalMsgs += msgs;
    if (follows) followed++;   // Follow zählt UNABHÄNGIG vom Gucken
  }
  const totalCoins = coinsFromSec(totalWatch, base);
  // Lostopf: Keyword + folgt ≥followMin Kanälen + ≥1 Coin (irgendwo geguckt).
  const eligible = registered && !banned && followed >= cfg.followMin && totalCoins >= JOIN_MIN_COINS;
  return {
    username, perChannel, totalWatchSec: totalWatch, totalCoins,
    channelsQualified: followed, channelsFollowed: followed,
    followMin: cfg.followMin, drawMinSec: base, coinBaseSec: base,
    registered, banned, eligible,
    coins: totalCoins, watchSec: totalWatch, msgs: totalMsgs,
  };
}

// ── Ziehung: nur die Pool-Bildung ─────────────────────────
// Zufall, Snapshot und Persistenz macht die Engine (drawWinner).
// Reihenfolge bleibt erhalten (Teilnehmer kommen nach Coins sortiert an) —
// wichtig, weil der gewichtete Zufallslauf über die Liste iteriert.
function buildPool(participants) {
  return participants
    .filter(p => p.eligible)
    .map(p => ({ username: p.username, weight: p.totalCoins, meta: p }));
}

module.exports = {
  id:    'CORE_WatchtimeChatActivity',
  label: 'Zuschauzeit & Chat',

  // Beschreibt die Einstellungen für Oberfläche UND Validierung (eine Quelle).
  config: {
    coinBaseSec:  { type: 'int',   min: 60, max: 360000, def: SECS_PER_COIN,  label: '1 Coin = X Sekunden Zuschauzeit' },
    followMin:    { type: 'int',   min: 0,  max: 10,     def: MIN_CHANNELS,   label: 'Mindestzahl gefolgter Kanäle' },
    chatBonusSec: { type: 'float', min: 0,  max: 300,    def: CHAT_BONUS_SEC, label: 'Bonus je sinnvoller Nachricht (s)' },
    chatMinWords: { type: 'int',   min: 1,  max: 50,     def: CHAT_MIN_WORDS, label: 'Mindestwörter je Nachricht' },
    chatCooldown: { type: 'int',   min: 0,  max: 3600,   def: CHAT_COOLDOWN,  label: 'Cooldown zwischen Boni (s)' },
  },

  // Regelfunktionen (pur, testbar ohne Infrastruktur)
  countWords,
  coinsFromSec,
  chatMeaningful,
  aggregate,
  buildPool,

  // Defaults für die Engine (Re-Export erhält die alte watchtime.js-API)
  defaults: { SECS_PER_COIN, CHAT_BONUS_SEC, CHAT_COOLDOWN, CHAT_MIN_WORDS, MIN_CHANNELS, JOIN_MIN_COINS },
};
