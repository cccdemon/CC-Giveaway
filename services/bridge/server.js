'use strict';

// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Ingest Bridge (inverted, Phase 3b)
// Public WS SERVER: each channel's Streamerbot connects OUT as a
// client and authenticates with a per-channel token. The channel is
// derived from the token (NOT the payload) → spoof-safe. Authenticated
// events get `channel` injected and are published to Redis.
//
// Bots connect via wss://<host>/ingest (Caddy strips /ingest → "/").
//   → { event:'ingest_auth', token:'<per-channel-token>' }
//   ← { event:'ingest_ok', channel } | { event:'ingest_denied' }
// then normal events: { event:'viewer_tick', user, follows }, ...
//
// Redis:
//   HGET ingest:tokens <token> → channel   (managed by giveaway admin)
//   publish ch:giveaway
//   subscribe ch:chat_reply → route to the matching channel's bot(s)
// ════════════════════════════════════════════════════════

const Redis     = require('ioredis');
const WebSocket = require('ws');
const express   = require('express');
const http      = require('http');

function log(tag, ...args)    { console.log( `[${tag}]`, ...args); }
function logErr(tag, ...args) { console.error(`[${tag}]`, ...args); }

const CFG = {
  port: parseInt(process.env.PORT || '3000'),
  redis: {
    host:          process.env.REDIS_HOST || 'redis',
    port:          parseInt(process.env.REDIS_PORT || '6379'),
    db:            parseInt(process.env.REDIS_DB   || '0'),
    lazyConnect:   true,
    retryStrategy: (t) => Math.min(t * 500, 5000),
  },
};

const redisPub = new Redis(CFG.redis);
const redisSub = new Redis(CFG.redis);
const redis    = new Redis(CFG.redis);   // token lookups

redisPub.on('connect', () => log('Redis', 'Pub connected (DB ' + CFG.redis.db + ')'));
redisPub.on('error',   (e) => logErr('Redis', 'Pub error:', e.message));
redisSub.on('error',   (e) => logErr('Redis', 'Sub error:', e.message));
redis.on('error',      (e) => logErr('Redis', 'Main error:', e.message));

async function redisReady() {
  for (let i = 0; i < 30; i++) {
    try {
      await redisPub.connect(); await redisPub.ping();
      await redisSub.connect(); await redis.connect();
      log('Redis', 'Ready');
      return;
    } catch(e) { log('Redis', `Waiting... (${i + 1}/30)`); await sleep(2000); }
  }
  throw new Error('Redis: Could not connect');
}

// event → Redis channel(s). Giveaway-only fork.
const ROUTES = {
  viewer_tick:   ['ch:giveaway'],
  chat_msg:      ['ch:giveaway'],
  time_cmd:      ['ch:giveaway'],
  giveaway_cmd:  ['ch:giveaway'],
  stream_online: ['ch:giveaway'],
  stream_offline:['ch:giveaway'],
  cc_debug:      ['ch:giveaway'],
};

// ── WS ingest server ──────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const clients = new Map();   // ws → { channel, ip, authed, connectedAt }

function connectedChannels() {
  const out = {};
  for (const [, c] of clients) if (c.authed) out[c.channel] = (out[c.channel] || 0) + 1;
  return out;
}

wss.on('connection', (ws, req) => {
  const meta = { team: null, channel: null, ip: req.socket.remoteAddress, authed: false, connectedAt: Date.now() };
  clients.set(ws, meta);
  log('Ingest', `Connect ${meta.ip} (${clients.size} total)`);

  // Auth-Timeout: unauthenticated Verbindung nach 10s schließen.
  const authTimer = setTimeout(() => { if (!meta.authed) { try { ws.close(); } catch(e){} } }, 10000);

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || !msg.event) return;

    if (!meta.authed) {
      if (msg.event !== 'ingest_auth') return;   // ignore until authed
      const token = String(msg.token || '');
      const value = token ? await redis.hget('ingest:tokens', token) : null;   // "teamId::channel"
      const [team, channel] = String(value || '').split('::');
      if (!team || !channel) {
        log('Ingest', `Auth denied from ${meta.ip}`);
        safeSend(ws, { event: 'ingest_denied' });
        try { ws.close(); } catch(e) {}
        return;
      }
      meta.authed = true;
      meta.team = team;
      meta.channel = channel;
      clearTimeout(authTimer);
      log('Ingest', `Auth OK ${meta.ip} → team "${team}" channel "${channel}"`);
      safeSend(ws, { event: 'ingest_ok', team, channel });
      return;
    }

    // authenticated: inject team+channel from the TOKEN (never the payload)
    const channels = ROUTES[msg.event];
    if (!channels) { log('Ingest', `${msg.event} (unrouted)`); return; }
    msg.team = meta.team;
    msg.channel = meta.channel;
    const payload = JSON.stringify(msg);
    log('Ingest', `← [${meta.team}/${meta.channel}] ${msg.event}${msg.user ? ' (' + msg.user + ')' : ''}`);
    for (const ch of channels) redisPub.publish(ch, payload).catch(e => logErr('Pub', ch, e.message));
  });

  ws.on('close', () => {
    clients.delete(ws);
    clearTimeout(authTimer);
    log('Ingest', `Disconnect ${meta.channel || meta.ip} (${clients.size} remaining)`);
  });
  ws.on('error', (e) => logErr('Ingest', e.message));
});

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── ch:chat_reply → route to the matching channel's bot(s) ──
function subscribeToReplies() {
  redisSub.subscribe('ch:chat_reply', (err) => {
    if (err) { logErr('Sub', 'chat_reply:', err.message); return; }
    log('Sub', 'Subscribed to ch:chat_reply');
  });
  redisSub.on('message', (channel, payload) => {
    if (channel !== 'ch:chat_reply') return;
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    const target = msg.channel ? String(msg.channel) : null;
    let sent = 0;
    for (const [ws, c] of clients) {
      if (!c.authed) continue;
      if (target && c.channel !== target) continue;   // route to the origin channel
      safeSend(ws, msg);
      sent++;
    }
    log('Ingest', `→ chat_reply${target ? ' [' + target + ']' : ' (all)'} to ${sent} bot(s): ${(msg.message || '').substring(0, 50)}`);
  });
}

// ── Health ────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await redisPub.ping();
    res.json({ status: 'ok', redis: 'ok', ingest_channels: connectedChannels() });
  } catch(e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

async function main() {
  await redisReady();
  subscribeToReplies();
  server.listen(CFG.port, () => log('Bridge', `Ingest WS + health on port ${CFG.port}`));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(err => { logErr('FATAL', err.message); process.exit(1); });
