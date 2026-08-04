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
// Chat-Texte (!los/!giveaway/Anmelde-Antwort) und Format-Helfer kommen aus
// dem Core — die Regeltexte gehören zur Mechanik (Phase 1, ARCHITEKTUR-CORES).
const CORE = require('./cores/watchtime-chat.js');
const { fmtDur, kw2 } = CORE;
const { Helix } = require('./helix.js');
const { judgeMessage, listModels, encryptKey, decryptKey, PROVIDERS } = require('./cores/chat-ai.js');
const { targz } = require('./targz.js');

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
  // Test-Console-Simulation (viewer_tick/chat_msg/time_cmd ueber die Admin-WS).
  // Standard AUS: simulierte Ticks landen in watchtime_events und damit im
  // Ziehungs-Snapshot — in einer laufenden Verlosung waere das erfundene
  // Viewtime. Fuer lokale Entwicklung ALLOW_SIM=true setzen.
  allowSim: process.env.ALLOW_SIM === 'true',
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
  'gw_list_giveaways',
]);

// Obergrenze gleichzeitiger Giveaways je Team (Entscheidung §10.2:
// 3 langlaufende + 1 Sofortverlosung; die Typ-Trennung kommt mit den Cores,
// bis dahin gilt die Summe). Konstante, per ENV überschreibbar — bewusst
// nicht im Admin-Panel einstellbar.
const MAX_PARALLEL_GIVEAWAYS = Math.max(1, parseInt(process.env.MAX_PARALLEL_GIVEAWAYS || '4', 10) || 4);

const validGid = (s) => (typeof s === 'string' && /^sess_\d+$/i.test(s)) ? s : null;

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
// Jedes Giveaway braucht ein eigenes Impressum des Veranstalters. Das ist
// keine Empfehlung, sondern Bedingung fuers Oeffnen - ein laufendes
// Gewinnspiel ohne Anbieterkennzeichnung ist ein rechtliches Problem des
// Veranstalters, und der Betreiber der Plattform ist dafuer nicht zustaendig.
async function hasImprint(teamId) {
  try {
    const r = await pg.query('SELECT imprint, imprint_url FROM teams WHERE id=$1', [teamId]);
    if (!r.rowCount) return false;
    return !!(String(r.rows[0].imprint || '').trim() || String(r.rows[0].imprint_url || '').trim());
  } catch(e) { logErr('GW', 'imprint check:', e.message); return false; }
}
const IMPRINT_HINT = 'Kein Impressum hinterlegt. Trage unter MEINE TEAMS das Impressum des '
                   + 'Veranstalters ein (Text oder Link), dann laesst sich das Giveaway oeffnen.';

// Der Glueckspiel-Ausschluss der Nutzungsbedingungen bindet nur, wenn der
// Veranstalter ihm zugestimmt hat. Ohne Zustimmung laeuft hier kein Giveaway.
// Muss mit TOS_VERSION in services/admin/server.js uebereinstimmen.
const TOS_VERSION = 1;
async function ownerAcceptedTos(teamId) {
  try {
    const r = await pg.query(
      `SELECT 1 FROM teams t JOIN tos_acceptances a ON a.login = t.owner_login
       WHERE t.id=$1 AND a.version >= $2 LIMIT 1`, [teamId, TOS_VERSION]);
    return r.rowCount > 0;
  } catch(e) { logErr('GW', 'tos check:', e.message); return false; }
}
const TOS_HINT = 'Den Nutzungsbedingungen wurde noch nicht zugestimmt. Melde dich unter '
               + 'MEINE TEAMS an und bestaetige sie, dann laesst sich das Giveaway oeffnen.';


// Die Erklaerung, wie man mitmacht — identisch fuer !giveaway und die
// Eroeffnungsansage. Text liegt im Core (infoText); hier nur Datensammlung.
// Ohne Schema — Chat-Texte zeigen nur den Host (anders als publicHost()).
const chatHost = () =>
  (process.env.PUBLIC_URL || 'https://team.raumdock.org').replace(/^https?:\/\//, '').replace(/\/+$/, '');
async function giveawayInfoText(teamId) {
  return CORE.infoText({
    keyword:    await redis.get(K.gwKeyword(teamId)) || '',
    followMin:  await wte.getFollowMin(teamId),
    drawMinSec: await wte.getDrawMinSec(teamId),
    host: chatHost(), teamId,
  });
}

// Jeder Statuswechsel wird im Chat angesagt. Die Ansagen sitzen in diesen
// Helfern und nicht in den gw_cmd-Faellen, damit der Auto-Pfad
// (stream_online/-offline) dieselbe Nachricht schickt und nichts vergessen wird.
async function openGiveaway(teamId, keyword) {
  const sid = `sess_${Date.now()}`;
  await wte.openGiveaway(teamId, keyword, sid);
  await redis.del(K.gwAutoPaused(teamId));   // frischer Start ist nie auto-pausiert
  const chans = await wte.getChannels(teamId);
  // core_config-Snapshot beim Öffnen: übernimmt die (Legacy-)Team-Werte aus
  // Redis — inkl. cfgDrawMinSec — in die Giveaway-Instanz (§6 Alt-Key-Migration).
  // Gelesen wird zur Laufzeit weiterhin aus Redis; der Snapshot dokumentiert,
  // mit welcher Konfiguration dieses Giveaway gestartet ist.
  const coreConfig = await snapshotCoreConfig(teamId);
  await pg.query(`INSERT INTO sessions (id, team_id, keyword, channels, core, status, core_config) VALUES ($1,$2,$3,$4,$5,'open',$6) ON CONFLICT (id) DO NOTHING`,
    [sid, teamId, keyword || '', JSON.stringify(chans), CORE.id, JSON.stringify(coreConfig)]);
  broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
  await announceTeam(teamId, '🎉 Das Giveaway ist ERÖFFNET! ' + await giveawayInfoText(teamId));
  log('GW', `[${teamId}] opened session ${sid}, kw="${keyword}", channels=${chans.join(',')}`);
  return sid;
}
// sessions.status spiegelt den Redis-Zustand (open/paused/closed) — rein
// informativ fuer Archiv/Panel, das Verhalten haengt weiter an Redis.
async function setSessionStatus(teamId, status) {
  try {
    const sid = await wte.getSessionId(teamId);
    if (sid) await pg.query(`UPDATE sessions SET status=$1 WHERE id=$2`, [status, sid]);
  } catch (e) { logErr('GW', 'setSessionStatus:', e.message); }
}
async function setSessionStatusById(gid, status) {
  try { await pg.query(`UPDATE sessions SET status=$1 WHERE id=$2`, [status, gid]); }
  catch (e) { logErr('GW', 'setSessionStatusById:', e.message); }
}
async function snapshotCoreConfig(teamId) {
  return {
    coinBaseSec: await wte.getCoinBaseSec(teamId),
    followMin:   await wte.getFollowMin(teamId),
    chat:        await wte.getChatConfig(teamId),
  };
}
// Ansage nur in bestimmte Kanäle (Instanz mit Kanal-Teilmenge);
// channels null = alle Team-Kanäle.
async function announceChannels(teamId, channels, message) {
  if (!Array.isArray(channels) || !channels.length) return announceTeam(teamId, message);
  for (const ch of channels) {
    redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: ch, message }));
  }
  return channels.length;
}
async function closeGiveaway(teamId) {
  const sid = await wte.getSessionId(teamId);
  await setSessionStatus(teamId, 'closed');
  await wte.closeGiveaway(teamId, sid);
  await redis.del(K.gwOnline(teamId), K.gwAutoPaused(teamId));
  boostAnnounced.delete(teamId);
  broadcastTeam(teamId, { event: 'gw_status', status: 'closed' });
  await announceTeam(teamId, '🔒 Das Giveaway ist GESCHLOSSEN — ab jetzt zählt keine Zuschauzeit mehr. '
    + 'Die Ziehung erfolgt gewichtet nach Punkten unter allen Zugelassenen. Viel Glück!');
  log('GW', `[${teamId}] closed`);
}
async function pauseGiveaway(teamId, { auto = false } = {}) {
  await wte.setPaused(teamId, true);
  await setSessionStatus(teamId, 'paused');
  if (auto) await redis.set(K.gwAutoPaused(teamId), '1');
  else      await redis.del(K.gwAutoPaused(teamId));
  broadcastTeam(teamId, { event: 'gw_status', status: 'paused' });
  await announceTeam(teamId, auto
    ? '⏸ Giveaway pausiert — alle Team-Kanäle sind offline. Zuschauzeit zählt gerade nicht, euer Punktestand bleibt erhalten.'
    : '⏸ Giveaway pausiert — Zuschauzeit zählt gerade nicht. Euer Punktestand bleibt erhalten.');
}
async function resumeGiveaway(teamId, { auto = false } = {}) {
  await wte.setPaused(teamId, false);
  await setSessionStatus(teamId, 'open');
  await redis.del(K.gwAutoPaused(teamId));
  broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
  await announceTeam(teamId, auto
    ? '▶ Giveaway läuft weiter — der Stream ist wieder online, Zuschauzeit zählt ab jetzt wieder.'
    : '▶ Giveaway läuft weiter — Zuschauzeit zählt ab jetzt wieder.');
}

// ── Auto-Steuerung: Stream online/offline → Giveaway pause/resume ──
async function handleStreamOnline(teamId, channel) {
  const ch = sanitizeChannel(channel);
  if (!ch) return;
  await redis.sadd(K.gwOnline(teamId), ch);
  if (await redis.get(K.cfgAutoResume(teamId)) !== '1') return;
  if (await wte.isOpen(teamId)) {
    if (await wte.isPaused(teamId)) {
      await resumeGiveaway(teamId, { auto: true });
      log('Auto', `[${teamId}] stream online (${ch}) → resume`);
      await audit({ teamId, actor: 'system', action: 'auto_resume', target: ch,
                    sessionId: await wte.getSessionId(teamId), detail: { trigger: 'stream_online' } });
    }
  } else {
    if (!await ownerAcceptedTos(teamId)) {
      log('Auto', `[${teamId}] stream online (${ch}) -> NICHT geoeffnet: Nutzungsbedingungen offen`);
      await audit({ teamId, actor: 'system', action: 'auto_open', target: ch,
                    result: 'denied', detail: { reason: 'no_tos' } });
      return;
    }
    if (!await hasImprint(teamId)) {
      log('Auto', `[${teamId}] stream online (${ch}) -> NICHT geoeffnet: kein Impressum`);
      await audit({ teamId, actor: 'system', action: 'auto_open', target: ch,
                    result: 'denied', detail: { reason: 'no_imprint' } });
      return;
    }
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
    await pauseGiveaway(teamId, { auto: true });
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

function publicHost() {
  return (process.env.PUBLIC_URL || 'https://team.raumdock.org').replace(/\/+$/, '');
}

// ── Gewinnermeldung ───────────────────────────────────────
// Meldefrist aus den Teilnahmebedingungen. Wer sie verstreichen laesst,
// verliert den Anspruch — deshalb steht die Frist im Datensatz und nicht
// nur im Text.
const CLAIM_DEADLINE_DAYS  = 14;
const CLAIM_RETENTION_DAYS = 365;   // 12 Monate ab Meldung, s. Datenschutzerklaerung

async function createClaim(teamId, result) {
  try {
    // Der Token macht den Direktlink aus dem Chat bequem. Er ersetzt die
    // Anmeldung aber nicht: abgeben darf nur, wer als Gewinner eingeloggt ist.
    const token = crypto.randomBytes(24).toString('base64url');
    const hash  = crypto.createHash('sha256').update(token).digest('hex');
    const deadline = new Date(Date.now() + CLAIM_DEADLINE_DAYS * 86400 * 1000);
    const r = await pg.query(`
      INSERT INTO draw_claims (draw_id, team_id, session_id, winner, token_hash, deadline_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (draw_id) DO NOTHING
      RETURNING id, deadline_at`,
      [result.drawId, teamId, result.sessionId || null, result.winner, hash, deadline]);
    if (!r.rowCount) return null;
    return { id: r.rows[0].id, deadlineAt: r.rows[0].deadline_at, token };
  } catch(e) { logErr('Claim', 'create:', e.message); return null; }
}

// Ansage in die Chats aller Team-Kanaele. Die bridge verwirft Nachrichten an
// Kanaele ohne verbundenen Bot, offline schadet also nicht.
async function announceTeam(teamId, message) {
  try {
    const channels = await wte.getChannels(teamId);
    for (const ch of channels) {
      redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: ch, message }));
    }
    return channels.length;
  } catch(e) { logErr('Announce', e.message); return 0; }
}

// Der Boost laeuft ueber ein Redis-TTL aus, es gibt also kein Ereignis dafuer.
// Der Ticker merkt sich pro Team den angesagten Faktor und sagt das Ende an,
// sobald er weg ist — sonst wundern sich die Zuschauer, warum es langsamer wird.
const boostAnnounced = new Map();
async function watchBoostExpiry() {
  for (const [teamId, factor] of [...boostAnnounced]) {
    try {
      const st = await wte.multiplierState(teamId);
      if (st.factor > 1) { boostAnnounced.set(teamId, st.factor); continue; }
      boostAnnounced.delete(teamId);
      await announceTeam(teamId, `⚡ Giveaway-Boost (Faktor ×${factor}) ist abgelaufen — Zuschauzeit zählt wieder normal.`);
      broadcastTeam(teamId, { event: 'gw_multiplier', factor: 1, secondsLeft: 0 });
    } catch(e) { logErr('Boost', e.message); boostAnnounced.delete(teamId); }
  }
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
    // Diese Events gehen in dieselbe Pipeline wie echte Ticks vom Ingest und
    // erzeugen echte watchtime_events. Darum: in Prod aus (ALLOW_SIM), und
    // wenn an, dann protokolliert — sonst waere Viewtime die einzige
    // zustandsaendernde Groesse ohne Spur im audit_log.
    case 'viewer_tick':
    case 'chat_msg':
    case 'time_cmd': {
      const teamId = sanitizeTeamId(msg.teamId);
      if (!await ownsTeam(meta.authUser, teamId)) return;
      const simBase = {
        teamId, actor: meta.authUser || '(unauthenticated)', ip: meta.ip,
        action: 'sim_' + msg.event, target: auditTarget(msg),
        detail: { channel: sanitizeChannel(msg.channel || '') || null,
                  message: msg.event === 'chat_msg' ? String(msg.message || '').slice(0, 120) : undefined },
      };
      if (!CFG.allowSim) {
        await audit({ ...simBase, result: 'denied', detail: { ...simBase.detail, reason: 'sim_disabled' } });
        send({ event: 'gw_ack', type: 'sim_disabled' });
        return;
      }
      await audit(simBase);
      redisPub.publish('ch:giveaway', JSON.stringify({ ...msg, team: teamId }))
        .catch((e) => logErr('Sim', 'republish failed:', e.message));
      break;
    }
  }
}

// Cmds die ein Member (nicht-Owner) darf: lesen, EIGENER Ingest-Token +
// Giveaway-Steuerung (oeffnen/pausieren/fortsetzen/Boost) fuer den Team-Pott.
// Destruktiv (close/reset), Tickets, Bans + Konfig bleiben Owner-only.
const MEMBER_CMDS = new Set([
  'gw_get_channels', 'gw_get_multiplier', 'gw_get_stream_settings', 'gw_get_keyword',
  'gw_get_ingest_tokens', 'gw_gen_ingest_token', 'gw_get_ai_settings',
  'gw_open', 'gw_pause', 'gw_resume', 'gw_set_multiplier',
]);

// Abgelehnte Versuche gehoeren ins Protokoll — aber das Admin-Panel pollt die
// Nur-Lese-Cmds im Sekundentakt, und ein Member, dem eines davon fehlt, hat so
// schon 4,5 Mio Zeilen erzeugt und den Log unbrauchbar gemacht. Fuer AUDIT_SKIP-
// Cmds daher nur die erste Ablehnung je (Team, Actor, Cmd) pro Fenster
// protokollieren: das Signal "hat es versucht" bleibt, das Rauschen faellt weg.
// Echte Mutationen laufen hier nie durch und werden immer protokolliert.
const DENY_LOG_WINDOW_SEC = 300;
async function shouldLogDeny(teamId, actor, cmd) {
  if (!AUDIT_SKIP.has(cmd)) return true;
  try {
    const key = `t:${teamId}:audit_deny:${actor}:${cmd}`;
    return (await redis.set(key, '1', 'EX', DENY_LOG_WINDOW_SEC, 'NX')) === 'OK';
  } catch { return true; }   // im Zweifel protokollieren
}
async function handleAdminCmd(send, msg, meta) {
  const teamId = sanitizeTeamId(msg.teamId);
  const actor  = meta.authUser || '(unauthenticated)';
  const owner  = await ownsTeam(meta.authUser, teamId);
  // Abgelehnte Versuche gehören genauso ins Protokoll wie erfolgreiche.
  const auditBase = { teamId, actor, ip: meta.ip, action: msg.cmd, target: auditTarget(msg) };
  if (!owner) {
    if (!MEMBER_CMDS.has(msg.cmd) || !await isMember(meta.authUser, teamId)) {
      if (await shouldLogDeny(teamId, actor, msg.cmd)) {
        await audit({ ...auditBase, result: 'denied', detail: auditDetail(msg) });
      }
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
      if (!await ownerAcceptedTos(teamId)) {
        Object.assign(outcome, { blocked: 'no_tos' });
        send({ event: 'gw_ack', type: 'open_blocked', error: TOS_HINT });
        break;
      }
      if (!await hasImprint(teamId)) {
        Object.assign(outcome, { blocked: 'no_imprint' });
        send({ event: 'gw_ack', type: 'open_blocked', error: IMPRINT_HINT });
        break;
      }
      outcome.sessionOpened = await openGiveaway(teamId, sanitizeStr(msg.keyword || '', 100));
      send({ event: 'gw_status', status: 'open' });
      break;
    case 'gw_close':
      outcome.sessionClosed = await wte.getSessionId(teamId);
      await closeGiveaway(teamId);
      send({ event: 'gw_status', status: 'closed' });
      break;
    case 'gw_pause': {
      // Mit giveawayId: nur diese Sekundär-Instanz pausieren.
      const gid = validGid(msg.giveawayId);
      if (gid && gid !== await sid()) {
        await wte.setPaused(teamId, true, gid);
        await setSessionStatusById(gid, 'paused');
        Object.assign(outcome, { giveawayId: gid });
        send({ event: 'gw_ack', type: 'instance_paused', giveawayId: gid });
        break;
      }
      await pauseGiveaway(teamId);               // manuell, nicht auto
      send({ event: 'gw_status', status: 'paused' });
      log('GW', `[${teamId}] paused`);
      break;
    }
    case 'gw_resume': {
      const gid = validGid(msg.giveawayId);
      if (gid && gid !== await sid()) {
        await wte.setPaused(teamId, false, gid);
        await setSessionStatusById(gid, 'open');
        Object.assign(outcome, { giveawayId: gid });
        send({ event: 'gw_ack', type: 'instance_resumed', giveawayId: gid });
        break;
      }
      await resumeGiveaway(teamId);
      send({ event: 'gw_status', status: 'open' });
      log('GW', `[${teamId}] resumed`);
      break;
    }
    // ── Phase 2d: Parallel-Instanzen (z.B. Sofortverlosung neben Kampagne) ──
    case 'gw_list_giveaways': {
      send({ event: 'gw_ack', type: 'giveaways', giveaways: await wte.listGiveaways(teamId),
             maxParallel: MAX_PARALLEL_GIVEAWAYS });
      break;
    }
    case 'gw_open_instance': {
      // Dieselben Rechts-Gates wie gw_open — jede Instanz ist ein Gewinnspiel.
      if (!await ownerAcceptedTos(teamId)) {
        Object.assign(outcome, { blocked: 'no_tos' });
        send({ event: 'gw_ack', type: 'open_blocked', error: TOS_HINT });
        break;
      }
      if (!await hasImprint(teamId)) {
        Object.assign(outcome, { blocked: 'no_imprint' });
        send({ event: 'gw_ack', type: 'open_blocked', error: IMPRINT_HINT });
        break;
      }
      const running = await wte.listGiveaways(teamId);
      if (running.length >= MAX_PARALLEL_GIVEAWAYS) {
        Object.assign(outcome, { blocked: 'limit', running: running.length });
        send({ event: 'gw_ack', type: 'open_blocked',
               error: `Maximal ${MAX_PARALLEL_GIVEAWAYS} gleichzeitige Giveaways je Team.` });
        break;
      }
      const keyword = sanitizeStr(msg.keyword || '', 100);
      const teamChans = await wte.getChannels(teamId);
      const wanted = Array.isArray(msg.channels) ? msg.channels.map(sanitizeChannel).filter(Boolean) : [];
      const channels = wanted.filter(ch => teamChans.includes(ch));   // nur eigene Kanäle
      const gid = `sess_${Date.now()}`;
      const coreConfig = await snapshotCoreConfig(teamId);
      await pg.query(`INSERT INTO sessions (id, team_id, keyword, channels, core, status, core_config)
                      VALUES ($1,$2,$3,$4,$5,'open',$6) ON CONFLICT (id) DO NOTHING`,
        [gid, teamId, keyword, JSON.stringify(channels.length ? channels : teamChans), CORE.id, JSON.stringify(coreConfig)]);
      await wte.openGiveawayInstance(teamId, gid, { keyword, channels: channels.length ? channels : null });
      Object.assign(outcome, { giveawayId: gid, keyword, channels: channels.length ? channels : 'alle' });
      await announceChannels(teamId, channels.length ? channels : null,
        '🎁 Zusätzliches Giveaway gestartet!' + (keyword ? ` Mitmachen: schreib "${keyword}" im Chat.` : ''));
      send({ event: 'gw_ack', type: 'instance_opened', giveawayId: gid, keyword,
             channels: channels.length ? channels : null });
      break;
    }
    case 'gw_close_instance': {
      const gid = validGid(msg.giveawayId);
      const known = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && !g.primary) : null;
      if (!known) {
        Object.assign(outcome, { error: 'unknown_instance', giveawayId: msg.giveawayId || null });
        send({ event: 'gw_ack', type: 'error', error: 'Unbekannte Giveaway-Instanz.' });
        break;
      }
      await wte.closeGiveawayInstance(teamId, gid);
      await setSessionStatusById(gid, 'closed');
      Object.assign(outcome, { giveawayId: gid });
      await announceChannels(teamId, known.channels,
        '🔒 Das zusätzliche Giveaway ist geschlossen — Ziehung folgt.');
      send({ event: 'gw_ack', type: 'instance_closed', giveawayId: gid });
      break;
    }
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
      // Mit giveawayId: Boost für genau diese Instanz („Boost für 15 Minuten"
      // muss ein Giveaway meinen, nicht das Team — §6).
      const mGid = validGid(msg.giveawayId) || undefined;
      const prev = await wte.multiplierState(teamId, mGid);
      const r = await wte.setMultiplier(teamId, msg.factor, (parseInt(msg.minutes) || 0) * 60, mGid);
      Object.assign(outcome, { factorBefore: prev.factor, factorAfter: r.factor, seconds: r.seconds });
      broadcastTeam(teamId, { event: 'gw_multiplier', factor: r.factor, secondsLeft: r.seconds });
      // Ein Boost, den keiner mitbekommt, bringt niemanden zum Zuschauen.
      // Faktor 1 = aus, das ist derselbe Befehl und wird genauso angesagt.
      if (r.factor > 1) {
        boostAnnounced.set(teamId, r.factor);
        await announceTeam(teamId, `⚡ Giveaway-Boost für ${Math.round(r.seconds / 60)} Minuten — Faktor ×${r.factor}`
          + ' auf Zuschauzeit UND Chat-Bonus. Jetzt zählt jede Minute mehr!');
      } else if (prev.factor > 1) {
        boostAnnounced.delete(teamId);
        await announceTeam(teamId, '⚡ Giveaway-Boost vorzeitig beendet — Zuschauzeit zählt wieder normal.');
      }
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
        // Mit giveawayId zieht die Instanz, sonst das Primary.
        const drawGid = validGid(msg.giveawayId) || await sid();
        const result = await wte.drawWinner(teamId, drawGid, { test: !!msg.test, prize: msg.prize });
        if (!result) { outcome.winner = null; send({ event: 'gw_ack', type: 'no_winner' }); break; }
        Object.assign(outcome, { winner: result.winner, winnerCoins: result.coins, drawId: result.drawId,
                                 eligibleCount: result.eligibleCount, totalCoins: result.total,
                                 randValue: result.rand, isTest: !!result.isTest });
        send({ event: 'gw_ack', type: 'winner_drawn', winner: result.winner, watchSec: result.watchSec, coins: result.coins, drawId: result.drawId, prize: result.prize });
        broadcastTeam(teamId, { event: 'gw_overlay', winner: result.winner, coins: result.coins });
        // Testziehungen erzeugen keine Meldefrist und keine Ansage.
        if (!result.isTest) {
          const claim = await createClaim(teamId, result);
          outcome.claimDeadline = claim ? claim.deadlineAt : null;
          await announceTeam(teamId, `🎉 Gewinner: @${result.winner} — herzlichen Glückwunsch! `
            + `Melde dich innerhalb von ${CLAIM_DEADLINE_DAYS} Tagen unter ${publicHost()}/viewer/claim `
            + '(Login mit Twitch), sonst wird ein Ersatzgewinner gezogen.');
        }
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
          const reply = CORE.joinReply({ username: u, agg: result });
          redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: reply }));
        }
        if (result && result.added) broadcastTeam(teamId, { event: 'wt_update', user: u, channel: result.channel, watchSec: result.watchSec, coins: result.coins });
        break;
      }
      case 'time_cmd': {
        // Text liegt im Core (statusText); hier nur Datensammlung.
        const u = sanitizeUsername(msg.user);
        const open = await wte.isOpen(teamId);
        let agg = null, poolTotal = 0, keyword = '';
        if (open) {
          agg = await wte.getUserAggregate(teamId, u);
          keyword = await redis.get(K.gwKeyword(teamId)) || '';
          if (agg.eligible) {
            const all = await wte.getAllParticipants(teamId);
            poolTotal = all.filter(p => p.eligible).reduce((s, p) => s + p.totalCoins, 0);
          }
        }
        const reply = CORE.statusText({ username: u, open, agg, keyword, poolTotal, host: chatHost(), teamId });
        redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: reply }));
        break;
      }
      case 'giveaway_cmd': {
        const info = await giveawayInfoText(teamId);
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

// ── Audit-Log: Filter, Verdichtung, Archiv ────────────────
// Das Log ist append-only und wird NIE geloescht — auch nicht vom Archiv-Export.
// Damit es trotzdem lesbar bleibt, passiert zweierlei: der Server filtert
// (statt dass der Client 200 Zeilen zieht und selbst siebt) und verdichtet
// direkt aufeinanderfolgende identische Eintraege zu einer Zeile mit Zaehler.
function auditFilters(q) {
  const params = [];
  let where = 'team_id = $1';
  params.push(sanitizeTeamId(q.team));
  const add = (sql, val) => { params.push(val); where += ` AND ${sql.replace('?', '$' + params.length)}`; };
  if (q.actor)   add('actor = ?',      sanitizeUsername(q.actor));
  if (q.target)  add('target = ?',     sanitizeUsername(q.target));
  if (q.action)  add('action = ?',     sanitizeStr(q.action, 50));
  if (q.result)  add('result = ?',     sanitizeStr(q.result, 20));
  if (q.session) add('session_id = ?', sanitizeStr(q.session, 60));
  if (q.from)    add('ts >= ?',        new Date(q.from));
  if (q.to)      add('ts <= ?',        new Date(q.to));
  // Freitext ueber die menschlich relevanten Spalten.
  if (q.q) {
    params.push('%' + sanitizeStr(q.q, 60).toLowerCase() + '%');
    where += ` AND (LOWER(actor) LIKE $${params.length} OR LOWER(COALESCE(target,'')) LIKE $${params.length}`
           + ` OR LOWER(action) LIKE $${params.length})`;
  }
  return { where, params };
}

app.get('/api/audit', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await ownsTeam(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.min(500,    Math.max(1, parseInt(req.query.limit) || 100));
    // Verdichtet wird ueber ein Rohzeilen-Fenster, nicht ueber die ganze Tabelle —
    // sonst laeuft jede Anfrage ueber Millionen Zeilen. `scanned`/`hasMore` sagen
    // dem Client, wie tief wirklich geschaut wurde.
    const scan  = Math.min(200000, Math.max(limit, parseInt(req.query.scan) || 20000));
    const { where, params } = auditFilters(req.query);
    let w = where;
    if (req.query.before) { params.push(parseInt(req.query.before)); w += ` AND id < $${params.length}`; }
    params.push(scan);
    const scanIdx = params.length;
    params.push(limit);

    const grouped = String(req.query.group || '1') !== '0';
    const sql = grouped ? `
      WITH base AS (
        SELECT id, ts, actor, actor_ip, action, target, result, detail, session_id
        FROM audit_log WHERE ${w} ORDER BY ts DESC, id DESC LIMIT $${scanIdx}
      ), num AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ts DESC, id DESC) AS rn FROM base
      ), grp AS (
        SELECT *, rn - ROW_NUMBER() OVER (
                    PARTITION BY actor, COALESCE(actor_ip,''), action,
                                 COALESCE(target,''), result
                    ORDER BY rn) AS island
        FROM num
      )
      SELECT MIN(rn) AS ord, COUNT(*)::int AS n,
             MAX(ts) AS ts, MIN(ts) AS ts_first,
             MAX(id) AS id, MIN(id) AS id_first,
             actor, actor_ip, action, target, result,
             (ARRAY_AGG(detail     ORDER BY rn))[1] AS detail,
             (ARRAY_AGG(session_id ORDER BY rn))[1] AS session_id
      FROM grp
      GROUP BY actor, actor_ip, action, target, result, island
      ORDER BY ord
      LIMIT $${params.length}` : `
      SELECT id, id AS id_first, ts, ts AS ts_first, 1 AS n,
             actor, actor_ip, action, target, result, detail, session_id
      FROM (SELECT * FROM audit_log WHERE ${w} ORDER BY ts DESC, id DESC LIMIT $${scanIdx}) s
      ORDER BY ts DESC, id DESC LIMIT $${params.length}`;

    const r = await pg.query(sql, params);
    const rows = r.rows;
    const scanned = rows.reduce((s, x) => s + x.n, 0);
    const last = rows[rows.length - 1];
    res.json({
      team: teamId, entries: rows, grouped,
      scanned, scanLimit: scan,
      hasMore: scanned >= scan || rows.length >= limit,
      nextBefore: last ? Number(last.id_first) : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Kennzahlen fuer den Kopf der Audit-Seite: Gesamtzahl, Verteilung, Zeitraum,
// vorkommende Aktionen/Actors als Filter-Vorschlaege. Bewusst ein eigener
// Aufruf — die Zaehlung laeuft ueber die ganze Tabelle und wird nicht gepollt.
app.get('/api/audit/stats', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await ownsTeam(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const [byResult, byAction, actors, span] = await Promise.all([
      pg.query(`SELECT result, COUNT(*)::bigint AS n FROM audit_log WHERE team_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [teamId]),
      pg.query(`SELECT action, result, COUNT(*)::bigint AS n FROM audit_log WHERE team_id=$1 GROUP BY 1,2 ORDER BY 3 DESC LIMIT 60`, [teamId]),
      pg.query(`SELECT actor, COUNT(*)::bigint AS n FROM audit_log WHERE team_id=$1 GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [teamId]),
      pg.query(`SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*)::bigint AS n FROM audit_log WHERE team_id=$1`, [teamId]),
    ]);
    res.json({
      team: teamId,
      total:    Number(span.rows[0].n || 0),
      firstTs:  span.rows[0].first_ts,
      lastTs:   span.rows[0].last_ts,
      byResult: byResult.rows.map(r => ({ result: r.result, n: Number(r.n) })),
      byAction: byAction.rows.map(r => ({ action: r.action, result: r.result, n: Number(r.n) })),
      actors:   actors.rows.map(r => ({ actor: r.actor, n: Number(r.n) })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Archiv: laedt den gefilterten Ausschnitt als .tar.gz herunter (CSV + JSONL +
// MANIFEST mit SHA-256 je Datei). Rein lesend — im Log bleibt jede Zeile stehen,
// das Archiv ist eine Kopie zum Weglegen, kein Verschieben.
const AUDIT_ARCHIVE_MAX = 500000;
app.get('/api/audit/archive', async (req, res) => {
  const teamId = sanitizeTeamId(req.query.team);
  const actor  = reqUser(req);
  try {
    if (!await ownsTeam(actor, teamId)) return res.status(403).json({ error: 'forbidden' });
    const { where, params } = auditFilters(req.query);
    params.push(AUDIT_ARCHIVE_MAX);
    const r = await pg.query(
      `SELECT id, ts, team_id, session_id, actor, actor_ip, action, target, result, detail
       FROM audit_log WHERE ${where} ORDER BY ts ASC, id ASC LIMIT $${params.length}`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'keine Eintraege fuer diesen Filter' });

    const csvCell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['id','ts','team_id','session_id','actor','actor_ip','action','target','result','detail'];
    const csv = '﻿' + [head.join(';')].concat(r.rows.map(e => [
      e.id, e.ts.toISOString(), e.team_id || '', e.session_id || '', e.actor,
      e.actor_ip || '', e.action, e.target || '', e.result, JSON.stringify(e.detail || {}),
    ].map(csvCell).join(';'))).join('\r\n') + '\r\n';
    const jsonl = r.rows.map(e => JSON.stringify(e)).join('\n') + '\n';

    const now  = new Date();
    const open = await wte.isOpen(teamId).catch(() => null);
    const sha  = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const filt = ['actor','target','action','result','session','from','to','q']
      .filter(k => req.query[k]).map(k => `  ${k} = ${req.query[k]}`).join('\n') || '  (kein Filter — voller Log dieses Teams)';
    const manifest = [
      'CC-Giveaway — Audit-Archiv',
      '',
      `Team:            ${teamId}`,
      `Erstellt:        ${now.toISOString()}`,
      `Erstellt von:    ${actor}`,
      `Eintraege:       ${r.rows.length}${r.rows.length >= AUDIT_ARCHIVE_MAX ? `  (Obergrenze ${AUDIT_ARCHIVE_MAX} erreicht — Archiv ist unvollstaendig, Zeitraum enger waehlen)` : ''}`,
      `Zeitraum:        ${r.rows[0].ts.toISOString()}  bis  ${r.rows[r.rows.length-1].ts.toISOString()}`,
      `Giveaway offen:  ${open === null ? 'unbekannt' : (open ? 'ja' : 'nein')}`,
      '',
      'Filter:',
      filt,
      '',
      'Dateien (SHA-256):',
      `  audit.csv    ${sha(csv)}`,
      `  audit.jsonl  ${sha(jsonl)}`,
      '',
      'Das Audit-Log ist append-only. Dieses Archiv ist eine Kopie —',
      'es wurde nichts geloescht und nichts veraendert.',
      '',
    ].join('\n');

    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const gz = targz([
      { name: 'MANIFEST.txt', content: manifest },
      { name: 'audit.csv',    content: csv },
      { name: 'audit.jsonl',  content: jsonl },
    ], now.getTime() / 1000);

    await audit({ teamId, actor, ip: req.ip, action: 'audit_archive', result: 'ok',
                  detail: { entries: r.rows.length, filter: filt.trim(), bytes: gz.length } });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${teamId}-${stamp}.tar.gz"`);
    res.send(gz);
  } catch(e) {
    await audit({ teamId, actor, ip: req.ip, action: 'audit_archive', result: 'error', detail: { error: e.message } });
    res.status(500).json({ error: e.message });
  }
});

// ── Gewinnermeldung: Selbstauskunft des Gewinners ─────────
// Kontaktdaten traegt ausschliesslich der Gewinner selbst ein, identifiziert
// ueber die Twitch-Session. Ein Token aus dem Chat-Link ist nur Bequemlichkeit
// und ersetzt die Anmeldung nicht — sonst koennte jeder, der den Chat mitliest,
// fremde Adressdaten hinterlegen.
const CLAIM_FIELDS = { real_name: 120, email: 190, street: 140, zip: 20, city: 90, country: 60, note: 500 };

app.get('/api/claim/mine', async (req, res) => {
  try {
    const user = sanitizeUsername(reqUser(req) || '');
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pg.query(`
      SELECT c.id, c.team_id, c.session_id, c.status, c.deadline_at, c.claimed_at, c.purge_at,
             c.real_name, c.email, c.street, c.zip, c.city, c.country, c.note,
             d.drawn_at, d.prize, d.winner_coins, t.name AS team_name
      FROM draw_claims c
      JOIN giveaway_draws d ON d.id = c.draw_id
      LEFT JOIN teams t ON t.id = c.team_id
      WHERE c.winner = $1 ORDER BY d.drawn_at DESC`, [user]);
    res.json({ user, claims: r.rows.map(c => ({ ...c, overdue: c.status === 'pending' && new Date(c.deadline_at) < new Date() })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claim', express.json(), async (req, res) => {
  const user = sanitizeUsername(reqUser(req) || '');
  const id   = parseInt(req.body && req.body.id);
  try {
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const cur = await pg.query('SELECT id, team_id, status, deadline_at FROM draw_claims WHERE id=$1 AND winner=$2', [id, user]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Keine Gewinnmeldung fuer dich unter dieser Nummer' });
    const c = cur.rows[0];
    if (new Date(c.deadline_at) < new Date()) {
      await audit({ teamId: c.team_id, actor: user, ip: req.ip, action: 'claim_submit', target: user,
                    result: 'denied', detail: { claimId: id, reason: 'deadline_passed' } });
      return res.status(410).json({ error: 'Die Meldefrist ist abgelaufen' });
    }
    if (!req.body.acceptTerms) return res.status(400).json({ error: 'Bitte die Teilnahmebedingungen bestaetigen' });

    const vals = {};
    for (const [k, max] of Object.entries(CLAIM_FIELDS)) vals[k] = sanitizeStr(req.body[k] || '', max) || null;
    if (!vals.real_name) return res.status(400).json({ error: 'Name fehlt' });
    if (!vals.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(vals.email)) {
      return res.status(400).json({ error: 'E-Mail-Adresse sieht nicht gueltig aus' });
    }
    const tv = await pg.query('SELECT MAX(version) AS v FROM terms_versions WHERE team_id=$1', [c.team_id]).catch(() => ({ rows: [{}] }));
    const purge = new Date(Date.now() + CLAIM_RETENTION_DAYS * 86400 * 1000);

    await pg.query(`
      UPDATE draw_claims SET status='claimed', real_name=$2, email=$3, street=$4, zip=$5, city=$6,
             country=$7, note=$8, terms_version=$9, claimed_at=NOW(), claim_ip=$10, purge_at=$11
      WHERE id=$1`,
      [id, vals.real_name, vals.email, vals.street, vals.zip, vals.city, vals.country, vals.note,
       tv.rows[0] ? tv.rows[0].v : null, req.ip || null, purge]);

    // Bewusst ohne die Kontaktdaten selbst: das Protokoll belegt, DASS gemeldet
    // wurde, es ist keine zweite Kopie der personenbezogenen Daten.
    await audit({ teamId: c.team_id, actor: user, ip: req.ip, action: 'claim_submit', target: user,
                  result: 'ok', detail: { claimId: id, fields: Object.keys(vals).filter(k => vals[k]), purgeAt: purge } });
    res.json({ ok: true, purgeAt: purge });
  } catch(e) {
    await audit({ actor: user, ip: req.ip, action: 'claim_submit', target: user, result: 'error', detail: { claimId: id, error: e.message } });
    res.status(500).json({ error: e.message });
  }
});

// ── Archiv: abgeschlossene Giveaways ──────────────────────
// Ein abgeschlossenes Giveaway soll ohne Datenbankzugriff nachvollziehbar sein:
// Sitzung, Kanaele, Teilnehmerstand, jede Ziehung mit Snapshot, das Audit-Log
// des Zeitraums und die Gewinnermeldung.
app.get('/api/archive', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    if (!await isMember(reqUser(req), teamId)) return res.status(403).json({ error: 'forbidden' });
    const r = await pg.query(`
      SELECT s.id, s.keyword, s.channels, s.opened_at, s.closed_at,
             s.total_participants, s.total_coins,
             (SELECT COUNT(*)::int FROM giveaway_draws d WHERE d.session_id = s.id AND NOT d.is_test) AS draws,
             (SELECT COUNT(*)::int FROM giveaway_draws d WHERE d.session_id = s.id AND d.is_test)     AS test_draws,
             (SELECT STRING_AGG(d.winner, ', ' ORDER BY d.drawn_at)
                FROM giveaway_draws d WHERE d.session_id = s.id AND NOT d.is_test)                    AS winners,
             (SELECT COUNT(*)::int FROM draw_claims c WHERE c.session_id = s.id AND c.status='claimed') AS claimed
      FROM sessions s WHERE s.team_id = $1
      ORDER BY s.opened_at DESC LIMIT 200`, [teamId]);
    res.json({ team: teamId, sessions: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Volles Dossier zu einer Sitzung. Kontaktdaten des Gewinners sieht nur der
// Owner — Members bekommen dieselbe Seite ohne diese Felder.
async function archiveDossier(teamId, sessionId, withContact) {
  const q = (sql, p) => pg.query(sql, p).then(r => r.rows).catch(() => []);
  const contact = withContact
    ? 'c.real_name, c.email, c.street, c.zip, c.city, c.country, c.note, c.claim_ip,'
    : '';
  const [session, draws, participation, claims, auditRows] = await Promise.all([
    q(`SELECT * FROM sessions WHERE id=$1 AND team_id=$2`, [sessionId, teamId]),
    q(`SELECT id, winner, winner_coins, winner_watch_sec, total_coins, eligible_count,
              rand_value, draw_index, is_test, prize, drawn_at, eligible_snapshot
       FROM giveaway_draws WHERE session_id=$1 ORDER BY drawn_at`, [sessionId]),
    q(`SELECT username, channel, watch_sec, msgs, coins, follows, valid
       FROM campaign_participation WHERE session_id=$1 ORDER BY coins DESC, username`, [sessionId]),
    q(`SELECT c.id, c.draw_id, c.winner, c.status, c.deadline_at, c.claimed_at,
              c.terms_version, c.purge_at, c.purged_at, ${contact} c.created_at
       FROM draw_claims c WHERE c.session_id=$1 ORDER BY c.created_at`, [sessionId]),
    q(`SELECT id, ts, actor, actor_ip, action, target, result, detail
       FROM audit_log WHERE session_id=$1 ORDER BY ts LIMIT 50000`, [sessionId]),
  ]);
  return { session: session[0] || null, draws, participation, claims, audit: auditRows };
}

app.get('/api/archive/:sessionId', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    const user   = reqUser(req);
    if (!await isMember(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    const owner = await ownsTeam(user, teamId);
    const d = await archiveDossier(teamId, sanitizeStr(req.params.sessionId, 60), owner);
    if (!d.session) return res.status(404).json({ error: 'Sitzung nicht gefunden' });
    res.json({ ...d, contactVisible: owner });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Komplettes Giveaway als .tar.gz. Nur der Owner — hier liegen Kontaktdaten drin.
app.get('/api/archive/:sessionId/export', async (req, res) => {
  const teamId = sanitizeTeamId(req.query.team);
  const actor  = reqUser(req);
  const sid    = sanitizeStr(req.params.sessionId, 60);
  try {
    if (!await ownsTeam(actor, teamId)) return res.status(403).json({ error: 'forbidden' });
    const d = await archiveDossier(teamId, sid, true);
    if (!d.session) return res.status(404).json({ error: 'Sitzung nicht gefunden' });

    const now = new Date();
    const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const toCsv = (rows) => {
      if (!rows.length) return '';
      const cols = Object.keys(rows[0]);
      return '﻿' + [cols.join(';')].concat(rows.map(r => cols.map(c => cell(r[c])).join(';'))).join('\r\n') + '\r\n';
    };
    const files = [
      { name: 'session.json',       content: JSON.stringify(d.session, null, 2) },
      { name: 'draws.json',         content: JSON.stringify(d.draws, null, 2) },
      { name: 'teilnehmer.csv',     content: toCsv(d.participation) },
      { name: 'ziehungen.csv',      content: toCsv(d.draws.map(({ eligible_snapshot, ...r }) => r)) },
      { name: 'gewinnermeldung.csv',content: toCsv(d.claims) },
      { name: 'audit.csv',          content: toCsv(d.audit) },
    ].filter(f => f.content);

    const manifest = [
      'CC-Giveaway — Archiv eines abgeschlossenen Giveaways',
      '',
      `Team:        ${teamId}`,
      `Sitzung:     ${sid}`,
      `Eroeffnet:   ${d.session.opened_at ? new Date(d.session.opened_at).toISOString() : '–'}`,
      `Geschlossen: ${d.session.closed_at ? new Date(d.session.closed_at).toISOString() : 'noch offen'}`,
      `Erstellt:    ${now.toISOString()} von ${actor}`,
      '',
      `Ziehungen:   ${d.draws.length} (davon Test: ${d.draws.filter(x => x.is_test).length})`,
      `Teilnehmer:  ${d.participation.length} Kanal-Datensaetze`,
      `Audit:       ${d.audit.length} Eintraege`,
      `Meldungen:   ${d.claims.length}`,
      '',
      'draws.json enthaelt je Ziehung den vollstaendigen eligible_snapshot —',
      'damit laesst sich jede Ziehung mit rand_value nachrechnen.',
      '',
      'Dateien (SHA-256):',
      ...files.map(f => `  ${f.name.padEnd(22)} ${sha(f.content)}`),
      '',
      'gewinnermeldung.csv enthaelt personenbezogene Daten des Gewinners.',
      `Im System werden diese Felder ${CLAIM_RETENTION_DAYS} Tage nach der Meldung automatisch`,
      'geloescht. Fuer dieses Archiv ist der Empfaenger selbst verantwortlich.',
      '',
    ].join('\n');
    files.unshift({ name: 'MANIFEST.txt', content: manifest });

    const gz = targz(files, now.getTime() / 1000);
    await audit({ teamId, actor, ip: req.ip, action: 'archive_export', target: sid, sessionId: sid,
                  result: 'ok', detail: { files: files.map(f => f.name), bytes: gz.length } });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="giveaway-${sid}.tar.gz"`);
    res.send(gz);
  } catch(e) {
    await audit({ teamId, actor, ip: req.ip, action: 'archive_export', target: sid, result: 'error', detail: { error: e.message } });
    res.status(500).json({ error: e.message });
  }
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
  // Phase 2 (Cores, docs/ARCHITEKTUR-CORES.md §7): sessions ist die
  // Giveaway-Instanz. Bestandszeilen bekommen den heutigen Core als Default
  // und laufen unveraendert weiter — keine Datenmigration.
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS core TEXT NOT NULL DEFAULT 'CORE_WatchtimeChatActivity'`);
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS core_config JSONB`);
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT`);
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS core TEXT`);
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS prize_id BIGINT`);
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
  // Die Audit-Seite filtert fast immer auf result/action — ohne diese Indizes
  // scannt jede Anfrage die ganze Team-Partition.
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_audit_team_result_ts ON audit_log(team_id, result, ts DESC)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_audit_team_action_ts ON audit_log(team_id, action, ts DESC)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id)`);

  // ── Gewinnermeldung ─────────────────────────────────────
  // Die einzigen Klardaten im System (Name, E-Mail, Anschrift). Sie kommen
  // ausschliesslich vom Gewinner selbst ueber ein Formular hinter Twitch-Login,
  // nie aus einer Fremdeingabe. purge_at setzt die 12-Monats-Frist aus der
  // Datenschutzerklaerung; runRetention() raeumt danach nur die Kontaktfelder,
  // der Ziehungsnachweis bleibt vollstaendig.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS draw_claims (
      id            BIGSERIAL PRIMARY KEY,
      draw_id       BIGINT NOT NULL REFERENCES giveaway_draws(id) ON DELETE CASCADE,
      team_id       TEXT NOT NULL,
      session_id    TEXT,
      winner        TEXT NOT NULL,
      token_hash    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      deadline_at   TIMESTAMPTZ NOT NULL,
      real_name     TEXT,
      email         TEXT,
      street        TEXT,
      zip           TEXT,
      city          TEXT,
      country       TEXT,
      note          TEXT,
      terms_version INTEGER,
      claimed_at    TIMESTAMPTZ,
      claim_ip      TEXT,
      purge_at      TIMESTAMPTZ,
      purged_at     TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pg.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_draw   ON draw_claims(draw_id)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_claims_winner ON draw_claims(winner)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_claims_team   ON draw_claims(team_id, created_at DESC)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_claims_purge  ON draw_claims(purge_at) WHERE purge_at IS NOT NULL`);
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
  startRetentionJob();
  server.listen(CFG.port, () => log('Giveaway', `Service on port ${CFG.port}`));
}

// Ein Boost ueberlebt den Neustart (Redis-TTL), die Merkliste im Speicher nicht.
// Ohne dieses Nachziehen bliebe das Boost-Ende nach einem Deploy stumm.
async function seedBoostWatch() {
  try {
    const r = await pg.query('SELECT id FROM teams');
    for (const row of r.rows) {
      const st = await wte.multiplierState(row.id);
      if (st.factor > 1) boostAnnounced.set(row.id, st.factor);
    }
    if (boostAnnounced.size) log('Boost', `laufende Boosts uebernommen: ${boostAnnounced.size}`);
  } catch(e) { logErr('Boost', 'seed:', e.message); }
}

function startWatchtimeTicker() {
  seedBoostWatch();
  setInterval(async () => {
    try {
      const updates = await wte.tickPresentUsers();
      // Das Panel zeigt die Primary-Ansicht — nur deren Stände broadcasten.
      // Sekundär-Instanzen buchen still und bekommen ihre Anzeige in Phase 2d.
      for (const u of updates) {
        if (!u.primary) continue;
        broadcastTeam(u.teamId, { event: 'wt_update', user: u.username, channel: u.channel,
                                  watchSec: u.watchSec, coins: u.coins });
      }
      await watchBoostExpiry();
    } catch(e) { logErr('Tick', e.message); }
  }, TICK_SEC * 1000);
  log('Tick', `Ticker started (${TICK_SEC}s)`);
}

// ── Aufbewahrung (DSGVO Art. 5 Abs. 1 lit. e) ─────────────
// Ohne Frist waere die Speicherung unbegrenzt - genau das laesst sich
// gegenueber Betroffenen nicht begruenden. Die Werte stehen so auch in der
// Datenschutzerklaerung; wer sie hier aendert, muss sie dort mitaendern.
const RETENTION = {
  participationDays: 90,   // Teilnahmedaten nach Abschluss der Session
  protocolDays:     365,   // ab hier werden Protokolle anonymisiert, NICHT geloescht
  claimDays: CLAIM_RETENTION_DAYS,   // Kontaktdaten des Gewinners (12 Monate)
};

async function runRetention() {
  const deleted = {};
  try {
    // Teilnahmedaten: nur aus abgeschlossenen Sessions. Laufende Giveaways
    // bleiben unangetastet, egal wie lange sie schon offen sind.
    const ev = await pg.query(
      `DELETE FROM watchtime_events WHERE session_id IN (
         SELECT id FROM sessions WHERE closed_at IS NOT NULL AND closed_at < NOW() - ($1 || ' days')::interval)`,
      [RETENTION.participationDays]);
    deleted.watchtime_events = ev.rowCount;

    const cp = await pg.query(
      `DELETE FROM campaign_participation WHERE session_id IN (
         SELECT id FROM sessions WHERE closed_at IS NOT NULL AND closed_at < NOW() - ($1 || ' days')::interval)`,
      [RETENTION.participationDays]);
    deleted.campaign_participation = cp.rowCount;

    const af = await pg.query(
      `DELETE FROM abuse_flags WHERE last_seen < NOW() - ($1 || ' days')::interval`,
      [RETENTION.participationDays]);
    deleted.abuse_flags = af.rowCount;

    // Protokolle werden NICHT geloescht — sie sind der Nachweis, dass korrekt
    // gezogen und verwaltet wurde, und muessen dauerhaft nachvollziehbar
    // bleiben. Nach Ablauf der Frist fallen stattdessen die personenbezogenen
    // Anteile weg: die IP verschwindet, betroffene Namen werden pseudonymisiert.
    // Vorgang, Zeitpunkt und Ergebnis bleiben vollstaendig erhalten
    // (Art. 17 Abs. 3 lit. e DSGVO, Datenminimierung nach Art. 5 Abs. 1 lit. c).
    const anonymized = {};
    const alIp = await pg.query(
      `UPDATE audit_log SET actor_ip = NULL
       WHERE actor_ip IS NOT NULL AND ts < NOW() - ($1 || ' days')::interval`,
      [RETENTION.protocolDays]);
    anonymized.audit_log_ip = alIp.rowCount;

    const alTgt = await pg.query(
      `UPDATE audit_log
       SET target = 'anonym_' || SUBSTRING(ENCODE(SHA256(target::bytea), 'hex') FOR 8)
       WHERE target IS NOT NULL AND target NOT LIKE 'anonym\\_%'
         AND ts < NOW() - ($1 || ' days')::interval`,
      [RETENTION.protocolDays]);
    anonymized.audit_log_target = alTgt.rowCount;

    // Kontaktdaten des Gewinners: eigene Frist, und nur diese Felder. Der
    // Ziehungsnachweis samt Snapshot bleibt unangetastet.
    const cl = await pg.query(
      `UPDATE draw_claims
       SET real_name=NULL, email=NULL, street=NULL, zip=NULL, city=NULL, country=NULL,
           note=NULL, claim_ip=NULL, purged_at=NOW()
       WHERE purged_at IS NULL AND purge_at IS NOT NULL AND purge_at < NOW()`);
    anonymized.draw_claims_contact = cl.rowCount;

    // Meldefrist verstrichen und nichts eingetragen → Anspruch verfallen.
    const ex = await pg.query(
      `UPDATE draw_claims SET status='expired'
       WHERE status='pending' AND deadline_at < NOW()`);
    anonymized.draw_claims_expired = ex.rowCount;

    const totalDel = Object.values(deleted).reduce((a, b) => a + b, 0);
    const totalAnon = Object.values(anonymized).reduce((a, b) => a + b, 0);
    if (totalDel)  log('Retention', `geloescht: ${JSON.stringify(deleted)}`);
    if (totalAnon) log('Retention', `anonymisiert: ${JSON.stringify(anonymized)}`);
    return { deleted, anonymized };
  } catch(e) { logErr('Retention', e.message); return { deleted, anonymized: {} }; }
}

function startRetentionJob() {
  // Einmal beim Start (holt nach, was waehrend einer Auszeit faellig wurde),
  // danach einmal taeglich.
  setTimeout(runRetention, 60000);
  setInterval(runRetention, 24 * 60 * 60 * 1000);
  log('Retention', `aktiv: Teilnahmedaten ${RETENTION.participationDays} Tage nach Session-Ende, `
    + `Protokolle nach ${RETENTION.protocolDays} Tagen anonymisiert (nicht geloescht), `
    + `Gewinner-Kontaktdaten ${RETENTION.claimDays} Tage`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(err => { logErr('FATAL', err.message); process.exit(1); });
