'use strict';

// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Giveaway Service (multi-tenant)
// Watchtime engine, coins, winner draw — all per team.
// Admin WS commands carry teamId; authorized via the X-Auth-User
// header injected by Caddy forward_auth (must own the team).
// Redis Sub: ch:giveaway (viewer_tick/chat_msg/time_cmd/… with team+channel)
// Redis Pub: ch:chat_reply (routed back to the origin channel's bot)
// ════════════════════════════════════════════════════════

const Redis     = require('ioredis');
const WebSocket = require('ws');
const express   = require('express');
const http      = require('http');
const crypto    = require('crypto');
const { Pool }  = require('pg');
const { WatchtimeEngine, K, sanitizeUsername, sanitizeStr, sanitizeTeamId, sanitizeChannel, TICK_SEC, ABUSE, MIN_CHANNELS } = require('./watchtime.js');
const kw2 = (n) => (n === 1 ? 'Kanal' : 'Kanälen');   // Grammatik-Helfer für Chat-Texte
const fmtDur = (sec) => {                              // 7200→"2 Std", 1800→"30 Min"
  sec = Math.max(0, Math.round(sec || 0));
  if (sec % 3600 === 0) return `${sec / 3600} Std`;
  if (sec >= 3600)      return `${(sec / 3600).toFixed(1)} Std`;
  return `${Math.round(sec / 60)} Min`;
};
const { Helix } = require('./helix.js');
const { judgeMessage, listModels, encryptKey, decryptKey, PROVIDERS } = require('./chat-ai.js');

function log(tag, ...args)    { console.log( `[${tag}]`, ...args); }
function logErr(tag, ...args) { console.error(`[${tag}]`, ...args); }

const CFG = {
  port: parseInt(process.env.PORT || '3001'),
  redis: {
    host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379'),
    db: parseInt(process.env.REDIS_DB || '0'), lazyConnect: true,
    retryStrategy: (t) => Math.min(t * 500, 5000),
  },
  pg: {
    host: process.env.PG_HOST || 'postgres', port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DB || 'chaoscrew', user: process.env.PG_USER || 'chaoscrew',
    password: process.env.PG_PASSWORD || 'changeme', max: 10, idleTimeoutMillis: 30000,
    // Selbstheilung: tote Connections (z.B. nach Postgres-Neustart) dürfen
    // Queries nicht ewig blockieren, sonst wedged der Pool → Server hängt.
    keepAlive: true,
    connectionTimeoutMillis: 8000,   // Acquire-Timeout (keine freie Connection)
    query_timeout: 20000,            // Query bricht ab statt ewig zu hängen
    statement_timeout: 20000,        // Server-seitiges Limit
    idle_in_transaction_session_timeout: 20000,
  },
};

const redis    = new Redis(CFG.redis);
const redisSub = new Redis(CFG.redis);
const redisPub = new Redis(CFG.redis);
const pg       = new Pool(CFG.pg);

redis.on('error',    (e) => logErr('Redis', 'Main:', e.message));
redisSub.on('error', (e) => logErr('Redis', 'Sub:', e.message));
redisPub.on('error', (e) => logErr('Redis', 'Pub:', e.message));
pg.on('error',       (e) => logErr('PG', e.message));

async function redisReady() {
  for (let i = 0; i < 30; i++) {
    try { await redis.connect(); await redis.ping(); await redisSub.connect(); await redisPub.connect(); log('Redis', 'Ready'); return; }
    catch(e) { log('Redis', `Waiting... (${i + 1}/30)`); await sleep(2000); }
  }
  throw new Error('Redis: Could not connect');
}
async function pgReady() {
  for (let i = 0; i < 30; i++) {
    try { const c = await pg.connect(); c.release(); log('PG', 'Ready'); return; }
    catch(e) { log('PG', `Waiting... (${i + 1}/30): ${e.message}`); await sleep(2000); }
  }
  throw new Error('PG: Could not connect');
}

// ── Chat-KI (optional, pro Team) ──────────────────────────
// Konfiguration liegt in der teams-Tabelle; der API-Key verschluesselt.
// Kurzer Cache, damit nicht jede Chatnachricht eine DB-Runde kostet.
// Der Master-Schluessel liegt in app_secrets und wird beim ersten Start selbst
// erzeugt - am Server ist nichts einzustellen. Wichtig und bewusst so:
// Schluessel und Chiffrat liegen in derselben Datenbank. Das schuetzt gegen
// Logs, Backup-Exporte und versehentlich geteilte Tabellenauszuege, NICHT
// gegen jemanden, der die ganze Datenbank hat.
let AI_SECRET = null;
const aiCfgCache = new Map();   // teamId -> {cfg, until}

async function loadMasterSecret() {
  const r = await pg.query(`SELECT value FROM app_secrets WHERE key='ai_master'`);
  if (r.rows[0] && r.rows[0].value) { AI_SECRET = r.rows[0].value; return AI_SECRET; }
  const gen = crypto.randomBytes(32).toString('base64');
  // ON CONFLICT: zwei Instanzen, die gleichzeitig starten, duerfen sich nicht
  // gegenseitig ueberschreiben - sonst waeren bereits verschluesselte Keys tot.
  await pg.query(`INSERT INTO app_secrets (key, value) VALUES ('ai_master', $1) ON CONFLICT (key) DO NOTHING`, [gen]);
  const again = await pg.query(`SELECT value FROM app_secrets WHERE key='ai_master'`);
  AI_SECRET = again.rows[0].value;
  log('AI', 'Master-Schluessel erzeugt und gespeichert');
  return AI_SECRET;
}

// Rotation: alle Team-Keys mit dem alten Schluessel lesen, mit dem neuen
// schreiben. Faellt irgendein Key aus, bricht die Transaktion ab - sonst
// haetten wir Keys, die mit zwei verschiedenen Schluesseln verschluesselt sind.
async function rotateMasterSecret() {
  const oldSecret = AI_SECRET;
  const next = crypto.randomBytes(32).toString('base64');
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const teams = await client.query(`SELECT id, ai_key_enc FROM teams WHERE ai_key_enc IS NOT NULL`);
    let reencrypted = 0, unreadable = 0;
    for (const row of teams.rows) {
      const plain = decryptKey(row.ai_key_enc, oldSecret);
      if (plain === null) { unreadable++; continue; }   // war schon unlesbar - nicht schlimmer machen
      await client.query('UPDATE teams SET ai_key_enc=$2 WHERE id=$1', [row.id, encryptKey(plain, next)]);
      reencrypted++;
    }
    await client.query(`UPDATE app_secrets SET value=$1, rotated_at=NOW() WHERE key='ai_master'`, [next]);
    await client.query('COMMIT');
    AI_SECRET = next;
    aiCfgCache.clear();
    log('AI', `Master-Schluessel rotiert: ${reencrypted} Keys neu verschluesselt, ${unreadable} unlesbar`);
    return { reencrypted, unreadable };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function getAiConfig(teamId) {
  const t = sanitizeTeamId(teamId);
  const hit = aiCfgCache.get(t);
  if (hit && hit.until > Date.now()) return hit.cfg;
  let cfg = { enabled: false, provider: 'anthropic', model: '', apiKey: null, hasKey: false };
  try {
    const r = await pg.query('SELECT ai_enabled, ai_provider, ai_model, ai_key_enc FROM teams WHERE id=$1', [t]);
    if (r.rows[0]) {
      const row = r.rows[0];
      cfg = {
        enabled:  !!row.ai_enabled,
        provider: PROVIDERS[row.ai_provider] ? row.ai_provider : 'anthropic',
        model:    row.ai_model || '',
        apiKey:   decryptKey(row.ai_key_enc, AI_SECRET),
        hasKey:   !!row.ai_key_enc,
      };
    }
  } catch(e) { logErr('AI', 'config load:', e.message); }
  aiCfgCache.set(t, { cfg, until: Date.now() + 30000 });
  return cfg;
}
function invalidateAiConfig(teamId) { aiCfgCache.delete(sanitizeTeamId(teamId)); }

// Wird von der Engine pro Chatnachricht gerufen. Fehler => null => Wortregel.
let aiErrorBudget = { fails: 0, until: 0 };
async function aiJudge(teamId, message) {
  const cfg = await getAiConfig(teamId);
  if (!cfg.enabled || !cfg.apiKey) return null;
  // Circuit-Breaker: nach 5 Fehlern in Folge 2 Minuten Pause, damit ein
  // ausgefallener Anbieter nicht jede Nachricht um das Timeout verzoegert.
  if (aiErrorBudget.until > Date.now()) return null;
  const v = await judgeMessage(cfg, message);
  if (v.source === 'error' && v.reason !== 'disabled') {
    if (++aiErrorBudget.fails >= 5) {
      aiErrorBudget = { fails: 0, until: Date.now() + 120000 };
      logErr('AI', `Aussetzer (${v.reason}) - pausiere 2 min, Wortregel greift`);
    }
  } else if (v.source !== 'error') {
    aiErrorBudget.fails = 0;
  }
  return v;
}

const wte = new WatchtimeEngine(redis, pg, aiJudge);
const helix = new Helix({
  clientId:     String(process.env.TWITCH_CLIENT_ID || '').replace(/^"|"$/g, ''),
  clientSecret: String(process.env.TWITCH_CLIENT_SECRET || '').replace(/^"|"$/g, ''),
  pg, redis,
});

// Phase 4: Follows pro Kanal via Helix verifizieren → chFollows autoritativ.
// Kanäle ohne Owner-Token (Scope nicht erteilt) bleiben permissiv (unverified).
async function verifyFollows(teamId) {
  const t = sanitizeTeamId(teamId);
  const result = { verified: [], unverified: [], mismatches: 0 };
  if (!helix.configured) { result.unverified = await wte.getChannels(t); return result; }
  const channels = await wte.getChannels(t);
  const participants = await wte.getAllParticipants(t);
  for (const ch of channels) {
    const token = await helix.validOwnerToken(ch);
    const bid   = token ? await helix.resolveUserId(ch) : null;
    if (!token || !bid) { result.unverified.push(ch); continue; }
    let followerIds;
    try { followerIds = await helix.getFollowerIds(token, bid); }
    catch(e) { logErr('Helix', `followers ${ch}:`, e.message); result.unverified.push(ch); continue; }
    // ALLE Teilnehmer gegen die Follower-Liste prüfen — auch wer diesen
    // Kanal nie geschaut hat (Follow ist Bedingung, Gucken optional).
    for (const p of participants) {
      const uid = await helix.resolveUserId(p.username);
      const follows = uid ? followerIds.has(uid) : false;
      const prev = await redis.get(K.chFollows(t, ch, p.username));
      if (prev !== null && (prev === '1') !== follows) result.mismatches++;
      await redis.set(K.chFollows(t, ch, p.username), follows ? '1' : '0');
    }
    result.verified.push(ch);
  }
  // Account-Alter-Flag (Multi-Account-Heuristik) — nur markieren, nicht bannen.
  try {
    for (const p of participants) {
      if (!p.registered) continue;
      const meta = await helix.resolveUserMeta(p.username);
      if (meta.createdAt) {
        const ageDays = (Date.now() - new Date(meta.createdAt).getTime()) / 86400000;
        if (ageDays < ABUSE.NEW_ACCOUNT_DAYS) await wte.flagUser(t, p.username, 'new_account', { createdAt: meta.createdAt, ageDays: Math.round(ageDays) });
      }
    }
  } catch(e) { logErr('Helix', 'account-age:', e.message); }
  log('Helix', `[${t}] verify: ok=${result.verified.length} unverified=${result.unverified.length} mismatches=${result.mismatches}`);
  return result;
}

// ── Team authz ────────────────────────────────────────────
async function ownsTeam(login, teamId) {
  if (!login || !teamId) return false;
  const r = await pg.query(`SELECT 1 FROM team_members WHERE team_id=$1 AND login=$2 AND role='owner'`, [teamId, login]);
  return r.rowCount > 0;
}
async function isMember(login, teamId) {
  if (!login || !teamId) return false;
  const r = await pg.query(`SELECT 1 FROM team_members WHERE team_id=$1 AND login=$2`, [teamId, login]);
  return r.rowCount > 0;
}
// Kanal dieses Members (für „eigener Kanal"-Rechte).
async function memberChannel(login, teamId) {
  if (!login || !teamId) return null;
  const r = await pg.query(`SELECT channel FROM team_members WHERE team_id=$1 AND login=$2`, [teamId, login]);
  return r.rows[0] ? sanitizeChannel(r.rows[0].channel) : null;
}

// ── Audit ─────────────────────────────────────────────────
// Append-only Protokoll jeder Aktion, die den Giveaway-Stand verändern kann.
// Nur-Lese-Cmds sind ausgenommen, sonst ersäuft der Log in Polling-Rauschen.
const AUDIT_SKIP = new Set([
  'gw_get_channels', 'gw_get_multiplier', 'gw_get_stream_settings',
  'gw_get_keyword', 'gw_get_ingest_tokens', 'gw_get_ai_settings', 'gw_list_ai_models',
]);

async function audit(entry) {
  const row = {
    teamId: entry.teamId || null, sessionId: entry.sessionId || null,
    actor: entry.actor || 'unknown', ip: entry.ip || null,
    action: entry.action, target: entry.target || null,
    result: entry.result || 'ok', detail: entry.detail || {},
  };
  try {
    await pg.query(
      `INSERT INTO audit_log (team_id, session_id, actor, actor_ip, action, target, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.teamId, row.sessionId, row.actor, row.ip, row.action, row.target, row.result, JSON.stringify(row.detail)]);
  } catch (e) {
    // Die Aktion ist bereits passiert — sie nachträglich zu verwerfen wäre
    // schlimmer als der Protokollverlust. Laut loggen, damit es auffällt.
    logErr('Audit', `WRITE FAILED action=${row.action} actor=${row.actor} target=${row.target}: ${e.message}`);
  }
}

// Nur die Felder des Cmds protokollieren, die etwas aussagen (kein Token!).
function auditDetail(msg) {
  const out = {};
  for (const k of ['keyword', 'user', 'channel', 'amount', 'factor', 'minutes',
                   'followMin', 'drawMinHours', 'autoPause', 'autoResume', 'prize', 'test']) {
    if (msg[k] !== undefined && msg[k] !== null && msg[k] !== '') out[k] = msg[k];
  }
  return out;
}
function auditTarget(msg) { return sanitizeUsername(msg.user || '') || sanitizeChannel(msg.channel || '') || null; }

// ── Session (per team) ────────────────────────────────────
async function openGiveaway(teamId, keyword) {
  const sid = `sess_${Date.now()}`;
  await wte.openGiveaway(teamId, keyword, sid);
  await redis.del(K.gwAutoPaused(teamId));   // frischer Start ist nie auto-pausiert
  const chans = await wte.getChannels(teamId);
  await pg.query(`INSERT INTO sessions (id, team_id, keyword, channels) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [sid, teamId, keyword || '', JSON.stringify(chans)]);
  broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
  log('GW', `[${teamId}] opened session ${sid}, kw="${keyword}", channels=${chans.join(',')}`);
  return sid;
}
async function closeGiveaway(teamId) {
  const sid = await wte.getSessionId(teamId);
  await wte.closeGiveaway(teamId, sid);
  await redis.del(K.gwOnline(teamId), K.gwAutoPaused(teamId));
  broadcastTeam(teamId, { event: 'gw_status', status: 'closed' });
  log('GW', `[${teamId}] closed`);
}

// ── Auto-Steuerung: Stream online/offline → Giveaway pause/resume ──
async function handleStreamOnline(teamId, channel) {
  const ch = sanitizeChannel(channel);
  if (!ch) return;
  await redis.sadd(K.gwOnline(teamId), ch);
  if (await redis.get(K.cfgAutoResume(teamId)) !== '1') return;
  if (await wte.isOpen(teamId)) {
    if (await wte.isPaused(teamId)) {
      await wte.setPaused(teamId, false);
      await redis.del(K.gwAutoPaused(teamId));
      broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
      log('Auto', `[${teamId}] stream online (${ch}) → resume`);
      await audit({ teamId, actor: 'system', action: 'auto_resume', target: ch,
                    sessionId: await wte.getSessionId(teamId), detail: { trigger: 'stream_online' } });
    }
  } else {
    const kw = await redis.get(K.gwKeyword(teamId)) || '';
    const newSid = await openGiveaway(teamId, kw);
    log('Auto', `[${teamId}] stream online (${ch}) → open`);
    await audit({ teamId, actor: 'system', action: 'auto_open', target: ch,
                  sessionId: newSid, detail: { trigger: 'stream_online', keyword: kw } });
  }
}
async function handleStreamOffline(teamId, channel) {
  const ch = sanitizeChannel(channel);
  if (!ch) return;
  await redis.srem(K.gwOnline(teamId), ch);
  if (await redis.get(K.cfgAutoPause(teamId)) !== '1') return;
  if (await redis.scard(K.gwOnline(teamId)) > 0) return;   // noch ein Kanal live
  if (await wte.isOpen(teamId) && !await wte.isPaused(teamId)) {
    await wte.setPaused(teamId, true);
    await redis.set(K.gwAutoPaused(teamId), '1');
    broadcastTeam(teamId, { event: 'gw_status', status: 'paused' });
    log('Auto', `[${teamId}] alle Streams offline → pause`);
    await audit({ teamId, actor: 'system', action: 'auto_pause', target: ch,
                  sessionId: await wte.getSessionId(teamId), detail: { trigger: 'stream_offline' } });
  }
}

// ── WS Server ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const clients = new Map(); // clientId → { ws, authUser, teamId, role, ip, connectedAt, msgCount }

function broadcastTeam(teamId, obj) {
  const str = JSON.stringify(obj);
  for (const [, c] of clients) if (c.teamId === teamId && c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
}

async function verifyOverlayKey(teamId, key) {
  if (!teamId || !key) return false;
  const r = await pg.query('SELECT 1 FROM teams WHERE id=$1 AND overlay_key=$2', [teamId, String(key)]);
  return r.rowCount > 0;
}

wss.on('connection', (ws, req) => {
  const clientId = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const isOverlay = (req.url || '').indexOf('/overlay-ws') === 0;
  const authUser = isOverlay ? '' : sanitizeUsername(req.headers['x-auth-user'] || '');
  const meta = { ws, authUser, teamId: null, overlay: isOverlay, role: null, ip: req.socket.remoteAddress, connectedAt: Date.now(), msgCount: 0 };
  clients.set(clientId, meta);
  log('WS', `Connected: ${clientId} user=${authUser || '?'} (${clients.size} total)`);

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    meta.msgCount++;
    if (msg.event === 'cc_identify') { meta.role = sanitizeStr(msg.role || '', 50); return; }
    await handleClientMessage(meta, msg);
  });
  ws.on('close', () => { clients.delete(clientId); log('WS', `Disconnected: ${clientId}`); });
});

async function sendTeamData(meta) {
  const send = (o) => meta.ws.readyState === WebSocket.OPEN && meta.ws.send(JSON.stringify(o));
  const teamId = meta.teamId;
  const participants = await wte.getAllParticipants(teamId);
  const open = await wte.isOpen(teamId);
  const paused = await wte.isPaused(teamId);
  const session = await wte.getSessionId(teamId);
  const channels = await wte.getChannels(teamId);
  send({ event: 'gw_data', teamId, open, paused, session, participants, channels });
}

async function handleClientMessage(meta, msg) {
  const send = (obj) => meta.ws.readyState === WebSocket.OPEN && meta.ws.send(JSON.stringify(obj));

  switch (msg.event) {
    // OBS-Overlay: public, key-authentifiziert, read-only.
    case 'overlay_subscribe': {
      const teamId = sanitizeTeamId(msg.teamId);
      if (!await verifyOverlayKey(teamId, msg.key)) { send({ event: 'overlay_denied' }); return; }
      meta.teamId = teamId;
      meta.overlay = true;
      send({ event: 'overlay_ok', teamId });
      send({ event: 'gw_status', status: await wte.isOpen(teamId) ? 'open' : 'closed' });
      break;
    }
    // Client wählt ein Team → nur Mitglieder dürfen dessen Daten sehen.
    case 'gw_get_all': {
      if (meta.overlay) return;   // Overlays dürfen keine Admin-Daten ziehen
      const teamId = sanitizeTeamId(msg.teamId);
      if (!await isMember(meta.authUser, teamId)) { send({ event: 'gw_ack', type: 'forbidden' }); return; }
      meta.teamId = teamId;
      await sendTeamData(meta);
      break;
    }
    case 'gw_cmd':
      await handleAdminCmd(send, msg, meta);
      break;
    case 'gw_overlay': {
      const teamId = sanitizeTeamId(msg.teamId);
      if (await isMember(meta.authUser, teamId)) broadcastTeam(teamId, { event: 'gw_overlay', winner: msg.winner || null, coins: msg.coins || 0 });
      break;
    }
    // Test-Console-Sim: nur für eigene Teams republishen.
    case 'viewer_tick':
    case 'chat_msg':
    case 'time_cmd': {
      const teamId = sanitizeTeamId(msg.teamId);
      if (!await ownsTeam(meta.authUser, teamId)) return;
      redisPub.publish('ch:giveaway', JSON.stringify({ ...msg, team: teamId }))
        .catch((e) => logErr('Sim', 'republish failed:', e.message));
      break;
    }
  }
}

// Cmds die ein Member (nicht-Owner) darf: nur lesen + EIGENEN Ingest-Token.
const MEMBER_CMDS = new Set([
  'gw_get_channels', 'gw_get_multiplier', 'gw_get_stream_settings', 'gw_get_keyword',
  'gw_get_ingest_tokens', 'gw_gen_ingest_token',
]);
async function handleAdminCmd(send, msg, meta) {
  const teamId = sanitizeTeamId(msg.teamId);
  const actor  = meta.authUser || '(unauthenticated)';
  const owner  = await ownsTeam(meta.authUser, teamId);
  // Abgelehnte Versuche gehören genauso ins Protokoll wie erfolgreiche.
  const auditBase = { teamId, actor, ip: meta.ip, action: msg.cmd, target: auditTarget(msg) };
  if (!owner) {
    if (!MEMBER_CMDS.has(msg.cmd) || !await isMember(meta.authUser, teamId)) {
      await audit({ ...auditBase, result: 'denied', detail: auditDetail(msg) });
      send({ event: 'gw_ack', type: 'forbidden' }); return;
    }
  }
  const sid = () => wte.getSessionId(teamId);
  // Cases hängen hier an, was das Ergebnis war (Gewinner, Faktor, alter Wert …).
  const outcome = {};

  try {
    await runAdminCmd(send, msg, meta, { teamId, owner, sid, outcome });
  } catch (e) {
    await audit({ ...auditBase, sessionId: await sid().catch(() => null),
                  result: 'error', detail: { ...auditDetail(msg), error: e.message } });
    logErr('GW', `cmd ${msg.cmd} failed:`, e.message);
    send({ event: 'gw_ack', type: 'cmd_error', cmd: msg.cmd, error: e.message });
    return;
  }
  if (!AUDIT_SKIP.has(msg.cmd)) {
    await audit({ ...auditBase, sessionId: await sid().catch(() => null),
                  result: 'ok', detail: { ...auditDetail(msg), ...outcome } });
  }
}

async function runAdminCmd(send, msg, meta, ctx) {
  const { teamId, owner, sid, outcome } = ctx;

  switch (msg.cmd) {
    case 'gw_open':
      outcome.sessionOpened = await openGiveaway(teamId, sanitizeStr(msg.keyword || '', 100));
      send({ event: 'gw_status', status: 'open' });
      break;
    case 'gw_close':
      outcome.sessionClosed = await wte.getSessionId(teamId);
      await closeGiveaway(teamId);
      send({ event: 'gw_status', status: 'closed' });
      break;
    case 'gw_pause':
      await wte.setPaused(teamId, true);
      await redis.del(K.gwAutoPaused(teamId));   // manuell, nicht auto
      broadcastTeam(teamId, { event: 'gw_status', status: 'paused' });
      send({ event: 'gw_status', status: 'paused' });
      log('GW', `[${teamId}] paused`);
      break;
    case 'gw_resume':
      await wte.setPaused(teamId, false);
      await redis.del(K.gwAutoPaused(teamId));
      broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
      send({ event: 'gw_status', status: 'open' });
      log('GW', `[${teamId}] resumed`);
      break;
    case 'gw_set_stream_settings': {
      const ap = !!msg.autoPause, ar = !!msg.autoResume;
      if (ap) await redis.set(K.cfgAutoPause(teamId), '1'); else await redis.del(K.cfgAutoPause(teamId));
      if (ar) await redis.set(K.cfgAutoResume(teamId), '1'); else await redis.del(K.cfgAutoResume(teamId));
      let fm = await wte.getFollowMin(teamId);
      const fmBefore = fm, dmBefore = await wte.getDrawMinSec(teamId);
      if (msg.followMin !== undefined && msg.followMin !== null) fm = await wte.setFollowMin(teamId, msg.followMin);
      let dm = dmBefore;
      if (msg.drawMinHours !== undefined && msg.drawMinHours !== null) dm = await wte.setDrawMinSec(teamId, parseFloat(msg.drawMinHours) * 3600);
      const chatBefore = await wte.getChatConfig(teamId);
      const chat = await wte.setChatConfig(teamId, {
        bonusSec: msg.chatBonusSec, minWords: msg.chatMinWords, cooldown: msg.chatCooldown });
      Object.assign(outcome, { followMinBefore: fmBefore, followMinAfter: fm,
                               coinBaseSecBefore: dmBefore, coinBaseSecAfter: dm,
                               chatBefore, chatAfter: chat });
      send({ event: 'gw_ack', type: 'stream_settings', autoPause: ap, autoResume: ar, followMin: fm, drawMinHours: dm / 3600,
                chatBonusSec: chat.bonusSec, chatMinWords: chat.minWords, chatCooldown: chat.cooldown });
      log('GW', `[${teamId}] settings: pause=${ap} resume=${ar} followMin=${fm} drawMin=${dm}s`);
      break;
    }
    case 'gw_get_ai_settings': {
      const cfg = await getAiConfig(teamId);
      // Der Key selbst wird NIE zurueckgegeben - nur ob einer hinterlegt ist.
      send({ event: 'gw_ack', type: 'ai_settings', enabled: cfg.enabled, provider: cfg.provider,
             model: cfg.model, hasKey: cfg.hasKey, secretConfigured: !!AI_SECRET, keySource: 'db',
             providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel, knownModels: p.knownModels })) });
      break;
    }
    case 'gw_set_ai_settings': {
      const before = await getAiConfig(teamId);
      const provider = PROVIDERS[msg.provider] ? msg.provider : 'anthropic';
      const model    = sanitizeStr(msg.model || '', 60) || PROVIDERS[provider].defaultModel;
      const enabled  = !!msg.enabled;
      // Leerer Key = unveraendert lassen; '-' = Key loeschen.
      let keyEnc, keyTouched = false;
      const rawKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '';
      if (rawKey === '-')      { keyEnc = null; keyTouched = true; }
      else if (rawKey)         { keyEnc = encryptKey(rawKey, AI_SECRET); keyTouched = true; }
      if (enabled && !keyTouched && !before.hasKey) {
        send({ event: 'gw_ack', type: 'ai_error', error: 'Kein API-Key hinterlegt' });
        return;
      }
      const sets = ['ai_enabled=$2', 'ai_provider=$3', 'ai_model=$4'];
      const params = [teamId, enabled, provider, model];
      if (keyTouched) { sets.push('ai_key_enc=$5'); params.push(keyEnc); }
      await pg.query(`UPDATE teams SET ${sets.join(', ')} WHERE id=$1`, params);
      invalidateAiConfig(teamId);
      const after = await getAiConfig(teamId);
      // API-Key kommt NIE ins Audit - nur die Tatsache, dass er ersetzt wurde.
      Object.assign(outcome, { enabledBefore: before.enabled, enabledAfter: after.enabled,
                               providerBefore: before.provider, providerAfter: after.provider,
                               modelBefore: before.model, modelAfter: after.model, keyChanged: keyTouched });
      send({ event: 'gw_ack', type: 'ai_settings', enabled: after.enabled, provider: after.provider,
             model: after.model, hasKey: after.hasKey, secretConfigured: !!AI_SECRET });
      break;
    }
    case 'gw_list_ai_models': {
      // Modelle beim Anbieter abfragen. Der zu pruefende Anbieter kann vom
      // gespeicherten abweichen - im Panel waehlt man ihn ja, bevor gespeichert wird.
      const cfg = await getAiConfig(teamId);
      const provider = PROVIDERS[msg.provider] ? msg.provider : cfg.provider;
      const r = await listModels({ provider, apiKey: cfg.apiKey });
      send({ event: 'gw_ack', type: 'ai_models', provider, models: r.models,
             source: r.source, error: r.error || null });
      break;
    }
    case 'gw_rotate_ai_secret': {
      const r = await rotateMasterSecret();
      Object.assign(outcome, r);
      send({ event: 'gw_ack', type: 'ai_rotated', ...r });
      break;
    }
    case 'gw_test_ai': {
      const cfg = await getAiConfig(teamId);
      if (!cfg.apiKey) { send({ event: 'gw_ack', type: 'ai_test', ok: false, error: 'Kein API-Key hinterlegt' }); break; }
      const sample = sanitizeStr(msg.sample || 'gutes spiel, das war knapp!', 200);
      const v = await judgeMessage({ ...cfg, enabled: true }, sample);
      Object.assign(outcome, { provider: cfg.provider, model: cfg.model, verdict: v.meaningful, source: v.source });
      send({ event: 'gw_ack', type: 'ai_test', ok: v.source !== 'error',
             meaningful: v.meaningful, source: v.source, error: v.reason || null, sample });
      break;
    }
    case 'gw_get_stream_settings': {
      const chat = await wte.getChatConfig(teamId);
      send({ event: 'gw_ack', type: 'stream_settings',
        autoPause:  await redis.get(K.cfgAutoPause(teamId)) === '1',
        autoResume: await redis.get(K.cfgAutoResume(teamId)) === '1',
        followMin:  await wte.getFollowMin(teamId),
        drawMinHours: (await wte.getDrawMinSec(teamId)) / 3600,
        chatBonusSec: chat.bonusSec, chatMinWords: chat.minWords, chatCooldown: chat.cooldown });
      break;
    }
    case 'gw_set_keyword': {
      const kw = sanitizeStr(msg.keyword || '', 100);
      outcome.keywordBefore = await redis.get(K.gwKeyword(teamId)) || '';
      outcome.keywordAfter  = kw;
      await redis.set(K.gwKeyword(teamId), kw);
      const s = await sid(); if (s) await pg.query('UPDATE sessions SET keyword=$1 WHERE id=$2', [kw, s]);
      send({ event: 'gw_ack', type: 'keyword_set', keyword: kw });
      break;
    }
    case 'gw_get_keyword':
      send({ event: 'gw_ack', type: 'keyword', keyword: await redis.get(K.gwKeyword(teamId)) || '' });
      break;
    case 'gw_get_channels': {
      let channels = await wte.getChannels(teamId);
      if (!owner) { const my = await memberChannel(meta.authUser, teamId); channels = channels.filter(c => c === my); }
      send({ event: 'gw_ack', type: 'channels', channels });
      break;
    }
    case 'gw_add_ticket': {
      const u = sanitizeUsername(msg.user); if (!u) return;
      const base = await wte.getCoinBaseSec(teamId);
      const before = (await wte.getUserAggregate(teamId, u)).totalWatchSec;
      await wte.registerUser(teamId, u);
      const r = await wte.adjustWatch(teamId, u, msg.channel, base);
      Object.assign(outcome, { deltaSec: base, coinsDelta: 1, channel: r.channel,
                               watchSecBefore: before, watchSecAfter: r.watchSec });
      send({ event: 'gw_ack', type: 'ticket_added', user: u, channel: r.channel, watchSec: r.watchSec });
      break;
    }
    case 'gw_sub_ticket': {
      const u = sanitizeUsername(msg.user); if (!u) return;
      const base = await wte.getCoinBaseSec(teamId);
      const before = (await wte.getUserAggregate(teamId, u)).totalWatchSec;
      const r = await wte.adjustWatch(teamId, u, msg.channel, -base);
      Object.assign(outcome, { deltaSec: -base, coinsDelta: -1, channel: r.channel,
                               watchSecBefore: before, watchSecAfter: r.watchSec });
      send({ event: 'gw_ack', type: 'ticket_removed', user: u, channel: r.channel, watchSec: r.watchSec });
      break;
    }
    case 'gw_ban': {
      const u = sanitizeUsername(msg.user); if (!u) return;
      const a = await wte.getUserAggregate(teamId, u);
      await wte.setBanned(teamId, u, true);
      Object.assign(outcome, { coinsAtBan: a.totalCoins, wasEligible: a.eligible });
      send({ event: 'gw_ack', type: 'banned', user: u });
      break;
    }
    case 'gw_unban': {
      const u = sanitizeUsername(msg.user); if (!u) return;
      await wte.setBanned(teamId, u, false);
      send({ event: 'gw_ack', type: 'unbanned', user: u });
      break;
    }
    case 'gw_reset': {
      // Destruktiv: Stand vorher festhalten, sonst ist der Verlust nicht belegbar.
      const before = await wte.getAllParticipants(teamId);
      Object.assign(outcome, {
        wipedParticipants: before.length,
        wipedCoins: Math.round(before.reduce((s, p) => s + p.totalCoins, 0) * 10000) / 10000,
        wipedEligible: before.filter(p => p.eligible).length,
        sessionBefore: await wte.getSessionId(teamId),
      });
      await closeGiveaway(teamId);
      await wte.resetGiveaway(teamId);
      send({ event: 'gw_ack', type: 'reset' });
      break;
    }
    case 'gw_set_multiplier': {
      const prev = await wte.multiplierState(teamId);
      const r = await wte.setMultiplier(teamId, msg.factor, (parseInt(msg.minutes) || 0) * 60);
      Object.assign(outcome, { factorBefore: prev.factor, factorAfter: r.factor, seconds: r.seconds });
      broadcastTeam(teamId, { event: 'gw_multiplier', factor: r.factor, secondsLeft: r.seconds });
      send({ event: 'gw_ack', type: 'multiplier_set', factor: r.factor, seconds: r.seconds });
      break;
    }
    case 'gw_get_multiplier': {
      const st = await wte.multiplierState(teamId);
      send({ event: 'gw_multiplier', factor: st.factor, secondsLeft: st.secondsLeft });
      break;
    }
    case 'gw_gen_ingest_token': {
      const ch = sanitizeChannel(msg.channel); if (!ch) return;
      if (!owner) { const my = await memberChannel(meta.authUser, teamId); if (ch !== my) { send({ event: 'gw_ack', type: 'forbidden' }); return; } }
      const key = teamId + '::' + ch;
      const token = crypto.randomBytes(24).toString('base64url');
      const old = await redis.hget('ingest:team_tokens', key);
      // Token selbst wird NIE protokolliert — nur dass rotiert wurde.
      Object.assign(outcome, { channel: ch, rotated: !!old });
      if (old) await redis.hdel('ingest:tokens', old);
      await redis.hset('ingest:tokens', token, key);
      await redis.hset('ingest:team_tokens', key, token);
      send({ event: 'gw_ack', type: 'ingest_token', channel: ch, token });
      break;
    }
    case 'gw_get_ingest_tokens': {
      const map = await redis.hgetall('ingest:team_tokens');
      let entries = Object.entries(map).filter(([k]) => k.startsWith(teamId + '::'));
      if (!owner) { const my = await memberChannel(meta.authUser, teamId); entries = entries.filter(([k]) => k.split('::')[1] === my); }
      const tokens = entries.map(([k, token]) => ({ channel: k.split('::')[1], token }));
      send({ event: 'gw_ack', type: 'ingest_tokens', tokens });
      break;
    }
    case 'gw_verify_follows': {
      const r = await verifyFollows(teamId);
      send({ event: 'gw_ack', type: 'follows_verified', verified: r.verified, unverified: r.unverified, mismatches: r.mismatches });
      break;
    }
    case 'gw_draw_winner': {
      try {
        // Vor echter Ziehung Follows via Helix verifizieren (Phase 4).
        if (!msg.test) { try { await verifyFollows(teamId); } catch(e) { logErr('Helix', 'pre-draw verify:', e.message); } }
        const result = await wte.drawWinner(teamId, await sid(), { test: !!msg.test, prize: msg.prize });
        if (!result) { outcome.winner = null; send({ event: 'gw_ack', type: 'no_winner' }); break; }
        Object.assign(outcome, { winner: result.winner, winnerCoins: result.coins, drawId: result.drawId,
                                 eligibleCount: result.eligibleCount, totalCoins: result.total,
                                 randValue: result.rand, isTest: !!result.isTest });
        send({ event: 'gw_ack', type: 'winner_drawn', winner: result.winner, watchSec: result.watchSec, coins: result.coins, drawId: result.drawId, prize: result.prize });
        broadcastTeam(teamId, { event: 'gw_overlay', winner: result.winner, coins: result.coins });
      } catch (e) {
        outcome.error = e.message;
        logErr('GW', 'draw failed:', e.message);
        send({ event: 'gw_ack', type: 'draw_error', error: e.message });
      }
      break;
    }
  }
}

// ── Redis Pub/Sub: consume ch:giveaway ───────────────────
function subscribeToGiveaway() {
  redisSub.subscribe('ch:giveaway', (err) => { if (err) return logErr('Sub', err.message); log('Sub', 'Subscribed ch:giveaway'); });
  redisSub.on('message', async (channel, payload) => {
    if (channel !== 'ch:giveaway') return;
    let msg; try { msg = JSON.parse(payload); } catch { return; }
    const teamId = sanitizeTeamId(msg.team);

    switch (msg.event) {
      case 'viewer_tick':
        await wte.handleViewerTick(teamId, msg.channel, msg.user, msg.follows);
        break;
      case 'chat_msg': {
        const result = await wte.handleChatMessage(teamId, msg.channel, msg.user, msg.message, msg.follows);
        const u = sanitizeUsername(msg.user);
        if (result && result.isNew) {
          broadcastTeam(teamId, { event: 'gw_join', user: u });
          let reply;
          if (result.eligible) {
            reply = `@${u} Du bist dabei & im Lostopf ✅ (${result.coins.toFixed(2)} Punkte). Weiter zuschauen + sinnvoll chatten erhöht deine Chance!`;
          } else {
            const need = [];
            if (result.channelsFollowed < result.followMin) need.push(`folge mind. ${result.followMin} ${kw2(result.followMin)}`);
            if ((result.totalWatchSec || 0) < result.drawMinSec) need.push(`sammle ${fmtDur(result.drawMinSec)} Zuschauzeit (zuschauen + sinnvoll chatten)`);
            reply = need.length
              ? `@${u} Angemeldet ✅ — für den Lostopf noch nötig: ${need.join(' + ')}. Stand: !los`
              : `@${u} Du bist dabei & im Lostopf ✅`;
          }
          redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: reply }));
        }
        if (result && result.added) broadcastTeam(teamId, { event: 'wt_update', user: u, channel: result.channel, watchSec: result.watchSec, coins: result.coins });
        break;
      }
      case 'time_cmd': {
        const u = sanitizeUsername(msg.user);
        let reply;
        if (!await wte.isOpen(teamId)) reply = `@${u} Kein Giveaway aktiv.`;
        else {
          const a = await wte.getUserAggregate(teamId, u);
          const kw = await redis.get(K.gwKeyword(teamId)) || '';
          if (a.eligible) {
            const all = await wte.getAllParticipants(teamId);
            const pool = all.filter(p => p.eligible).reduce((s, p) => s + p.totalCoins, 0);
            const chance = pool > 0 ? (a.totalCoins / pool * 100) : 0;
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
        const host = (process.env.PUBLIC_URL || 'https://team.raumdock.org').replace(/^https?:\/\//, '').replace(/\/+$/, '');
        reply += ` | Status: ${host}/viewer/status | Regeln: ${host}/viewer/terms?team=${teamId}`;
        redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: reply }));
        break;
      }
      case 'giveaway_cmd': {
        const kw = await redis.get(K.gwKeyword(teamId)) || '';
        const host = (process.env.PUBLIC_URL || 'https://team.raumdock.org').replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const kwTxt = kw ? `"${kw}"` : 'das Keyword';
        const fm = await wte.getFollowMin(teamId);
        const dmSec = await wte.getDrawMinSec(teamId);
        const dmTxt = dmSec > 0 ? ` + mind. 1 Punkt (${fmtDur(dmSec)} Zuschauzeit)` : '';
        const info = `🎁 Team-Giveaway: schau auf EINEM der Team-Kanäle zu — die Zuschauzeit zählt zusammen (${fmtDur(dmSec)} = 1 Punkt), sinnvoller Chat (>3 Wörter) gibt Bonus. Mitmachen: schreib ${kwTxt} im Chat (= anmelden). Für den Lostopf: folge ≥${fm} ${kw2(fm)}${dmTxt}. Befehle: !los = dein Status & Chance · !giveaway = diese Info. Regeln: ${host}/viewer/terms?team=${teamId} | Status: ${host}/viewer/status`;
        redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: info }));
        break;
      }
      case 'stream_online': {
        try { await pg.query('TRUNCATE TABLE debug_log'); } catch(e) { logErr('Debug', e.message); }
        await handleStreamOnline(teamId, msg.channel);
        break;
      }
      case 'stream_offline': {
        await handleStreamOffline(teamId, msg.channel);
        break;
      }
      case 'cc_debug': {
        try {
          await pg.query(`INSERT INTO debug_log (source, stage, username, info) VALUES ($1,$2,$3,$4)`,
            [sanitizeStr(msg.source, 50), sanitizeStr(msg.stage, 50), msg.user ? sanitizeUsername(msg.user) : null, msg.info ? sanitizeStr(msg.info, 500) : null]);
        } catch(e) { logErr('Debug', e.message); }
        break;
      }
    }
  });
}

// ── REST (behind Caddy forward_auth; X-Auth-User trusted) ─
app.use(express.json({ limit: '10mb' }));   // Backup-Import kann groß werden
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type'); next(); });
function reqUser(req) { return sanitizeUsername(req.headers['x-auth-user'] || ''); }

app.get('/health', async (req, res) => {
  try { await redis.ping(); await pg.query('SELECT 1'); res.json({ status: 'ok', service: 'giveaway', redis: 'ok', pg: 'ok' }); }
  catch(e) { res.status(503).json({ status: 'error', error: e.message }); }
});

app.get('/api/participants', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await isMember(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    res.json({ team: teamId, open: await wte.isOpen(teamId), session: await wte.getSessionId(teamId), participants: await wte.getAllParticipants(teamId) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Backup: Export / Import ───────────────────────────────
// Export ist lesend und unkritisch, Import überschreibt den Live-Stand —
// beides nur für den Team-Owner, beides im Audit-Log.
app.get('/api/export', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await ownsTeam(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const data = await wte.exportTeam(teamId);
    data.exportedAt = new Date().toISOString();
    data.exportedBy = reqUser(req);
    if (req.query.full === '1') {
      const draws = await pg.query('SELECT * FROM giveaway_draws WHERE session_id IN (SELECT id FROM sessions WHERE team_id=$1)', [teamId]);
      const audit = await pg.query('SELECT * FROM audit_log WHERE team_id=$1 ORDER BY ts', [teamId]);
      data.history = { draws: draws.rows, audit: audit.rows };
    }
    await audit({ teamId, actor: reqUser(req), ip: req.ip, action: 'export',
                  detail: { participants: data.participants.length, full: req.query.full === '1' } });
    res.setHeader('Content-Disposition', `attachment; filename="giveaway_backup_${teamId}.json"`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/import', async (req, res) => {
  const teamId = sanitizeTeamId(req.query.team);
  const actor  = reqUser(req);
  try {
    if (!await ownsTeam(actor, teamId)) return res.status(403).json({ error: 'forbidden' });
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
    // Replace löscht den Live-Stand — nur mit ausdrücklicher Bestätigung.
    if (mode === 'replace' && req.query.confirm !== 'replace') {
      return res.status(400).json({ error: 'replace erfordert confirm=replace' });
    }
    // Stand vor dem Import festhalten, damit der Import selbst umkehrbar bleibt.
    const before = await wte.exportTeam(teamId);
    const r = await wte.importTeam(teamId, req.body, { mode });
    await audit({ teamId, actor, ip: req.ip, action: 'import',
                  sessionId: await wte.getSessionId(teamId),
                  detail: { mode, usersImported: r.users, channels: r.channels,
                            participantsBefore: before.participants.length,
                            backupExportedAt: req.body && req.body.exportedAt } });
    broadcastTeam(teamId, { event: 'gw_status', status: await wte.isOpen(teamId) ? 'open' : 'closed' });
    res.json({ ok: true, ...r, participantsBefore: before.participants.length });
  } catch(e) {
    await audit({ teamId, actor, ip: req.ip, action: 'import', result: 'error', detail: { error: e.message } });
    res.status(400).json({ error: e.message });
  }
});

// Audit-Log: nur der Team-Owner sieht, wer was gemacht hat.
app.get('/api/audit', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await ownsTeam(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const params = [teamId];
    let where = 'team_id = $1';
    if (req.query.actor)  { params.push(sanitizeUsername(req.query.actor));  where += ` AND actor = $${params.length}`; }
    if (req.query.target) { params.push(sanitizeUsername(req.query.target)); where += ` AND target = $${params.length}`; }
    if (req.query.action) { params.push(sanitizeStr(req.query.action, 50));  where += ` AND action = $${params.length}`; }
    params.push(limit);
    const r = await pg.query(
      `SELECT id, ts, actor, actor_ip, action, target, result, detail, session_id
       FROM audit_log WHERE ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length}`, params);
    res.json({ team: teamId, entries: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Zuschauer-Statusseite: eigener Stand über alle Teams (nur eigene Daten).
app.get('/api/my-status', async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamIds = await wte.getUserTeams(user);
    const out = [];
    for (const t of teamIds) {
      const a = await wte.getUserAggregate(t, user);
      if (a.totalCoins <= 0 && !a.registered) continue;   // veraltet/leer überspringen
      const nr = await pg.query('SELECT name FROM teams WHERE id=$1', [t]);
      if (!nr.rowCount) continue;
      let chance = 0;
      if (a.eligible) {
        const all = await wte.getAllParticipants(t);
        const pool = all.filter(p => p.eligible).reduce((s, p) => s + p.totalCoins, 0);
        chance = pool > 0 ? (a.totalCoins / pool * 100) : 0;
      }
      out.push({ teamId: t, name: nr.rows[0].name, coins: a.totalCoins, watchSec: a.totalWatchSec,
                 channelsQualified: a.channelsQualified, followMin: a.followMin, drawMinSec: a.drawMinSec, registered: a.registered, eligible: a.eligible,
                 chance, open: await wte.isOpen(t), paused: await wte.isPaused(t), perChannel: a.perChannel });
    }
    res.json({ login: user, teams: out.sort((x, y) => y.coins - x.coins) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await isMember(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const r = await pg.query('SELECT * FROM sessions WHERE team_id=$1 ORDER BY opened_at DESC LIMIT 50', [teamId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/draws', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await isMember(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.min(parseInt(req.query.limit || '50'), 500);
    const cols = req.query.full === '1' ? 'd.*'
      : 'd.id, d.session_id, d.winner, d.winner_coins, d.total_coins, d.eligible_count, d.rand_value, d.draw_index, d.is_test, d.prize, d.drawn_at';
    const r = await pg.query(`SELECT ${cols} FROM giveaway_draws d JOIN sessions s ON s.id=d.session_id
                              WHERE s.team_id=$1 ORDER BY d.drawn_at DESC LIMIT $2`, [teamId, limit]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Anti-Abuse-Log (nachvollziehbar): alle Flags der aktuellen Session mit Beweis.
app.get('/api/abuse', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await isMember(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const sid = req.query.session || await wte.getSessionId(teamId);
    const r = await pg.query(`
      SELECT username, reason, occurrences, first_seen, last_seen, detail
      FROM abuse_flags WHERE team_id=$1 AND ($2::text IS NULL OR session_id=$2)
      ORDER BY last_seen DESC LIMIT 500`, [teamId, sid || null]);
    res.json({ team: teamId, session: sid || null, flags: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));

// ── Schema ────────────────────────────────────────────────
async function ensureSchema() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS giveaway_draws (
      id BIGSERIAL PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      winner TEXT NOT NULL, winner_coins NUMERIC(10,4) NOT NULL DEFAULT 0, winner_watch_sec BIGINT NOT NULL DEFAULT 0,
      total_coins NUMERIC(10,4) NOT NULL DEFAULT 0, eligible_count INTEGER NOT NULL DEFAULT 0,
      rand_value NUMERIC(20,10) NOT NULL DEFAULT 0, draw_index INTEGER NOT NULL DEFAULT 1,
      is_test BOOLEAN NOT NULL DEFAULT FALSE, prize TEXT, eligible_snapshot JSONB,
      drawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS prize TEXT`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_draws_session ON giveaway_draws(session_id)`);
  // Multi-tenant + multi-channel columns.
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS channels JSONB`);
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS team_id TEXT`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_sessions_team ON sessions(team_id)`);
  await pg.query(`ALTER TABLE watchtime_events ADD COLUMN IF NOT EXISTS channel TEXT`);
  await pg.query(`ALTER TABLE watchtime_events ADD COLUMN IF NOT EXISTS team_id TEXT`);
  await pg.query(`ALTER TABLE watchtime_events DROP CONSTRAINT IF EXISTS watchtime_events_event_type_check`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS campaign_participation (
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, username TEXT NOT NULL, channel TEXT NOT NULL,
      watch_sec BIGINT NOT NULL DEFAULT 0, msgs INTEGER NOT NULL DEFAULT 0, coins NUMERIC(10,4) NOT NULL DEFAULT 0,
      follows BOOLEAN NOT NULL DEFAULT FALSE, valid BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (session_id, username, channel))`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_cp_session ON campaign_participation(session_id)`);
  // Phase 7: Anti-Abuse-Flags (append-only Audit pro Session, mit Beweis).
  await pg.query(`
    CREATE TABLE IF NOT EXISTS abuse_flags (
      session_id  TEXT NOT NULL,
      team_id     TEXT,
      username    TEXT NOT NULL,
      reason      TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detail      JSONB,
      PRIMARY KEY (session_id, username, reason)
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_abuse_team ON abuse_flags(team_id)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_abuse_session ON abuse_flags(session_id)`);
  // Audit: append-only, jede Aktion mit Einfluss auf das Giveaway.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      team_id    TEXT,
      session_id TEXT,
      actor      TEXT NOT NULL,
      actor_ip   TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      result     TEXT NOT NULL DEFAULT 'ok',
      detail     JSONB
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_audit_team_ts ON audit_log(team_id, ts DESC)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`);
  // Chat-KI pro Team. ai_key_enc ist AES-256-GCM; Schluessel aus app_secrets.
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS ai_provider TEXT`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS ai_model TEXT`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS ai_key_enc TEXT`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotated_at TIMESTAMPTZ
    )`);
  log('Schema', 'multi-tenant + abuse + audit schema ensured');
}

async function main() {
  await redisReady();
  await pgReady();
  await ensureSchema();
  await loadMasterSecret();
  subscribeToGiveaway();
  startWatchtimeTicker();
  server.listen(CFG.port, () => log('Giveaway', `Service on port ${CFG.port}`));
}

function startWatchtimeTicker() {
  setInterval(async () => {
    try {
      const updates = await wte.tickPresentUsers();
      for (const u of updates) broadcastTeam(u.teamId, { event: 'wt_update', user: u.username, channel: u.channel, watchSec: u.watchSec, coins: u.coins });
    } catch(e) { logErr('Tick', e.message); }
  }, TICK_SEC * 1000);
  log('Tick', `Ticker started (${TICK_SEC}s)`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(err => { logErr('FATAL', err.message); process.exit(1); });
