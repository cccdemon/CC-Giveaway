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

// ── Deltas (vorher inline in tickPresentUsers/handleChatMessage) ──
// Wie viel Viewtime ein Ereignis wert ist, ist Mechanik — der Multiplier
// (time-boxed Boost) wirkt auf beide Wege.
function tickDelta({ tickSec, multiplier }) { return tickSec * multiplier; }
function chatDelta({ bonusSec, multiplier }) { return bonusSec * multiplier; }

// ── Chat-Texte (vorher hartcodiert in server.js) ──────────
// Grammatik-/Format-Helfer gehören zu den Texten und damit zum Core.
const kw2 = (n) => (n === 1 ? 'Kanal' : 'Kanälen');
const fmtDur = (sec) => {                              // 7200→"2 Std", 1800→"30 Min"
  sec = Math.max(0, Math.round(sec || 0));
  if (sec % 3600 === 0) return `${sec / 3600} Std`;
  if (sec >= 3600)      return `${(sec / 3600).toFixed(1)} Std`;
  return `${Math.round(sec / 60)} Min`;
};

// !giveaway und die Eröffnungsansage — ein Text, eine Stelle zum Pflegen.
function infoText({ keyword, followMin, drawMinSec, host, teamId }) {
  const kwTxt = keyword ? `"${keyword}"` : 'das Keyword';
  const dmTxt = drawMinSec > 0 ? ` + mind. 1 Punkt (${fmtDur(drawMinSec)} Zuschauzeit)` : '';
  return `🎁 Team-Giveaway: schau auf EINEM der Team-Kanäle zu — die Zuschauzeit zählt zusammen (${fmtDur(drawMinSec)} = 1 Punkt), sinnvoller Chat (>3 Wörter) gibt Bonus. Mitmachen: schreib ${kwTxt} im Chat (= anmelden). Für den Lostopf: folge ≥${followMin} ${kw2(followMin)}${dmTxt}. Befehle: !los = dein Status & Chance · !giveaway = diese Info. Regeln: ${host}/viewer/terms?team=${teamId} | Status: ${host}/viewer/status`;
}

// !los — Status & Chance. agg = getParticipant/getUserAggregate-Ergebnis,
// poolTotal = Summe der Gewichte aller Berechtigten.
function statusText({ username, open, agg, keyword, poolTotal, host, teamId }) {
  const u = username;
  let reply;
  if (!open) reply = `@${u} Kein Giveaway aktiv.`;
  else {
    const a = agg;
    const kw = keyword || '';
    if (a.eligible) {
      const chance = poolTotal > 0 ? (a.totalCoins / poolTotal * 100) : 0;
      reply = `@${u} 🎟 ${a.totalCoins.toFixed(2)} Punkte | folgt ${a.channelsQualified}/${a.followMin} ✓ | Chance ${chance.toFixed(1)}% | im Lostopf ✅`;
    } else if (!a.registered) {
      reply = `@${u} 🎟 ${a.totalCoins.toFixed(2)} Punkte – schreib "${kw || 'das Keyword'}" um dich anzumelden. Für den Lostopf: folge ≥${a.followMin} ${kw2(a.followMin)}${a.drawMinSec > 0 ? ` + ${fmtDur(a.drawMinSec)} Viewtime` : ''}.`;
    } else if (a.channelsQualified < a.followMin) {
      reply = `@${u} 🎟 ${a.totalCoins.toFixed(2)} Punkte – du folgst erst ${a.channelsQualified}/${a.followMin} ${kw2(a.followMin)}. Folge mind. ${a.followMin} zum Mitmachen!`;
    } else if (a.totalWatchSec < a.drawMinSec) {
      reply = `@${u} 🎟 ${a.totalCoins.toFixed(2)} Punkte, folgst ${a.channelsQualified}/${a.followMin} ✓ – für den Lostopf noch ${fmtDur(a.drawMinSec - a.totalWatchSec)} Viewtime sammeln (zuschauen + sinnvoll chatten).`;
    } else {
      reply = `@${u} 🎟 ${a.totalCoins.toFixed(2)} Punkte – schau zu (egal welcher Kanal) & folge ≥${a.followMin} ${kw2(a.followMin)}.`;
    }
  }
  return reply + ` | Status: ${host}/viewer/status | Regeln: ${host}/viewer/terms?team=${teamId}`;
}

// Antwort auf die Keyword-Anmeldung (gw_join im Chat).
function joinReply({ username, agg }) {
  const u = username, result = agg;
  if (result.eligible) {
    return `@${u} Du bist dabei & im Lostopf ✅ (${result.coins.toFixed(2)} Punkte). Weiter zuschauen + sinnvoll chatten erhöht deine Chance!`;
  }
  const need = [];
  if (result.channelsFollowed < result.followMin) need.push(`folge mind. ${result.followMin} ${kw2(result.followMin)}`);
  if ((result.totalWatchSec || 0) < result.drawMinSec) need.push(`sammle ${fmtDur(result.drawMinSec)} Zuschauzeit (zuschauen + sinnvoll chatten)`);
  return need.length
    ? `@${u} Angemeldet ✅ — für den Lostopf noch nötig: ${need.join(' + ')}. Stand: !los`
    : `@${u} Du bist dabei & im Lostopf ✅`;
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
  tickDelta,
  chatDelta,

  // Chat-Texte (!los, !giveaway, Anmelde-Antwort) + Format-Helfer
  infoText,
  statusText,
  joinReply,
  fmtDur,
  kw2,

  // Defaults für die Engine (Re-Export erhält die alte watchtime.js-API)
  defaults: { SECS_PER_COIN, CHAT_BONUS_SEC, CHAT_COOLDOWN, CHAT_MIN_WORDS, MIN_CHANNELS, JOIN_MIN_COINS },

  // UI-Vertrag (P5): gemeinsame Oberflächen lesen NUR diese Deklaration.
  // columns=null → das Panel behält sein Standard-Kampagnen-Layout.
  display: {
    css:        'core-watchtime',
    icon:       '📈',
    unit:       'Punkte',
    winnerStat: 'coins',       // winner_coins = Coins/Punkte aus aktiver Teilnahme
    drawKind:   'weighted',    // Zufall, gewichtet nach Punkten
    emptyPool:  'Keine Teilnehmer mit Punkten im Lostopf.',
    columns: null,
    tiles: null,       // null = Standard-Kampagnen-Kacheln des Panels
    panelCard: null,   // Kampagne hat keine eigene Rail-Karte
  },
};
