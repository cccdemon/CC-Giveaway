'use strict';

// Helix.getViewerCounts — Diagnosewert (Twitch-Zuschauer je Kanal). Kein
// Netz: fetch ist gestubbt, Redis ist eine Map.

const { test } = require('node:test');
const assert = require('node:assert');
const { Helix } = require('../helix.js');

function makeRedis() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, String(v)); return 'OK'; },
  };
}
function stubFetch(streams) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/oauth2/token')) return { ok: true, status: 200, async json() { return { access_token: 'app', expires_in: 3600 }; } };
    return { ok: true, status: 200, async json() { return { data: streams }; } };
  };
  fn.calls = calls;
  return fn;
}

test('getViewerCounts: live → Zahl, nicht live → null, Ergebnis gecacht', async () => {
  const orig = global.fetch;
  const f = stubFetch([{ user_login: 'alpha', viewer_count: 42 }]);
  global.fetch = f;
  try {
    const h = new Helix({ clientId: 'c', clientSecret: 's', pg: null, redis: makeRedis() });
    const r1 = await h.getViewerCounts(['Alpha', 'beta']);
    assert.deepEqual(r1, { alpha: 42, beta: null });
    const streamsCalls = f.calls.filter(u => u.includes('/streams')).length;
    assert.equal(streamsCalls, 1);
    const r2 = await h.getViewerCounts(['alpha', 'beta']);
    assert.deepEqual(r2, { alpha: 42, beta: null });
    assert.equal(f.calls.filter(u => u.includes('/streams')).length, streamsCalls, 'zweiter Aufruf aus dem Cache');
  } finally { global.fetch = orig; }
});

test('getViewerCounts: ohne Credentials oder bei Fehler leeres Ergebnis, kein Wurf', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('netz weg'); };
  try {
    const off = new Helix({ clientId: '', clientSecret: '', pg: null, redis: makeRedis() });
    assert.deepEqual(await off.getViewerCounts(['alpha']), {});
    const on = new Helix({ clientId: 'c', clientSecret: 's', pg: null, redis: makeRedis() });
    assert.deepEqual(await on.getViewerCounts(['alpha']), {});
  } finally { global.fetch = orig; }
});
