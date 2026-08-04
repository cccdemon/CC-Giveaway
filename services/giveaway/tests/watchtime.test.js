'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  WatchtimeEngine, K, coinsFromSec, countWords, sanitizeStr, sanitizeUsername, matchesKeyword,
  CHAT_BONUS_SEC, SECS_PER_COIN,
} = require('../watchtime.js');

const TEAM = 'team_test';
const CH = ['justcallmedeimos', 'jerichoramirez', 'x_jazzz_x'];

// ── In-memory redis/pg mocks ──────────────────────────────
function makeRedis() {
  const store = new Map(), sets = new Map(), lists = new Map();
  const api = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, String(v)); return 'OK'; },
    async del(...ks) { ks.flat().forEach(k => { store.delete(k); sets.delete(k); lists.delete(k); }); return 1; },
    async incr(k) { const n = (parseFloat(store.get(k)) || 0) + 1; store.set(k, String(n)); return n; },
    async incrbyfloat(k, by) { const n = (parseFloat(store.get(k)) || 0) + Number(by); store.set(k, String(n)); return String(n); },
    async incrby(k, by) { const n = (parseInt(store.get(k)) || 0) + parseInt(by); store.set(k, String(n)); return n; },
    async sadd(k, ...m) { if (!sets.has(k)) sets.set(k, new Set()); m.flat().forEach(x => sets.get(k).add(x)); return 1; },
    async srem(k, ...m) { if (sets.has(k)) m.flat().forEach(x => sets.get(k).delete(x)); return 1; },
    async smembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
    async lpush(k, ...v) { if (!lists.has(k)) lists.set(k, []); lists.get(k).unshift(...v.flat().map(String)); return lists.get(k).length; },
    async ltrim(k, a, b) { if (lists.has(k)) lists.set(k, lists.get(k).slice(a, b + 1)); return 'OK'; },
    async lrange(k, a, b) { const l = lists.get(k) || []; return l.slice(a, b === -1 ? undefined : b + 1); },
    async ttl(k) { return store.has(k) ? 100 : -2; },
    pipeline() {
      const ops = [];
      const p = { del:(...a)=>{ops.push(()=>api.del(...a));return p;}, set:(...a)=>{ops.push(()=>api.set(...a));return p;},
                  srem:(...a)=>{ops.push(()=>api.srem(...a));return p;}, async exec(){ for (const o of ops) await o(); return []; } };
      return p;
    },
  };
  return api;
}
function makePg(channels) {
  return {
    async query(sql) {
      if (/from team_members/i.test(sql)) return { rows: (channels || []).map(c => ({ channel: c })) };
      return { rows: [{ n: 0 }], rowCount: 1 };
    },
    async connect() {
      return { async query(sql) {
        if (/RETURNING id/.test(sql)) return { rows: [{ id: 1 }] };
        if (/COUNT/.test(sql)) return { rows: [{ n: 0 }] };
        if (/SELECT winner/.test(sql)) return { rows: [{}] };
        return { rows: [], rowCount: 1 };
      }, release() {} };
    },
  };
}
function engine(channels) { return new WatchtimeEngine(makeRedis(), makePg(channels || CH)); }

test('coinsFromSec / countWords / sanitize', () => {
  assert.equal(coinsFromSec(SECS_PER_COIN), 1);
  assert.equal(countWords('one two three four'), 4);
  assert.equal(sanitizeUsername('Bob_X!!'), 'bob_x');
  assert.equal(sanitizeStr('<b>hi"there</b>'), 'bhithere/b');
});

test('getChannels reads team_members', async () => {
  const e = engine();
  assert.deepEqual(await e.getChannels(TEAM), CH);
});

test('chat bonus 0.5s when following + >3 words', async () => {
  const e = engine();
  await e.redis.set(K.gwOpen(TEAM), 'true');
  const r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'this is a message', true);
  assert.equal(r.added, CHAT_BONUS_SEC);
});

test('chat bonus blocked when not following', async () => {
  const e = engine();
  await e.redis.set(K.gwOpen(TEAM), 'true');
  const r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'this is a message', false);
  assert.equal(r.followed, false);
});

test('multiplier doubles chat bonus', async () => {
  const e = engine();
  await e.redis.set(K.gwOpen(TEAM), 'true');
  await e.setMultiplier(TEAM, 2, 900);
  const r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'this is a message', true);
  assert.equal(r.added, CHAT_BONUS_SEC * 2);
});

test('multiplier clamps + removes at 1', async () => {
  const e = engine();
  await e.setMultiplier(TEAM, 99, 60);
  assert.equal(await e.getMultiplier(TEAM), 10);
  await e.setMultiplier(TEAM, 1, 60);
  assert.equal(await e.getMultiplier(TEAM), 1);
});

test('keyword matches as a word, not only as the whole message', () => {
  assert.equal(matchesKeyword('!basher', '!basher'), true);
  assert.equal(matchesKeyword('  !BASHER  ', '!basher'), true);
  assert.equal(matchesKeyword('!basher bin dabei', '!basher'), true);
  assert.equal(matchesKeyword('ja klar !basher', '!basher'), true);
  assert.equal(matchesKeyword('!basher!', '!basher'), true);
  assert.equal(matchesKeyword('basher', '!basher'), true);      // ! am Wortrand egal
  assert.equal(matchesKeyword('!bash', '!basher'), false);
  assert.equal(matchesKeyword('!basherx', '!basher'), false);
  assert.equal(matchesKeyword('kein keyword hier', '!basher'), false);
  assert.equal(matchesKeyword('!basher', ''), false);           // Keyword deaktiviert
  assert.equal(matchesKeyword('!basher', null), false);
});

// Opt-in per Keyword steht jedem offen (= Zustimmung Regeln). Der Coin-Gate
// sitzt in `eligible`, nicht in der Anmeldung.
test('keyword opt-in registers everyone, eligibility still needs >=1 coin', async () => {
  const e = engine();
  await e.redis.set(K.gwOpen(TEAM), 'true');
  await e.redis.set(K.gwKeyword(TEAM), 'join');
  await e.redis.set(K.chFollows(TEAM, 'jerichoramirez', 'bob'), '1');
  let r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'join', true);
  assert.equal(r.registered, true);
  assert.equal(r.isNew, true);
  assert.equal(r.eligible, false);        // angemeldet, aber 0 Coins
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'join', true);
  assert.equal(r.isNew, false);
  assert.equal(r.eligible, true);
});

test('eligible only with valid coins on >=2 channels + registered', async () => {
  const e = engine();
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
  await e.redis.set(K.gwRegistered(TEAM, 'bob'), '1');
  let a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.channelsQualified, 1);
  assert.equal(a.eligible, false);
  await e.redis.set(K.chWatch(TEAM, 'jerichoramirez', 'bob'), String(SECS_PER_COIN));
  await e.redis.set(K.chFollows(TEAM, 'jerichoramirez', 'bob'), '1');
  a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.channelsQualified, 2);
  assert.equal(a.totalCoins, 2);
  assert.equal(a.eligible, true);
});

test('follow gate decoupled from watching: follow >=min, watch anywhere', async () => {
  const e = engine();
  // Carol watches ONLY deimos, but follows deimos + jericho (Helix-verified).
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'carol'), String(SECS_PER_COIN));
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'carol'), '1');
  await e.redis.set(K.chFollows(TEAM, 'jerichoramirez', 'carol'), '1');
  await e.redis.set(K.gwRegistered(TEAM, 'carol'), '1');
  const a = await e.getUserAggregate(TEAM, 'carol');
  assert.equal(a.channelsFollowed, 2);
  assert.equal(a.totalCoins, 1);        // watched only one channel → pooled total
  assert.equal(a.eligible, true);       // follows 2 + has viewtime → in pool
});

test('followMin is configurable per team', async () => {
  const e = engine();
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'dave'), String(SECS_PER_COIN));
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'dave'), '1');
  await e.redis.set(K.gwRegistered(TEAM, 'dave'), '1');
  let a = await e.getUserAggregate(TEAM, 'dave');
  assert.equal(a.eligible, false);      // default 2, follows only 1
  await e.setFollowMin(TEAM, 1);
  a = await e.getUserAggregate(TEAM, 'dave');
  assert.equal(a.followMin, 1);
  assert.equal(a.eligible, true);       // now 1 follow suffices
});

test('coin base is configurable and doubles as the draw threshold', async () => {
  const e = engine();
  await e.setCoinBaseSec(TEAM, 3600);                                 // 1 Coin = 1h
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'erin'), '1800');
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'erin'), '1');
  await e.redis.set(K.chFollows(TEAM, 'jerichoramirez', 'erin'), '1');
  await e.redis.set(K.gwRegistered(TEAM, 'erin'), '1');
  let a = await e.getUserAggregate(TEAM, 'erin');
  assert.equal(a.totalCoins, 0.5);
  assert.equal(a.coinBaseSec, 3600);
  assert.equal(a.drawMinSec, 3600);
  assert.equal(a.eligible, false);      // <1 Coin
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'erin'), '3600');
  a = await e.getUserAggregate(TEAM, 'erin');
  assert.equal(a.totalCoins, 1);
  assert.equal(a.eligible, true);       // genau 1 Coin reicht
});

test('chat bonus is configurable per team', async () => {
  const e = engine();
  await e.redis.set(K.gwOpen(TEAM), 'true');
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
  const key = K.chWatch(TEAM, 'justcallmedeimos', 'bob');

  // Default: 4 Wörter, +2s
  let r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'eins zwei drei vier', true);
  assert.equal(r.added, 2);

  // Schwelle hoch, Bonus hoch, Cooldown aus
  await e.setChatConfig(TEAM, { minWords: 6, bonusSec: 5, cooldown: 0 });
  assert.deepEqual(await e.getChatConfig(TEAM), { bonusSec: 5, minWords: 6, cooldown: 0 });
  assert.equal(await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'eins zwei drei vier', true), null);
  r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'eins zwei drei vier fuenf sechs', true);
  assert.equal(r.added, 5);

  // Bonus 0 = Chat zählt gar nicht
  await e.setChatConfig(TEAM, { bonusSec: 0 });
  const before = await e.redis.get(key);
  assert.equal(await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'eins zwei drei vier fuenf sechs', true), null);
  assert.equal(await e.redis.get(key), before);

  // Clamping: unsinnige Werte werden begrenzt, nicht übernommen
  const c = await e.setChatConfig(TEAM, { bonusSec: 9999, minWords: 0, cooldown: -5 });
  assert.equal(c.bonusSec, 300);
  assert.equal(c.minWords, 1);
  assert.equal(c.cooldown, 0);
});

test('chat bonus honours the viewtime multiplier', async () => {
  const e = engine();
  await e.redis.set(K.gwOpen(TEAM), 'true');
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
  await e.setChatConfig(TEAM, { bonusSec: 3, cooldown: 0 });
  await e.setMultiplier(TEAM, 2, 600);
  const r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'eins zwei drei vier', true);
  assert.equal(r.added, 6);
});

test('ai judge overrides the word rule in both directions, errors fall back', async () => {
  const mk = (judge) => new WatchtimeEngine(makeRedis(), makePg(CH), judge);
  const setup = async (e) => {
    await e.redis.set(K.gwOpen(TEAM), 'true');
    await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
    await e.setChatConfig(TEAM, { cooldown: 0 });
  };

  // Kurze Nachricht (unter der Wortschwelle) — KI sagt sinnvoll → Bonus.
  const yes = mk(async () => ({ meaningful: true, source: 'ai' }));
  await setup(yes);
  const r1 = await yes.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'gg wp', true);
  assert.equal(r1.added, 2);
  assert.equal(r1.judgedBy, 'ai');

  // Lange Nachricht (über der Schwelle) — KI sagt Spam → kein Bonus.
  const no = mk(async () => ({ meaningful: false, source: 'ai' }));
  await setup(no);
  assert.equal(await no.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'aaa bbb ccc ddd eee', true), null);

  // KI kaputt → Wortregel entscheidet wie vorher.
  const broken = mk(async () => ({ meaningful: null, source: 'error' }));
  await setup(broken);
  const r2 = await broken.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'eins zwei drei vier', true);
  assert.equal(r2.added, 2);
  assert.equal(r2.judgedBy, 'words');
  assert.equal(await broken.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'zu kurz', true), null);
});

test('backup roundtrip: export → reset → import restores the exact state', async () => {
  const e = engine();
  await e.setCoinBaseSec(TEAM, 3600);
  await e.setFollowMin(TEAM, 1);
  await e.redis.set(K.gwKeyword(TEAM), '!basher');
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'bob'), '5400');
  await e.redis.set(K.chMsgs(TEAM, 'justcallmedeimos', 'bob'), '12');
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
  await e.redis.set(K.chFollows(TEAM, 'jerichoramirez', 'bob'), '1');
  await e.redis.set(K.gwRegistered(TEAM, 'bob'), '1');
  await e.redis.sadd(K.gwUsers(TEAM), 'bob');

  const backup = await e.exportTeam(TEAM);
  assert.equal(backup.format, 'cc-giveaway-backup');
  assert.equal(backup.config.coinBaseSec, 3600);
  assert.equal(backup.config.keyword, '!basher');
  assert.equal(backup.participants.length, 1);

  await e.resetGiveaway(TEAM);
  assert.equal((await e.getAllParticipants(TEAM)).length, 0);

  const r = await e.importTeam(TEAM, backup, { mode: 'replace' });
  assert.equal(r.users, 1);
  const a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, 5400);
  assert.equal(a.msgs, 12);
  assert.equal(a.registered, true);
  assert.equal(a.channelsFollowed, 2);
  assert.equal(a.eligible, true);
  assert.equal(await e.getCoinBaseSec(TEAM), 3600);
});

test('backup merge adds on top instead of replacing', async () => {
  const e = engine();
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'bob'), '1000');
  await e.redis.sadd(K.gwUsers(TEAM), 'bob');
  const backup = await e.exportTeam(TEAM);
  await e.importTeam(TEAM, backup, { mode: 'merge' });
  const a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, 2000);      // 1000 vorhanden + 1000 aus dem Backup
});

test('import rejects foreign or unversioned payloads', async () => {
  const e = engine();
  await assert.rejects(() => e.importTeam(TEAM, { hello: 'world' }), /format/);
  await assert.rejects(() => e.importTeam(TEAM, { format: 'cc-giveaway-backup', version: 99, participants: [] }), /Version/);
  await assert.rejects(() => e.importTeam(TEAM, { format: 'cc-giveaway-backup', version: 1 }), /participants/);
});

test('team isolation: users/coins do not leak across teams', async () => {
  const e = engine();
  await e.redis.set(K.chWatch('team_a', 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  await e.redis.sadd(K.gwUsers('team_a'), 'bob');
  const a = await e.getUserAggregate('team_a', 'bob');
  const b = await e.getUserAggregate('team_b', 'bob');
  assert.equal(a.totalCoins, 1);
  assert.equal(b.totalCoins, 0);
  assert.equal((await e.getAllParticipants('team_b')).length, 0);
});

test('abuse: dup_message flag after identical repeats', async () => {
  const e = engine(); const flags = [];
  e.flagUser = async (t, u, r) => flags.push(r);
  for (let i = 0; i < 3; i++) await e._detectAbuse(TEAM, 'spammer', 'copy paste spam text');
  assert.ok(flags.includes('dup_message'));
});

test('abuse: high_rate flag on message burst', async () => {
  const e = engine(); const flags = [];
  e.flagUser = async (t, u, r) => flags.push(r);
  for (let i = 0; i < 12; i++) await e._detectAbuse(TEAM, 'fast', 'unique message number ' + i);
  assert.ok(flags.includes('high_rate'));
});

test('drawWinner ignores non-eligible', async () => {
  const e = engine();
  for (const ch of ['justcallmedeimos', 'jerichoramirez']) {
    await e.redis.set(K.chWatch(TEAM, ch, 'alice'), String(SECS_PER_COIN));
    await e.redis.set(K.chFollows(TEAM, ch, 'alice'), '1');
  }
  await e.redis.set(K.gwRegistered(TEAM, 'alice'), '1');
  await e.redis.sadd(K.gwUsers(TEAM), 'alice');
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
  await e.redis.set(K.gwRegistered(TEAM, 'bob'), '1');
  await e.redis.sadd(K.gwUsers(TEAM), 'bob');
  const r = await e.drawWinner(TEAM, 'sess_1', {});
  assert.equal(r.winner, 'alice');
  assert.equal(r.eligibleCount, 1);
});

// ── Phase 2b: Giveaway-Dimension (g:<sid>-Schlüssel) ──────
// gid = Session-ID. Ohne offene Session bleibt alles auf den Legacy-Keys —
// das decken die Tests oben ab. Hier: Migration, Isolation, Aufräumen.

test('phase2b: laufendes Giveaway migriert Altbestand beim ersten Zugriff', async () => {
  const e = engine();
  // Altbestand aus der Zeit vor dem Deploy:
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.tickPresentUsers();
  const a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, SECS_PER_COIN + 60);
  // Quelle ist jetzt der g:-Schlüssel, der Legacy-Schlüssel ist weg:
  assert.equal(await e.redis.get(K.chWatch(TEAM, 'justcallmedeimos', 'bob')), null);
  assert.equal(parseFloat(await e.redis.get(K.gWatch(TEAM, 'sess_1', 'justcallmedeimos', 'bob'))), SECS_PER_COIN + 60);
});

test('phase2b: zweites Giveaway startet bei null, Stand des ersten bleibt getrennt', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.tickPresentUsers();
  let a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, 60);
  await e.openGiveaway(TEAM, 'join', 'sess_2');
  a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, 0);                 // frischer Stand
  assert.equal(parseFloat(await e.redis.get(K.gWatch(TEAM, 'sess_1', 'justcallmedeimos', 'bob'))), 60);
});

test('phase2b: Multiplier haengt am Giveaway, nicht am Team', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.setMultiplier(TEAM, 2, 900);
  assert.equal(await e.getMultiplier(TEAM), 2);
  await e.openGiveaway(TEAM, 'join', 'sess_2');
  assert.equal(await e.getMultiplier(TEAM), 1);     // kein Alt-Boost im neuen Giveaway
});

test('phase2b: Legacy-Multiplier wirkt nach Deploy weiter (Fallback)', async () => {
  const e = engine();
  await e.redis.set(K.gwMult(TEAM), '3');           // Boost von vor dem Deploy
  await e.redis.set(K.gwSessionId(TEAM), 'sess_1'); // laufende Session
  assert.equal(await e.getMultiplier(TEAM), 3);
});

test('phase2b: reset raeumt auch die g:-Schluessel ab', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.tickPresentUsers();
  await e.setMultiplier(TEAM, 2, 900);
  await e.resetGiveaway(TEAM);
  assert.equal(await e.redis.get(K.gWatch(TEAM, 'sess_1', 'justcallmedeimos', 'bob')), null);
  assert.equal(await e.redis.get(K.gMult(TEAM, 'sess_1')), null);
  const a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, 0);
});

test('phase2b: backup roundtrip ueber die Giveaway-Dimension', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.tickPresentUsers();
  const dump = await e.exportTeam(TEAM);
  assert.equal(dump.participants[0].perChannel['justcallmedeimos'].watchSec, 60);
  await e.resetGiveaway(TEAM);
  await e.importTeam(TEAM, dump, { mode: 'replace' });
  const a = await e.getUserAggregate(TEAM, 'bob');
  assert.equal(a.totalWatchSec, 60);
});

// ── Phase 2c: Parallelbetrieb (Abnahme §8 Phase 2) ────────

test('phase2c: ein viewer_tick erhoeht beide Giveaways, Staende getrennt', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');                       // Kampagne (Primary)
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz' }); // Sofortverlosung
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  const updates = await e.tickPresentUsers();
  assert.equal(updates.length, 2);                                    // beide bedient
  const a1 = await e.getUserAggregate(TEAM, 'bob');                   // Primary
  const a2 = await e.getUserAggregate(TEAM, 'bob', 'sess_2');
  assert.equal(a1.totalWatchSec, 60);
  assert.equal(a2.totalWatchSec, 60);
  // getrennte Schlüssel:
  assert.equal(parseFloat(await e.redis.get(K.gWatch(TEAM, 'sess_1', 'justcallmedeimos', 'bob'))), 60);
  assert.equal(parseFloat(await e.redis.get(K.gWatch(TEAM, 'sess_2', 'justcallmedeimos', 'bob'))), 60);
});

test('phase2c: Keyword je Giveaway, Anmeldung landet nur dort', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz' });
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  assert.equal((await e.getUserAggregate(TEAM, 'bob')).registered, false);           // Primary nicht
  assert.equal((await e.getUserAggregate(TEAM, 'bob', 'sess_2')).registered, true);  // Instanz ja
  const r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'join', true);
  assert.equal(r.registered, true);                                                  // Primary-Kontrakt
  assert.equal((await e.getUserAggregate(TEAM, 'bob')).registered, true);
});

test('phase2c: Pause einer Instanz stoppt nur deren Accrual', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', {});
  await e.setPaused(TEAM, true, 'sess_2');
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.tickPresentUsers();
  assert.equal((await e.getUserAggregate(TEAM, 'bob')).totalWatchSec, 60);
  assert.equal((await e.getUserAggregate(TEAM, 'bob', 'sess_2')).totalWatchSec, 0);
  await e.setPaused(TEAM, false, 'sess_2');
  await e.tickPresentUsers();
  assert.equal((await e.getUserAggregate(TEAM, 'bob', 'sess_2')).totalWatchSec, 60);
});

test('phase2c: Instanz mit Kanal-Teilmenge bekommt nur diese Ticks', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', { channels: ['jerichoramirez'] });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);   // nicht in sess_2-Liste
  await e.tickPresentUsers();
  assert.equal((await e.getUserAggregate(TEAM, 'bob')).totalWatchSec, 60);
  assert.equal((await e.getUserAggregate(TEAM, 'bob', 'sess_2')).totalWatchSec, 0);
  await e.handleViewerTick(TEAM, 'jerichoramirez', 'bob', true);     // in beiden
  await e.tickPresentUsers();
  assert.equal((await e.getUserAggregate(TEAM, 'bob', 'sess_2')).totalWatchSec, 60);
});

test('phase2c: Ziehung je Giveaway zieht nur dessen Stand', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz' });
  // bob nur in sess_2 berechtigt: Anmeldung dort + Viewtime + Follows
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'bob'), '1');
  await e.redis.set(K.chFollows(TEAM, 'jerichoramirez', 'bob'), '1');
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  await e.redis.set(K.gWatch(TEAM, 'sess_2', 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  await e.redis.sadd(K.gwUsers(TEAM), 'bob');
  const r2 = await e.drawWinner(TEAM, 'sess_2', {});
  assert.equal(r2.winner, 'bob');
  const r1 = await e.drawWinner(TEAM, 'sess_1', {});
  assert.equal(r1, null);                            // Primary: niemand berechtigt
});

test('phase2c: close der Instanz laesst Kampagne im Scan-Set, und umgekehrt', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', {});
  await e.closeGiveawayInstance(TEAM, 'sess_2');
  assert.deepEqual(await e.listOpenTeams(), [TEAM]);  // Kampagne läuft weiter
  await e.closeGiveaway(TEAM, 'sess_1');
  assert.deepEqual(await e.listOpenTeams(), []);
});
