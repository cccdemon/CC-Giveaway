'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { judgeMessage, encryptKey, decryptKey, PROVIDERS } = require('../chat-ai.js');

// Antwort-Stub je Provider — so wie die echten APIs den Text verpacken.
const bodyFor = {
  anthropic: (t) => ({ content: [{ type: 'text', text: t }] }),
  openai:    (t) => ({ choices: [{ message: { content: t } }] }),
  gemini:    (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] }),
};
function stubFetch(provider, text, opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (opts.status && opts.status >= 400) return { ok: false, status: opts.status };
    return { ok: true, status: 200, async json() { return bodyFor[provider](text); } };
  };
  fn.calls = calls;
  return fn;
}
const cfg = (provider, model) => ({ enabled: true, provider, model, apiKey: 'k-test' });

for (const provider of Object.keys(PROVIDERS)) {
  test(`${provider}: JA/NEIN wird korrekt gelesen`, async () => {
    // Jeder Test nutzt eine eigene Nachricht, sonst antwortet der Cache.
    const yes = await judgeMessage(cfg(provider), `ja-${provider}`, { fetch: stubFetch(provider, 'JA') });
    assert.deepEqual({ m: yes.meaningful, s: yes.source }, { m: true, s: 'ai' });
    const no = await judgeMessage(cfg(provider), `nein-${provider}`, { fetch: stubFetch(provider, 'NEIN') });
    assert.equal(no.meaningful, false);
  });

  test(`${provider}: API-Fehler fällt auf die Wortregel zurück`, async () => {
    const r = await judgeMessage(cfg(provider), `fehler-${provider}`, { fetch: stubFetch(provider, '', { status: 500 }) });
    assert.equal(r.meaningful, null);       // null = Aufrufer nimmt countWords
    assert.equal(r.source, 'error');
  });

  test(`${provider}: unklare Antwort zählt nicht als sinnvoll`, async () => {
    const r = await judgeMessage(cfg(provider), `unklar-${provider}`, { fetch: stubFetch(provider, 'Das kommt darauf an …') });
    assert.equal(r.meaningful, null);
    assert.equal(r.reason, 'unparsable');
  });

  test(`${provider}: API-Key geht im Header, nicht im Body`, async () => {
    const f = stubFetch(provider, 'JA');
    await judgeMessage(cfg(provider), `header-${provider}`, { fetch: f });
    const { init } = f.calls[0];
    assert.ok(!String(init.body).includes('k-test'), 'Key darf nie im Body stehen');
    assert.ok(JSON.stringify(init.headers).includes('k-test'), 'Key gehört in den Header');
  });
}

test('zweite identische Nachricht kommt aus dem Cache (kein zweiter Call)', async () => {
  const f = stubFetch('anthropic', 'JA');
  const a = await judgeMessage(cfg('anthropic'), 'cache-probe eins zwei', { fetch: f });
  const b = await judgeMessage(cfg('anthropic'), 'cache-probe eins zwei', { fetch: f });
  assert.equal(a.source, 'ai');
  assert.equal(b.source, 'cache');
  assert.equal(b.meaningful, true);
  assert.equal(f.calls.length, 1);
});

test('Timeout gibt auf, statt den Chat zu blockieren', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
  const t0 = Date.now();
  const r = await judgeMessage(cfg('anthropic'), 'haengt fest', { fetch: hang, timeoutMs: 60 });
  assert.equal(r.meaningful, null);
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - t0 < 1000, 'darf nicht auf das Netz warten');
});

test('ohne Key oder deaktiviert wird gar nicht erst gefragt', async () => {
  const f = stubFetch('anthropic', 'JA');
  assert.equal((await judgeMessage({ enabled: false, apiKey: 'k' }, 'x', { fetch: f })).meaningful, null);
  assert.equal((await judgeMessage({ enabled: true, apiKey: '' }, 'x', { fetch: f })).meaningful, null);
  assert.equal(f.calls.length, 0);
});

test('API-Key: verschlüsseln und wieder lesen; falsches Secret gibt nichts preis', () => {
  const enc = encryptKey('sk-geheim-123', 'secret-a');
  assert.ok(!enc.includes('sk-geheim-123'), 'Klartext darf nicht im Speicherwert stehen');
  assert.equal(decryptKey(enc, 'secret-a'), 'sk-geheim-123');
  assert.equal(decryptKey(enc, 'secret-b'), null);      // falscher Schlüssel
  assert.equal(decryptKey('kaputt', 'secret-a'), null); // manipulierter Wert
  assert.throws(() => encryptKey('sk-x', ''), /Master-Schl/);
});
