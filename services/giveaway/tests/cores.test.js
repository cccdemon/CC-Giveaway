'use strict';

// Phase-1-Abnahme (docs/ARCHITEKTUR-CORES.md): dieselben Eingaben gegen die
// ALTE Implementierung (hier als eingefrorene Referenz-Kopie des Codes vor
// dem Umbau) und den Core — Coins, Berechtigung und Pool-Gewichte müssen
// exakt gleich sein. Dazu Vertrags-Checks (config-Deklaration ↔ Engine-API).

const { test } = require('node:test');
const assert = require('node:assert');

const CORE = require('../cores/watchtime-chat');
const { SECS_PER_COIN, CHAT_BONUS_SEC, CHAT_MIN_WORDS, CHAT_COOLDOWN,
        MIN_CHANNELS, coinsFromSec, countWords } = require('../watchtime');

// ── Referenz: Stand vor Phase 1 (watchtime.js, unverändert kopiert) ──
function refCoinsFromSec(watchSec, baseSec) {
  const base = (Number.isFinite(baseSec) && baseSec > 0) ? baseSec : 7200;
  return Math.round((watchSec / base) * 10000) / 10000;
}

function refAggregate({ username, perChannelRaw, registered, banned, cfg }) {
  const base = cfg.coinBaseSec;
  const perChannel = {};
  let totalWatch = 0, totalMsgs = 0, followed = 0;
  for (const [ch, raw] of Object.entries(perChannelRaw)) {
    const coins = refCoinsFromSec(raw.watchSec, base);
    perChannel[ch] = { watchSec: raw.watchSec, coins, msgs: raw.msgs, follows: raw.follows };
    totalWatch += raw.watchSec; totalMsgs += raw.msgs;
    if (raw.follows) followed++;
  }
  const totalCoins = refCoinsFromSec(totalWatch, base);
  const eligible = registered && !banned && followed >= cfg.followMin && totalCoins >= 1;
  return {
    username, perChannel, totalWatchSec: totalWatch, totalCoins,
    channelsQualified: followed, channelsFollowed: followed,
    followMin: cfg.followMin, drawMinSec: base, coinBaseSec: base,
    registered, banned, eligible,
    coins: totalCoins, watchSec: totalWatch, msgs: totalMsgs,
  };
}

// Ereignisfolge → Roh-Zustand, wie ihn die Engine aus Redis sammeln würde.
// (tick = +60s auf Kanal, chat = +2s Bonus; entspricht TICK_SEC/CHAT_BONUS_SEC.)
function replay(events) {
  const raw = {};
  for (const e of events) {
    raw[e.ch] = raw[e.ch] || { watchSec: 0, msgs: 0, follows: false };
    if (e.type === 'tick')   raw[e.ch].watchSec += 60 * (e.mult || 1);
    if (e.type === 'chat')   { raw[e.ch].watchSec += 2 * (e.mult || 1); raw[e.ch].msgs++; }
    if (e.type === 'follow') raw[e.ch].follows = true;
  }
  return raw;
}

const SCENARIOS = [
  { name: 'leer',            events: [], registered: false, banned: false, cfg: { coinBaseSec: 7200, followMin: 2 } },
  { name: 'lurker 2h',       events: [...Array(120)].map(() => ({ type: 'tick', ch: 'a' })),
    registered: false, banned: false, cfg: { coinBaseSec: 7200, followMin: 2 } },
  { name: 'voll berechtigt', events: [
      { type: 'follow', ch: 'a' }, { type: 'follow', ch: 'b' },
      ...[...Array(120)].map(() => ({ type: 'tick', ch: 'a' })),
      ...[...Array(30)].map(() => ({ type: 'chat', ch: 'b' }))],
    registered: true, banned: false, cfg: { coinBaseSec: 7200, followMin: 2 } },
  { name: 'gebannt',         events: [
      { type: 'follow', ch: 'a' }, { type: 'follow', ch: 'b' },
      ...[...Array(200)].map(() => ({ type: 'tick', ch: 'a' }))],
    registered: true, banned: true, cfg: { coinBaseSec: 7200, followMin: 2 } },
  { name: 'zu wenig follows', events: [
      { type: 'follow', ch: 'a' },
      ...[...Array(150)].map(() => ({ type: 'tick', ch: 'a' }))],
    registered: true, banned: false, cfg: { coinBaseSec: 7200, followMin: 2 } },
  { name: 'kleine coin-basis + multiplier', events: [
      { type: 'follow', ch: 'a' },
      ...[...Array(10)].map(() => ({ type: 'tick', ch: 'a', mult: 2 })),
      ...[...Array(5)].map(() => ({ type: 'chat', ch: 'a', mult: 2 }))],
    registered: true, banned: false, cfg: { coinBaseSec: 600, followMin: 1 } },
  { name: 'followMin 0',     events: [...Array(120)].map(() => ({ type: 'tick', ch: 'a' })),
    registered: true, banned: false, cfg: { coinBaseSec: 7200, followMin: 0 } },
  { name: 'krumme sekunden', events: [
      { type: 'follow', ch: 'a' }, { type: 'follow', ch: 'b' }, { type: 'follow', ch: 'c' },
      ...[...Array(37)].map(() => ({ type: 'tick', ch: 'a' })),
      ...[...Array(113)].map(() => ({ type: 'chat', ch: 'b' })),
      ...[...Array(7)].map(() => ({ type: 'tick', ch: 'c', mult: 1.5 }))],
    registered: true, banned: false, cfg: { coinBaseSec: 3600, followMin: 2 } },
];

test('Phase 1: CORE.aggregate === alte getUserAggregate-Logik (alle Szenarien)', () => {
  for (const s of SCENARIOS) {
    const input = { username: 'user_' + s.name.replace(/\W/g, ''), perChannelRaw: replay(s.events),
                    registered: s.registered, banned: s.banned, cfg: s.cfg };
    assert.deepStrictEqual(CORE.aggregate(input), refAggregate(input), 'Szenario: ' + s.name);
  }
});

test('Phase 1: buildPool === alter eligible-Filter, Gewicht = Coins, Reihenfolge stabil', () => {
  const parts = SCENARIOS.map(s => CORE.aggregate({
    username: 'user_' + s.name.replace(/\W/g, ''), perChannelRaw: replay(s.events),
    registered: s.registered, banned: s.banned, cfg: s.cfg,
  })).sort((a, b) => b.totalCoins - a.totalCoins);   // wie getAllParticipants

  const pool = CORE.buildPool(parts);
  const refEligible = parts.filter(p => p.eligible);

  assert.deepStrictEqual(pool.map(e => e.username), refEligible.map(p => p.username));
  assert.deepStrictEqual(pool.map(e => e.weight),   refEligible.map(p => p.totalCoins));
  for (const e of pool) assert.strictEqual(e.meta.username, e.username);
  // Gesamtgewicht identisch → gewichteter Zufallslauf trifft dieselben Grenzen.
  assert.strictEqual(pool.reduce((s, e) => s + e.weight, 0),
                     refEligible.reduce((s, p) => s + p.totalCoins, 0));
});

test('Phase 1: chatMeaningful === alte Wortregel + KI-Override', () => {
  const cases = [
    { msg: 'eins zwei drei vier', ai: null,                                    want: { meaningful: true,  judgedBy: 'words' } },
    { msg: 'zu kurz',             ai: null,                                    want: { meaningful: false, judgedBy: 'words' } },
    { msg: 'zu kurz',             ai: { meaningful: true,  source: 'ai' },     want: { meaningful: true,  judgedBy: 'ai' } },
    { msg: 'eins zwei drei vier', ai: { meaningful: false, source: 'ai' },     want: { meaningful: false, judgedBy: 'ai' } },
    { msg: 'eins zwei drei vier', ai: { meaningful: true,  source: 'cache' },  want: { meaningful: true,  judgedBy: 'ai_cache' } },
    // KI-Fehler (meaningful null) → fail-open auf Wortregel, wie vorher.
    { msg: 'eins zwei drei vier', ai: { meaningful: null,  source: 'ai' },     want: { meaningful: true,  judgedBy: 'words' } },
  ];
  for (const c of cases) {
    assert.deepStrictEqual(
      CORE.chatMeaningful({ message: c.msg, minWords: 4, aiVerdict: c.ai }), c.want,
      JSON.stringify(c));
  }
});

test('Phase 1: Re-Exporte der Engine zeigen auf den Core (keine zweite Kopie)', () => {
  assert.strictEqual(coinsFromSec, CORE.coinsFromSec);
  assert.strictEqual(countWords, CORE.countWords);
  assert.strictEqual(SECS_PER_COIN, CORE.defaults.SECS_PER_COIN);
  assert.strictEqual(CHAT_BONUS_SEC, CORE.defaults.CHAT_BONUS_SEC);
  assert.strictEqual(CHAT_MIN_WORDS, CORE.defaults.CHAT_MIN_WORDS);
  assert.strictEqual(CHAT_COOLDOWN, CORE.defaults.CHAT_COOLDOWN);
  assert.strictEqual(MIN_CHANNELS, CORE.defaults.MIN_CHANNELS);
});

test('Phase 1: config-Deklaration trägt die alten Defaults', () => {
  assert.strictEqual(CORE.id, 'CORE_WatchtimeChatActivity');
  assert.strictEqual(CORE.config.coinBaseSec.def, 7200);
  assert.strictEqual(CORE.config.followMin.def, 2);
  assert.strictEqual(CORE.config.chatBonusSec.def, 2);
  assert.strictEqual(CORE.config.chatMinWords.def, 4);
  assert.strictEqual(CORE.config.chatCooldown.def, 10);
  // Grenzen decken sich mit den Engine-Settern (setCoinBaseSec/setFollowMin/setChatConfig).
  assert.strictEqual(CORE.config.coinBaseSec.min, 60);
  assert.strictEqual(CORE.config.coinBaseSec.max, 360000);
  assert.strictEqual(CORE.config.followMin.max, 10);
});

test('Phase 1: Chat-Texte byte-gleich zum alten server.js-Stand', () => {
  const host = 'team.raumdock.org', teamId = 'chaoscrew';

  // !giveaway (vorher giveawayInfoText in server.js)
  assert.strictEqual(
    CORE.infoText({ keyword: '!basher', followMin: 2, drawMinSec: 7200, host, teamId }),
    '🎁 Team-Giveaway: schau auf EINEM der Team-Kanäle zu — die Zuschauzeit zählt zusammen (2 Std = 1 Punkt), '
    + 'sinnvoller Chat (>3 Wörter) gibt Bonus. Mitmachen: schreib "!basher" im Chat (= anmelden). '
    + 'Für den Lostopf: folge ≥2 Kanälen + mind. 1 Punkt (2 Std Zuschauzeit). '
    + 'Befehle: !los = dein Status & Chance · !giveaway = diese Info. '
    + 'Regeln: team.raumdock.org/viewer/terms?team=chaoscrew | Status: team.raumdock.org/viewer/status');

  // !los: geschlossen / berechtigt / nicht angemeldet (vorher time_cmd in server.js)
  const suffix = ' | Status: team.raumdock.org/viewer/status | Regeln: team.raumdock.org/viewer/terms?team=chaoscrew';
  assert.strictEqual(
    CORE.statusText({ username: 'bob', open: false, agg: null, keyword: '', poolTotal: 0, host, teamId }),
    '@bob Kein Giveaway aktiv.' + suffix);

  const eligibleAgg = { eligible: true, registered: true, totalCoins: 2.5, totalWatchSec: 18000,
                        channelsQualified: 2, followMin: 2, drawMinSec: 7200 };
  assert.strictEqual(
    CORE.statusText({ username: 'bob', open: true, agg: eligibleAgg, keyword: '!basher', poolTotal: 10, host, teamId }),
    '@bob 🎟 2.50 Punkte | folgt 2/2 ✓ | Chance 25.0% | im Lostopf ✅' + suffix);

  const unregAgg = { eligible: false, registered: false, totalCoins: 0.5, totalWatchSec: 3600,
                     channelsQualified: 1, followMin: 2, drawMinSec: 7200 };
  assert.strictEqual(
    CORE.statusText({ username: 'bob', open: true, agg: unregAgg, keyword: '!basher', poolTotal: 0, host, teamId }),
    '@bob 🎟 0.50 Punkte – schreib "!basher" um dich anzumelden. Für den Lostopf: folge ≥2 Kanälen + 2 Std Viewtime.' + suffix);

  // Anmelde-Antwort (vorher chat_msg/gw_join in server.js)
  assert.strictEqual(
    CORE.joinReply({ username: 'bob', agg: { eligible: true, coins: 1.25 } }),
    '@bob Du bist dabei & im Lostopf ✅ (1.25 Punkte). Weiter zuschauen + sinnvoll chatten erhöht deine Chance!');
  assert.strictEqual(
    CORE.joinReply({ username: 'bob', agg: { eligible: false, channelsFollowed: 1, followMin: 2,
                                             totalWatchSec: 0, drawMinSec: 7200 } }),
    '@bob Angemeldet ✅ — für den Lostopf noch nötig: folge mind. 2 Kanälen + sammle 2 Std Zuschauzeit (zuschauen + sinnvoll chatten). Stand: !los');
});

test('Phase 1: fmtDur/tickDelta/chatDelta unverändert', () => {
  assert.strictEqual(CORE.fmtDur(7200), '2 Std');
  assert.strictEqual(CORE.fmtDur(1800), '30 Min');
  assert.strictEqual(CORE.fmtDur(5400), '1.5 Std');
  assert.strictEqual(CORE.kw2(1), 'Kanal');
  assert.strictEqual(CORE.kw2(2), 'Kanälen');
  assert.strictEqual(CORE.tickDelta({ tickSec: 60, multiplier: 2 }), 120);
  assert.strictEqual(CORE.chatDelta({ bonusSec: 2, multiplier: 1.5 }), 3);
});

test('Phase 2a: Registry löst Core-IDs auf, Fallback = heutiger Core', () => {
  const reg = require('../cores/index.js');
  assert.strictEqual(reg.getCore('CORE_WatchtimeChatActivity'), CORE);
  assert.strictEqual(reg.getCore('gibts_nicht'), CORE);   // Bestands-Sessions laufen weiter
  assert.strictEqual(reg.getCore(null), CORE);
  assert.strictEqual(reg.DEFAULT_CORE_ID, 'CORE_WatchtimeChatActivity');
  assert.deepStrictEqual(reg.listCores(), [
    { id: 'CORE_WatchtimeChatActivity', label: 'Zuschauzeit & Chat' },
    { id: 'CORE_CurrentViewers',        label: 'Sofortverlosung' },
    { id: 'CORE_TicketBuy',             label: 'Los-Einsatz' },
    { id: 'CORE_ScreenshotContest',     label: 'Screenshot-Contest' },
  ]);
});

test('statusLine: jede Sekundär-Mechanik liefert eine !los-Zusatzzeile', () => {
  const cv = require('../cores/current-viewers');
  const tb = require('../cores/ticket-buy');
  const sc = require('../cores/screenshot-contest');

  // Sofortverlosung: offenes Fenster nennt Keyword + Restzeit, sonst Hinweis.
  assert.strictEqual(cv.statusLine({ keyword: 'sofort', secondsLeft: 90 }),
    '⚡ Sofortverlosung: Anmeldefenster OFFEN — schreib "sofort" (noch 90 Sekunden).');
  assert.strictEqual(cv.statusLine({ keyword: '', secondsLeft: 0 }),
    '⚡ Außerdem läuft eine Sofortverlosung — das nächste Anmeldefenster wird angesagt.');

  // Los-Einsatz: nennt den (konfigurierten) Setz-Befehl, Fallback = Default.
  assert.strictEqual(tb.statusLine({ cmd: '!lose' }),
    '🎟 Außerdem läuft ein Los-Giveaway — Lose setzen mit „!lose <anzahl>" oder auf der Setz-Seite.');
  assert.ok(tb.statusLine({}).includes('!setzen'));

  // Contest: Voting-Zustand entscheidet die Zeile.
  assert.ok(sc.statusLine({ voting: 'open' }).includes('VOTING ist offen'));
  assert.ok(sc.statusLine({ voting: 'closed' }).includes('Einsendungen'));
  assert.ok(sc.statusLine({ voting: 'paused' }).includes('Einsendungen'));

  // Mit url hängen infoText/statusLine den Seiten-Link an (Ansagen im Chat).
  assert.ok(tb.statusLine({ cmd: '!lose', url: 'https://x/viewer/wager' }).endsWith('→ https://x/viewer/wager'));
  assert.ok(tb.infoText({ cmd: '!lose', url: 'https://x/viewer/wager' }).includes('https://x/viewer/wager'));
  assert.ok(sc.statusLine({ voting: 'open', url: 'https://x/viewer/contest' }).endsWith('→ https://x/viewer/contest'));
  assert.ok(sc.infoText({ url: 'https://x/viewer/contest' }).includes('https://x/viewer/contest'));

  // Kampagnen-Core braucht KEINE statusLine (Primary spricht via statusText).
  assert.strictEqual(typeof CORE.statusLine, 'undefined');
});

test('Phase 1: coinsFromSec Fallback bei fehlender Basis unverändert', () => {
  for (const sec of [0, 1, 3599, 3600, 7200, 10800, 123456]) {
    assert.strictEqual(CORE.coinsFromSec(sec), refCoinsFromSec(sec));
    assert.strictEqual(CORE.coinsFromSec(sec, 0), refCoinsFromSec(sec, 0));
    assert.strictEqual(CORE.coinsFromSec(sec, NaN), refCoinsFromSec(sec, NaN));
    assert.strictEqual(CORE.coinsFromSec(sec, 600), refCoinsFromSec(sec, 600));
  }
});
