'use strict';

// ════════════════════════════════════════════════════════
// CHAT-AI — optionale KI-Bewertung "ist diese Nachricht sinnvoll?"
// Provider-agnostisch: anthropic | openai | gemini (lokal später nachrüstbar).
// Ersetzt NUR die Wortzählung. Fällt bei Fehler/Timeout auf sie zurück.
//
// Grundsätze:
//   - fail-open: eine kaputte oder langsame KI darf den Chat nie blockieren.
//   - kurze Antwort: ein Wort ("JA"/"NEIN"), damit es billig und schnell bleibt.
//   - Cache pro (Provider, Modell, Nachricht) — Twitch-Chat wiederholt sich stark.
//   - API-Keys werden nie geloggt, nie exportiert, nie ins Audit geschrieben.
// ════════════════════════════════════════════════════════

const { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('crypto');

const TIMEOUT_MS   = 4000;   // danach zählt die Wortregel — Chat wartet nie länger
const CACHE_MAX    = 2000;
const MAX_MSG_LEN  = 400;

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', defaultModel: 'claude-opus-4-8' },
  openai:    { label: 'OpenAI (GPT)',       defaultModel: 'gpt-5' },
  gemini:    { label: 'Google (Gemini)',    defaultModel: 'gemini-2.5-flash' },
};

const SYSTEM_PROMPT =
  'Du bewertest Twitch-Chatnachrichten für ein Giveaway. Eine Nachricht ist SINNVOLL, ' +
  'wenn sie ein echter Beitrag zur Unterhaltung ist: eine Frage, eine Reaktion auf den ' +
  'Stream, eine Meinung, ein Gruß mit Inhalt. Sie ist NICHT sinnvoll bei reinem ' +
  'Emote-Spam, zusammenhanglosen Zeichen, Copypasta, Werbung oder wenn sie nur ' +
  'geschrieben wurde, um Punkte zu farmen. Kurze Nachrichten können sinnvoll sein. ' +
  'Antworte mit genau einem Wort: JA oder NEIN.';

// ── Verdict-Cache (LRU-ish) ───────────────────────────────
const cache = new Map();
const cacheKey = (provider, model, msg) =>
  createHash('sha1').update(`${provider}|${model}|${msg.toLowerCase().trim()}`).digest('hex');

function cacheGet(k) {
  if (!cache.has(k)) return undefined;
  const v = cache.get(k);
  cache.delete(k); cache.set(k, v);   // refresh recency
  return v;
}
function cacheSet(k, v) {
  cache.set(k, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ── Key-Verschlüsselung (AES-256-GCM) ─────────────────────
// Der API-Key eines Teams liegt verschlüsselt in Postgres. Ohne AI_KEY_SECRET
// ist er nicht lesbar — ein DB-Dump allein gibt ihn also nicht preis.
function keyFromSecret(secret) {
  return scryptSync(String(secret || ''), 'cc-giveaway-ai', 32);
}
function encryptKey(plain, secret) {
  if (!plain) return null;
  if (!secret) throw new Error('AI_KEY_SECRET nicht gesetzt — API-Key kann nicht sicher gespeichert werden');
  const iv = randomBytes(12);
  const c  = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
function decryptKey(stored, secret) {
  if (!stored || !secret) return null;
  try {
    const [iv, tag, data] = String(stored).split('.');
    const d = createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }   // falscher Secret oder manipulierter Wert
}

// ── Provider-Aufrufe ──────────────────────────────────────
// Jeder gibt den rohen Antworttext zurück; die Auswertung ist gemeinsam.

async function callAnthropic({ apiKey, model, message, signal, fetchImpl }) {
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new Error('anthropic refusal');
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
}

async function callOpenAI({ apiKey, model, message, signal, fetchImpl }) {
  const r = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, max_completion_tokens: 8,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: message }],
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const j = await r.json();
  return ((j.choices || [])[0] || {}).message?.content || '';
}

async function callGemini({ apiKey, model, message, signal, fetchImpl }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetchImpl(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: message }] }],
      generationConfig: { maxOutputTokens: 8 },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const j = await r.json();
  return (((j.candidates || [])[0] || {}).content?.parts || []).map(p => p.text || '').join(' ');
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini };

// ── Öffentliche API ───────────────────────────────────────
// Rückgabe: { meaningful: bool|null, source: 'ai'|'cache'|'error', reason? }
// meaningful === null heißt: keine Entscheidung — Aufrufer nimmt die Wortregel.
async function judgeMessage(cfg, message, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const msg = String(message || '').trim().slice(0, MAX_MSG_LEN);
  if (!cfg || !cfg.enabled || !cfg.apiKey || !msg) return { meaningful: null, source: 'error', reason: 'disabled' };
  const provider = PROVIDERS[cfg.provider] ? cfg.provider : 'anthropic';
  const model    = cfg.model || PROVIDERS[provider].defaultModel;
  if (typeof fetchImpl !== 'function') return { meaningful: null, source: 'error', reason: 'no-fetch' };

  const ck = cacheKey(provider, model, msg);
  const hit = cacheGet(ck);
  if (hit !== undefined) return { meaningful: hit, source: 'cache' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const text = await CALLERS[provider]({ apiKey: cfg.apiKey, model, message: msg, signal: ctrl.signal, fetchImpl });
    const norm = String(text || '').trim().toUpperCase();
    // Nur eindeutige Antworten zählen — alles andere fällt auf die Wortregel zurück,
    // damit ein schwatzhaftes Modell nicht als "sinnvoll" durchgewinkt wird.
    let meaningful = null;
    if (/^JA\b/.test(norm) || norm === 'YES') meaningful = true;
    else if (/^NEIN\b/.test(norm) || norm === 'NO') meaningful = false;
    if (meaningful === null) return { meaningful: null, source: 'error', reason: 'unparsable' };
    cacheSet(ck, meaningful);
    return { meaningful, source: 'ai' };
  } catch (e) {
    return { meaningful: null, source: 'error', reason: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { judgeMessage, encryptKey, decryptKey, PROVIDERS, SYSTEM_PROMPT, TIMEOUT_MS };
