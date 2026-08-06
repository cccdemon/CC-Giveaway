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
  // In-Memory-Tabellen für die TicketBuy-Pfade (Phase 4b) — die übrigen
  // Queries laufen wie bisher auf die Dummy-Antwort.
  const prizes = [], wagers = [], ledger = [], entries = [], cvotes = [];
  let prizeSeq = 1, entrySeq = 1;
  async function query(sql, p = []) {
    if (/from team_members/i.test(sql)) return { rows: (channels || []).map(c => ({ channel: c })) };
    if (/INSERT INTO giveaway_prizes/.test(sql)) {
      const row = { id: prizeSeq++, team_id: p[0], session_id: p[1], title: p[2],
                    description: p[3], wager_end: p[4], status: 'open' };
      prizes.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (/SELECT id, title, status, wager_end FROM giveaway_prizes/.test(sql)
        || /SELECT id, title, status FROM giveaway_prizes/.test(sql)
        || /SELECT id, status FROM giveaway_prizes/.test(sql)) {
      const r = prizes.filter(x => x.id === p[0] && x.team_id === p[1]);
      return { rows: r, rowCount: r.length };
    }
    if (/SELECT id, title, sponsor, description, wager_end, status FROM giveaway_prizes/.test(sql)) {
      const r = prizes.filter(x => x.id === p[0]);
      return { rows: r, rowCount: r.length };
    }
    if (/COUNT\(\*\) AS n FROM giveaway_prizes/.test(sql)) {
      return { rows: [{ n: prizes.filter(x => x.team_id === p[0] && x.session_id === p[1] && x.status === 'open').length }] };
    }
    if (/UPDATE giveaway_prizes SET status='cancelled'/.test(sql)) {
      const pr = prizes.find(x => x.id === p[0]); if (pr) pr.status = 'cancelled';
      return { rowCount: pr ? 1 : 0, rows: [] };
    }
    if (/UPDATE giveaway_prizes SET (title|sponsor|description|wager_end)=\$1/.test(sql)) {
      const field = sql.match(/SET (\w+)=\$1/)[1];
      const pr = prizes.find(x => x.id === p[1]); if (pr) pr[field] = p[0];
      return { rowCount: pr ? 1 : 0, rows: [] };
    }
    if (/FROM giveaway_prizes p WHERE/.test(sql)) {
      return { rows: prizes.filter(x => x.team_id === p[0] && (!/status='open'/.test(sql) || x.status === 'open'))
        .map(x => ({ ...x, total_stake: wagers.filter(w => w.prize_id === x.id).reduce((s, w) => s + w.amount, 0) })) };
    }
    if (/INSERT INTO prize_wagers/.test(sql)) {
      wagers.push({ prize_id: p[0], team_id: p[1], username: p[2], amount: parseFloat(p[3]) });
      return { rowCount: 1, rows: [] };
    }
    if (/AS stake FROM prize_wagers WHERE prize_id=\$1 AND username=\$2/.test(sql)) {
      const stake = wagers.filter(w => w.prize_id === p[0] && w.username === p[1]).reduce((s, w) => s + w.amount, 0);
      return { rows: [{ stake }] };
    }
    if (/GROUP BY username HAVING/.test(sql)) {
      const by = new Map();
      for (const w of wagers) if (w.prize_id === p[0] && w.team_id === p[1])
        by.set(w.username, (by.get(w.username) || 0) + w.amount);
      return { rows: [...by.entries()].filter(([, s]) => s > 0).map(([username, stake]) => ({ username, stake })) };
    }
    // ── Contest (Phase 6) ──
    if (/DELETE FROM contest_entries WHERE session_id=\$1 AND team_id=\$2 AND username=\$3/.test(sql)) {
      const idx = entries.findIndex(e => e.session_id === p[0] && e.team_id === p[1] && e.username === p[2]);
      if (idx < 0) return { rowCount: 0, rows: [] };
      const id = entries[idx].id;
      entries.splice(idx, 1);
      for (let i = cvotes.length - 1; i >= 0; i--) if (cvotes[i].entry_id === id) cvotes.splice(i, 1);   // CASCADE
      return { rowCount: 1, rows: [{ id }] };
    }
    if (/INSERT INTO contest_entries/.test(sql)) {
      const ex = entries.find(e => e.session_id === p[1] && e.username === p[2]);
      if (ex) Object.assign(ex, { title: p[3], mime: p[4], image: p[5], status: 'pending' });
      else entries.push({ id: entrySeq++, team_id: p[0], session_id: p[1], username: p[2],
                          title: p[3], mime: p[4], image: p[5], status: 'pending' });
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT id FROM contest_entries WHERE session_id=\$1 AND username=\$2/.test(sql)) {
      const r = entries.filter(e => e.session_id === p[0] && e.username === p[1]);
      return { rows: r, rowCount: r.length };
    }
    if (/COUNT\(\*\)::int AS n FROM contest_votes WHERE entry_id=\$1/.test(sql)) {
      return { rows: [{ n: cvotes.filter(v => v.entry_id === p[0]).length }] };
    }
    if (/DELETE FROM contest_votes WHERE entry_id=\$1/.test(sql)) {
      const before = cvotes.length;
      for (let i = cvotes.length - 1; i >= 0; i--) if (cvotes[i].entry_id === p[0]) cvotes.splice(i, 1);
      return { rowCount: before - cvotes.length, rows: [] };
    }
    if (/UPDATE contest_entries SET status=\$3/.test(sql)) {
      const e = entries.find(x => x.id === p[0] && x.team_id === p[1]);
      if (e) e.status = p[2];
      return e ? { rowCount: 1, rows: [{ username: e.username, title: e.title }] } : { rowCount: 0, rows: [] };
    }
    if (/SELECT id, username, status FROM contest_entries WHERE id=\$1/.test(sql)) {
      const r = entries.filter(e => e.id === p[0] && e.session_id === p[1] && e.team_id === p[2]);
      return { rows: r, rowCount: r.length };
    }
    if (/INSERT INTO contest_votes/.test(sql)) {
      const ex = cvotes.find(v => v.entry_id === p[0] && v.voter === p[3]);
      if (ex) ex.score = p[4];
      else cvotes.push({ entry_id: p[0], team_id: p[1], session_id: p[2], voter: p[3], score: p[4] });
      return { rowCount: 1, rows: [] };
    }
    if (/FROM contest_entries e/.test(sql)) {
      const all = !/status='approved'/.test(sql);
      return { rows: entries.filter(e => e.session_id === p[0] && e.team_id === p[1] && (all || e.status === 'approved'))
        .map(e => {
          const vs = cvotes.filter(v => v.entry_id === e.id);
          return { entry_id: e.id, username: e.username, title: e.title, status: e.status,
                   score: vs.reduce((s, v) => s + v.score, 0), votes: vs.length };
        }).sort((a, b) => b.score - a.score || b.votes - a.votes || a.entry_id - b.entry_id) };
    }
    if (/INSERT INTO credit_ledger/.test(sql)) {
      ledger.push({ team_id: p[0], username: p[1], entry_type: p[2], amount: parseFloat(p[3]) });
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT COALESCE\(SUM\(amount\),0\) AS bal FROM credit_ledger/.test(sql)) {
      const bal = ledger.filter(r => r.team_id === p[0] && r.username === p[1]).reduce((s, r) => s + r.amount, 0);
      return { rows: [{ bal }] };
    }
    // Panel-Teilnehmerlisten je Mechanik + Dropdown-Statistiken
    if (/SUM\(amount\) AS balance FROM credit_ledger/.test(sql)) {
      const by = new Map();
      for (const r of ledger) if (r.team_id === p[0]) by.set(r.username, (by.get(r.username) || 0) + r.amount);
      return { rows: [...by.entries()].map(([username, balance]) => ({ username, balance })) };
    }
    if (/SUM\(w\.amount\) AS stake/.test(sql)) {
      const by = new Map();
      for (const w of wagers) {
        const pr = prizes.find(x => x.id === w.prize_id);
        if (pr && pr.team_id === p[0] && pr.session_id === p[1]) by.set(w.username, (by.get(w.username) || 0) + w.amount);
      }
      return { rows: [...by.entries()].map(([username, stake]) => ({ username, stake })) };
    }
    if (/COUNT\(\*\)::int AS cnt FROM contest_entries/.test(sql)) {
      return { rows: [{ cnt: entries.filter(e => e.session_id === p[0] && e.team_id === p[1]).length }] };
    }
    if (/SELECT id, opened_at FROM sessions/.test(sql)) {
      return { rows: (p[1] || []).map(id => ({ id, opened_at: '2026-08-06T10:00:00Z' })) };
    }
    return { rows: [{ n: 0 }], rowCount: 1 };
  }
  return {
    prizes, wagers, ledger, entries, cvotes,
    query,
    async connect() {
      return { async query(sql, p = []) {
        if (/UPDATE giveaway_prizes SET status='drawn'/.test(sql)) {
          const pr = prizes.find(x => x.id === p[0]); if (pr) pr.status = 'drawn';
          return { rowCount: pr ? 1 : 0, rows: [] };
        }
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

// ── Phase 2d: Server-Anbindung der Instanzen ──────────────

test('phase2d: Sekundaer-Boost laesst Primary-Boost unberuehrt', async () => {
  const e = engine();
  await e.redis.set(K.gwMult(TEAM), '3');            // Legacy-Boost von vor dem Deploy
  await e.redis.set(K.gwSessionId(TEAM), 'sess_1');
  await e.redis.set(K.gwOpen(TEAM), 'true');
  await e.openGiveawayInstance(TEAM, 'sess_2', {});
  await e.setMultiplier(TEAM, 2, 900, 'sess_2');
  assert.equal(await e.getMultiplier(TEAM), 3);           // Primary weiter 3 (Fallback)
  assert.equal(await e.getMultiplier(TEAM, 'sess_2'), 2);
  await e.setMultiplier(TEAM, 1, 0, 'sess_2');            // Sekundär aus
  assert.equal(await e.getMultiplier(TEAM), 3);           // Primary unberührt
});

test('phase2d: listGiveaways liefert Primary + Instanzen mit Metadaten', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', channels: ['jerichoramirez'] });
  await e.setPaused(TEAM, true, 'sess_2');
  const list = await e.listGiveaways(TEAM);
  assert.equal(list.length, 2);
  const p = list.find(g => g.primary), s = list.find(g => !g.primary);
  assert.equal(p.gid, 'sess_1');
  assert.equal(p.keyword, 'join');
  assert.equal(s.gid, 'sess_2');
  assert.equal(s.paused, true);
  assert.deepEqual(s.channels, ['jerichoramirez']);
});

// ── Phase 3: CORE_CurrentViewers (Sofortverlosung) ────────

test('phase3: CV-Instanz sammelt keine Watchtime, Kampagne schon', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  const updates = await e.tickPresentUsers();
  assert.equal(updates.length, 1);                                  // nur Kampagne
  assert.equal(await e.redis.get(K.gWatch(TEAM, 'sess_2', 'justcallmedeimos', 'bob')), null);
});

test('phase3: berechtigt nur mit Keyword UND viewer_tick-Praesenz', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  // alice: nur Chat (Keyword) — chLastTick fehlt → nicht anwesend
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'alice', 'blitz', true);
  // bob: Keyword + viewer_tick → anwesend
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  const parts = await e.getInstantParticipants(TEAM, 'sess_2');
  const alice = parts.find(p => p.username === 'alice');
  const bob   = parts.find(p => p.username === 'bob');
  assert.equal(alice.eligible, false);   // Chat-Tab offen reicht nicht
  assert.equal(bob.eligible, true);
  assert.equal(bob.weight, 1);
});

test('phase3: Ziehung der CV-Instanz zieht unter Anwesenden, stempelt Core', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  const r = await e.drawWinner(TEAM, 'sess_2', {});
  assert.equal(r.winner, 'bob');
  assert.equal(r.coins, 1);              // Gewicht 1, kein Coin-Konto
  assert.equal(r.eligibleCount, 1);
});

test('phase3: leere CV-Ziehung liefert null (Abbruch statt Leer-Zug)', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  // alice hat Keyword, aber keine Praesenz → niemand berechtigt
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'alice', 'blitz', true);
  assert.equal(await e.drawWinner(TEAM, 'sess_2', {}), null);
});

test('phase3: CV beeinflusst die Kampagne nicht (Keyword-Trennung + Draw)', async () => {
  const e = engine();
  await e.openGiveaway(TEAM, 'join', 'sess_1');
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  assert.equal((await e.getUserAggregate(TEAM, 'bob')).registered, false);   // Kampagne unberührt
  assert.equal(await e.drawWinner(TEAM, 'sess_1', {}), null);                // dort niemand drin
});

test('phase3: cleanup raeumt die Instanz vollstaendig ab', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  await e.closeGiveawayInstance(TEAM, 'sess_2');
  await e.cleanupGiveawayInstance(TEAM, 'sess_2');
  assert.equal(await e.redis.get(K.gReg(TEAM, 'sess_2', 'bob')), null);
  assert.equal(await e.redis.get(K.gCore(TEAM, 'sess_2')), null);
  assert.equal(await e.redis.get(K.gWinEnd(TEAM, 'sess_2')), null);
  assert.deepEqual(await e.redis.smembers(K.gwSet(TEAM)), []);
});

test('phase3: windowEndsAt steht in listGiveaways', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  const g = (await e.listGiveaways(TEAM)).find(x => x.gid === 'sess_2');
  assert.equal(g.core, 'CORE_CurrentViewers');
  assert.ok(g.windowEndsAt > Math.floor(Date.now() / 1000));
  assert.ok(g.windowEndsAt <= Math.floor(Date.now() / 1000) + 61);
});

// ── Phase 4b: CORE_TicketBuy (Preise, Einsätze, Guthaben) ─

test('phase4b: earn beim Close - Guthaben wandert ins Ledger', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy', wagerCmd: '!setzen' });
  await e.redis.set(K.gWatch(TEAM, 'sess_2', 'justcallmedeimos', 'bob'), String(SECS_PER_COIN * 2));
  await e.redis.sadd(K.gwUsers(TEAM), 'bob');
  const s = await e.settleTicketBuyInstance(TEAM, 'sess_2');
  assert.equal(s.users, 1);
  assert.equal(s.total, 2);
  assert.equal(await e.credit.balance(TEAM, 'bob'), 2);
  assert.equal(await e.redis.get(K.gWatch(TEAM, 'sess_2', 'justcallmedeimos', 'bob')), null);   // aufgeräumt
});

test('phase4b: setzen/zuruecknehmen bucht Ledger UND wagers, prueft Guthaben', async () => {
  const e = engine();
  await e.credit.book(TEAM, 'bob', 'earn', 5);
  const prizeId = await e.addPrize(TEAM, null, { title: 'Headset' });
  let r = await e.placeWager(TEAM, null, 'bob', prizeId, 3);
  assert.equal(r.stake, 3);
  assert.equal(r.balance, 2);
  r = await e.placeWager(TEAM, null, 'bob', prizeId, 3);          // mehr als übrig
  assert.equal(r.error, 'no_credit');
  r = await e.placeWager(TEAM, null, 'bob', prizeId, 0);          // Rücknahme komplett
  assert.equal(r.refunded, 3);
  assert.equal(await e.credit.balance(TEAM, 'bob'), 5);
  r = await e.placeWager(TEAM, null, 'bob', prizeId, 0);
  assert.equal(r.error, 'nothing_to_refund');
});

test('phase4b: Ziehung je Preis, Gewicht = Einsatz, afterDraw bindet Einsaetze', async () => {
  const e = engine();
  await e.credit.book(TEAM, 'bob', 'earn', 10);
  await e.credit.book(TEAM, 'alice', 'earn', 10);
  const p1 = await e.addPrize(TEAM, null, { title: 'Headset' });
  const p2 = await e.addPrize(TEAM, null, { title: 'Maus' });
  await e.placeWager(TEAM, null, 'bob', p1, 4);
  await e.placeWager(TEAM, null, 'alice', p2, 2);                 // anderer Preis
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  const r = await e.drawWinner(TEAM, 'sess_2', { prizeId: p1 });
  assert.equal(r.winner, 'bob');                                  // alice setzt auf p2, nicht im Pool
  assert.equal(r.coins, 4);                                       // Gewicht = Einsatz
  assert.equal(r.prizeId, p1);
  assert.equal(e.pg.prizes.find(x => x.id === p1).status, 'drawn');   // afterDraw in der TX
  const late = await e.placeWager(TEAM, null, 'bob', p1, 0);      // Rücknahme nach Ziehung
  assert.equal(late.error, 'no_prize');                           // gebunden
});

test('phase4b: Ziehung ohne prizeId wirft (TicketBuy zieht je Preis)', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  await assert.rejects(() => e.drawWinner(TEAM, 'sess_2', {}), /prizeId/);
});

test('phase4b: Setz-Befehl per Chat, konfigurierbarer Befehl', async () => {
  const e = engine();
  await e.credit.book(TEAM, 'bob', 'earn', 5);
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy', wagerCmd: '!lose' });
  const prizeId = await e.addPrize(TEAM, 'sess_2', { title: 'Headset' });
  // konfigurierter Befehl wirkt:
  let r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', `!lose ${prizeId} 2`, true);
  assert.ok(r.chatReply.includes('✅'));
  assert.equal(await e.prizeStake(prizeId, 'bob'), 2);
  // Default-Befehl wirkt NICHT (Instanz hat !lose konfiguriert):
  r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', `!setzen ${prizeId} 1`, true);
  assert.ok(!r || !r.chatReply);
  // Hilfe ohne Argumente:
  r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', '!lose', true);
  assert.ok(r.chatReply.includes('Lose setzen'));
  // Rücknahme per Chat:
  r = await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', `!lose ${prizeId} 0`, true);
  assert.ok(r.chatReply.includes('↩'));
  assert.equal(await e.prizeStake(prizeId, 'bob'), 0);
});

test('phase4b: verfuegbares Guthaben = Ledger + Live-Stand laufender Instanz', async () => {
  const e = engine();
  await e.credit.book(TEAM, 'bob', 'earn', 1);
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  await e.redis.set(K.gWatch(TEAM, 'sess_2', 'justcallmedeimos', 'bob'), String(SECS_PER_COIN));
  assert.equal(await e.availableCredit(TEAM, 'bob'), 2);          // 1 Ledger + 1 live
  const prizeId = await e.addPrize(TEAM, 'sess_2', { title: 'Headset' });
  const r = await e.placeWager(TEAM, 'sess_2', 'bob', prizeId, 2);   // gegen Live-Anteil
  assert.equal(r.stake, 2);
  assert.equal(await e.credit.balance(TEAM, 'bob'), -1);          // interimistisch negativ
  await e.redis.sadd(K.gwUsers(TEAM), 'bob');
  await e.settleTicketBuyInstance(TEAM, 'sess_2');                // earn +1 → Summe wieder 0
  assert.equal(await e.credit.balance(TEAM, 'bob'), 0);
});

// ── Phase 6: CORE_ScreenshotContest ───────────────────────
// Berechtigung liest den Kampagnen-/Legacy-Stand: Follow + Viewtime.
async function contestSetup(minWatchSec) {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_9', { core: 'CORE_ScreenshotContest', minWatchSec: minWatchSec ?? 600 });
  // bob: Follow + 1h Viewtime auf dem Instanz-Kanal (legacy = Kampagnenstand)
  for (const u of ['bob', 'carol', 'dave']) {
    await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', u), '1');
    await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', u), '3600');
  }
  return e;
}
const IMG = Buffer.from('fakepng');

test('phase6: einsenden braucht Follow und Viewtime', async () => {
  const e = await contestSetup(600);
  // eve: weder Follow noch Viewtime
  let r = await e.submitContestEntry(TEAM, 'sess_9', 'eve', { mime: 'image/png', image: IMG });
  assert.equal(r.error, 'not_following');
  // mallory: Follow, aber zu wenig Viewtime
  await e.redis.set(K.chFollows(TEAM, 'justcallmedeimos', 'mallory'), '1');
  await e.redis.set(K.chWatch(TEAM, 'justcallmedeimos', 'mallory'), '60');
  r = await e.submitContestEntry(TEAM, 'sess_9', 'mallory', { mime: 'image/png', image: IMG });
  assert.equal(r.error, 'not_enough_watchtime');
  r = await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'Mein Shot', mime: 'image/png', image: IMG });
  assert.equal(r.ok, true);
});

test('phase6: eine Einsendung pro Person, Ersetzen warnt vor Stimmenverlust', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'V1', mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);
  await e.setContestVoting(TEAM, 'sess_9', 'open');
  await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 8);
  // Ersetzen ohne Bestätigung → blockiert mit Stimmenzahl
  let r = await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'V2', mime: 'image/png', image: IMG });
  assert.equal(r.error, 'votes_would_be_lost');
  assert.equal(r.votes, 1);
  // Mit Bestätigung → ersetzt, Stimmen verfallen, Status zurück auf pending
  r = await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'V2', mime: 'image/png', image: IMG, confirmReplace: true });
  assert.equal(r.replaced, true);
  const st = await e.getContestStandings(TEAM, 'sess_9', { all: true });
  assert.equal(st.length, 1);                       // immer noch EINE Einsendung
  assert.equal(st[0].votes, 0);                     // Stimmen verfallen
  assert.equal(st[0].status, 'pending');            // neue Freigabe nötig
});

test('phase6: Voting-Steuerung open/pause/resume/close erzwingt den Zustand', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);
  assert.equal((await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 7)).error, 'voting_not_open');
  await e.setContestVoting(TEAM, 'sess_9', 'open');
  assert.equal((await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 7)).ok, true);
  await e.setContestVoting(TEAM, 'sess_9', 'paused');
  assert.equal((await e.castContestVote(TEAM, 'sess_9', 'dave', 1, 5)).error, 'voting_not_open');
  await e.setContestVoting(TEAM, 'sess_9', 'open');   // fortsetzen
  assert.equal((await e.castContestVote(TEAM, 'sess_9', 'dave', 1, 5)).ok, true);
});

test('phase6: eine Stimme je Voter+Screenshot, Re-Vote ueberschreibt (max n Votes)', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);
  await e.setContestVoting(TEAM, 'sess_9', 'open');
  await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 3);
  await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 10);   // ueberschreibt, addiert nicht
  await e.castContestVote(TEAM, 'sess_9', 'dave', 1, 6);
  const st = await e.getContestStandings(TEAM, 'sess_9');
  assert.equal(st[0].votes, 2);                     // 2 Voter → max 2 Votes
  assert.equal(st[0].score, 16);                    // 10 + 6, Punktsumme
  // eigene Einsendung nicht votebar:
  assert.equal((await e.castContestVote(TEAM, 'sess_9', 'bob', 1, 10)).error, 'own_entry');
});

test('phase6: Ziehung deterministisch, Gleichstand lost die Engine aus', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob',   { mime: 'image/png', image: IMG });
  await e.submitContestEntry(TEAM, 'sess_9', 'carol', { mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);
  await e.reviewContestEntry(TEAM, 2, true);
  await e.setContestVoting(TEAM, 'sess_9', 'open');
  await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 9);   // bobs Entry: 9
  await e.castContestVote(TEAM, 'sess_9', 'bob',   2, 4);   // carols Entry: 4
  const r = await e.drawWinner(TEAM, 'sess_9', {});
  assert.equal(r.winner, 'bob');                    // hoechste Punktsumme, deterministisch
  assert.equal(r.coins, 9);                         // Score im Ergebnis
  assert.equal(r.eligibleCount, 1);                 // nur der Fuehrende im Pool
  assert.equal(await e.getContestVoting(TEAM, 'sess_9'), 'closed');   // Ziehung schliesst Voting
});

test('phase6: Contest ohne bewertete Einsendungen zieht nicht', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);        // freigegeben, aber 0 Stimmen
  assert.equal(await e.drawWinner(TEAM, 'sess_9', {}), null);
});

test('phase3b: Keyword zaehlt nur im offenen Anmeldefenster, Fenster mehrfach oeffenbar', async () => {
  const e = engine();
  // Instanz OHNE Fenster: Keyword wird ignoriert
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 0 });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  let parts = await e.getInstantParticipants(TEAM, 'sess_2');
  assert.equal(parts.length, 0);                        // Fenster zu → keine Anmeldung
  // Fenster oeffnen → Anmeldung zaehlt
  await e.openInstantWindow(TEAM, 'sess_2', 60);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  parts = await e.getInstantParticipants(TEAM, 'sess_2');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].eligible, true);
  // Fenster "ablaufen lassen" (Ende in die Vergangenheit) → carol kommt nicht mehr rein
  await e.redis.set(K.gWinEnd(TEAM, 'sess_2'), String(Math.floor(Date.now() / 1000) - 5));
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'carol', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'carol', 'blitz', true);
  parts = await e.getInstantParticipants(TEAM, 'sess_2');
  assert.equal(parts.length, 1);                        // bob bleibt, carol nicht
  // Zweites Fenster: carol kommt dazu, bob bleibt angemeldet
  await e.openInstantWindow(TEAM, 'sess_2', 60);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'carol', 'blitz', true);
  parts = await e.getInstantParticipants(TEAM, 'sess_2');
  assert.equal(parts.length, 2);                        // akkumuliert ueber Fenster
  // Ziehung bleibt manuell moeglich
  const r = await e.drawWinner(TEAM, 'sess_2', {});
  assert.ok(['bob', 'carol'].includes(r.winner));
});

test('lifecycle: max. eine TicketBuy-/Contest-Instanz je Team, CV mehrfach ok', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  await assert.rejects(() => e.openGiveawayInstance(TEAM, 'sess_3', { core: 'CORE_TicketBuy' }),
    /duplicate_core/);
  await e.openGiveawayInstance(TEAM, 'sess_4', { core: 'CORE_ScreenshotContest' });
  await assert.rejects(() => e.openGiveawayInstance(TEAM, 'sess_5', { core: 'CORE_ScreenshotContest' }),
    /duplicate_core/);
  // Sofortverlosungen haben keine Zuschauer-Seite → mehrfach erlaubt
  await e.openGiveawayInstance(TEAM, 'sess_6', { keyword: 'a', core: 'CORE_CurrentViewers' });
  await e.openGiveawayInstance(TEAM, 'sess_7', { keyword: 'b', core: 'CORE_CurrentViewers' });
});

test('lifecycle: openPrizeCount zaehlt nur offene Preise der Instanz', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  const p1 = await e.addPrize(TEAM, 'sess_2', { title: 'Headset' });
  await e.addPrize(TEAM, 'sess_2', { title: 'Maus' });
  assert.equal(await e.openPrizeCount(TEAM, 'sess_2'), 2);
  await e.cancelPrize(TEAM, p1);
  assert.equal(await e.openPrizeCount(TEAM, 'sess_2'), 1);
});

test('prize: editPrize aendert nur offene Preise', async () => {
  const e = engine();
  const p1 = await e.addPrize(TEAM, null, { title: 'Headset' });
  let r = await e.editPrize(TEAM, p1, { title: 'Headset Pro', sponsor: 'XY' });
  assert.equal(r.prize.title, 'Headset Pro');
  assert.equal(r.prize.sponsor, 'XY');
  await e.pg.query(`UPDATE giveaway_prizes SET status='cancelled' WHERE id=$1`, [p1]);
  r = await e.editPrize(TEAM, p1, { title: 'zu spaet' });
  assert.equal(r.error, 'not_open');
  r = await e.editPrize(TEAM, 999, { title: 'x' });
  assert.equal(r.error, 'no_prize');
});

test('prize: cancelPrize bucht alle Einsaetze zurueck, danach kein Setzen mehr', async () => {
  const e = engine();
  await e.credit.book(TEAM, 'bob', 'earn', 5);
  await e.credit.book(TEAM, 'alice', 'earn', 5);
  const p1 = await e.addPrize(TEAM, null, { title: 'Headset' });
  await e.placeWager(TEAM, null, 'bob', p1, 3);
  await e.placeWager(TEAM, null, 'alice', p1, 2);
  const r = await e.cancelPrize(TEAM, p1);
  assert.equal(r.refundedUsers, 2);
  assert.equal(r.refundedTotal, 5);
  assert.equal(await e.credit.balance(TEAM, 'bob'), 5);      // alles zurück
  assert.equal(await e.credit.balance(TEAM, 'alice'), 5);
  assert.equal((await e.getPrizeStakes(TEAM, p1)).length, 0); // keine offenen Einsätze
  const late = await e.placeWager(TEAM, null, 'bob', p1, 1);
  assert.equal(late.error, 'no_prize');                       // storniert = nicht mehr setzbar
  const again = await e.cancelPrize(TEAM, p1);
  assert.equal(again.error, 'not_open');                      // kein Doppel-Storno
});

test('phase6b: Einsendung zurueckziehen loescht Bild und Stimmen (nur solange offen)', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'V1', mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);
  await e.setContestVoting(TEAM, 'sess_9', 'open');
  await e.castContestVote(TEAM, 'sess_9', 'carol', 1, 8);
  // Fremder kann nichts zurueckziehen
  let r = await e.withdrawContestEntry(TEAM, 'sess_9', 'carol');
  assert.equal(r.error, 'no_entry');
  // Einsender zieht zurueck → Einsendung UND Stimmen weg
  r = await e.withdrawContestEntry(TEAM, 'sess_9', 'bob');
  assert.equal(r.ok, true);
  assert.equal((await e.getContestStandings(TEAM, 'sess_9', { all: true })).length, 0);
  assert.equal(e.pg.cvotes.length, 0);
  // Nach Instanz-Schliessung kein Rueckzug mehr
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'V2', mime: 'image/png', image: IMG });
  await e.redis.set(K.gOpen(TEAM, 'sess_9'), 'false');
  r = await e.withdrawContestEntry(TEAM, 'sess_9', 'bob');
  assert.equal(r.error, 'contest_closed');
});

test('instanz: Anzeigename wird gespeichert, gelistet und mit aufgeraeumt', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', name: 'Freitags-Blitz' });
  const g = (await e.listGiveaways(TEAM)).find(x => x.gid === 'sess_2');
  assert.equal(g.name, 'Freitags-Blitz');
  await e.cleanupGiveawayInstance(TEAM, 'sess_2');
  assert.equal(await e.redis.get(K.gName(TEAM, 'sess_2')), null);
});

test('cfg: Regeln gelten pro Giveaway (Copy-on-Open, Vorgaben bleiben unberuehrt)', async () => {
  const e = engine();
  // Team-Vorgaben setzen, dann Kampagne oeffnen → eigene Kopie
  await e.setCoinBaseSec(TEAM, 3600);
  await e.setFollowMin(TEAM, 1);
  await e.openGiveaway(TEAM, 'go', 'sess_1');
  assert.equal(await e.getCoinBaseSec(TEAM, 'sess_1'), 3600);
  // Vorgaben NACH dem Start aendern → laufendes Giveaway unberuehrt
  await e.setCoinBaseSec(TEAM, 7200);
  assert.equal(await e.getCoinBaseSec(TEAM, 'sess_1'), 3600);   // eigene Kopie
  assert.equal(await e.getCoinBaseSec(TEAM), 7200);             // Vorgabe fuer den naechsten Start
  // Live-Aenderung mit gid → wirkt nur auf dieses Giveaway
  await e.setCoinBaseSec(TEAM, 1800, 'sess_1');
  assert.equal(await e.getCoinBaseSec(TEAM, 'sess_1'), 1800);
  assert.equal(await e.getCoinBaseSec(TEAM), 7200);
  // Chat-Konfig genauso
  await e.setChatConfig(TEAM, { minWords: 6 }, 'sess_1');
  assert.equal((await e.getChatConfig(TEAM, 'sess_1')).minWords, 6);
  assert.equal((await e.getChatConfig(TEAM)).minWords, 4);      // Default/Vorgabe
  // TicketBuy-Instanz bekommt ebenfalls eine Kopie, Sofortverlosung nicht
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  assert.equal(await e.redis.get(K.gCfgCoinBase(TEAM, 'sess_2')), '7200');
  await e.openGiveawayInstance(TEAM, 'sess_3', { keyword: 'x', core: 'CORE_CurrentViewers' });
  assert.equal(await e.redis.get(K.gCfgCoinBase(TEAM, 'sess_3')), null);
  // Cleanup raeumt die Kopie ab
  await e.cleanupGiveawayInstance(TEAM, 'sess_2');
  assert.equal(await e.redis.get(K.gCfgCoinBase(TEAM, 'sess_2')), null);
});

test('phase3c: Chat-Ansagen der Sofortverlosung sind schaltbar (announce-Flag)', async () => {
  const e = engine();
  // Default: an — kein Redis-Key, listGiveaways meldet announce=true.
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers' });
  let g = (await e.listGiveaways(TEAM)).find(x => x.gid === 'sess_2');
  assert.equal(g.announce, true);
  assert.equal(await e.redis.get(K.gAnnounce(TEAM, 'sess_2')), null);
  // Stumm geoeffnet → Flag gespeichert und gemeldet.
  await e.openGiveawayInstance(TEAM, 'sess_3', { keyword: 'still', core: 'CORE_CurrentViewers', announce: false });
  g = (await e.listGiveaways(TEAM)).find(x => x.gid === 'sess_3');
  assert.equal(g.announce, false);
  // Umschalten wie gw_set_announce (Server schreibt den Key direkt).
  await e.redis.del(K.gAnnounce(TEAM, 'sess_3'));
  g = (await e.listGiveaways(TEAM)).find(x => x.gid === 'sess_3');
  assert.equal(g.announce, true);
  // Cleanup raeumt das Flag mit ab.
  await e.redis.set(K.gAnnounce(TEAM, 'sess_3'), 'false');
  await e.cleanupGiveawayInstance(TEAM, 'sess_3');
  assert.equal(await e.redis.get(K.gAnnounce(TEAM, 'sess_3')), null);
});

// ── Panel: Teilnehmerlisten je Mechanik + Dropdown-Statistiken ──
test('panel: getTicketBuyParticipants — Guthaben team-weit, Einsatz je Instanz', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { core: 'CORE_TicketBuy' });
  await e.credit.book(TEAM, 'bob', 'earn', 5);
  await e.credit.book(TEAM, 'alice', 'earn', 3);
  const p1 = await e.addPrize(TEAM, 'sess_2', { title: 'Headset' });
  await e.placeWager(TEAM, null, 'bob', p1, 2);
  const parts = await e.getTicketBuyParticipants(TEAM, 'sess_2');
  const bob = parts.find(x => x.username === 'bob');
  const alice = parts.find(x => x.username === 'alice');
  assert.equal(bob.balance, 3);                 // 5 verdient - 2 gesetzt
  assert.equal(bob.stake, 2);
  assert.equal(bob.eligible, true);
  assert.equal(alice.balance, 3);
  assert.equal(alice.stake, 0);
  assert.equal(alice.eligible, false);          // Guthaben ohne Einsatz = nicht im Pool
  assert.equal(parts[0].username, 'bob');       // Sortierung: Einsatz zuerst
  // Dropdown-Statistik zaehlt nur Setzer
  const g = (await e.listGiveaways(TEAM, { stats: true })).find(x => x.gid === 'sess_2');
  assert.equal(g.participants, 1);
  assert.ok(g.startedAt);
});

test('panel: getContestParticipants — Status/Punkte je Einsender', async () => {
  const e = await contestSetup(0);
  await e.submitContestEntry(TEAM, 'sess_9', 'bob', { title: 'Mein Shot', mime: 'image/png', image: IMG });
  await e.submitContestEntry(TEAM, 'sess_9', 'carol', { mime: 'image/png', image: IMG });
  await e.reviewContestEntry(TEAM, 1, true);
  await e.setContestVoting(TEAM, 'sess_9', 'open');
  await e.castContestVote(TEAM, 'sess_9', 'dave', 1, 7);
  const parts = await e.getContestParticipants(TEAM, 'sess_9');
  const bob = parts.find(x => x.username === 'bob');
  const carol = parts.find(x => x.username === 'carol');
  assert.equal(bob.status, 'approved');
  assert.equal(bob.eligible, true);
  assert.equal(bob.score, 7);
  assert.equal(bob.votes, 1);
  assert.equal(carol.status, 'pending');
  assert.equal(carol.eligible, false);
  // Dropdown-Statistik zaehlt alle Einsender
  const g = (await e.listGiveaways(TEAM, { stats: true })).find(x => x.gid === 'sess_9');
  assert.equal(g.participants, 2);
});

test('panel: listGiveaways stats — Angemeldete bei der Sofortverlosung', async () => {
  const e = engine();
  await e.openGiveawayInstance(TEAM, 'sess_2', { keyword: 'blitz', core: 'CORE_CurrentViewers', windowSec: 60 });
  await e.handleViewerTick(TEAM, 'justcallmedeimos', 'bob', true);
  await e.handleChatMessage(TEAM, 'justcallmedeimos', 'bob', 'blitz', true);
  const g = (await e.listGiveaways(TEAM, { stats: true })).find(x => x.gid === 'sess_2');
  assert.equal(g.participants, 1);
  // Ohne stats keine Zusatzfelder (interne Aufrufer zahlen nichts mit)
  const g2 = (await e.listGiveaways(TEAM)).find(x => x.gid === 'sess_2');
  assert.equal(g2.participants, undefined);
});
