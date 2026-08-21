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
const CoreRegistry = require('./cores/index.js');
const ChatTexts = require('./chat-texts.js');
const { fmtDur, kw2 } = CORE;
const { Helix } = require('./helix.js');
const { judgeMessage, listModels, encryptKey, decryptKey, PROVIDERS } = require('./cores/chat-ai.js');
const { targz } = require('./targz.js');
const TermsMod = require('./terms.js');
const { rerollBlocked, REROLL_BLOCK_MSG } = require('./claim-rules.js');

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
  // Zeitgeber (Ticker, Sofort-Fenster-Watcher, Retention) laufen genau EINMAL.
  // Bei einem einzelnen Container ist das der Normalfall (Default true). Wer
  // den Dienst je repliziert, setzt das Flag auf allen weiteren Instanzen auf
  // false: sonst bucht jede Replik denselben Tick noch einmal (docs/SKALIERUNG.md).
  runScheduler: process.env.RUN_SCHEDULER !== 'false',
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
const { CreditLedger, EXPIRE_MONTHS: CREDIT_EXPIRE_MONTHS } = require('./credit.js');
const credit = new CreditLedger(pg);
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
  'gw_list_giveaways', 'gw_list_prizes', 'gw_list_entries', 'gw_list_drafts',
  'gw_preflight', 'gw_get_chat_templates',
]);

// Obergrenze gleichzeitiger Giveaways je Team (Entscheidung §10.2:
// 3 langlaufende + 1 Sofortverlosung; die Typ-Trennung kommt mit den Cores,
// bis dahin gilt die Summe). Konstante, per ENV überschreibbar — bewusst
// nicht im Admin-Panel einstellbar.
const MAX_PARALLEL_GIVEAWAYS = Math.max(1, parseInt(process.env.MAX_PARALLEL_GIVEAWAYS || '4', 10) || 4);
// Abgeschaltete Mechaniken: kein neues Giveaway und kein neuer Entwurf mehr.
// Laufende Instanzen bleiben bedienbar (Voting, Ziehung, Aufraeumen), damit
// nichts mitten im Betrieb abbricht. Wieder freigeben = hier austragen und die
// Typ-Karte in giveaway-admin.html wieder einblenden.
const DISABLED_CORES = new Set(['CORE_ScreenshotContest']);
const DRAFT_TYPE_CORE = { campaign: 'CORE_WatchtimeChatActivity', instant: 'CORE_CurrentViewers',
                          ticketbuy: 'CORE_TicketBuy', contest: 'CORE_ScreenshotContest' };
const CORE_DISABLED_HINT = 'Diese Mechanik ist vorübergehend abgeschaltet — das System ist noch nicht fertig.';
// Interner Weg zum admin-Service (Compose-Servicename) — nur für den
// Terms-Snapshot beim ersten Giveaway eines Teams (P1b), lesend/öffentliche Route.
const ADMIN_URL = process.env.ADMIN_URL || 'http://admin:3005';

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

// Deaktivierte Teams (teams.deactivated_at, Team-Verwaltung im admin-Service)
// öffnen nichts mehr — Nachweise bleiben, der Live-Betrieb ist beendet.
async function teamActive(teamId) {
  try {
    const r = await pg.query('SELECT deactivated_at FROM teams WHERE id=$1', [teamId]);
    return r.rowCount > 0 && !r.rows[0].deactivated_at;
  } catch(e) { logErr('GW', 'active check:', e.message); return false; }
}
const DEACTIVATED_HINT = 'Dieses Team ist deaktiviert — es lassen sich keine Giveaways mehr öffnen. '
                       + 'Der Owner kann es unter MEINE TEAMS reaktivieren.';

// Der Glueckspiel-Ausschluss der Nutzungsbedingungen bindet nur, wenn der
// Veranstalter ihm zugestimmt hat. Ohne Zustimmung laeuft hier kein Giveaway.
// Muss mit TOS_VERSION in services/admin/server.js uebereinstimmen.
const TOS_VERSION = 2;
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
// !los kannte nur die Kampagne — parallele Sekundär-Instanzen (Sofort/Los/
// Contest) bekommen je eine kurze Zusatzzeile aus ihrem Core (statusLine).
// Pausierte Instanzen bleiben stumm; Fehler hier dürfen !los nie brechen.
async function secondaryStatusLines(teamId, channel) {
  const lines = [];
  const ch = sanitizeChannel(channel || '');
  try {
    for (const g of await wte.listGiveaways(teamId)) {
      if (g.primary || g.paused || g.closed) continue;   // geschlossen = nichts anzusagen
      // Kanal-limitierte Instanz nur auf ihren eigenen Kanälen ansagen.
      if (Array.isArray(g.channels) && ch && !g.channels.includes(ch)) continue;
      // Stumm geschaltete Sofortverlosung taucht auch in !los nicht auf.
      if (g.announce === false) continue;
      const core = CoreRegistry.getCore(g.core);
      if (typeof core.statusLine !== 'function') continue;
      const ctx = { keyword: g.keyword };
      if (core.id === 'CORE_CurrentViewers') {
        ctx.secondsLeft = g.windowEndsAt ? g.windowEndsAt - Math.floor(Date.now() / 1000) : 0;
      } else if (core.id === 'CORE_TicketBuy') {
        ctx.cmd = await redis.get(K.gWagerCmd(teamId, g.gid)) || '';
        ctx.url = publicHost() + '/viewer/wager';
      } else if (core.id === 'CORE_ScreenshotContest') {
        ctx.voting = await redis.get(K.gVoteState(teamId, g.gid)) || 'closed';
        ctx.url = publicHost() + '/viewer/contest';
      }
      lines.push(core.statusLine(ctx));
    }
  } catch (e) { logErr('GW', 'secondaryStatusLines:', e.message); }
  return lines.join(' ');
}

// ── Chat-Ansagen über den Vorlagen-Resolver (18.8.26) ─────
// Jede Broadcast-Ansage läuft hier durch: Team-Vorlage (chat_templates)
// schlägt den eingebauten Standard; Links (Teilnahmebedingungen / Seite)
// hängen am Haken der Vorlage. Fail-open: Fehler beim Lesen der Vorlage
// dürfen die Ansage nie verhindern — dann kommt der Standardtext.
function viewerPageUrl(groupId) {
  if (groupId === 'CORE_TicketBuy') return publicHost() + '/viewer/wager';
  if (groupId === 'CORE_ScreenshotContest') return publicHost() + '/viewer/contest';
  return publicHost() + '/viewer/status';
}
async function chatText(teamId, groupId, key, ctx = {}) {
  let ov = null;
  try { ov = await wte.getChatTemplate(teamId, groupId, key); }
  catch (e) { logErr('GW', 'chatTemplate:', e.message); }
  const full = { host: chatHost(), teamId,
    termsUrl: publicHost() + '/viewer/terms?team=' + teamId,
    pageUrl: viewerPageUrl(groupId), ...ctx };
  return ChatTexts.resolveChatText(groupId, key, full, ov);
}

async function giveawayInfoText(teamId) {
  const sid = await wte.getSessionId(teamId);   // laufende Kampagne → deren Werte
  return CORE.infoText({
    keyword:    await redis.get(K.gwKeyword(teamId)) || '',
    followMin:  await wte.getFollowMin(teamId, sid),
    drawMinSec: await wte.getDrawMinSec(teamId, sid),
    host: chatHost(), teamId,
  });
}

// Jeder Statuswechsel wird im Chat angesagt. Die Ansagen sitzen in diesen
// Helfern und nicht in den gw_cmd-Faellen, damit der Auto-Pfad
// (stream_online/-offline) dieselbe Nachricht schickt und nichts vergessen wird.
// Chat-Zeile „Zu gewinnen: X — bereitgestellt von Y" für Ansagen.
function prizeLine(prize, sponsor) {
  if (!prize) return '';
  return ` 🎁 Zu gewinnen: ${prize}` + (sponsor ? ` — bereitgestellt von ${sponsor}` : '') + '.';
}

async function openGiveaway(teamId, keyword, prize = '', sponsor = '') {
  // START-GATE zuerst: wirft TermsSnapshotError, BEVOR Redis-/DB-Zustand
  // entsteht — es bleibt keine teilweise geöffnete Session zurück.
  const termsV = await snapshotTermsVersion(teamId);
  const sid = `sess_${Date.now()}`;
  await wte.openGiveaway(teamId, keyword, sid);
  await redis.del(K.gwAutoPaused(teamId));   // frischer Start ist nie auto-pausiert
  const chans = await wte.getChannels(teamId);
  // core_config-Snapshot beim Öffnen: übernimmt die (Legacy-)Team-Werte aus
  // Redis — inkl. cfgDrawMinSec — in die Giveaway-Instanz (§6 Alt-Key-Migration).
  // Gelesen wird zur Laufzeit weiterhin aus Redis; der Snapshot dokumentiert,
  // mit welcher Konfiguration dieses Giveaway gestartet ist.
  const coreConfig = await snapshotCoreConfig(teamId);
  await pg.query(`INSERT INTO sessions (id, team_id, keyword, channels, core, status, core_config, prize, sponsor, terms_version) VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [sid, teamId, keyword || '', JSON.stringify(chans), CORE.id, JSON.stringify(coreConfig), prize || null, sponsor || null, termsV]);
  broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
  await announceTeam(teamId, await chatText(teamId, CORE.id, 'open', {
    keyword: keyword || '', followMin: await wte.getFollowMin(teamId, sid),
    drawMinSec: await wte.getDrawMinSec(teamId, sid),
    gewinn: prize || '', sponsor: sponsor || '' }) + prizeLine(prize, sponsor));
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
// Startprüfung — klar getrennt in BLOCKER (Start bricht ab) und WARNUNGEN
// (Start läuft, Panel zeigt den Hinweis). Harte Gates davor bleiben:
// TOS, Impressum, Gewinn, eingefrorene Bedingungen-Fassung.
// Platzhalter-Erkennung in zwei Stufen, weil eckige Klammern in eigenen
// Bedingungen auch schlicht Auszeichnung sein können ("**Stand:** [19.07.2026]"):
//   BLOCKER  = Vorlagen-Syntax "{{ … }}" — die ist nie ein gewollter Wert.
//   WARNUNG  = "[ … ]" mit typischem Platzhalter-Wort ("[Haupt-Kanal]",
//              "[Datum]", "[Dein Name]", "[TBD]", "[…]"). Start läuft weiter,
//              das Panel nennt die Fundstellen.
// Markdown-Links "[Text](url)" sind in beiden Stufen ausgenommen.
const TERMS_MUSTACHE_RE = /\{\{\s*[^}\n]{1,60}?\s*\}\}/g;
const TERMS_BRACKET_RE  = /\[([^\]\n]{1,60})\](?!\()/g;
// Wortliste = was in Vorlagen üblicherweise auszufüllen ist. Bewusst eng:
// lieber eine Warnung zu wenig als ein Fehlalarm auf einem echten Wert.
const PLACEHOLDER_WORDS = /^(?:[.…x]{1,6}|tbd|todo|(?:haupt-?)?kanal(?:name)?|kanäle|datum|uhrzeit|zeitraum|beginn|ende|name|vorname|nachname|dein[a-zä]*\b.*|ihr[a-zä]*\b.*|hier\b.*|veranstalter|betreiber|streamer|sponsor|preis|gewinn|adresse|anschrift|ort|e-?mail|link|url|website|platzhalter)$/i;
function findTermsPlaceholders(terms) {
  const out = { blocking: [], suspect: [] };
  if (!terms) return out;
  for (const m of terms.matchAll(TERMS_MUSTACHE_RE)) {
    if (!out.blocking.includes(m[0])) out.blocking.push(m[0]);
  }
  for (const m of terms.matchAll(TERMS_BRACKET_RE)) {
    const inner = m[1].trim();
    if (!PLACEHOLDER_WORDS.test(inner)) continue;
    if (!out.suspect.includes(m[0])) out.suspect.push(m[0]);
  }
  return out;
}
async function startChecks(teamId) {
  const out = { blockers: [], warnings: [], placeholders: [] };
  try {
    const tr = await pg.query('SELECT terms FROM teams WHERE id=$1', [teamId]);
    const terms = tr.rowCount ? tr.rows[0].terms : null;
    const ph = findTermsPlaceholders(terms);
    if (ph.blocking.length) {
      out.blockers.push('terms_placeholders');
      out.placeholders = ph.blocking;
    } else if (ph.suspect.length) {
      out.warnings.push('Mögliche Platzhalter in den Teilnahmebedingungen: '
        + ph.suspect.slice(0, 5).join(', ')
        + (ph.suspect.length > 5 ? ' …' : ''));
      out.placeholders = ph.suspect;
    }
  } catch (e) { logErr('GW', 'startChecks:', e.message); }
  return out;
}
function placeholderBlockMsg(found) {
  const list = Array.isArray(found) && found.length
    ? ' (' + found.slice(0, 5).join(', ') + (found.length > 5 ? ' …' : '') + ')'
    : '';
  return 'Deine Teilnahmebedingungen enthalten noch unausgefüllte Vorlagen-Platzhalter'
    + list + '. Bitte in der Team-Verwaltung vervollständigen, dann starten.';
}

// Geltende Teilnahmebedingungen je Session festhalten (sessions.terms_version).
// HARTES START-GATE: liefert immer eine Fassung > 0 oder wirft
// TermsSnapshotError — ohne eingefrorene Fassung startet kein Giveaway
// (Logik + Tests in terms.js). Altbestand mit 0/NULL bleibt lesbar und
// wird im Archiv als "nicht eingefroren" gekennzeichnet, aber nie
// nachträglich umgeschrieben.
async function snapshotTermsVersion(teamId) {
  return TermsMod.snapshotTermsVersion(pg, teamId, { adminUrl: ADMIN_URL });
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
  for (const k of [...boostAnnounced.keys()]) if (k.startsWith(teamId + '|')) boostAnnounced.delete(k);
  broadcastTeam(teamId, { event: 'gw_status', status: 'closed' });
  await announceTeam(teamId, await chatText(teamId, CORE.id, 'closed'));
  log('GW', `[${teamId}] closed`);
}
async function pauseGiveaway(teamId, { auto = false } = {}) {
  await wte.setPaused(teamId, true);
  await setSessionStatus(teamId, 'paused');
  if (auto) await redis.set(K.gwAutoPaused(teamId), '1');
  else      await redis.del(K.gwAutoPaused(teamId));
  broadcastTeam(teamId, { event: 'gw_status', status: 'paused' });
  await announceTeam(teamId, await chatText(teamId, CORE.id, auto ? 'pauseAuto' : 'pause'));
}
async function resumeGiveaway(teamId, { auto = false } = {}) {
  await wte.setPaused(teamId, false);
  await setSessionStatus(teamId, 'open');
  await redis.del(K.gwAutoPaused(teamId));
  broadcastTeam(teamId, { event: 'gw_status', status: 'open' });
  await announceTeam(teamId, await chatText(teamId, CORE.id, auto ? 'resumeAuto' : 'resume'));
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
    if (!await teamActive(teamId)) {
      log('Auto', `[${teamId}] stream online (${ch}) -> NICHT geoeffnet: Team deaktiviert`);
      await audit({ teamId, actor: 'system', action: 'auto_open', target: ch,
                    result: 'denied', detail: { reason: 'team_deactivated' } });
      return;
    }
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
    const aChecks = await startChecks(teamId);
    if (aChecks.blockers.length) {
      log('Auto', `[${teamId}] stream online (${ch}) -> NICHT geoeffnet: Platzhalter in den Bedingungen`);
      await audit({ teamId, actor: 'system', action: 'auto_open', target: ch,
                    result: 'denied', detail: { reason: aChecks.blockers[0], placeholders: aChecks.placeholders } });
      return;
    }
    // Warnungen blockieren den Auto-Start nicht, landen aber im Log.
    if (aChecks.warnings.length) log('Auto', `[${teamId}] ${aChecks.warnings.join(' | ')}`);
    const kw = await redis.get(K.gwKeyword(teamId)) || '';
    let newSid;
    try {
      newSid = await openGiveaway(teamId, kw);
    } catch (e) {
      if (e && e.code === 'terms_snapshot_failed') {
        log('Auto', `[${teamId}] stream online (${ch}) -> NICHT geoeffnet: ${e.message}`);
        await audit({ teamId, actor: 'system', action: 'auto_open', target: ch,
                      result: 'denied', detail: { reason: 'no_terms_snapshot', error: e.reason } });
        return;
      }
      throw e;
    }
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
// Hinter Caddy: ein Proxy-Hop — req.ip (Audit-Einträge!) ist die echte
// Client-IP statt der Caddy-Container-IP.
app.set('trust proxy', 1);
const server = http.createServer(app);
// Admin-/Overlay-WS-Nachrichten sind klein (JSON-Cmds) — 256 KiB Deckel
// gegen Speicher-DoS; Bilder laufen ohnehin über REST.
const wss    = new WebSocket.Server({ server, maxPayload: 256 * 1024 });
const clients = new Map(); // clientId → { ws, authUser, teamId, role, ip, connectedAt, msgCount }
// Drossel je Verbindung: Panel pollt ~7 Cmds/10s — 300/10s ist reichlich.
const WS_MSG_WINDOW_MS = 10000;
const WS_MSG_MAX = 300;

// Panel-Nachrichten gehen ueber Redis statt direkt an die lokale Client-Map:
// bei einem Container ist das derselbe Weg mit einem Hop mehr, bei mehreren
// erreicht ein Ereignis auch die Browser, die an einer anderen Instanz haengen
// (docs/SKALIERUNG.md). Absichtlich fire-and-forget — das Panel frischt ohnehin
// zyklisch nach, ein verlorener Hinweis ist kein Datenverlust.
const PANEL_CH = 'ch:panel';
function broadcastTeam(teamId, obj) {
  if (!teamId) return;
  redisPub.publish(PANEL_CH, JSON.stringify({ team: teamId, payload: obj }))
    .catch(e => logErr('Panel', 'publish:', e.message));
}

// Zustellung an die Browser DIESER Instanz.
function deliverToPanels(teamId, str) {
  for (const [, c] of clients) if (c.teamId === teamId && c.ws.readyState === WebSocket.OPEN) c.ws.send(str);
}

function subscribeToPanel() {
  redisSub.subscribe(PANEL_CH, (err) => {
    if (err) return logErr('Sub', PANEL_CH + ':', err.message);
    log('Sub', 'Subscribed ' + PANEL_CH);
  });
  redisSub.on('message', (channel, payload) => {
    if (channel !== PANEL_CH) return;
    let msg; try { msg = JSON.parse(payload); } catch { return; }
    if (!msg || !msg.team) return;
    deliverToPanels(msg.team, JSON.stringify(msg.payload));
  });
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
// Schluessel `${teamId}|${gid||''}` — ein Boost gehoert seit Phase 2d zu einem
// konkreten Giveaway. Wer hier nur je Team prueft, prueft den Primary und
// erklaert Instanz-Boosts faelschlich fuer abgelaufen (Bug 18.8.26: Panel
// zeigte Ende + Neustart im Wechsel, Chat sagte das Ende sofort an).
const boostAnnounced = new Map();
async function watchBoostExpiry() {
  for (const [key, b] of [...boostAnnounced]) {
    try {
      const st = await wte.multiplierState(b.teamId, b.gid);   // gid null = Team-/Legacy-Key
      if (st.factor > 1) { boostAnnounced.set(key, { ...b, factor: st.factor }); continue; }
      boostAnnounced.delete(key);
      await announceTeam(b.teamId, await chatText(b.teamId, '_common', 'boostEnd', { faktor: b.factor }));
      broadcastTeam(b.teamId, { event: 'gw_multiplier', factor: 1, secondsLeft: 0, giveawayId: b.gid || null });
    } catch(e) { logErr('Boost', e.message); boostAnnounced.delete(key); }
  }
}

wss.on('connection', (ws, req) => {
  const clientId = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const authUser = sanitizeUsername(req.headers['x-auth-user'] || '');
  const meta = { ws, authUser, teamId: null, role: null, ip: req.socket.remoteAddress, connectedAt: Date.now(), msgCount: 0 };
  clients.set(clientId, meta);
  log('WS', `Connected: ${clientId} user=${authUser || '?'} (${clients.size} total)`);

  ws.on('message', async (data) => {
    const now = Date.now();
    if (!meta.msgWindow || now - meta.msgWindow > WS_MSG_WINDOW_MS) { meta.msgWindow = now; meta.msgN = 0; }
    if (++meta.msgN > WS_MSG_MAX) {
      log('WS', `Rate limit ${clientId} (${meta.authUser || '?'}) — closing`);
      try { ws.close(); } catch(e) { /* egal */ }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    meta.msgCount++;
    if (msg.event === 'cc_identify') { meta.role = sanitizeStr(msg.role || '', 50); return; }
    await handleClientMessage(meta, msg);
  });
  ws.on('close', () => { clients.delete(clientId); log('WS', `Disconnected: ${clientId}`); });
});

// gid optional (Phase 2d): Panel kann den Stand einer Sekundär-Instanz
// abfragen; ohne gid gilt wie bisher das Primary.
async function sendTeamData(meta, gid = null) {
  const send = (o) => meta.ws.readyState === WebSocket.OPEN && meta.ws.send(JSON.stringify(o));
  const teamId = meta.teamId;
  // Teilnehmerliste je Mechanik (Roadmap „Spalten je Mechanik"): Instanz-Cores
  // liefern ihre eigenen Felder + Spaltendeklaration (CORE.display.columns);
  // Kampagne/Watchtime bleibt beim bisherigen Layout (display=null).
  const coreId = gid ? await wte.getCoreId(teamId, gid) : null;
  let participants, display = null;
  if (coreId === 'CORE_CurrentViewers')          participants = await wte.getInstantParticipants(teamId, gid);
  else if (coreId === 'CORE_TicketBuy')          participants = await wte.getTicketBuyParticipants(teamId, gid);
  else if (coreId === 'CORE_ScreenshotContest')  participants = await wte.getContestParticipants(teamId, gid);
  else                                           participants = await wte.getAllParticipants(teamId, gid || undefined);
  if (coreId && coreId !== CORE.id) {
    try { display = (CoreRegistry.getCore(coreId).display || {}).columns || null; } catch { /* Standard-Spalten */ }
  }
  // P5: kompletter Anzeige-Vertrag des Cores (unit, drawKind, emptyPool, …) —
  // `display` bleibt aus Kompatibilität die reine Spaltenliste.
  let coreMeta = null;
  try { coreMeta = CoreRegistry.getCore(coreId || CORE.id).display || null; } catch { /* Standard */ }
  const open = await wte.isOpen(teamId, gid || undefined);
  const paused = await wte.isPaused(teamId, gid || undefined);
  const session = gid || await wte.getSessionId(teamId);
  const channels = await wte.getChannels(teamId);
  // Kampagnen-Liste: nur wer in DIESEM Giveaway etwas getan hat. Ohne den
  // Filter stand jeder je gesehene Zuschauer des Teams mit Nullwerten in der
  // Tabelle — auch bei geschlossener Kampagne (9.8.26, „Roster fuellt sich").
  if (!gid) {
    // Kampagnen-Ansicht ohne laufende Kampagne: die Liste bleibt leer. Vorher
    // stand hier jeder je gesehene Zuschauer des Teams mit Nullwerten (9.8.26).
    if (!(await wte.getSessionId(teamId))) participants = [];
    else participants = participants.filter(p => p.registered || p.banned
      || (parseFloat(p.totalCoins) || 0) > 0 || (parseInt(p.totalWatchSec, 10) || 0) > 0
      || (parseInt(p.msgs, 10) || 0) > 0);
  }
  // Ingest-Puls je Kanal: kommen ueberhaupt viewer_tick an? Ohne Ticks kann
  // die Sofortverlosung niemanden ziehen — das Panel warnt sichtbar.
  let ingestPulse = [];
  try { ingestPulse = await wte.getIngestPulse(teamId, channels); }
  catch (e) { logErr('GW', 'ingestPulse:', e.message); }
  send({ event: 'gw_data', teamId, giveawayId: gid, core: coreId, display, coreMeta, open, paused,
         session, participants, channels, ingestPulse });
}

async function handleClientMessage(meta, msg) {
  const send = (obj) => meta.ws.readyState === WebSocket.OPEN && meta.ws.send(JSON.stringify(obj));

  switch (msg.event) {
    // Client wählt ein Team → nur Mitglieder dürfen dessen Daten sehen.
    case 'gw_get_all': {
      const teamId = sanitizeTeamId(msg.teamId);
      if (!await isMember(meta.authUser, teamId)) { send({ event: 'gw_ack', type: 'forbidden' }); return; }
      meta.teamId = teamId;
      await sendTeamData(meta, validGid(msg.giveawayId));
      break;
    }
    case 'gw_cmd':
      await handleAdminCmd(send, msg, meta);
      break;
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
  'gw_list_giveaways', 'gw_list_prizes', 'gw_list_entries', 'gw_preflight',
  // Sofortverlosung darf jeder streamende Member fahren: Fenster öffnen,
  // ziehen (Entscheidung: Ziehung macht der jeweilige Kanalstreamer) und
  // die Chat-Ansagen der Instanz stumm/laut schalten.
  'gw_instant_window', 'gw_draw_winner', 'gw_set_announce', 'gw_announce_page',
  // Losanpassung (Betreiber 18.8.26): darf jedes Team-Mitglied — ohne offene
  // Preise ist sie gefahrlos wiederholbar und voll auditiert.
  'gw_reset_credit',
  // Vorlagen LESEN darf jedes Mitglied; SETZEN bleibt Owner (Konfig).
  'gw_get_chat_templates',
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
    case 'gw_open': {
      if (!await teamActive(teamId)) {
        Object.assign(outcome, { blocked: 'team_deactivated' });
        send({ event: 'gw_ack', type: 'open_blocked', error: DEACTIVATED_HINT });
        break;
      }
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
      // Der Gewinn ist Pflichtangabe — Teilnehmer müssen wissen, worum es geht.
      const oPrize   = sanitizeStr(msg.prize || '', 100).trim();
      const oSponsor = sanitizeStr(msg.sponsor || '', 100).trim();
      if (!oPrize) {
        Object.assign(outcome, { blocked: 'no_prize' });
        send({ event: 'gw_ack', type: 'open_blocked',
               error: 'Bitte zuerst eintragen, was verlost wird (Feld „Gewinn" — ggf. mit Sponsor).' });
        break;
      }
      const oChecks = await startChecks(teamId);
      if (oChecks.blockers.length) {
        Object.assign(outcome, { blocked: oChecks.blockers[0] });
        send({ event: 'gw_ack', type: 'open_blocked', error: placeholderBlockMsg(oChecks.placeholders) });
        break;
      }
      if (oChecks.warnings.length) send({ event: 'gw_ack', type: 'open_warnings', warnings: oChecks.warnings });
      Object.assign(outcome, { prize: oPrize, sponsor: oSponsor || undefined });
      try {
        outcome.sessionOpened = await openGiveaway(teamId, sanitizeStr(msg.keyword || '', 100), oPrize, oSponsor);
      } catch (e) {
        if (e && e.code === 'terms_snapshot_failed') {
          Object.assign(outcome, { blocked: 'no_terms_snapshot', error: e.reason });
          send({ event: 'gw_ack', type: 'open_blocked',
                 error: 'Start abgebrochen: ' + e.message + ' Bitte später erneut versuchen.' });
          break;
        }
        throw e;
      }
      send({ event: 'gw_status', status: 'open' });
      break;
    }
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
      // P5: Anzeige-Metadaten je Instanz aus dem Core-Vertrag — das Panel
      // braucht damit keine eigenen CORE_LABEL/ICON/CSS-Tabellen mehr.
      const gwList = (await wte.listGiveaways(teamId, { stats: true })).map(g => {
        let d = {};
        try { const c = CoreRegistry.getCore(g.core); d = c.display || {}; g.coreLabel = c.label; } catch { /* Fallback unten */ }
        return { ...g, coreLabel: g.coreLabel || g.core || 'Kampagne',
                 coreIcon: d.icon || '🎁', coreCss: d.css || 'core-watchtime',
                 coreUnit: d.unit !== undefined ? d.unit : 'Punkte', drawKind: d.drawKind || 'weighted',
                 corePanelCard: d.panelCard !== undefined ? d.panelCard : null,
                 coreBeta: !!d.beta };
      });
      send({ event: 'gw_ack', type: 'giveaways', giveaways: gwList,
             maxParallel: MAX_PARALLEL_GIVEAWAYS });
      break;
    }
    // ── Entwürfe: Giveaway VOR dem Stream vorbereiten, später starten.
    // Team-weit (PG), Owner-only (nicht in MEMBER_CMDS). Der Start läuft
    // über gw_open_instance mit draftId — der Entwurf wird dabei verbraucht.
    case 'gw_save_draft': {
      const cfg = (msg.config && typeof msg.config === 'object') ? msg.config : {};
      const dType = ['campaign', 'instant', 'ticketbuy', 'contest'].includes(cfg.type) ? cfg.type : null;
      if (dType && DISABLED_CORES.has(DRAFT_TYPE_CORE[dType])) {
        Object.assign(outcome, { error: 'core_disabled', core: DRAFT_TYPE_CORE[dType] });
        send({ event: 'gw_ack', type: 'error', error: CORE_DISABLED_HINT });
        break;
      }
      if (!dType) {
        Object.assign(outcome, { error: 'bad_type' });
        send({ event: 'gw_ack', type: 'error', error: 'Unbekannter Giveaway-Typ.' });
        break;
      }
      const clean = {
        type: dType,
        prize: sanitizeStr(cfg.prize || '', 100).trim(),
        sponsor: sanitizeStr(cfg.sponsor || '', 100).trim(),
        name: sanitizeStr(cfg.name || '', 40).trim(),
        keyword: sanitizeStr(cfg.keyword || '', 100).trim(),
        windowSec: Math.max(0, parseInt(cfg.windowSec, 10) || 0),
        announce: cfg.announce !== false,
        wagerCmd: sanitizeStr(cfg.wagerCmd || '', 30).trim().toLowerCase(),
        minWatchSec: Math.max(0, parseInt(cfg.minWatchSec, 10) || 0),
        channels: Array.isArray(cfg.channels) ? cfg.channels.map(sanitizeChannel).filter(Boolean).slice(0, 20) : [],
        // P6: Los-Giveaway-Preise schon im Entwurf — werden beim Start angelegt.
        prizes: dType === 'ticketbuy' && Array.isArray(cfg.prizes)
          ? cfg.prizes.slice(0, 20).map(p => ({
              title: sanitizeStr((p && p.title) || '', 100).trim(),
              sponsor: sanitizeStr((p && p.sponsor) || '', 100).trim(),
              description: sanitizeStr((p && p.description) || '', 500).trim(),
              wagerEndMinutes: Math.max(0, parseInt(p && p.wagerEndMinutes, 10) || 0),
            })).filter(p => p.title)
          : [],
      };
      const updId = parseInt(msg.draftId, 10);
      let draftId = null;
      if (Number.isFinite(updId) && updId > 0) {
        const u = await pg.query(`UPDATE giveaway_drafts SET config=$1 WHERE id=$2 AND team_id=$3 RETURNING id`,
          [JSON.stringify(clean), updId, teamId]);
        if (u.rowCount) draftId = u.rows[0].id;
      }
      if (!draftId) {
        const ins = await pg.query(`INSERT INTO giveaway_drafts (team_id, config, created_by) VALUES ($1,$2,$3) RETURNING id`,
          [teamId, JSON.stringify(clean), meta.authUser]);
        draftId = ins.rows[0].id;
      }
      Object.assign(outcome, { draftId, draftType: dType, name: clean.name || undefined });
      send({ event: 'gw_ack', type: 'draft_saved', draftId });
      break;
    }
    // P6: Teilnehmer-Vorschau vor dem Start — wie viele Zuschauer würden die
    // Bedingungen der gewählten Mechanik JETZT erfüllen. Read-only.
    case 'gw_preflight': {
      const pfCore = CoreRegistry.CORES[msg.core] ? msg.core : CoreRegistry.DEFAULT_CORE_ID;
      const pfTeamChans = await wte.getChannels(teamId);
      const pfWanted = Array.isArray(msg.channels) ? msg.channels.map(sanitizeChannel).filter(Boolean) : [];
      const pfChans = pfWanted.filter(ch => pfTeamChans.includes(ch));
      const pf = await wte.previewEligible(teamId, {
        core: pfCore, channels: pfChans.length ? pfChans : null,
        minWatchSec: Math.max(0, parseInt(msg.minWatchSec, 10) || 0) });
      send({ event: 'gw_ack', type: 'preflight', core: pfCore, ...pf });
      break;
    }
    case 'gw_list_drafts': {
      const r = await pg.query(
        `SELECT id, config, created_by, created_at FROM giveaway_drafts WHERE team_id=$1 ORDER BY id DESC LIMIT 50`, [teamId]);
      send({ event: 'gw_ack', type: 'drafts', drafts: r.rows });
      break;
    }
    case 'gw_delete_draft': {
      const delId = parseInt(msg.draftId, 10);
      const r = Number.isFinite(delId)
        ? await pg.query(`DELETE FROM giveaway_drafts WHERE id=$1 AND team_id=$2 RETURNING id`, [delId, teamId])
        : { rowCount: 0 };
      if (!r.rowCount) {
        Object.assign(outcome, { error: 'not_found', draftId: msg.draftId });
        send({ event: 'gw_ack', type: 'error', error: 'Diesen Entwurf gibt es nicht.' });
        break;
      }
      Object.assign(outcome, { draftId: delId });
      send({ event: 'gw_ack', type: 'draft_deleted', draftId: delId });
      break;
    }
    case 'gw_open_instance': {
      // Dieselben Rechts-Gates wie gw_open — jede Instanz ist ein Gewinnspiel.
      if (!await teamActive(teamId)) {
        Object.assign(outcome, { blocked: 'team_deactivated' });
        send({ event: 'gw_ack', type: 'open_blocked', error: DEACTIVATED_HINT });
        break;
      }
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
      const iChecks = await startChecks(teamId);
      if (iChecks.blockers.length) {
        Object.assign(outcome, { blocked: iChecks.blockers[0] });
        send({ event: 'gw_ack', type: 'open_blocked', error: placeholderBlockMsg(iChecks.placeholders) });
        break;
      }
      if (iChecks.warnings.length) send({ event: 'gw_ack', type: 'open_warnings', warnings: iChecks.warnings });
      // Geschlossene, noch nicht aufgeraeumte Instanzen belegen keinen Platz.
      const running = (await wte.listGiveaways(teamId)).filter(g => !g.closed);
      if (running.length >= MAX_PARALLEL_GIVEAWAYS) {
        Object.assign(outcome, { blocked: 'limit', running: running.length });
        send({ event: 'gw_ack', type: 'open_blocked',
               error: `Maximal ${MAX_PARALLEL_GIVEAWAYS} gleichzeitige Giveaways je Team.` });
        break;
      }
      const keyword = sanitizeStr(msg.keyword || '', 100);
      // Phase 3: Instanz kann einen anderen Core fahren (Registry-validiert).
      const coreId = CoreRegistry.CORES[msg.core] ? msg.core : CoreRegistry.DEFAULT_CORE_ID;
      if (DISABLED_CORES.has(coreId)) {
        Object.assign(outcome, { blocked: 'core_disabled', core: coreId });
        send({ event: 'gw_ack', type: 'open_blocked', error: CORE_DISABLED_HINT });
        break;
      }
      const coreMod = CoreRegistry.getCore(coreId);
      // Gewinn ist Pflicht — ausser beim Los-Giveaway (dort sind die einzeln
      // angelegten Preise die Gewinne, je Preis mit eigenem Sponsor).
      const iPrize   = sanitizeStr(msg.prize || '', 100).trim();
      const iSponsor = sanitizeStr(msg.sponsor || '', 100).trim();
      if (!iPrize && coreId !== 'CORE_TicketBuy') {
        Object.assign(outcome, { blocked: 'no_prize', core: coreId });
        send({ event: 'gw_ack', type: 'open_blocked',
               error: 'Bitte eintragen, was verlost wird (Gewinn — ggf. mit Sponsor).' });
        break;
      }
      let windowSec = 0;
      if (coreId === 'CORE_CurrentViewers') {   // Sofortverlosung
        if (!keyword) {
          Object.assign(outcome, { blocked: 'no_keyword', core: coreId });
          send({ event: 'gw_ack', type: 'open_blocked',
                 error: 'Eine Sofortverlosung braucht ein Keyword — ohne Opt-in kein Teilnehmer.' });
          break;
        }
        // 0 = Anmeldefenster später öffnen (gw_instant_window). Das Fenster
        // ist nur die Anmeldephase — gezogen wird manuell (★).
        const wc = coreMod.config.windowSec;
        const wReq = parseInt(msg.windowSec, 10);
        windowSec = (Number.isFinite(wReq) && wReq > 0) ? Math.max(wc.min, Math.min(wc.max, wReq)) : 0;
      }
      // TicketBuy: Setz-Befehl kommt aus der WebUI (Default aus der Core-Config).
      let wagerCmd = '';
      if (coreId === 'CORE_TicketBuy') {
        // Teilnahme ist Opt-in: ohne Keyword sammelt jeder Guthaben, aber
        // niemand kann setzen — darum Pflicht wie bei der Sofortverlosung.
        if (!keyword) {
          Object.assign(outcome, { blocked: 'no_keyword', core: coreId });
          send({ event: 'gw_ack', type: 'open_blocked',
                 error: 'Ein Los-Giveaway braucht ein Teilnahme-Keyword — nur wer es schreibt, nimmt teil (Guthaben sammeln alle).' });
          break;
        }
        wagerCmd = sanitizeStr(msg.wagerCmd || '', 30).trim().toLowerCase() || coreMod.config.wagerCmd.def;
        // Der Befehl routet den Chat-Einsatz — muss je Team eindeutig sein.
        if (await wte.wagerCmdTaken(teamId, wagerCmd)) {
          Object.assign(outcome, { blocked: 'wager_cmd_taken', wagerCmd });
          send({ event: 'gw_ack', type: 'open_blocked',
                 error: `„${wagerCmd}" wird schon von einem laufenden Los-Giveaway benutzt — bitte einen anderen Setz-Befehl wählen.` });
          break;
        }
      }
      // Mindest-Viewtime: Contest (Einsenden/Voten) und Sofortverlosung
      // (Teilnahmeschwelle, Default 10 Minuten) — beide WebUI-konfigurierbar.
      let minWatchSec = null;
      if (coreId === 'CORE_ScreenshotContest' || coreId === 'CORE_CurrentViewers') {
        const mc = coreMod.config.minWatchSec;
        minWatchSec = Math.max(mc.min, Math.min(mc.max,
          Number.isFinite(parseInt(msg.minWatchSec, 10)) ? parseInt(msg.minWatchSec, 10) : mc.def));
      }
      // Zuschauer-Seiten (Setzen/Contest) finden ihre Instanz über das Team —
      // zwei parallele Contests waeren auf der Zuschauer-Seite nicht
      // unterscheidbar. Los-Giveaways duerfen parallel laufen: ein Giveaway
      // = ein Preis, mehrere Preise = mehrere Los-Giveaways.
      if (coreId === 'CORE_ScreenshotContest') {
        const dup = (await wte.listGiveaways(teamId)).find(g => !g.primary && !g.closed && g.core === coreId);
        if (dup) {
          Object.assign(outcome, { blocked: 'duplicate_core', existing: dup.gid });
          send({ event: 'gw_ack', type: 'open_blocked',
                 error: 'Es läuft bereits ein Screenshot-Contest in diesem Team — erst schließen, dann neu starten.' });
          break;
        }
      }
      const teamChans = await wte.getChannels(teamId);
      const wanted = Array.isArray(msg.channels) ? msg.channels.map(sanitizeChannel).filter(Boolean) : [];
      const channels = wanted.filter(ch => teamChans.includes(ch));   // nur eigene Kanäle
      const gid = `sess_${Date.now()}`;
      const coreConfig = coreId === 'CORE_CurrentViewers' ? { windowSec, minWatchSec }
                       : coreId === 'CORE_ScreenshotContest' ? { minWatchSec }
                       : coreId === 'CORE_TicketBuy' ? { ...(await snapshotCoreConfig(teamId)), wagerCmd }
                       : await snapshotCoreConfig(teamId);
      // START-GATE: ohne eingefrorene Bedingungen-Fassung keine Instanz —
      // vor INSERT und vor openGiveawayInstance, damit nichts zurückbleibt.
      let termsV;
      try {
        termsV = await snapshotTermsVersion(teamId);
      } catch (e) {
        if (e && e.code === 'terms_snapshot_failed') {
          Object.assign(outcome, { blocked: 'no_terms_snapshot', error: e.reason });
          send({ event: 'gw_ack', type: 'open_blocked',
                 error: 'Start abgebrochen: ' + e.message + ' Bitte später erneut versuchen.' });
          break;
        }
        throw e;
      }
      await pg.query(`INSERT INTO sessions (id, team_id, keyword, channels, core, status, core_config, prize, sponsor, terms_version)
                      VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [gid, teamId, keyword, JSON.stringify(channels.length ? channels : teamChans), coreId,
         JSON.stringify(coreConfig), iPrize || null, iSponsor || null, termsV]);
      // Sofortverlosung: Chat-Ansagen abschaltbar (Fenster/Vorbereitung/!los).
      // Die Gewinner-Ansage bleibt IMMER — der Gewinner muss es erfahren.
      const announceOn = coreId !== 'CORE_CurrentViewers' || msg.announce !== false;
      await wte.openGiveawayInstance(teamId, gid, { keyword, channels: channels.length ? channels : null,
                                                    core: coreId, windowSec, wagerCmd, minWatchSec,
                                                    announce: announceOn,
                                                    name: sanitizeStr(msg.name || '', 40).trim() });
      Object.assign(outcome, { giveawayId: gid, keyword, core: coreId, windowSec: windowSec || undefined,
                               wagerCmd: wagerCmd || undefined, prize: iPrize || undefined,
                               sponsor: iSponsor || undefined, channels: channels.length ? channels : 'alle',
                               announce: announceOn });
      if (announceOn) {
        let openTxt;
        if (coreId === 'CORE_CurrentViewers') {
          openTxt = windowSec > 0
            ? await chatText(teamId, coreId, 'windowOpen', { keyword, windowSec,
                minuten: Math.round(windowSec / 60),
                minWatchSec: minWatchSec !== null ? minWatchSec : undefined })
            : await chatText(teamId, coreId, 'prep', { keyword });
        } else if (coreId === 'CORE_ScreenshotContest') {
          openTxt = await chatText(teamId, coreId, 'open', { gewinn: iPrize || '', sponsor: iSponsor || '' });
        } else if (coreId === 'CORE_TicketBuy') {
          openTxt = await chatText(teamId, coreId, 'open', { befehl: wagerCmd, keyword, gewinn: iPrize || '', sponsor: iSponsor || '' });
        } else {
          openTxt = '🎁 Zusätzliches Giveaway gestartet!' + (keyword ? ` Mitmachen: schreib "${keyword}" im Chat.` : '');
        }
        await announceChannels(teamId, channels.length ? channels : null, openTxt + prizeLine(iPrize, iSponsor));
      }
      // P6: vorbereitete Preise direkt beim Start anlegen (Los-Giveaway) —
      // aus dem Modal oder aus einem Entwurf (draftStart sendet dessen config).
      // Ein Giveaway = ein Preis: aus Modal/Entwurf wird genau der erste
      // gueltige Preis angelegt, weitere brauchen eigene Instanzen.
      if (coreId === 'CORE_TicketBuy' && Array.isArray(msg.prizes) && msg.prizes.length) {
        const created = [];
        try {
          for (const p of msg.prizes.slice(0, 1)) {
            const pTitle = sanitizeStr((p && p.title) || '', 100).trim();
            if (!pTitle) continue;
            const endMin = Math.max(0, parseInt(p && p.wagerEndMinutes, 10) || 0);
            const newPrizeId = await wte.addPrize(teamId, gid, {
              title: pTitle,
              description: sanitizeStr((p && p.description) || '', 500),
              wagerEndTs: endMin ? Math.floor(Date.now() / 1000) + endMin * 60 : null });
            const pSpons = sanitizeStr((p && p.sponsor) || '', 100).trim();
            if (pSpons) await pg.query(`UPDATE giveaway_prizes SET sponsor=$1 WHERE id=$2`, [pSpons, newPrizeId]);
            created.push(newPrizeId);
          }
        } catch (e) { logErr('GW', 'draft prizes:', e.message); }
        if (created.length) Object.assign(outcome, { startPrizes: created });
      }
      // Start aus einem Entwurf: der Entwurf ist damit verbraucht.
      const usedDraft = parseInt(msg.draftId, 10);
      if (Number.isFinite(usedDraft) && usedDraft > 0) {
        try {
          await pg.query(`DELETE FROM giveaway_drafts WHERE id=$1 AND team_id=$2`, [usedDraft, teamId]);
          Object.assign(outcome, { draftId: usedDraft });
        } catch (e) { logErr('GW', 'draft cleanup:', e.message); }
      }
      send({ event: 'gw_ack', type: 'instance_opened', giveawayId: gid, keyword, core: coreId,
             windowSec: windowSec || null, wagerCmd: wagerCmd || null,
             channels: channels.length ? channels : null });
      break;
    }
    // SCHLIESSEN und AUFRAEUMEN sind zwei Schritte. Reihenfolge fuer ALLE
    // Mechaniken (Betreiber 9.8.26): erst schliessen (Sammeln/Anmelden
    // vorbei, Topf bleibt), dann ziehen, dann aufraeumen. Zweiter Aufruf auf
    // eine bereits geschlossene Instanz raeumt sie ab.
    case 'gw_close_instance': {
      const gid = validGid(msg.giveawayId);
      const known = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && !g.primary) : null;
      if (!known) {
        Object.assign(outcome, { error: 'unknown_instance', giveawayId: msg.giveawayId || null });
        send({ event: 'gw_ack', type: 'error', error: 'Unbekannte Giveaway-Instanz.' });
        break;
      }
      // Schritt 2: aufraeumen. Beim Los-Giveaway erst, wenn kein Preis mehr
      // offen ist — sonst waeren die Einsaetze ohne Ziehung verloren.
      if (known.closed) {
        if (known.core === 'CORE_TicketBuy') {
          const openPrizes = await wte.openPrizeCount(teamId, gid);
          if (openPrizes > 0) {
            Object.assign(outcome, { blocked: 'open_prizes', openPrizes });
            send({ event: 'gw_ack', type: 'error',
                   error: `Noch ${openPrizes} ungezogene${openPrizes === 1 ? 'r Preis' : ' Preise'} — erst ziehen (★) oder stornieren (✖), dann aufräumen.` });
            break;
          }
        }
        await wte.cleanupGiveawayInstance(teamId, gid);
        Object.assign(outcome, { giveawayId: gid, cleaned: true });
        send({ event: 'gw_ack', type: 'instance_cleaned', giveawayId: gid });
        break;
      }
      // Schritt 1: schliessen. Der Topf bleibt stehen, gezogen wird danach.
      await wte.closeGiveawayInstance(teamId, gid);
      await setSessionStatusById(gid, 'closed');
      Object.assign(outcome, { giveawayId: gid });
      if (known.core === 'CORE_TicketBuy') {
        // Erspielten Stand als Guthaben gutschreiben (§10.1). Aufgeraeumt
        // wird erst nach der Ziehung je Preis.
        const settled = await wte.settleTicketBuyInstance(teamId, gid);
        Object.assign(outcome, { settledUsers: settled.users, settledCredit: settled.total });
        await announceChannels(teamId, known.channels,
          await chatText(teamId, known.core, 'closed', { konten: settled.users }));
      } else if (known.core === 'CORE_CurrentViewers') {
        if (known.announce !== false) await announceChannels(teamId, known.channels,
          await chatText(teamId, known.core, 'closed'));
      } else if (known.core === 'CORE_ScreenshotContest') {
        await announceChannels(teamId, known.channels,
          await chatText(teamId, known.core, 'closed'));
      } else {
        await announceChannels(teamId, known.channels,
          '🔒 Das zusätzliche Giveaway ist geschlossen — Ziehung folgt.');
      }
      send({ event: 'gw_ack', type: 'instance_closed', giveawayId: gid });
      break;
    }

    // Geschlossen, aber noch nicht aufgeraeumt → wieder oeffnen (Betreiber
    // 18.8.26): ein versehentliches SCHLIESSEN darf das Giveaway nicht
    // endgueltig beenden. AUFRAEUMEN bleibt der einzige endgueltige Schritt;
    // Ziehung und Ersatzziehung (reroll) bleiben davon unberuehrt.
    case 'gw_reopen_instance': {
      if (!await teamActive(teamId)) {
        Object.assign(outcome, { blocked: 'team_deactivated' });
        send({ event: 'gw_ack', type: 'open_blocked', error: DEACTIVATED_HINT });
        break;
      }
      const gid = validGid(msg.giveawayId);
      const known = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && !g.primary) : null;
      if (!known || !known.closed) {
        Object.assign(outcome, { error: !known ? 'unknown_instance' : 'not_closed', giveawayId: msg.giveawayId || null });
        send({ event: 'gw_ack', type: 'error',
               error: !known ? 'Unbekannte Giveaway-Instanz.' : 'Dieses Giveaway ist nicht geschlossen.' });
        break;
      }
      await wte.reopenGiveawayInstance(teamId, gid);
      await setSessionStatusById(gid, 'open');
      Object.assign(outcome, { giveawayId: gid, reopened: true });
      if (known.core === 'CORE_TicketBuy') {
        await announceChannels(teamId, known.channels,
          await chatText(teamId, known.core, 'reopened'));
      } else if (known.core === 'CORE_CurrentViewers') {
        if (known.announce !== false) await announceChannels(teamId, known.channels,
          await chatText(teamId, known.core, 'reopened'));
      } else {
        await announceChannels(teamId, known.channels,
          '🔓 Das zusätzliche Giveaway ist wieder offen.');
      }
      send({ event: 'gw_ack', type: 'instance_reopened', giveawayId: gid });
      break;
    }

    // Storno = Alternative zur Ziehung (Betreiber 18.8.26): erst SCHLIESSEN
    // (bucht das Guthaben), dann statt ★ ziehen ✖ stornieren — alle Einsätze
    // zurück, kein Gewinner, aufräumen. Wer weiter verlosen will, startet
    // schlicht ein neues Los-Giveaway.
    case 'gw_cancel_instance': {
      const gid = validGid(msg.giveawayId);
      const known = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && !g.primary && g.core === 'CORE_TicketBuy') : null;
      if (!known) {
        Object.assign(outcome, { error: 'no_ticketbuy_instance', giveawayId: msg.giveawayId || null });
        send({ event: 'gw_ack', type: 'error', error: 'Stornieren geht nur bei einem Los-Giveaway.' });
        break;
      }
      if (!known.closed) {
        Object.assign(outcome, { error: 'not_closed', giveawayId: gid });
        send({ event: 'gw_ack', type: 'error',
               error: 'Erst SCHLIESSEN — Storno ersetzt danach die Ziehung.' });
        break;
      }
      const openPrizes = await wte.listPrizes(teamId, { openOnly: true, gid });
      if (!openPrizes.length) {
        Object.assign(outcome, { error: 'no_open_prize', giveawayId: gid });
        send({ event: 'gw_ack', type: 'error',
               error: 'Kein offener Preis — dieses Giveaway ist schon gezogen oder storniert.' });
        break;
      }
      let refunded = 0;
      for (const p of openPrizes) {
        const r = await wte.cancelPrize(teamId, p.id);
        refunded += r.refundedUsers || 0;
      }
      await wte.cleanupGiveawayInstance(teamId, gid);
      await setSessionStatusById(gid, 'closed');
      Object.assign(outcome, { giveawayId: gid, cancelled: true, refundedUsers: refunded });
      await announceChannels(teamId, known.channels,
        '🎟 Das Los-Giveaway wurde storniert — es wird kein Gewinner gezogen. '
        + 'Alle Einsätze sind zurückgebucht und eure Zuschauzeit ist als Los-Guthaben gutgeschrieben; '
        + 'es bleibt erhalten und zählt beim nächsten Los-Giveaway weiter.');
      send({ event: 'gw_ack', type: 'instance_cancelled', giveawayId: gid,
             refundedUsers: refunded });
      break;
    }

    // ── Phase 4b: Preise (CORE_TicketBuy) ──────────────────
    case 'gw_add_prize': {
      const gid = validGid(msg.giveawayId);
      const inst = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && g.core === 'CORE_TicketBuy') : null;
      if (!inst) {
        Object.assign(outcome, { error: 'no_ticketbuy_instance' });
        send({ event: 'gw_ack', type: 'error', error: 'Preise brauchen eine laufende Los-Giveaway-Instanz.' });
        break;
      }
      const title = sanitizeStr(msg.title || '', 100).trim();
      if (!title) {
        Object.assign(outcome, { error: 'no_title' });
        send({ event: 'gw_ack', type: 'error', error: 'Preis braucht einen Titel.' });
        break;
      }
      const endMin = Math.max(0, parseInt(msg.wagerEndMinutes, 10) || 0);
      const wagerEndTs = endMin ? Math.floor(Date.now() / 1000) + endMin * 60 : null;
      const pSponsor = sanitizeStr(msg.sponsor || '', 100).trim();
      let prizeId;
      try {
        prizeId = await wte.addPrize(teamId, gid, {
          title, description: sanitizeStr(msg.description || '', 500), wagerEndTs });
      } catch (e) {
        if (e && e.message === 'prize_exists') {
          Object.assign(outcome, { error: 'prize_exists' });
          send({ event: 'gw_ack', type: 'error',
                 error: 'Ein Los-Giveaway verlost genau einen Preis. Für einen weiteren Preis ein zusätzliches Los-Giveaway starten (＋ oben).' });
          break;
        }
        throw e;
      }
      if (pSponsor) await pg.query(`UPDATE giveaway_prizes SET sponsor=$1 WHERE id=$2`, [pSponsor, prizeId]);
      Object.assign(outcome, { prizeId, title, sponsor: pSponsor || undefined, giveawayId: gid, wagerEndMinutes: endMin || null });
      const cmd = (await redis.get(K.gWagerCmd(teamId, gid))) || '!setzen';
      await announceChannels(teamId, inst.channels,
        await chatText(teamId, 'CORE_TicketBuy', 'prizeAdded',
          { nr: prizeId, preis: title, sponsor: pSponsor, befehl: cmd, minuten: endMin || 0 }));
      send({ event: 'gw_ack', type: 'prize_added', prizeId, title });
      break;
    }
    case 'gw_list_prizes': {
      // giveawayId gesetzt = nur die Preise DIESER Instanz (ein Team darf
      // mehrere Los-Giveaways parallel fahren).
      send({ event: 'gw_ack', type: 'prizes', giveawayId: validGid(msg.giveawayId) || null,
             prizes: await wte.listPrizes(teamId, { openOnly: !!msg.openOnly,
                                                    gid: validGid(msg.giveawayId) || null }) });
      break;
    }
    // Preis korrigieren (Titel/Sponsor/Beschreibung/Einsatz-Ende) — nur offene.
    case 'gw_edit_prize': {
      const prizeId = parseInt(msg.prizeId, 10);
      if (!Number.isFinite(prizeId) || prizeId <= 0) {
        Object.assign(outcome, { error: 'bad_request' });
        send({ event: 'gw_ack', type: 'error', error: 'Preis-ID fehlt.' });
        break;
      }
      const fields = {};
      if (msg.title !== undefined)       fields.title       = msg.title;
      if (msg.sponsor !== undefined)     fields.sponsor     = msg.sponsor;
      if (msg.description !== undefined) fields.description = msg.description;
      if (msg.wagerEndMinutes !== undefined) {
        const endMin = Math.max(0, parseInt(msg.wagerEndMinutes, 10) || 0);
        fields.wagerEndTs = endMin ? Math.floor(Date.now() / 1000) + endMin * 60 : null;
      }
      const r = await wte.editPrize(teamId, prizeId, fields);
      if (r.error) {
        Object.assign(outcome, { error: r.error, prizeId });
        send({ event: 'gw_ack', type: 'error',
               error: r.error === 'not_open' ? 'Dieser Preis ist schon gezogen oder storniert.' : 'Diesen Preis gibt es nicht.' });
        break;
      }
      Object.assign(outcome, { prizeId, fields: Object.keys(fields) });
      send({ event: 'gw_ack', type: 'prize_edited', prizeId });
      break;
    }
    // Preis stornieren: alle Einsätze zurückbuchen, status='cancelled'.
    case 'gw_cancel_prize': {
      const prizeId = parseInt(msg.prizeId, 10);
      if (!Number.isFinite(prizeId) || prizeId <= 0) {
        Object.assign(outcome, { error: 'bad_request' });
        send({ event: 'gw_ack', type: 'error', error: 'Preis-ID fehlt.' });
        break;
      }
      const r = await wte.cancelPrize(teamId, prizeId);
      if (r.error) {
        Object.assign(outcome, { error: r.error, prizeId });
        send({ event: 'gw_ack', type: 'error',
               error: r.error === 'not_open' ? 'Dieser Preis ist schon gezogen oder storniert.' : 'Diesen Preis gibt es nicht.' });
        break;
      }
      Object.assign(outcome, { prizeId, title: r.title, refundedUsers: r.refundedUsers, refundedTotal: r.refundedTotal });
      const cGid = validGid(msg.giveawayId);
      const cInst = cGid ? (await wte.listGiveaways(teamId)).find(g => g.gid === cGid) : null;
      await announceChannels(teamId, cInst ? cInst.channels : null,
        await chatText(teamId, 'CORE_TicketBuy', 'prizeCancelled',
          { nr: prizeId, preis: r.title, anzahl: r.refundedUsers || 0 }));
      send({ event: 'gw_ack', type: 'prize_cancelled', prizeId, refundedUsers: r.refundedUsers });
      break;
    }
    // Losanpassung: alle Lose-Konten des Teams auf null (Neustart) — Lose
    // bleiben sonst über Giveaways hinweg erhalten. Gegenbuchung je Konto,
    // blockiert solange irgendwo ein offener Preis liegt.
    case 'gw_reset_credit': {
      const r = await wte.resetTeamCredit(teamId, { detail: { reason: 'admin_reset', actor: meta.authUser || null } });
      if (r.error) {
        Object.assign(outcome, { error: r.error, openPrizes: r.open });
        send({ event: 'gw_ack', type: 'error',
               error: `Losanpassung blockiert: ${r.open} offener Preis(e) im Team — erst ziehen oder stornieren.` });
        break;
      }
      Object.assign(outcome, { users: r.users, total: r.total });
      send({ event: 'gw_ack', type: 'credit_reset', users: r.users, total: r.total });
      break;
    }
    // ── Chat-Ansagen-Vorlagen (18.8.26): Katalog + Team-Overrides ──
    case 'gw_get_chat_templates': {
      const stored = await wte.listChatTemplates(teamId);
      const byKey = {};
      stored.forEach(s => { byKey[s.core + '|' + s.key] = s; });
      const groups = ['_common', 'CORE_WatchtimeChatActivity', 'CORE_CurrentViewers',
                      'CORE_TicketBuy', 'CORE_ScreenshotContest'].map(gr => ({
        core: gr,
        entries: ChatTexts.listChatTexts(gr).map(e => {
          const s = byKey[gr + '|' + e.key] || null;
          return { key: e.key, label: e.label, placeholders: e.placeholders, defaultText: e.defaultText,
                   text: s ? s.text : '', appendTerms: s ? s.appendTerms : false, appendPage: s ? s.appendPage : false };
        }),
      }));
      send({ event: 'gw_ack', type: 'chat_templates', groups });
      break;
    }
    case 'gw_set_chat_template': {
      const gr = String(msg.core || '');
      const key = String(msg.key || '');
      if (!ChatTexts.listChatTexts(gr).some(e => e.key === key)) {
        Object.assign(outcome, { error: 'bad_request', core: gr, key });
        send({ event: 'gw_ack', type: 'error', error: 'Unbekannte Chat-Nachricht.' });
        break;
      }
      const r = await wte.setChatTemplate(teamId, gr, key, {
        text: sanitizeStr(msg.text || '', 500),
        appendTerms: !!msg.appendTerms, appendPage: !!msg.appendPage });
      Object.assign(outcome, { core: gr, key, reset: !!r.reset,
                               appendTerms: !!msg.appendTerms, appendPage: !!msg.appendPage });
      send({ event: 'gw_ack', type: 'chat_template_set', core: gr, key, reset: !!r.reset });
      break;
    }
    case 'gw_set_wager_cmd': {
      const gid = validGid(msg.giveawayId);
      const inst = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && g.core === 'CORE_TicketBuy') : null;
      const cmd = sanitizeStr(msg.command || '', 30).trim().toLowerCase();
      if (!inst || !cmd) {
        Object.assign(outcome, { error: 'bad_request' });
        send({ event: 'gw_ack', type: 'error', error: 'Instanz oder Befehl fehlt.' });
        break;
      }
      if (await wte.wagerCmdTaken(teamId, cmd, gid)) {
        Object.assign(outcome, { error: 'wager_cmd_taken', wagerCmd: cmd });
        send({ event: 'gw_ack', type: 'error',
               error: `„${cmd}" wird schon von einem laufenden Los-Giveaway benutzt.` });
        break;
      }
      const before = await redis.get(K.gWagerCmd(teamId, gid));
      await redis.set(K.gWagerCmd(teamId, gid), cmd);
      Object.assign(outcome, { giveawayId: gid, cmdBefore: before, cmdAfter: cmd });
      await announceChannels(teamId, inst.channels,
        await chatText(teamId, 'CORE_TicketBuy', 'wagerCmd', { befehl: cmd }));
      send({ event: 'gw_ack', type: 'wager_cmd_set', giveawayId: gid, command: cmd });
      break;
    }
    // Sofortverlosung: (weiteres) Anmeldefenster öffnen — Ziehung bleibt manuell.
    case 'gw_instant_window': {
      const gid = validGid(msg.giveawayId);
      const inst = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && g.core === 'CORE_CurrentViewers') : null;
      if (!inst) {
        Object.assign(outcome, { error: 'no_instant_instance' });
        send({ event: 'gw_ack', type: 'error', error: 'Keine Sofortverlosungs-Instanz gewählt.' });
        break;
      }
      const w = await wte.openInstantWindow(teamId, gid, msg.windowSec);
      Object.assign(outcome, { giveawayId: gid, windowSec: w.windowSec });
      const cvMin = parseInt(await redis.get(K.gMinWatch(teamId, gid)), 10);
      if (inst.announce) await announceChannels(teamId, inst.channels,
        await chatText(teamId, 'CORE_CurrentViewers', 'windowOpen',
          { keyword: inst.keyword, windowSec: w.windowSec, minuten: Math.round(w.windowSec / 60),
            minWatchSec: Number.isFinite(cvMin) ? cvMin : undefined }));
      // Ohne viewer_tick ist niemand „anwesend" — die Ziehung liefe ins Leere.
      // Darum beim Oeffnen des Fensters sofort warnen, nicht erst beim ★.
      let pulse = [];
      try { pulse = await wte.getIngestPulse(teamId, inst.channels); } catch { /* Warnung entfaellt */ }
      const dead = pulse.filter(x => x.stale).map(x => x.channel);
      if (dead.length) Object.assign(outcome, { ingestStale: dead });
      send({ event: 'gw_ack', type: 'instant_window', giveawayId: gid, windowSec: w.windowSec,
             endsAt: w.endsAt, ingestStale: dead, ingestPulse: pulse });
      break;
    }
    // Zuschauer-Seite der Instanz im Chat ankündigen (Setz-/Contest-Seite).
    case 'gw_announce_page': {
      const gid = validGid(msg.giveawayId);
      const inst = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid) : null;
      let txt = null;
      if (inst && inst.core === 'CORE_TicketBuy') {
        const cmd = await redis.get(K.gWagerCmd(teamId, gid)) || '!setzen';
        txt = await chatText(teamId, inst.core, 'page', { befehl: cmd });
      } else if (inst && inst.core === 'CORE_ScreenshotContest') {
        txt = await chatText(teamId, inst.core, 'page');
      }
      if (!txt) {
        Object.assign(outcome, { error: 'no_viewer_page' });
        send({ event: 'gw_ack', type: 'error', error: 'Für diese Instanz gibt es keine Zuschauer-Seite.' });
        break;
      }
      Object.assign(outcome, { giveawayId: gid, core: inst.core });
      await announceChannels(teamId, inst.channels, txt);
      send({ event: 'gw_ack', type: 'page_announced', giveawayId: gid });
      break;
    }
    // Chat-Ansagen der Sofortverlosung an/aus (Gewinner-Ansage bleibt immer).
    case 'gw_set_announce': {
      const gid = validGid(msg.giveawayId);
      const inst = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && g.core === 'CORE_CurrentViewers') : null;
      if (!inst) {
        Object.assign(outcome, { error: 'no_instant_instance' });
        send({ event: 'gw_ack', type: 'error', error: 'Keine Sofortverlosungs-Instanz gewählt.' });
        break;
      }
      const on = msg.on !== false;
      if (on) await redis.del(K.gAnnounce(teamId, gid));
      else    await redis.set(K.gAnnounce(teamId, gid), 'false');
      Object.assign(outcome, { giveawayId: gid, announceBefore: inst.announce, announceAfter: on });
      send({ event: 'gw_ack', type: 'announce_set', giveawayId: gid, announce: on });
      break;
    }
    // ── Phase 6: Screenshot-Contest ────────────────────────
    case 'gw_contest_voting': {
      // Voting öffnen / pausieren / fortsetzen / schließen (Pflicht-Steuerung).
      const gid = validGid(msg.giveawayId);
      const inst = gid ? (await wte.listGiveaways(teamId)).find(g => g.gid === gid && g.core === 'CORE_ScreenshotContest') : null;
      const action = String(msg.action || '');
      const map = { open: 'open', resume: 'open', pause: 'paused', close: 'closed' };
      if (!inst || !map[action]) {
        Object.assign(outcome, { error: 'bad_request' });
        send({ event: 'gw_ack', type: 'error', error: 'Contest-Instanz oder Aktion (open/pause/resume/close) fehlt.' });
        break;
      }
      const before = await wte.getContestVoting(teamId, gid);
      const state = await wte.setContestVoting(teamId, gid, map[action]);
      Object.assign(outcome, { giveawayId: gid, votingBefore: before, votingAfter: state });
      const votingKeys = { open: 'votingOpen', paused: 'votingPaused', closed: 'votingClosed' };
      if (before !== state) await announceChannels(teamId, inst.channels,
        await chatText(teamId, 'CORE_ScreenshotContest', votingKeys[state]));
      send({ event: 'gw_ack', type: 'contest_voting', giveawayId: gid, voting: state });
      break;
    }
    case 'gw_review_entry': {
      const entryId = parseInt(msg.entryId, 10);
      const approve = msg.decision === 'approve';
      if (!Number.isFinite(entryId) || !['approve', 'reject'].includes(msg.decision)) {
        Object.assign(outcome, { error: 'bad_request' });
        send({ event: 'gw_ack', type: 'error', error: 'entryId und decision (approve/reject) nötig.' });
        break;
      }
      const r = await wte.reviewContestEntry(teamId, entryId, approve);
      if (r.error) {
        Object.assign(outcome, { error: r.error, entryId });
        send({ event: 'gw_ack', type: 'error', error: 'Einsendung nicht gefunden.' });
        break;
      }
      Object.assign(outcome, { entryId, decision: msg.decision, entrant: r.username });
      send({ event: 'gw_ack', type: 'entry_reviewed', entryId, decision: msg.decision, username: r.username });
      break;
    }
    // Owner-Löschung einer Einsendung (Moderation): Bild weg, Stimmen weg.
    // Für unpassende, aber harmlose Bilder reicht reject — Löschen ist für
    // Inhalte, die nicht gespeichert bleiben dürfen.
    case 'gw_delete_entry': {
      const entryId = parseInt(msg.entryId, 10);
      if (!Number.isFinite(entryId) || entryId <= 0) {
        Object.assign(outcome, { error: 'bad_request' });
        send({ event: 'gw_ack', type: 'error', error: 'entryId fehlt.' });
        break;
      }
      const r = await wte.deleteContestEntry(teamId, entryId);
      if (r.error) {
        Object.assign(outcome, { error: r.error, entryId });
        send({ event: 'gw_ack', type: 'error', error: 'Einsendung nicht gefunden.' });
        break;
      }
      Object.assign(outcome, { entryId, entrant: r.username, title: r.title });
      send({ event: 'gw_ack', type: 'entry_deleted', entryId, username: r.username });
      break;
    }
    case 'gw_list_entries': {
      const gid = validGid(msg.giveawayId);
      if (!gid) { send({ event: 'gw_ack', type: 'error', error: 'giveawayId fehlt.' }); break; }
      send({ event: 'gw_ack', type: 'entries',
             giveawayId: gid,
             voting: await wte.getContestVoting(teamId, gid),
             entries: await wte.getContestStandings(teamId, gid, { all: true }) });
      break;
    }
    case 'gw_set_stream_settings': {
      // Ziel bestimmen: gewählte offene Instanz → nur dieses Giveaway;
      // laufende Kampagne → nur diese Kampagne; nichts offen → Team-Vorgaben
      // (gelten ab dem nächsten Start, Copy-on-Open).
      const sGid = validGid(msg.giveawayId)
                || (await redis.get(K.gwOpen(teamId)) === 'true' ? await sid() : null);
      const ap = !!msg.autoPause, ar = !!msg.autoResume;   // Auto-Pause bleibt team-weit (Stream-Ereignis)
      if (ap) await redis.set(K.cfgAutoPause(teamId), '1'); else await redis.del(K.cfgAutoPause(teamId));
      if (ar) await redis.set(K.cfgAutoResume(teamId), '1'); else await redis.del(K.cfgAutoResume(teamId));
      let fm = await wte.getFollowMin(teamId, sGid);
      const fmBefore = fm, dmBefore = await wte.getDrawMinSec(teamId, sGid);
      if (msg.followMin !== undefined && msg.followMin !== null) fm = await wte.setFollowMin(teamId, msg.followMin, sGid);
      let dm = dmBefore;
      if (msg.drawMinHours !== undefined && msg.drawMinHours !== null) dm = await wte.setDrawMinSec(teamId, parseFloat(msg.drawMinHours) * 3600, sGid);
      const chatBefore = await wte.getChatConfig(teamId, sGid);
      const chat = await wte.setChatConfig(teamId, {
        enabled: typeof msg.chatEnabled === 'boolean' ? msg.chatEnabled : undefined,
        bonusSec: msg.chatBonusSec, minWords: msg.chatMinWords, cooldown: msg.chatCooldown }, sGid);
      Object.assign(outcome, { scope: sGid || 'team_defaults',
                               followMinBefore: fmBefore, followMinAfter: fm,
                               coinBaseSecBefore: dmBefore, coinBaseSecAfter: dm,
                               chatBefore, chatAfter: chat });
      send({ event: 'gw_ack', type: 'stream_settings', scope: sGid || 'defaults',
                autoPause: ap, autoResume: ar, followMin: fm, drawMinHours: dm / 3600,
                chatEnabled: chat.enabled, chatBonusSec: chat.bonusSec,
                chatMinWords: chat.minWords, chatCooldown: chat.cooldown });
      log('GW', `[${teamId}] settings(${sGid || 'defaults'}): pause=${ap} resume=${ar} followMin=${fm} drawMin=${dm}s`);
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
      // Effektive Werte der Auswahl: offene Instanz/Kampagne → deren eigene
      // Werte; sonst die Team-Vorgaben für den nächsten Start.
      const sGid = validGid(msg.giveawayId)
                || (await redis.get(K.gwOpen(teamId)) === 'true' ? await sid() : null);
      const chat = await wte.getChatConfig(teamId, sGid);
      send({ event: 'gw_ack', type: 'stream_settings', scope: sGid || 'defaults',
        autoPause:  await redis.get(K.cfgAutoPause(teamId)) === '1',
        autoResume: await redis.get(K.cfgAutoResume(teamId)) === '1',
        followMin:  await wte.getFollowMin(teamId, sGid),
        drawMinHours: (await wte.getDrawMinSec(teamId, sGid)) / 3600,
        chatEnabled: chat.enabled, chatBonusSec: chat.bonusSec,
        chatMinWords: chat.minWords, chatCooldown: chat.cooldown });
      break;
    }
    case 'gw_set_keyword': {
      // Mit giveawayId: Keyword der Sekundär-Instanz (Sofortverlosung etc.),
      // sonst wie bisher das der Kampagne.
      const kw = sanitizeStr(msg.keyword || '', 100);
      const kGid = validGid(msg.giveawayId);
      // Los-Giveaway: das Keyword IST der Teilnahme-Opt-in (18.8.26) — leeren
      // wuerde placeWager wieder fuer Unangemeldete oeffnen. Aendern ja, abschalten nein.
      if (!kw && await wte.getCoreId(teamId, kGid) === 'CORE_TicketBuy') {
        Object.assign(outcome, { error: 'keyword_required', giveawayId: kGid });
        send({ event: 'gw_ack', type: 'error',
               error: 'Ein Los-Giveaway braucht ein Teilnahme-Keyword — ändern ja, abschalten nein.' });
        break;
      }
      const kKey = (kGid && kGid !== await sid()) ? K.gKw(teamId, kGid) : K.gwKeyword(teamId);
      outcome.keywordBefore = await redis.get(kKey) || '';
      outcome.keywordAfter  = kw;
      if (kGid) outcome.giveawayId = kGid;
      await redis.set(kKey, kw);
      const s = kGid || await sid();
      if (s) await pg.query('UPDATE sessions SET keyword=$1 WHERE id=$2', [kw, s]);
      send({ event: 'gw_ack', type: 'keyword_set', keyword: kw, giveawayId: kGid || null });
      break;
    }
    case 'gw_get_keyword': {
      const kGid = validGid(msg.giveawayId);
      const kKey = (kGid && kGid !== await sid()) ? K.gKw(teamId, kGid) : K.gwKeyword(teamId);
      send({ event: 'gw_ack', type: 'keyword', keyword: await redis.get(kKey) || '', giveawayId: kGid || null });
      break;
    }
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
      // Boost einschalten nur, wenn der Ingest lebt: mindestens ein Kanal der
      // Auswahl ist laut Streamerbot online UND liefert Ticks. Ohne Ticks
      // wuerde der Boost nur die Uhr abbrennen (Betreiber 18.8.26).
      // Ausschalten (Faktor 1) geht immer.
      if ((parseFloat(msg.factor) || 1) > 1) {
        const mInst = mGid ? (await wte.listGiveaways(teamId)).find(g => g.gid === mGid) : null;
        let mPulse = [];
        try { mPulse = await wte.getIngestPulse(teamId, mInst ? mInst.channels : null); }
        catch (e) { logErr('GW', 'boostPulse:', e.message); }
        if (!mPulse.some(x => x.online && !x.silent)) {
          Object.assign(outcome, { blocked: 'ingest_offline' });
          send({ event: 'gw_ack', type: 'error',
                 error: 'Boost nicht möglich: kein Kanal ist live mit verbundenem Streamerbot — ohne Zuschauer-Ticks würde die Boost-Zeit wirkungslos ablaufen.' });
          break;
        }
      }
      const r = await wte.setMultiplier(teamId, msg.factor, (parseInt(msg.minutes) || 0) * 60, mGid);
      const bKey = `${teamId}|${r.gid || ''}`;
      Object.assign(outcome, { factorBefore: prev.factor, factorAfter: r.factor, seconds: r.seconds, giveawayId: r.gid || null });
      broadcastTeam(teamId, { event: 'gw_multiplier', factor: r.factor, secondsLeft: r.seconds, giveawayId: r.gid || null });
      // Ein Boost, den keiner mitbekommt, bringt niemanden zum Zuschauen.
      // Faktor 1 = aus, das ist derselbe Befehl und wird genauso angesagt.
      if (r.factor > 1) {
        boostAnnounced.set(bKey, { teamId, gid: r.gid || null, factor: r.factor });
        await announceTeam(teamId, await chatText(teamId, '_common', 'boostStart',
          { minuten: Math.round(r.seconds / 60), faktor: r.factor }));
      } else if (prev.factor > 1) {
        boostAnnounced.delete(bKey);
        await announceTeam(teamId, await chatText(teamId, '_common', 'boostStop'));
      }
      send({ event: 'gw_ack', type: 'multiplier_set', factor: r.factor, seconds: r.seconds });
      break;
    }
    case 'gw_get_multiplier': {
      const st = await wte.multiplierState(teamId, validGid(msg.giveawayId) || undefined);
      send({ event: 'gw_multiplier', factor: st.factor, secondsLeft: st.secondsLeft,
             giveawayId: validGid(msg.giveawayId) || null });
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
        // Mit giveawayId zieht die Instanz, sonst das Primary. Ohne expliziten
        // prize-Text kommt der beim Öffnen eingetragene Gewinn (+ Sponsor)
        // in den Ziehungssatz.
        const drawGid = validGid(msg.giveawayId) || await sid();
        let drawPrize = sanitizeStr(msg.prize || '', 100).trim();
        const drawPrizeIdNum = parseInt(msg.prizeId, 10);
        if (!drawPrize && Number.isFinite(drawPrizeIdNum)) {   // Los-Giveaway: Titel + Sponsor des Preises
          try {
            const pr = await pg.query(`SELECT title, sponsor FROM giveaway_prizes WHERE id=$1`, [drawPrizeIdNum]);
            if (pr.rowCount) drawPrize = pr.rows[0].title
              + (pr.rows[0].sponsor ? ` — bereitgestellt von ${pr.rows[0].sponsor}` : '');
          } catch (e) { logErr('GW', 'draw prize lookup:', e.message); }
        }
        if (!drawPrize && drawGid) {
          try {
            const sp = await pg.query(`SELECT prize, sponsor FROM sessions WHERE id=$1`, [drawGid]);
            if (sp.rowCount && sp.rows[0].prize) {
              drawPrize = sp.rows[0].prize + (sp.rows[0].sponsor ? ` — bereitgestellt von ${sp.rows[0].sponsor}` : '');
            }
          } catch (e) { logErr('GW', 'draw prize lookup:', e.message); }
        }
        // P6: Ersatzziehung — verknüpft mit der Ursprungsziehung, mit Grund;
        // der ursprüngliche Gewinner ist IMMER ausgeschlossen, sein Claim
        // wird danach 'replaced'. Bereits wirksam abgewickelte Gewinne
        // (gemeldet/kontaktiert/versendet/erledigt) blockieren den Ersatz —
        // sonst gäbe es zwei gültige Ansprüche auf denselben Gewinn.
        let rerollOf = parseInt(msg.rerollOf, 10);
        let rerollWinner = null, rerollReason = null;
        if (Number.isFinite(rerollOf) && rerollOf > 0) {
          const orig = await pg.query(`
            SELECT d.id, d.winner FROM giveaway_draws d JOIN sessions s ON s.id = d.session_id
            WHERE d.id=$1 AND s.team_id=$2`, [rerollOf, teamId]);
          if (!orig.rowCount) {
            Object.assign(outcome, { error: 'reroll_not_found', rerollOf });
            send({ event: 'gw_ack', type: 'draw_error', error: 'Ursprungsziehung nicht gefunden.' });
            break;
          }
          const oc = await pg.query(
            `SELECT status, handling FROM draw_claims WHERE draw_id=$1 AND team_id=$2`, [rerollOf, teamId]);
          const blockReason = rerollBlocked(oc.rows[0] || null);
          if (blockReason) {
            Object.assign(outcome, { error: 'reroll_blocked', rerollOf, reason: blockReason });
            send({ event: 'gw_ack', type: 'draw_error',
                   error: (REROLL_BLOCK_MSG[blockReason] || 'Der Gewinn ist bereits abgewickelt')
                        + ' — Ersatzziehung nicht möglich. Kläre die bestehende Abwicklung zuerst mit dem Gewinner.' });
            break;
          }
          rerollWinner = orig.rows[0].winner;
          rerollReason = sanitizeStr(msg.reason || '', 200).trim() || 'Gewinner hat sich nicht fristgerecht gemeldet';
        } else { rerollOf = null; }
        const result = await wte.drawWinner(teamId, drawGid, {
          test: !!msg.test, prize: drawPrize, prizeId: msg.prizeId,
          rerollOf, rerollReason,
          excludeWinner: rerollOf ? rerollWinner : null });
        if (!result) {
          outcome.winner = null;
          // P4: Leermeldung aus dem Core-Vertrag statt pauschal "keine Coins".
          let emptyMsg = null;
          try {
            const cid = drawGid ? await wte.getCoreId(teamId, drawGid) : CORE.id;
            emptyMsg = (CoreRegistry.getCore(cid).display || {}).emptyPool || null;
          } catch { /* Standardtext im Panel */ }
          // Warum leer? Bei der Sofortverlosung fast immer: angemeldet ja,
          // anwesend nein (keine viewer_tick). Zahlen mitschicken.
          let noWinner = { event: 'gw_ack', type: 'no_winner', message: emptyMsg };
          try {
            const cid2 = drawGid ? await wte.getCoreId(teamId, drawGid) : CORE.id;
            if (cid2 === 'CORE_CurrentViewers') {
              const rows = await wte.getInstantParticipants(teamId, drawGid);
              const inst2 = (await wte.listGiveaways(teamId)).find(g => g.gid === drawGid);
              const pulse2 = await wte.getIngestPulse(teamId, inst2 ? inst2.channels : null);
              noWinner.registered = rows.length;
              noWinner.present = rows.filter(r => r.present).length;
              noWinner.ingestStale = pulse2.filter(x => x.stale).map(x => x.channel);
            }
          } catch (e) { logErr('GW', 'no_winner detail:', e.message); }
          send(noWinner);
          break;
        }
        // P4: semantische Felder aus dem Core-Vertrag — winner_coins bleibt
        // aus Kompatibilität, `weight`/`unit`/`drawKind` sagen, was es IST.
        let dMeta = {};
        try { dMeta = CoreRegistry.getCore(result.core || CORE.id).display || {}; } catch { /* Standard */ }
        const semantic = { core: result.core || null, unit: dMeta.unit !== undefined ? dMeta.unit : 'Punkte',
                           winnerStat: dMeta.winnerStat || 'coins', drawKind: dMeta.drawKind || 'weighted',
                           weight: result.coins, votes: result.msgs || 0,
                           prizeId: result.prizeId || null, eligibleCount: result.eligibleCount };
        Object.assign(outcome, { winner: result.winner, winnerCoins: result.coins, drawId: result.drawId,
                                 eligibleCount: result.eligibleCount, totalCoins: result.total,
                                 randValue: result.rand, isTest: !!result.isTest, core: result.core || null });
        send({ event: 'gw_ack', type: 'winner_drawn', winner: result.winner, watchSec: result.watchSec,
               coins: result.coins, drawId: result.drawId, prize: result.prize, ...semantic });
        // Testziehungen erzeugen keine Meldefrist und keine Ansage.
        if (!result.isTest) {
          // Ersatzziehung: alten Claim als ersetzt markieren (sofern der
          // Gewinner nicht schon erfolgreich gemeldet hatte) — der Datensatz
          // bleibt als Nachweis, die Meldeseite weist ihn ab.
          if (rerollOf) {
            const rc = await pg.query(`
              UPDATE draw_claims SET status='replaced'
              WHERE draw_id=$1 AND team_id=$2 AND status <> 'claimed' RETURNING id, winner`, [rerollOf, teamId]);
            Object.assign(outcome, { rerollOf, rerollReason,
                                     replacedClaim: rc.rowCount ? rc.rows[0].id : null });
          }
          const claim = await createClaim(teamId, result);
          outcome.claimDeadline = claim ? claim.deadlineAt : null;
          // P4: Gewinner-Ansage aus dem Core (Einsatz/Score/Sofort-Wortlaut),
          // Fallback = bisheriger generischer Text. Die Meldefrist-Zeile
          // bleibt immer dran — der Gewinner muss wissen, wie es weitergeht.
          let winLine = await chatText(teamId, result.core || CORE.id, 'winner',
            { gewinner: result.winner, preis: result.prize || 'Preis',
              gewinn: result.prize || '', punkte: result.coins });
          if (!winLine) winLine = `🎉 Gewinner: @${result.winner} — herzlichen Glückwunsch!`;
          await announceTeam(teamId, winLine
            + ` Melde dich innerhalb von ${CLAIM_DEADLINE_DAYS} Tagen unter ${publicHost()}/viewer/claim `
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

// ── Ingest-Anomalie (ChatGPT-Review #4) ──────────────────
// Ein kompromittierter Streamerbot-Token kann beliebige Zuschauernamen
// melden. Verhindern lässt sich das nicht (der Kanal-PC ist die Quelle),
// aber auffällige Sprünge der gemeldeten Zuschauerzahl werden markiert:
// Minuten-Sets je Kanal; springt eine Minute auf ≥3× der Vorminute (und
// ≥20 Nutzer), gibt es einen abuse_flag + Audit-Eintrag — Entscheidung
// bleibt beim Owner (Token rotieren, Kanal-Coins verwerfen).
const ANOM_MIN_USERS = 20;
const ANOM_FACTOR    = 3;
async function trackIngestAnomaly(teamId, channel, user) {
  try {
    if (!teamId || !channel || !user) return;
    const min = Math.floor(Date.now() / 60000);
    const key = (m) => `t:${teamId}:anom:${channel}:${m}`;
    await redis.sadd(key(min), user);
    await redis.expire(key(min), 240);
    // Auswertung einmal je Minute (erste Tick der neuen Minute prüft die letzte)
    if (await redis.set(`t:${teamId}:anom:chk:${channel}:${min}`, '1', 'EX', 240, 'NX') !== 'OK') return;
    const n1 = await redis.scard(key(min - 1));
    const n2 = await redis.scard(key(min - 2));
    if (n1 >= ANOM_MIN_USERS && n1 >= ANOM_FACTOR * Math.max(1, n2)) {
      if (await redis.set(`t:${teamId}:anom:flagged:${channel}`, '1', 'EX', 600, 'NX') === 'OK') {
        await wte.flagUser(teamId, channel, 'ingest_anomaly', { channel, minuteUsers: n1, prevUsers: n2 });
        await audit({ teamId, actor: 'system', action: 'ingest_anomaly', target: channel,
                      detail: { minuteUsers: n1, prevUsers: n2 } });
        logErr('Ingest', `[${teamId}] anomaly on ${channel}: ${n2} -> ${n1} users/min`);
      }
    }
  } catch (e) { logErr('Ingest', 'anomaly check:', e.message); }
}

// Einfache Redis-Drossel für teure REST-Pfade (ChatGPT-Review #12) —
// dieselbe NX+EX-Mechanik wie beim Contest-Voting. true = durchlassen.
async function rateLimit(key, seconds) {
  try { return (await redis.set(`rl:${key}`, '1', 'EX', seconds, 'NX')) === 'OK'; }
  catch { return true; }   // Redis-Störung darf legitime Nutzung nicht blocken
}

// ── Ingest-Ereignisse: eine Quelle, ein Einstiegspunkt ───
// consumeIngest kapselt den Transport. Heute Redis Pub/Sub (jede Replik saehe
// jedes Ereignis — deshalb laeuft der Dienst einfach); der Umstieg auf Redis
// Streams mit Consumer-Group ist damit ein Eingriff an genau dieser Stelle
// statt einer Suche durch die ganze Datei (docs/SKALIERUNG.md).
function consumeIngest(handler) {
  redisSub.subscribe('ch:giveaway', (err) => { if (err) return logErr('Sub', err.message); log('Sub', 'Subscribed ch:giveaway'); });
  redisSub.on('message', async (channel, payload) => {
    if (channel !== 'ch:giveaway') return;
    let msg; try { msg = JSON.parse(payload); } catch { return; }
    try { await handler(msg); } catch (e) { logErr('Ingest', 'handler:', e.message); }
  });
}

function subscribeToGiveaway() {
  consumeIngest(async (msg) => {
    const teamId = sanitizeTeamId(msg.team);

    switch (msg.event) {
      case 'viewer_tick':
        await wte.handleViewerTick(teamId, msg.channel, msg.user, msg.follows);
        await trackIngestAnomaly(teamId, sanitizeChannel(msg.channel), sanitizeUsername(msg.user));
        break;
      case 'chat_msg': {
        const result = await wte.handleChatMessage(teamId, msg.channel, msg.user, msg.message, msg.follows);
        const u = sanitizeUsername(msg.user);
        if (result && result.isNew) {
          broadcastTeam(teamId, { event: 'gw_join', user: u });   // Panel-Hinweis + Refresh
          const reply = CORE.joinReply({ username: u, agg: result });
          redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: reply }));
        }
        if (result && result.added) broadcastTeam(teamId, { event: 'wt_update', user: u, channel: result.channel, watchSec: result.watchSec, coins: result.coins });
        // Phase 4b: Antwort auf Setz-Befehle (Bestätigung, Hilfe, Fehler).
        if (result && result.chatReply) {
          redisPub.publish('ch:chat_reply', JSON.stringify({ event: 'chat_reply', channel: msg.channel, message: result.chatReply }));
        }
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
        let reply = CORE.statusText({ username: u, open, agg, keyword, poolTotal, host: chatHost(), teamId });
        const extra = await secondaryStatusLines(teamId, msg.channel);
        if (extra) reply += ' ' + extra;
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
    if (!await rateLimit(`export:${teamId}`, 10)) return res.status(429).json({ error: 'rate_limited' });
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
    if (!await rateLimit(`import:${teamId}`, 30)) return res.status(429).json({ error: 'rate_limited' });
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
    if (!await rateLimit(`auditarch:${teamId}`, 10)) return res.status(429).json({ error: 'rate_limited' });
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

// Teams für die Zuschauer-Seiten (Setzen/Contest): der Redis-Reverse-Index
// (getUserTeams) kennt nur Zuschauer, die schon einen viewer_tick hatten —
// Streamer selbst und frisch eingeloggte Zuschauer stehen NICHT drin und
// sahen „kein Contest/kein Guthaben", obwohl eine Instanz lief. Darum
// Union aus Index + team_members + allen Teams mit offener Instanz der
// gesuchten Mechanik (die Teilnahme-Gates prüfen ohnehin je Nutzer).
async function viewerTeams(user, coreId, { scanAll = true } = {}) {
  const set = new Set(await wte.getUserTeams(user));
  try {
    const r = await pg.query('SELECT team_id FROM team_members WHERE login=$1', [user]);
    for (const row of r.rows) set.add(row.team_id);
  } catch (e) { logErr('GW', 'viewerTeams members:', e.message); }
  // scanAll: auch fremde Teams mit passender offener Instanz (Contest-Seite).
  // Die Setz-Seite laesst das WEG — dort zaehlt nur, wo die Person Daten hat
  // oder Mitglied ist; sonst erschienen alle Los-Giveaways der Plattform.
  if (scanAll) try {
    for (const t of await redis.smembers(K.openTeams())) {
      if (set.has(t)) continue;
      if ((await wte.listGiveaways(t)).some(g => !g.primary && !g.closed && g.core === coreId)) set.add(t);
    }
  } catch (e) { logErr('GW', 'viewerTeams scan:', e.message); }
  return [...set];
}

// ── Phase 4c: Lose setzen (CORE_TicketBuy) ────────────────
// Identität kommt ausschließlich aus der Twitch-Session (X-Auth-User via
// Caddy forward_auth) — wie bei der Gewinnermeldung, nie per Fremdeingabe.
app.get('/api/wager/state', async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const out = [];
    for (const t of await viewerTeams(user, 'CORE_TicketBuy', { scanAll: false })) {
      const available = await wte.availableCredit(t, user);
      const insts = (await wte.listGiveaways(t)).filter(g => g.core === 'CORE_TicketBuy' && g.gid && !g.closed);
      const tName = await teamName(t);
      // Je laufendem Los-Giveaway ein Block: eigener Preis, eigener
      // Setz-Befehl, eigene Kanaele (ein Giveaway = ein Preis).
      let visible = 0;
      for (const g of insts) {
        // Opt-in-Filter: die Seite zeigt nur Giveaways, bei denen die Person
        // per Keyword angemeldet ist. Instanzen ohne Keyword (Altbestand)
        // bleiben sichtbar. Fremde Teams verschwinden damit von selbst.
        const kw = await redis.get(K.gKw(t, g.gid));
        const registered = await redis.get(K.gReg(t, g.gid, user)) === '1';
        if (kw && !registered) continue;
        if (!kw && !registered && !(available > 0)) continue;   // Altbestand: ohne Guthaben nichts anzeigbar
        visible++;
        const prizes = await wte.listPrizes(t, { gid: g.gid });
        const withStake = [];
        for (const pz of prizes) withStake.push({ ...pz, myStake: await wte.prizeStake(pz.id, user) });
        const seen = await pg.query(`SELECT 1 FROM participation_consents
          WHERE team_id=$1 AND session_id=$2 AND username=$3 AND action='wager'`, [t, g.gid, user]);
        out.push({ teamId: t, teamName: tName, available, prizes: withStake,
                   wagerCmd: (await redis.get(K.gWagerCmd(t, g.gid))) || '!setzen',
                   consented: seen.rowCount > 0, registered: registered || !kw,
                   giveawayId: g.gid, name: g.name || null,
                   channels: g.channels || await wte.getChannels(t) });
      }
      // Kein (angemeldetes) Los-Giveaway, aber Guthaben da: Stand trotzdem zeigen.
      if (!visible && available > 0) {
        out.push({ teamId: t, teamName: tName, available, prizes: [], wagerCmd: null,
                   consented: false, giveawayId: null, name: null,
                   channels: await wte.getChannels(t) });
      }
    }
    res.json({ user, teams: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wager', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const prizeId = parseInt(req.body && req.body.prizeId, 10);
    const amtRaw = req.body ? req.body.amount : undefined;
    const amount = parseInt(amtRaw, 10);
    if (!teamId || !Number.isFinite(prizeId) || prizeId <= 0
        || amtRaw === undefined || amtRaw === null || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'bad_request' });
    }
    if (!await rateLimit(`wager:${user}`, 1)) return res.status(429).json({ error: 'rate_limited' });
    // P1c: erster Web-Einsatz braucht die sichtbare Kenntnisnahme der
    // Bedingungen (Checkbox). Chat-Einsätze laufen ohne Checkbox — dort
    // steht die Kenntnisnahme in den Bedingungen selbst (Befehl = Teilnahme).
    // Die Instanz haengt am Preis, nicht an der Reihenfolge der Liste —
    // ein Team darf mehrere Los-Giveaways parallel fahren.
    const tbGid = await wte.prizeGiveawayId(teamId, prizeId);
    if (amount > 0 && tbGid && !(req.body && req.body.acceptTerms)) {
      const seen = await pg.query(`SELECT 1 FROM participation_consents
        WHERE team_id=$1 AND session_id=$2 AND username=$3 AND action='wager'`, [teamId, tbGid, user]);
      if (!seen.rowCount) {
        return res.status(428).json({ error: 'terms_required',
          termsUrl: `/viewer/terms?team=${encodeURIComponent(teamId)}` });
      }
    }
    const r = await wte.placeWager(teamId, tbGid, user, prizeId, amount, { source: 'web' });
    if (r.error) return res.status(409).json({ error: r.error });
    // Zustandsändernd ausserhalb der Admin-WS → eigener Audit-Eintrag.
    await audit({ teamId, actor: user, ip: req.ip, action: amount === 0 ? 'wager_retract' : 'wager_set',
                  target: user, detail: { prizeId, amount: amount || undefined,
                                          refunded: r.refunded, stake: r.stake } });
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Echte Dateisignatur statt Browser-MIME (ChatGPT-Review #11): der Client
// kann den Content-Type beliebig behaupten — die Magic Bytes nicht.
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const IMG_TOKEN_RE = /^[a-f0-9]{16,64}$/;

// Bildmaße ohne Bibliothek: PNG aus dem IHDR-Chunk, JPEG aus dem ersten
// SOF-Segment. Nur für die Contest-Auflösungsregel (1080p–4K) — schlägt das
// Parsen fehl, wird abgelehnt (kein gültiges Bild).
function imageDims(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length >= 24) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      const SOF = [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF];
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xFF) { i++; continue; }
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        if (SOF.includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unlesbar → null */ }
  return null;
}
// Betreiber-Vorgabe: 1080p bis 4K (DCI-Breite toleriert).
const RES_MIN_W = 1920, RES_MIN_H = 1080, RES_MAX_W = 4096, RES_MAX_H = 2160;

// ── Preis-Bild (CORE_TicketBuy): Upload nur Team-Mitglieder, sichtbar für
// eingeloggte Zuschauer auf der Setz-Seite. MIME-/Größen-Grenzen wie beim
// Contest. Leeres imageBase64 = Bild entfernen. Nur offene Preise —
// nach der Ziehung ist der Ziehungssatz der Nachweis.
app.post('/api/prize/image', express.json({ limit: '12mb' }), async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const prizeId = parseInt(req.body && req.body.prizeId, 10);
    if (!teamId || !Number.isFinite(prizeId) || prizeId <= 0) return res.status(400).json({ error: 'bad_request' });
    if (!await isMember(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    const pr = await pg.query(`SELECT id, status FROM giveaway_prizes WHERE id=$1 AND team_id=$2`, [prizeId, teamId]);
    if (!pr.rowCount) return res.status(404).json({ error: 'no_prize' });
    if (pr.rows[0].status !== 'open') return res.status(409).json({ error: 'not_open' });
    const b64 = String((req.body && req.body.imageBase64) || '');
    if (!b64) {
      // status='open' auch im UPDATE: zwischen Check und Write kann der
      // Preis gezogen/storniert werden — dann ist er unantastbar.
      const u = await pg.query(
        `UPDATE giveaway_prizes SET image=NULL, image_mime=NULL, image_token=NULL WHERE id=$1 AND status='open'`, [prizeId]);
      if (!u.rowCount) return res.status(409).json({ error: 'not_open' });
      await audit({ teamId, actor: user, ip: req.ip, action: 'prize_image_removed',
                    target: String(prizeId), detail: { prizeId } });
      return res.json({ ok: true, removed: true });
    }
    const ContestCore = CoreRegistry.getCore('CORE_ScreenshotContest');
    const mime = String((req.body && req.body.mime) || '');
    if (!ContestCore.IMAGE_MIMES.includes(mime)) return res.status(400).json({ error: 'bad_mime' });
    let image;
    try { image = Buffer.from(b64, 'base64'); } catch { image = null; }
    if (!image || !image.length) return res.status(400).json({ error: 'no_image' });
    if (image.length > ContestCore.IMAGE_MAX_BYTES) return res.status(413).json({ error: 'image_too_large' });
    if (sniffImage(image) !== mime) return res.status(400).json({ error: 'bad_image' });
    const u = await pg.query(
      `UPDATE giveaway_prizes SET image=$1, image_mime=$2, image_token=$3 WHERE id=$4 AND status='open'`,
      [image, mime, crypto.randomBytes(16).toString('hex'), prizeId]);
    if (!u.rowCount) return res.status(409).json({ error: 'not_open' });
    await audit({ teamId, actor: user, ip: req.ip, action: 'prize_image_set',
                  target: String(prizeId), detail: { prizeId, bytes: image.length, mime } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bewusst nur Login-Gate (kein Team-Check): Preis-Bilder sind Werbe-Inhalt
// der Setz-Seite — Zuschauer sind keine Team-Mitglieder. Die URL trägt einen
// unerratbaren Token (kein Durchprobieren fortlaufender IDs).
app.get('/api/prize/image/:token', async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).end();
    const token = String(req.params.token || '');
    if (!IMG_TOKEN_RE.test(token)) return res.status(400).end();
    const r = await pg.query(`SELECT image_mime, image FROM giveaway_prizes WHERE image_token=$1`, [token]);
    if (!r.rowCount || !r.rows[0].image) return res.status(404).end();
    res.set('Content-Type', r.rows[0].image_mime || 'application/octet-stream')
       .set('Cache-Control', 'private, max-age=300').send(r.rows[0].image);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Interner Ingest-Puls (nur admin-Service, Shared-Secret) ──
// Der admin-Service hat kein Redis, braucht die Zahlen aber für die
// Betriebsseite: kommen von den Kanälen überhaupt viewer_tick an?
app.get('/internal/ingest-pulse', async (req, res) => {
  const key = process.env.INTERNAL_API_KEY || '';
  if (!key || req.get('X-Internal-Key') !== key) return res.status(403).json({ error: 'forbidden' });
  try {
    const out = [];
    const teams = await pg.query(
      `SELECT id, name FROM teams WHERE deactivated_at IS NULL ORDER BY name`);
    for (const t of teams.rows) {
      const pulse = await wte.getIngestPulse(t.id);
      if (!pulse.length) continue;
      const running = (await wte.listGiveaways(t.id)).filter(g => !g.closed).length;
      out.push({ teamId: t.id, teamName: t.name, running, channels: pulse });
    }
    res.json({ teams: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Interner Team-Cleanup (nur admin-Service, Shared-Secret) ──
// Der admin-Service hat kein Redis — Live-State-Aufräumen (Team verlassen /
// Kanal ändern / Team deaktivieren) läuft darum über diesen Endpunkt.
// Fail-closed: ohne INTERNAL_API_KEY (ENV, beide Services identisch) ist er
// tot. Der Pfad ist über Caddy zwar session-gated erreichbar, aber ohne den
// Key nutzlos. Mit channel: nur Ingest-Token dieses Kanals widerrufen +
// Kanal-Cache invalidieren; ohne channel: volles Team-Wipe (Instanzen,
// t:<team>:*-Namespace, alle Tokens). PG-Nachweise bleiben unberührt.
app.post('/internal/team/cleanup', express.json(), async (req, res) => {
  const key = process.env.INTERNAL_API_KEY || '';
  if (!key || req.get('X-Internal-Key') !== key) return res.status(403).json({ error: 'forbidden' });
  try {
    const teamId = sanitizeTeamId(req.body && req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'bad_request' });
    const channel = sanitizeChannel((req.body && req.body.channel) || '');
    if (channel) {
      const k = teamId + '::' + channel;
      const tok = await redis.hget('ingest:team_tokens', k);
      if (tok) { await redis.hdel('ingest:tokens', tok); await redis.hdel('ingest:team_tokens', k); }
      await redis.del(K.gwChannels(teamId));   // Kanalliste sofort neu aus PG lesen
      await audit({ teamId, actor: 'system', action: 'team_channel_cleanup', target: channel,
                    detail: { tokenRevoked: !!tok } });
      return res.json({ ok: true, tokenRevoked: !!tok });
    }
    // Best-effort mit Fehlerliste: ein hängender Schritt darf die übrigen
    // nicht verhindern — der Aufrufer (admin) protokolliert das Ergebnis.
    const errors = [];
    let closed = 0;
    for (const g of await wte.listGiveaways(teamId)) {
      if (!g.gid || g.primary) continue;
      try {
        await wte.closeGiveawayInstance(teamId, g.gid);
        await wte.cleanupGiveawayInstance(teamId, g.gid);
        closed++;
      } catch (e) { errors.push(`instance ${g.gid}: ${e.message}`); }
    }
    try { await wte.resetGiveaway(teamId); }
    catch (e) { errors.push(`reset: ${e.message}`); }
    const map = await redis.hgetall('ingest:team_tokens');
    let tokens = 0;
    for (const [k, tok] of Object.entries(map)) {
      if (!k.startsWith(teamId + '::')) continue;
      try {
        await redis.hdel('ingest:tokens', tok);
        await redis.hdel('ingest:team_tokens', k);
        tokens++;
      } catch (e) { errors.push(`token ${k}: ${e.message}`); }
    }
    await audit({ teamId, actor: 'system', action: 'team_wipe', target: teamId,
                  detail: { instancesClosed: closed, tokensRevoked: tokens,
                            errors: errors.length ? errors : undefined } });
    res.json({ ok: !errors.length, instancesClosed: closed, tokensRevoked: tokens,
               errors: errors.length ? errors : undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Phase 6: Screenshot-Contest (nur eingeloggte Zuschauer) ──
// Anti-Votebot: Twitch-Session + UNIQUE(entry, voter) + Viewtime-Schwelle
// + Rate-Limit. Identität ausschließlich aus X-Auth-User.
async function contestInstance(teamId) {
  return (await wte.listGiveaways(teamId)).find(g => g.core === 'CORE_ScreenshotContest' && g.gid && !g.closed) || null;
}

// Follow-Fallback für die Contest-Seite: das Redis-Flag (chFollows) entsteht
// nur durch Streamerbot-Live-Events — wer der Seite ohne laufenden Ingest
// begegnet, folgt vielleicht längst. Dann einmalig via Helix nachprüfen
// (Owner-Token des Kanals) und das Flag setzen, wie es das Live-Event täte.
// Kanäle ohne eingeloggten Owner liefern null → kein Nachweis, kein Flag.
// Anzeigename des Teams für die Zuschauer-Seiten (Fallback: id).
async function teamName(teamId) {
  try {
    const r = await pg.query('SELECT name FROM teams WHERE id=$1', [teamId]);
    return (r.rowCount && r.rows[0].name) || teamId;
  } catch { return teamId; }
}

async function helixFollowFallback(teamId, gid, user) {
  try {
    if (!helix.configured) return false;
    let chans = null;
    try { const raw = await redis.get(K.gChanList(teamId, gid)); if (raw) chans = JSON.parse(raw); } catch { /* alle */ }
    if (!Array.isArray(chans) || !chans.length) chans = await wte.getChannels(teamId);
    for (const ch of chans) {
      if (await redis.get(K.chFollows(teamId, ch, user)) === '1') return true;
      if (await helix.userFollowsChannel(ch, user) === true) {
        await redis.set(K.chFollows(teamId, ch, user), '1');
        return true;
      }
    }
  } catch (e) { logErr('Helix', 'follow fallback:', e.message); }
  return false;
}

app.get('/api/contest/state', async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.query.team || '');
    const teams = teamId ? [teamId] : await viewerTeams(user, 'CORE_ScreenshotContest');
    const out = [];
    for (const t of teams) {
      const inst = await contestInstance(t);
      if (!inst) continue;
      let elig = await wte._contestEligibility(t, inst.gid, user);
      if (!elig.followsHost && await helixFollowFallback(t, inst.gid, user)) {
        elig = await wte._contestEligibility(t, inst.gid, user);   // Flag gesetzt → neu lesen
      }
      const standings = await wte.getContestStandings(t, inst.gid, { all: true });
      const mine = standings.find(s => s.username === user) || null;
      // Sichtbar für Voter: nur approved; eigene Einsendung immer.
      const entries = [];
      for (const s of standings) {
        if (s.status !== 'approved' && s.username !== user) continue;
        const v = await pg.query(`SELECT score FROM contest_votes WHERE entry_id=$1 AND voter=$2`, [s.entryId, user]);
        entries.push({ ...s, myScore: v.rowCount ? v.rows[0].score : null, own: s.username === user });
      }
      // P1c: schon zugestimmt? Dann zeigt die Seite keine Checkbox mehr.
      const consentSeen = await pg.query(`SELECT 1 FROM participation_consents
        WHERE team_id=$1 AND session_id=$2 AND username=$3 AND action='contest_entry'`, [t, inst.gid, user]);
      out.push({ teamId: t, teamName: await teamName(t), giveawayId: inst.gid,
                 channels: inst.channels || await wte.getChannels(t),
                 voting: await wte.getContestVoting(t, inst.gid),
                 canSubmit: elig.followsHost && elig.watchOk,
                 canVote: elig.watchOk,
                 consented: consentSeen.rowCount > 0,
                 minWatch: elig.minWatch, watchSec: Math.round(elig.watchSec),
                 followsHost: elig.followsHost,
                 myEntry: mine ? { entryId: mine.entryId, title: mine.title, status: mine.status, votes: mine.votes } : null,
                 entries });
    }
    res.json({ user, contests: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 12mb JSON-Limit: 7 MB Binärbild ≈ 9,4 MB Base64 + JSON-Rahmen.
app.post('/api/contest/entry', express.json({ limit: '12mb' }), async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const inst = teamId ? await contestInstance(teamId) : null;
    if (!inst) return res.status(404).json({ error: 'no_contest' });
    const ContestCore = CoreRegistry.getCore('CORE_ScreenshotContest');
    const mime = String(req.body.mime || '');
    if (!ContestCore.IMAGE_MIMES.includes(mime)) return res.status(400).json({ error: 'bad_mime' });
    let image;
    try { image = Buffer.from(String(req.body.imageBase64 || ''), 'base64'); } catch { image = null; }
    if (!image || !image.length) return res.status(400).json({ error: 'no_image' });
    if (image.length > ContestCore.IMAGE_MAX_BYTES) return res.status(413).json({ error: 'image_too_large' });
    if (sniffImage(image) !== mime) return res.status(400).json({ error: 'bad_image' });
    await helixFollowFallback(teamId, inst.gid, user);   // Follow ggf. via Helix nachweisen
    const dims = imageDims(image, mime);
    if (!dims || dims.w < RES_MIN_W || dims.h < RES_MIN_H || dims.w > RES_MAX_W || dims.h > RES_MAX_H) {
      return res.status(400).json({ error: 'bad_resolution',
                                    width: dims ? dims.w : null, height: dims ? dims.h : null });
    }
    if (!await rateLimit(`centry:${user}`, 15)) return res.status(429).json({ error: 'rate_limited' });
    // P1c: Upload braucht die sichtbare Kenntnisnahme der Bedingungen —
    // beim Ersetzen reicht die bereits protokollierte Zustimmung.
    if (!(req.body && req.body.acceptTerms)) {
      const seen = await pg.query(`SELECT 1 FROM participation_consents
        WHERE team_id=$1 AND session_id=$2 AND username=$3 AND action='contest_entry'`,
        [teamId, inst.gid, user]);
      if (!seen.rowCount) {
        return res.status(428).json({ error: 'terms_required',
          termsUrl: `/viewer/terms?team=${encodeURIComponent(teamId)}` });
      }
    }
    const r = await wte.submitContestEntry(teamId, inst.gid, user, {
      title: req.body.title, mime, image, confirmReplace: !!req.body.confirmReplace });
    if (r.error) return res.status(r.error === 'votes_would_be_lost' ? 409 : 403).json(r);
    await audit({ teamId, actor: user, ip: req.ip, action: 'contest_submit', target: user,
                  detail: { giveawayId: inst.gid, replaced: r.replaced, bytes: image.length } });
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contest/vote', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const inst = teamId ? await contestInstance(teamId) : null;
    if (!inst) return res.status(404).json({ error: 'no_contest' });
    const ContestCore = CoreRegistry.getCore('CORE_ScreenshotContest');
    const score = ContestCore.clampScore(req.body.score);
    const entryId = parseInt(req.body.entryId, 10);
    if (!score || !Number.isFinite(entryId)) return res.status(400).json({ error: 'bad_request' });
    // Rate-Limit: max. 1 Vote/Sekunde je Nutzer (Bot-Bremse, UX-neutral).
    const rl = await redis.set(`t:${teamId}:contest:rl:${user}`, '1', 'EX', 1, 'NX');
    if (rl !== 'OK') return res.status(429).json({ error: 'rate_limited' });
    const r = await wte.castContestVote(teamId, inst.gid, user, entryId, score);
    if (r.error) return res.status(403).json(r);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// P6: Laufende Kampagnen-/Sofortverlosungs-Teilnahme selbst zurückziehen —
// entfernt das Opt-in (kein Lostopf mehr), Zuschauzeit bleibt Messwert.
app.post('/api/participation/withdraw', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.body && req.body.team);
    if (!teamId) return res.status(400).json({ error: 'bad_request' });
    if (!await rateLimit(`withdraw:${user}`, 5)) return res.status(429).json({ error: 'rate_limited' });
    const gid = validGid(req.body && req.body.giveawayId);
    if (gid) {
      // Rückzug aus einer Instanz nur für Mechaniken mit Keyword-Opt-in.
      const g = (await wte.listGiveaways(teamId)).find(x => x.gid === gid);
      if (!g) return res.status(404).json({ error: 'unknown_instance' });
      if (g.core === 'CORE_TicketBuy' || g.core === 'CORE_ScreenshotContest') {
        return res.status(409).json({ error: 'use_specific_withdraw' });
      }
    }
    const r = await wte.unregisterUser(teamId, user, gid || undefined);
    if (r.error) return res.status(409).json({ error: r.error });
    await audit({ teamId, actor: user, ip: req.ip, action: 'participation_withdraw', target: user,
                  sessionId: r.giveawayId, detail: { giveawayId: r.giveawayId } });
    res.json({ ok: true, giveawayId: r.giveawayId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Einsendung zurückziehen — nur der Einsender selbst, nur solange der
// Contest läuft. Zeile weg = Bild weg, Stimmen fallen mit (CASCADE).
app.post('/api/contest/withdraw', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const inst = teamId ? await contestInstance(teamId) : null;
    if (!inst) return res.status(404).json({ error: 'no_contest' });
    const r = await wte.withdrawContestEntry(teamId, inst.gid, user);
    if (r.error) return res.status(409).json({ error: r.error });
    await audit({ teamId, actor: user, ip: req.ip, action: 'contest_withdraw', target: user,
                  sessionId: inst.gid, detail: { entryId: r.entryId } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// URL trägt einen unerratbaren Token statt der fortlaufenden ID (kein
// Durchprobieren); die Statusprüfung bleibt als zweite Schicht bestehen.
app.get('/api/contest/image/:token', async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const token = String(req.params.token || '');
    if (!IMG_TOKEN_RE.test(token)) return res.status(400).end();
    const r = await pg.query(`SELECT team_id, username, mime, image, status FROM contest_entries WHERE image_token=$1`, [token]);
    if (!r.rowCount) return res.status(404).end();
    const e = r.rows[0];
    // approved sehen alle Eingeloggten; pending/rejected nur Einsender + Team-Mitglieder.
    if (e.status !== 'approved' && e.username !== user && !await isMember(user, e.team_id)) {
      return res.status(403).end();
    }
    res.set('Content-Type', e.mime).set('Cache-Control', 'private, max-age=300').send(e.image);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/claim/mine', async (req, res) => {
  try {
    const user = sanitizeUsername(reqUser(req) || '');
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const r = await pg.query(`
      SELECT c.id, c.team_id, c.session_id, c.status, c.deadline_at, c.claimed_at, c.purge_at,
             c.real_name, c.email, c.street, c.zip, c.city, c.country, c.note, c.handling,
             d.drawn_at, d.prize, d.winner_coins, d.core, t.name AS team_name
      FROM draw_claims c
      JOIN giveaway_draws d ON d.id = c.draw_id
      LEFT JOIN teams t ON t.id = c.team_id
      WHERE c.winner = $1 ORDER BY d.drawn_at DESC`, [user]);
    // P4: Gewichtssemantik je Mechanik mitliefern — die Claim-Seite soll
    // Einsätze/Scores nicht pauschal "Punkte" nennen.
    res.json({ user, claims: r.rows.map(c => {
      let d = {};
      try { d = CoreRegistry.getCore(c.core).display || {}; } catch { /* Standard */ }
      return { ...c, unit: d.unit !== undefined ? d.unit : 'Punkte', drawKind: d.drawKind || 'weighted',
               overdue: c.status === 'pending' && new Date(c.deadline_at) < new Date() };
    }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Gewinn-Abwicklung (Inbox) — NUR Owner: hier stehen Kontaktdaten ──
app.get('/api/claims', async (req, res) => {
  try {
    const user = reqUser(req);
    const teamId = sanitizeTeamId(req.query.team);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    if (!await ownsTeam(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    const r = await pg.query(`
      SELECT c.id, c.session_id, c.winner, c.status, c.claim_source, c.handling, c.handled_at, c.handled_by,
             c.deadline_at, c.claimed_at, c.purge_at, c.purged_at, c.created_at,
             c.real_name, c.email, c.street, c.zip, c.city, c.country, c.note,
             d.drawn_at, d.prize
      FROM draw_claims c
      JOIN giveaway_draws d ON d.id = c.draw_id
      WHERE c.team_id = $1
      ORDER BY c.created_at DESC LIMIT 500`, [teamId]);
    // Reiner Zugriff auf Kontaktdaten gehört ins Protokoll (wie Archiv/DSGVO).
    await audit({ teamId, actor: user, ip: null, action: 'claims_inbox_view', target: null,
                  detail: { rows: r.rowCount } });
    res.json({ team: teamId,
               claims: r.rows.map(c => ({ ...c,
                 overdue: c.status === 'pending' && new Date(c.deadline_at) < new Date() })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gewinner hat sich AUSSERHALB der Plattform gemeldet (WhatsApp, Discord,
// live im Stream …) — der Owner erfasst das, damit Frist/Abwicklung stimmen.
// claim_source='external' hält den Unterschied zur Selbstmeldung im
// Nachweis fest; Kontaktdaten entstehen dabei keine.
app.post('/api/claims/external', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const claimId = parseInt(req.body && req.body.claimId, 10);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    if (!await ownsTeam(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    if (!Number.isFinite(claimId)) return res.status(400).json({ error: 'bad_request' });
    const r = await pg.query(`
      UPDATE draw_claims SET status='claimed', claimed_at=NOW(), claim_source='external'
      WHERE id=$1 AND team_id=$2 AND status IN ('pending','expired')
      RETURNING id, winner`, [claimId, teamId]);
    if (!r.rowCount) return res.status(409).json({ error: 'not_open_or_missing' });
    await audit({ teamId, actor: user, ip: req.ip, action: 'claim_external', target: r.rows[0].winner,
                  detail: { claimId } });
    res.json({ ok: true, claimId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const CLAIM_HANDLING = new Set(['contacted', 'shipped', 'done']);
app.post('/api/claims/handling', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const claimId = parseInt(req.body && req.body.claimId, 10);
    const handling = req.body && req.body.handling ? String(req.body.handling) : null;
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    if (!await ownsTeam(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    if (!Number.isFinite(claimId) || (handling !== null && !CLAIM_HANDLING.has(handling))) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const r = await pg.query(`
      UPDATE draw_claims SET handling=$1, handled_at=NOW(), handled_by=$2
      WHERE id=$3 AND team_id=$4 RETURNING id, winner, handling`, [handling, user, claimId, teamId]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await audit({ teamId, actor: user, ip: req.ip, action: 'claim_handling', target: r.rows[0].winner,
                  detail: { claimId, handling } });
    res.json({ ok: true, claimId, handling });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Kontaktdaten sofort löschen (Abwicklung fertig) — Ziehungsnachweis bleibt.
app.post('/api/claims/purge', express.json(), async (req, res) => {
  try {
    const user = reqUser(req);
    const teamId = sanitizeTeamId(req.body && req.body.team);
    const claimId = parseInt(req.body && req.body.claimId, 10);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    if (!await ownsTeam(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    if (!Number.isFinite(claimId)) return res.status(400).json({ error: 'bad_request' });
    const r = await pg.query(`
      UPDATE draw_claims
      SET real_name=NULL, email=NULL, street=NULL, zip=NULL, city=NULL, country=NULL,
          note=NULL, claim_ip=NULL, purged_at=NOW()
      WHERE id=$1 AND team_id=$2 AND purged_at IS NULL RETURNING id, winner`, [claimId, teamId]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await audit({ teamId, actor: user, ip: req.ip, action: 'claim_purge', target: r.rows[0].winner,
                  detail: { claimId } });
    res.json({ ok: true, claimId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claim', express.json(), async (req, res) => {
  const user = sanitizeUsername(reqUser(req) || '');
  const id   = parseInt(req.body && req.body.id);
  try {
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    if (!await rateLimit(`claim:${user}`, 5)) return res.status(429).json({ error: 'rate_limited' });
    const cur = await pg.query('SELECT id, team_id, session_id, status, handling, deadline_at FROM draw_claims WHERE id=$1 AND winner=$2', [id, user]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Keine Gewinnmeldung fuer dich unter dieser Nummer' });
    const c = cur.rows[0];
    if (c.status === 'replaced') {
      return res.status(410).json({ error: 'Fuer diese Ziehung wurde bereits ein Ersatzgewinner gezogen' });
    }
    if (new Date(c.deadline_at) < new Date()) {
      await audit({ teamId: c.team_id, actor: user, ip: req.ip, action: 'claim_submit', target: user,
                    result: 'denied', detail: { claimId: id, reason: 'deadline_passed' } });
      return res.status(410).json({ error: 'Die Meldefrist ist abgelaufen' });
    }
    // P6: Korrektur nur solange der Veranstalter die Meldung noch nicht
    // bearbeitet (kontaktiert/versendet/erledigt) — danach ist sie fixiert.
    if (c.handling) {
      await audit({ teamId: c.team_id, actor: user, ip: req.ip, action: 'claim_submit', target: user,
                    result: 'denied', detail: { claimId: id, reason: 'already_handled', handling: c.handling } });
      return res.status(409).json({ error: 'Der Veranstalter bearbeitet deine Meldung bereits — Aenderungen bitte direkt mit ihm klaeren' });
    }
    if (!req.body.acceptTerms) return res.status(400).json({ error: 'Bitte die Teilnahmebedingungen bestaetigen' });

    const vals = {};
    for (const [k, max] of Object.entries(CLAIM_FIELDS)) vals[k] = sanitizeStr(req.body[k] || '', max) || null;
    if (!vals.real_name) return res.status(400).json({ error: 'Name fehlt' });
    if (!vals.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(vals.email)) {
      return res.status(400).json({ error: 'E-Mail-Adresse sieht nicht gueltig aus' });
    }
    // P1b: massgeblich ist die beim Start der Session eingefrorene Fassung;
    // nur wenn keine vorliegt (Altbestand), die aktuell juengste des Teams.
    let tv = { rows: [{}] };
    try {
      const sv = c.session_id
        ? await pg.query('SELECT terms_version AS v FROM sessions WHERE id=$1 AND terms_version > 0', [c.session_id])
        : { rowCount: 0 };
      tv = sv.rowCount ? sv
         : await pg.query('SELECT MAX(version) AS v FROM terms_versions WHERE team_id=$1', [c.team_id]);
    } catch { /* Fallback unten: null */ }
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
      SELECT s.id, s.keyword, s.channels, s.opened_at, s.closed_at, s.core,
             s.total_participants, s.total_coins,
             (SELECT COUNT(*)::int FROM giveaway_draws d WHERE d.session_id = s.id AND NOT d.is_test) AS draws,
             (SELECT COUNT(*)::int FROM giveaway_draws d WHERE d.session_id = s.id AND d.is_test)     AS test_draws,
             (SELECT STRING_AGG(d.winner, ', ' ORDER BY d.drawn_at)
                FROM giveaway_draws d WHERE d.session_id = s.id AND NOT d.is_test)                    AS winners,
             (SELECT COUNT(*)::int FROM draw_claims c WHERE c.session_id = s.id AND c.status='claimed') AS claimed
      FROM sessions s WHERE s.team_id = $1
      ORDER BY s.opened_at DESC LIMIT 200`, [teamId]);
    // ── Kampagnen-Klammer: Auto-Open legte (vor dem Core-Umbau) je
    // Stream-Start eine NEUE Sitzung an, während der Coin-Bestand team-weit
    // durchlief. Für den Nachweis gehören diese Sitzungen zusammen.
    // Eine Gruppe endet mit der Sitzung, die geschlossen wurde UND eine
    // echte Ziehung hat (der Bestand ist damit verlost) — oder wenn
    // zwischendurch ein gw_reset lag. Instanz-Mechaniken bleiben einzeln.
    let campaigns = [];
    try {
      const resets = await pg.query(
        `SELECT ts FROM audit_log WHERE team_id=$1 AND action='gw_reset' AND result='ok' ORDER BY ts`, [teamId]);
      const resetTs = resets.rows.map(x => new Date(x.ts).getTime());
      const camp = r.rows.filter(s => !s.core || s.core === 'CORE_WatchtimeChatActivity')
        .slice().sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
      let cur = null;
      for (const s of camp) {
        const t = new Date(s.opened_at).getTime();
        if (cur && resetTs.some(x => x > cur.lastOpen && x < t)) { campaigns.push(cur); cur = null; }
        if (!cur) cur = { sessions: [], from: s.opened_at, to: null, draws: 0, winners: [], lastOpen: 0 };
        cur.sessions.push(s.id);
        cur.lastOpen = t;
        cur.to = s.closed_at || s.opened_at;
        cur.draws += Number(s.draws) || 0;
        if (s.winners) cur.winners.push(s.winners);
        cur.endCoins = s.total_coins;
        if (s.closed_at && Number(s.draws) > 0) { campaigns.push(cur); cur = null; }
      }
      if (cur) campaigns.push(cur);
      for (const c of campaigns) {
        delete c.lastOpen;
        const [act, tn] = await Promise.all([
          pg.query(`SELECT MIN(ts) AS f, MAX(ts) AS l FROM watchtime_events WHERE session_id = ANY($1)`, [c.sessions]),
          pg.query(`SELECT COUNT(DISTINCT username)::int AS n FROM campaign_participation WHERE session_id = ANY($1)`, [c.sessions]),
        ]);
        if (act.rows[0] && act.rows[0].f) { c.dataFrom = act.rows[0].f; c.dataTo = act.rows[0].l; }
        c.participants = tn.rows[0] ? tn.rows[0].n : 0;
      }
      campaigns.reverse();
    } catch (e) { logErr('GW', 'campaign grouping:', e.message); campaigns = []; }
    // P3: Mechanik-Badges für die Liste aus dem Core-Vertrag.
    const sessionsOut = r.rows.map(s => {
      let d = {}, label = null;
      try { const c = CoreRegistry.getCore(s.core); d = c.display || {}; label = c.label; } catch { /* Kampagne */ }
      return { ...s, coreLabel: label || 'Kampagne', coreIcon: d.icon || '📈',
               coreUnit: d.unit !== undefined ? d.unit : 'Punkte', drawKind: d.drawKind || 'weighted' };
    });
    res.json({ team: teamId, sessions: sessionsOut, campaigns });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Kumuliertes Kampagnen-Dossier über mehrere Sitzungen. Die Teilnahme-
// Snapshots sind je Sitzung bereits KUMULATIV (Redis-Bestand beim Close) —
// darum zählt je (Zuschauer, Kanal) das MAXIMUM (= Endstand), keine Summe.
app.get('/api/archive/campaign', async (req, res) => {
  try {
    const teamId = sanitizeTeamId(req.query.team);
    const user = reqUser(req);
    if (!await isMember(user, teamId)) return res.status(403).json({ error: 'forbidden' });
    const owner = await ownsTeam(user, teamId);
    const ids = String(req.query.sessions || '').split(',')
      .map(s => sanitizeStr(s, 60).trim()).filter(Boolean).slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: 'bad_request' });
    const ses = await pg.query(
      `SELECT id, keyword, channels, opened_at, closed_at, prize, sponsor
       FROM sessions WHERE team_id=$1 AND id = ANY($2) ORDER BY opened_at`, [teamId, ids]);
    if (!ses.rowCount) return res.status(404).json({ error: 'not_found' });
    const vids = ses.rows.map(x => x.id);
    const contact = owner ? 'c.real_name, c.email, c.street, c.zip, c.city, c.country, c.note,' : '';
    const [participation, draws, claims, activity] = await Promise.all([
      pg.query(`SELECT username, channel, MAX(watch_sec)::bigint AS watch_sec, MAX(msgs)::int AS msgs,
                       MAX(coins) AS coins, BOOL_OR(follows) AS follows, BOOL_OR(valid) AS valid
                FROM campaign_participation WHERE session_id = ANY($1)
                GROUP BY username, channel ORDER BY MAX(coins) DESC, username`, [vids]).then(r => r.rows),
      pg.query(`SELECT id, session_id, winner, winner_coins, winner_watch_sec, total_coins, eligible_count,
                       rand_value, draw_index, is_test, prize, drawn_at
                FROM giveaway_draws WHERE session_id = ANY($1) ORDER BY drawn_at`, [vids]).then(r => r.rows),
      pg.query(`SELECT c.id, c.session_id, c.winner, c.status, c.claim_source, c.handling,
                       c.deadline_at, c.claimed_at, c.terms_version, c.purge_at, c.purged_at, ${contact} c.created_at
                FROM draw_claims c WHERE c.session_id = ANY($1) ORDER BY c.created_at`, [vids]).then(r => r.rows),
      pg.query(`SELECT MIN(ts) AS first_event, MAX(ts) AS last_event, COUNT(*)::bigint AS events
                FROM watchtime_events WHERE session_id = ANY($1)`, [vids]).then(r => r.rows[0] || null),
    ]);
    res.json({ sessions: ses.rows, participation, draws, claims, activity, contactVisible: owner });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Volles Dossier zu einer Sitzung. Kontaktdaten des Gewinners sieht nur der
// Owner — Members bekommen dieselbe Seite ohne diese Felder.
async function archiveDossier(teamId, sessionId, withContact) {
  const q = (sql, p) => pg.query(sql, p).then(r => r.rows).catch(() => []);
  const contact = withContact
    ? 'c.real_name, c.email, c.street, c.zip, c.city, c.country, c.note, c.claim_ip,'
    : '';
  const [session, draws, participation, claims, auditRows, activity, consents] = await Promise.all([
    q(`SELECT * FROM sessions WHERE id=$1 AND team_id=$2`, [sessionId, teamId]),
    q(`SELECT id, winner, winner_coins, winner_watch_sec, total_coins, eligible_count,
              rand_value, draw_index, is_test, prize, drawn_at, eligible_snapshot, core, prize_id,
              reroll_of, reroll_reason
       FROM giveaway_draws WHERE session_id=$1 ORDER BY drawn_at`, [sessionId]),
    q(`SELECT username, channel, watch_sec, msgs, coins, follows, valid
       FROM campaign_participation WHERE session_id=$1 ORDER BY coins DESC, username`, [sessionId]),
    q(`SELECT c.id, c.draw_id, c.winner, c.status, c.claim_source, c.handling, c.handled_at,
              c.deadline_at, c.claimed_at,
              c.terms_version, c.purge_at, c.purged_at, ${contact} c.created_at
       FROM draw_claims c WHERE c.session_id=$1 ORDER BY c.created_at`, [sessionId]),
    q(`SELECT id, ts, actor, actor_ip, action, target, result, detail
       FROM audit_log WHERE session_id=$1 ORDER BY ts LIMIT 50000`, [sessionId]),
    // Tatsächlicher Datenzeitraum: opened_at kann bei migrierten Kampagnen
    // jünger sein als die ältesten Viewtime-Events (Altbestand vor dem
    // Core-Umbau) — das Dossier zeigt darum beides.
    q(`SELECT MIN(ts) AS first_event, MAX(ts) AS last_event, COUNT(*)::bigint AS events
       FROM watchtime_events WHERE session_id=$1`, [sessionId]),
    // P1c: Kenntnisnahme-Protokoll (verdichtet — wer wann welcher Fassung
    // zugestimmt hat, steht personenbezogen in participation_consents).
    q(`SELECT action, COUNT(*)::int AS n, MIN(created_at) AS first, MAX(created_at) AS last
       FROM participation_consents WHERE session_id=$1 GROUP BY action ORDER BY action`, [sessionId]),
  ]);
  // P3: mechanik-spezifische Dossier-Teile — TicketBuy (Preise, Einsätze,
  // Guthaben-Buchungen) und Contest (Einsendungen, Voting) waren bisher
  // nicht Teil des Nachweises.
  const core = session[0] ? (session[0].core || 'CORE_WatchtimeChatActivity') : null;
  const extras = {};
  if (core === 'CORE_TicketBuy') {
    extras.prizes = await q(
      `SELECT id, title, sponsor, description, status, wager_end, created_at
       FROM giveaway_prizes WHERE session_id=$1 ORDER BY id`, [sessionId]);
    extras.wagers = await q(
      `SELECT w.prize_id, w.username, w.amount, w.created_at
       FROM prize_wagers w JOIN giveaway_prizes p ON p.id = w.prize_id
       WHERE p.session_id=$1 ORDER BY w.created_at`, [sessionId]);
    extras.ledger = await q(
      `SELECT username, entry_type, amount, ref_prize, created_at FROM credit_ledger
       WHERE ref_session=$1
          OR ref_prize IN (SELECT id FROM giveaway_prizes WHERE session_id=$1)
       ORDER BY created_at`, [sessionId]);
  } else if (core === 'CORE_ScreenshotContest') {
    extras.entries = await q(
      `SELECT e.id, e.username, e.title, e.status, e.created_at,
              COALESCE(SUM(v.score),0)::int AS score, COUNT(v.id)::int AS votes
       FROM contest_entries e LEFT JOIN contest_votes v ON v.entry_id = e.id
       WHERE e.session_id=$1 GROUP BY e.id
       ORDER BY score DESC, votes DESC, e.id`, [sessionId]);
    extras.voteStats = (await q(
      `SELECT COUNT(*)::int AS votes, COUNT(DISTINCT voter)::int AS voters
       FROM contest_votes WHERE session_id=$1`, [sessionId]))[0] || null;
  }
  let coreMeta = null;
  try {
    const c = CoreRegistry.getCore(core);
    coreMeta = { label: c.label, ...(c.display || {}) };
  } catch { /* Kampagne / unbekannt */ }
  return { session: session[0] || null, draws, participation, claims, audit: auditRows,
           activity: activity[0] || null, consents, coreMeta, ...extras };
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
    if (!await rateLimit(`archexp:${teamId}`, 10)) return res.status(429).json({ error: 'rate_limited' });
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
      // P3: mechanik-spezifische Nachweise (nur vorhanden, wenn befüllt).
      { name: 'preise.csv',         content: toCsv(d.prizes || []) },
      { name: 'einsaetze.csv',      content: toCsv(d.wagers || []) },
      { name: 'guthaben.csv',       content: toCsv(d.ledger || []) },
      { name: 'einsendungen.csv',   content: toCsv(d.entries || []) },
      { name: 'zustimmungen.csv',   content: toCsv(d.consents || []) },
    ].filter(f => f.content);

    const manifest = [
      'CC-Giveaway — Archiv eines abgeschlossenen Giveaways',
      '',
      `Team:        ${teamId}`,
      `Sitzung:     ${sid}`,
      `Mechanik:    ${(d.coreMeta && d.coreMeta.label) || d.session.core || 'Kampagne'}`,
      `Bedingungen: ${d.session.terms_version > 0
        ? `Fassung ${d.session.terms_version} (öffentlich: /viewer/terms?team=${teamId}&version=${d.session.terms_version})`
        : 'Standard-Vorlage (Fassung nicht eingefroren)'}`,
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
// P2: "Meine Teilnahmen" — CORE-übergreifender Selbstauskunfts-Endpunkt.
// Je Team: Kampagnen-Stand (wie bisher), aktive Instanzen mit mechanik-
// spezifischem Eigen-Status, Los-Guthaben samt Journal (auch ohne laufende
// Instanz) und die eigene Contest-Historie (inkl. Bild-Token nach Ende).
app.get('/api/my-status', async (req, res) => {
  try {
    const user = reqUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const teamIds = await wte.getUserTeams(user);
    const out = [];
    for (const t of teamIds) {
      const a = await wte.getUserAggregate(t, user);
      const nr = await pg.query('SELECT name FROM teams WHERE id=$1', [t]);
      if (!nr.rowCount) continue;
      let chance = 0;
      if (a.eligible) {
        const all = await wte.getAllParticipants(t);
        const pool = all.filter(p => p.eligible).reduce((s, p) => s + p.totalCoins, 0);
        chance = pool > 0 ? (a.totalCoins / pool * 100) : 0;
      }
      // Aktive Sekundär-Instanzen mit Eigen-Status je Mechanik.
      const giveaways = [];
      for (const g of await wte.listGiveaways(t)) {
        if (g.primary || g.closed) continue;   // geschlossen = fuer Zuschauer vorbei
        let d = {}, label = g.core;
        try { const c = CoreRegistry.getCore(g.core); d = c.display || {}; label = c.label; } catch { /* Fallback */ }
        const row = { gid: g.gid, core: g.core, label, icon: d.icon || '🎁',
                      unit: d.unit !== undefined ? d.unit : 'Punkte', drawKind: d.drawKind || 'weighted',
                      name: g.name || null, keyword: g.keyword || null, paused: !!g.paused };
        if (g.core === 'CORE_CurrentViewers') {
          const me = (await wte.getInstantParticipants(t, g.gid)).find(p => p.username === user);
          const end = parseInt(await redis.get(K.gWinEnd(t, g.gid)), 10);
          row.instant = {
            registered: !!me, present: !!(me && me.present), eligible: !!(me && me.eligible),
            windowOpen: Number.isFinite(end) && end * 1000 > Date.now(),
            windowEndsIn: (Number.isFinite(end) && end * 1000 > Date.now())
              ? end - Math.floor(Date.now() / 1000) : null,
          };
        } else if (g.core === 'CORE_TicketBuy') {
          const prizes = await wte.listPrizes(t, { gid: g.gid, openOnly: false });
          const withStake = [];
          for (const p of prizes) {
            withStake.push({ id: p.id, title: p.title, status: p.status, wagerEnd: p.wager_end,
                             totalStake: p.total_stake, myStake: await wte.prizeStake(p.id, user) });
          }
          // Persönlicher Ergebnisstatus je Preis: offen / gewonnen /
          // nicht gewonnen (nur wenn gesetzt) / storniert.
          const pids = withStake.map(p => p.id);
          if (pids.length) {
            const dr = await pg.query(
              `SELECT prize_id, winner FROM giveaway_draws WHERE prize_id = ANY($1) AND NOT is_test`, [pids]);
            const wonBy = new Map(dr.rows.map(r => [parseInt(r.prize_id), r.winner]));
            for (const p of withStake) {
              if (p.status === 'cancelled')  p.myResult = 'storniert';
              else if (p.status === 'drawn') p.myResult = wonBy.get(p.id) === user ? 'gewonnen'
                                            : (Number(p.myStake) > 0 ? 'nicht_gewonnen' : null);
              else                           p.myResult = 'offen';
            }
          }
          row.ticketBuy = { balance: await wte.availableCredit(t, user), prizes: withStake };
        } else if (g.core === 'CORE_ScreenshotContest') {
          const standings = await wte.getContestStandings(t, g.gid, { all: true });
          const approved = standings.filter(s => s.status === 'approved');
          const mine = standings.find(s => s.username === user) || null;
          const mv = await pg.query(
            `SELECT COUNT(*)::int AS n FROM contest_votes WHERE session_id=$1 AND voter=$2`, [g.gid, user]);
          row.contest = {
            voting: await wte.getContestVoting(t, g.gid),
            myVotes: mv.rows[0].n,
            myEntry: mine ? { title: mine.title, status: mine.status, score: mine.score, votes: mine.votes,
                              rank: mine.status === 'approved'
                                ? approved.findIndex(s => s.entryId === mine.entryId) + 1 : null,
                              imageToken: mine.imageToken } : null,
          };
        }
        giveaways.push(row);
      }
      // Los-Guthaben: bleibt team-weit über Instanzen hinweg bestehen —
      // Journal = verständliche Guthabenhistorie (Beleg je Buchung).
      let credit = null;
      try {
        const bal = await wte.credit.balance(t, user);
        const stmt = await wte.credit.statement(t, user, 15);
        if (bal !== 0 || stmt.length) credit = { balance: bal, statement: stmt };
      } catch { /* kein Guthaben-Journal */ }
      // Eigene Contest-Historie (auch abgeschlossene Contests, Bild bleibt
      // über den Token erreichbar, solange die Einsendung gespeichert ist).
      const hist = await pg.query(`
        SELECT e.session_id, e.title, e.status, e.created_at, e.image_token,
               COALESCE(SUM(v.score),0)::int AS score, COUNT(v.id)::int AS votes,
               s.closed_at, s.prize
        FROM contest_entries e
        LEFT JOIN contest_votes v ON v.entry_id = e.id
        LEFT JOIN sessions s ON s.id = e.session_id
        WHERE e.team_id=$1 AND e.username=$2
        GROUP BY e.id, s.closed_at, s.prize
        ORDER BY e.created_at DESC LIMIT 10`, [t, user]);
      // Kenntnisnahmen: welche Bedingungen-Fassung hat die Person wann
      // akzeptiert (je Giveaway die erste Aktion) — Beleg auf der Statusseite.
      const myConsents = await pg.query(`
        SELECT session_id, action, terms_version, created_at
        FROM participation_consents WHERE team_id=$1 AND username=$2
        ORDER BY created_at DESC LIMIT 5`, [t, user]);
      const hasAny = a.totalCoins > 0 || a.registered || giveaways.length || credit || hist.rowCount
                   || myConsents.rowCount;
      if (!hasAny) continue;   // veraltet/leer überspringen
      out.push({ teamId: t, name: nr.rows[0].name, coins: a.totalCoins, watchSec: a.totalWatchSec,
                 channelsQualified: a.channelsQualified, followMin: a.followMin, drawMinSec: a.drawMinSec,
                 registered: a.registered, eligible: a.eligible,
                 chance, open: await wte.isOpen(t), paused: await wte.isPaused(t), perChannel: a.perChannel,
                 giveaways, credit, contestHistory: hist.rows, consents: myConsents.rows });
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
      : 'd.id, d.session_id, d.winner, d.winner_coins, d.total_coins, d.eligible_count, d.rand_value, d.draw_index, d.is_test, d.prize, d.drawn_at, d.core, d.prize_id';
    const r = await pg.query(`SELECT ${cols} FROM giveaway_draws d JOIN sessions s ON s.id=d.session_id
                              WHERE s.team_id=$1 ORDER BY d.drawn_at DESC LIMIT $2`, [teamId, limit]);
    // P4: Semantik je Zeile aus dem Core-Vertrag — die Historie soll Einsätze,
    // Scores und Sofortverlosungen nicht pauschal als "Coins" beschriften.
    res.json(r.rows.map(row => {
      let d = {};
      try { d = CoreRegistry.getCore(row.core).display || {}; } catch { /* Standard */ }
      return { ...row, unit: d.unit !== undefined ? d.unit : 'Punkte',
               drawKind: d.drawKind || 'weighted' };
    }));
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
  // Gewinn ist Pflichtangabe je Giveaway, Sponsor/Bereitsteller optional
  // (Transparenz gegenüber Teilnehmern; Bestand bleibt NULL-tolerant).
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prize TEXT`);
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sponsor TEXT`);
  // P1b: Welche Bedingungen-Fassung galt beim Start dieser Session
  // (terms_versions des admin-Service; 0/NULL = Vorlage ohne Snapshot).
  await pg.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS terms_version INTEGER`);
  // P1c: Kenntnisnahme/Zustimmung je Teilnehmeraktion — append-only, die
  // ERSTE Aktion je (Session, Nutzer, Aktion) zählt (ON CONFLICT DO NOTHING).
  // Personenbezogen → collectSubjectData()/eraseSubject() im admin-Service
  // sind mitgezogen (Pseudonymisierung statt Löschung, Art. 17 Abs. 3 lit. e).
  await pg.query(`
    CREATE TABLE IF NOT EXISTS participation_consents (
      id BIGSERIAL PRIMARY KEY,
      team_id       TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      core          TEXT,
      username      TEXT NOT NULL,
      action        TEXT NOT NULL,
      terms_version INTEGER,
      source        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team_id, session_id, username, action))`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_consents_user ON participation_consents(username)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_consents_session ON participation_consents(session_id)`);
  await pg.query(`ALTER TABLE giveaway_prizes ADD COLUMN IF NOT EXISTS sponsor TEXT`);
  // Preis-Bild fürs Formular/Setz-Seite (Roadmap-Feinschliff) — BYTEA wie
  // beim Contest, Grenzen (MIME/Größe) identisch. Kein Personenbezug.
  await pg.query(`ALTER TABLE giveaway_prizes ADD COLUMN IF NOT EXISTS image BYTEA`);
  await pg.query(`ALTER TABLE giveaway_prizes ADD COLUMN IF NOT EXISTS image_mime TEXT`);
  // Unerratbare Bild-URLs (ChatGPT-Review #8): Token statt fortlaufender ID.
  // Backfill für Bestandszeilen — sonst wären alte Bilder unerreichbar.
  await pg.query(`ALTER TABLE giveaway_prizes ADD COLUMN IF NOT EXISTS image_token TEXT`);
  await pg.query(`ALTER TABLE contest_entries ADD COLUMN IF NOT EXISTS image_token TEXT`);
  for (const tbl of ['giveaway_prizes', 'contest_entries']) {
    const need = await pg.query(
      tbl === 'giveaway_prizes'
        ? `SELECT id FROM giveaway_prizes WHERE image IS NOT NULL AND image_token IS NULL`
        : `SELECT id FROM contest_entries WHERE image_token IS NULL`);
    for (const row of need.rows) {
      await pg.query(`UPDATE ${tbl} SET image_token=$1 WHERE id=$2`,
        [crypto.randomBytes(16).toString('hex'), row.id]);
    }
  }
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_prizes_imgtok ON giveaway_prizes(image_token)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_entries_imgtok ON contest_entries(image_token)`);
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS core TEXT`);
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS prize_id BIGINT`);
  // P6: Ersatzziehung ist mit der Ursprungsziehung verknüpft (statt einer
  // unverbundenen Neuziehung) — inkl. Grund; der alte Claim wird 'replaced'.
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS reroll_of BIGINT`);
  await pg.query(`ALTER TABLE giveaway_draws ADD COLUMN IF NOT EXISTS reroll_reason TEXT`);
  // Phase 4a (CORE_TicketBuy, §5.2/§10.1): team-weites Guthaben-Journal,
  // append-only. Kontostand = SUM(amount); Korrekturen nur per Gegenbuchung.
  // Personenbezogen → collectSubjectData()/eraseSubject() im admin-Service
  // und runRetention() (Verfall nach Inaktivität) sind mitgezogen.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id BIGSERIAL PRIMARY KEY,
      team_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      entry_type  TEXT NOT NULL,
      amount      NUMERIC(12,4) NOT NULL,
      ref_session TEXT,
      ref_prize   BIGINT,
      detail      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_ledger(team_id, username, created_at DESC)`);
  // Phase 4b (CORE_TicketBuy): Preise + Einsätze. prize_wagers ist append-only
  // (Rücknahme = negative Zeile) und personenbezogen → DSGVO-Pfade im
  // admin-Service sind mitgezogen.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS giveaway_prizes (
      id BIGSERIAL PRIMARY KEY,
      team_id     TEXT NOT NULL,
      session_id  TEXT,
      title       TEXT NOT NULL,
      description TEXT,
      wager_end   TIMESTAMPTZ,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_prizes_team ON giveaway_prizes(team_id, status)`);
  // Chat-Ansagen-Vorlagen (18.8.26): eigener Text je (Team, Core, Nachricht),
  // Katalog + Rendering in chat-texts.js. Kein Personenbezug.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS chat_templates (
      team_id      TEXT NOT NULL,
      core         TEXT NOT NULL,
      msg_key      TEXT NOT NULL,
      text         TEXT NOT NULL,
      append_terms BOOLEAN NOT NULL DEFAULT FALSE,
      append_page  BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, core, msg_key))`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS prize_wagers (
      id BIGSERIAL PRIMARY KEY,
      prize_id   BIGINT NOT NULL REFERENCES giveaway_prizes(id) ON DELETE CASCADE,
      team_id    TEXT NOT NULL,
      username   TEXT NOT NULL,
      amount     NUMERIC(12,4) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_wagers_prize ON prize_wagers(prize_id, username)`);
  // Phase 6 (CORE_ScreenshotContest, §5.4): Einsendungen (Bild als BYTEA,
  // Backup-Container sichert mit) + Votes. UNIQUE(session_id, username) =
  // eine Einsendung pro Person; UNIQUE(entry_id, voter) = eine Stimme je
  // (Voter, Screenshot) — strukturell max. n Votes bei n Votern.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS contest_entries (
      id BIGSERIAL PRIMARY KEY,
      team_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      username   TEXT NOT NULL,
      title      TEXT,
      mime       TEXT NOT NULL,
      image      BYTEA NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, username))`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_entries_session ON contest_entries(session_id, status)`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS contest_votes (
      id BIGSERIAL PRIMARY KEY,
      entry_id   BIGINT NOT NULL REFERENCES contest_entries(id) ON DELETE CASCADE,
      team_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      voter      TEXT NOT NULL,
      score      INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entry_id, voter))`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_votes_session ON contest_votes(session_id, voter)`);
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
  // Gewinn-Abwicklung (Inbox): operativer Stand zusätzlich zum Claim-Status —
  // status sagt, was der GEWINNER getan hat (pending/claimed/expired),
  // handling sagt, was der VERANSTALTER getan hat (contacted/shipped/done).
  await pg.query(`ALTER TABLE draw_claims ADD COLUMN IF NOT EXISTS handling   TEXT`);
  await pg.query(`ALTER TABLE draw_claims ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ`);
  await pg.query(`ALTER TABLE draw_claims ADD COLUMN IF NOT EXISTS handled_by TEXT`);
  // 'external' = Owner hat eine Meldung außerhalb der Plattform erfasst
  // (WhatsApp/Discord/live) — im Nachweis von der Selbstmeldung unterscheidbar.
  await pg.query(`ALTER TABLE draw_claims ADD COLUMN IF NOT EXISTS claim_source TEXT`);
  // Entwürfe: Giveaway vor dem Stream vorbereiten (Team-weit, Owner-only).
  // Kein Personenbezug — config enthält nur die Formularwerte des Modals.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS giveaway_drafts (
      id BIGSERIAL PRIMARY KEY,
      team_id    TEXT NOT NULL,
      config     JSONB NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_drafts_team ON giveaway_drafts(team_id)`);
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
  subscribeToPanel();
  // Zeitgeber nur, wenn diese Instanz sie fahren soll (RUN_SCHEDULER).
  if (CFG.runScheduler) {
    startWatchtimeTicker();
    startInstantWatcher();
    startRetentionJob();
  } else {
    log('Sched', 'RUN_SCHEDULER=false — Ticker, Sofort-Watcher und Retention laufen auf einer anderen Instanz');
  }
  server.listen(CFG.port, () => log('Giveaway', `Service on port ${CFG.port}`));
}

// Ein Boost ueberlebt den Neustart (Redis-TTL), die Merkliste im Speicher nicht.
// Ohne dieses Nachziehen bliebe das Boost-Ende nach einem Deploy stumm.
async function seedBoostWatch() {
  try {
    const r = await pg.query('SELECT id FROM teams');
    for (const row of r.rows) {
      const t = row.id;
      const gids = [null, ...(await wte.listGiveaways(t)).filter(g => !g.closed && g.gid).map(g => g.gid)];
      for (const gid of gids) {
        const st = await wte.multiplierState(t, gid);
        if (st.factor > 1) boostAnnounced.set(`${t}|${gid || ''}`, { teamId: t, gid, factor: st.factor });
      }
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

// ── Phase 3: Sofortverlosungs-Watcher ─────────────────────
// Das Zeitfenster ist NUR die Anmeldephase (Keyword + Anwesenheit) — die
// Ziehung macht der Streamer ausdrücklich selbst (★ im Panel), und es kann
// mehrere Fenster geben. Der Watcher schließt abgelaufene Fenster mit
// Chat-Ansage; sonst passiert nichts automatisch.
let instantBusy = false;
function startInstantWatcher() {
  setInterval(async () => {
    if (instantBusy) return;   // kein Überlappen bei langsamer Runde
    instantBusy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const t of await wte.listOpenTeams()) {
        for (const g of await wte.listGiveaways(t)) {
          if (g.primary || !g.windowEndsAt || g.windowEndsAt > now) continue;
          await closeInstantWindow(t, g);
        }
      }
    } catch(e) { logErr('Instant', e.message); }
    finally { instantBusy = false; }
  }, 5000);
  log('Instant', 'Sofortverlosungs-Watcher gestartet (5s, schließt nur Fenster — Ziehung ist manuell)');
}

async function closeInstantWindow(teamId, g) {
  await redis.del(K.gWinEnd(teamId, g.gid));
  const rows = await wte.getInstantParticipants(teamId, g.gid);
  const n = rows.filter(p => p.eligible).length;
  if (g.announce !== false) await announceChannels(teamId, g.channels,
    await chatText(teamId, 'CORE_CurrentViewers', 'windowClosed', { anzahl: n }));
  // Angemeldet, aber keiner anwesend? Dann fehlen die viewer_tick — das
  // Panel soll das sehen, bevor der Streamer live auf ★ drueckt.
  let pulse = [];
  try { pulse = await wte.getIngestPulse(teamId, g.channels); } catch { /* Warnung entfaellt */ }
  broadcastTeam(teamId, { event: 'gw_ack', type: 'instant_window_closed', giveawayId: g.gid, eligible: n,
                          registered: rows.length, ingestPulse: pulse,
                          ingestStale: pulse.filter(x => x.stale).map(x => x.channel) });
  await audit({ teamId, actor: 'system:instant', ip: null, action: 'instant_window_closed',
                target: null, detail: { giveawayId: g.gid, keyword: g.keyword, eligible: n } });
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

    // Guthaben (CORE_TicketBuy): nach 12 Monaten ohne Bewegung verfaellt der
    // Restsaldo per Gegenbuchung (§10.1) — das Journal bleibt vollstaendig.
    try { anonymized.credit_expired = await credit.expireInactive(CREDIT_EXPIRE_MONTHS); }
    catch (e) { logErr('Retention', 'credit expire:', e.message); }

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
