'use strict';

// ════════════════════════════════════════════════════════
// TEAM GIVEAWAY – Admin Service
// Login + user management (PostgreSQL + signed-cookie sessions),
// aggregated health, static admin pages.
//
// Auth model: Caddy `forward_auth` → GET /auth/verify. Valid session
// cookie → 200; else 302 → login. Browser auth endpoints are reached
// via /admin/auth/* (Caddy strips /admin). User-management API under
// /api/users re-verifies the cookie in-process (role: superadmin).
// ════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { Pool } = require('pg');
const A = require('./auth.js');
const { createBanCache } = require('./ban-cache.js');

const unquote = (s) => String(s || '').replace(/^"|"$/g, '');

// Standard-Teilnahmebedingungen (Draft-Vorlage pro Team).
let TERMS_TEMPLATE = '';
try { TERMS_TEMPLATE = fs.readFileSync(path.join(__dirname, 'terms-template.md'), 'utf8'); }
catch (e) { console.error('[Terms] template not loaded:', e.message); }

function log(tag, ...args)    { console.log( `[${tag}]`, ...args); }
function logErr(tag, ...args) { console.error(`[${tag}]`, ...args); }

const CFG = {
  port: parseInt(process.env.PORT || '3005'),
  services: {
    bridge:   process.env.BRIDGE_URL   || 'http://bridge:3000',
    giveaway: process.env.GIVEAWAY_URL || 'http://giveaway:3001',
  },
  pg: {
    host:     process.env.PG_HOST     || 'postgres',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DB       || 'chaoscrew',
    user:     process.env.PG_USER     || 'chaoscrew',
    password: process.env.PG_PASSWORD || 'changeme',
    max: 5,
    idleTimeoutMillis: 30000,
    // Selbstheilung: tote Connections (Postgres-Neustart) dürfen forward_auth
    // nicht ewig blockieren — sonst hängt die ganze Domain.
    keepAlive: true,
    connectionTimeoutMillis: 8000,
    query_timeout: 15000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  },
  sessionSecret:  process.env.SESSION_SECRET || '',
  cookieSecure:   process.env.COOKIE_SECURE !== 'false',
  bootstrapUser:  process.env.ADMIN_BOOTSTRAP_USER || 'admin',
  bootstrapPass:  process.env.ADMIN_BOOTSTRAP_PASS || '',
  // Twitch-Logins mit Plattform-Adminrechten (Superadmin). Komma-getrennt.
  platformAdmins: String(process.env.PLATFORM_ADMINS || 'justcallmedeimos')
                    .split(',').map(s => A.sanitizeUserName(s)).filter(Boolean),
  loginPath:      '/admin/login.html',
  // Twitch OAuth (open self-registration)
  twitchClientId:     unquote(process.env.TWITCH_CLIENT_ID),
  twitchClientSecret: unquote(process.env.TWITCH_CLIENT_SECRET),
  publicUrl:          (unquote(process.env.ADMIN_PUBLIC_URL) || 'https://team.raumdock.org').replace(/\/$/, ''),
};
const TWITCH_REDIRECT = CFG.publicUrl + '/admin/auth/twitch/callback';

if (!CFG.sessionSecret) {
  CFG.sessionSecret = require('crypto').randomBytes(32).toString('hex');
  logErr('Auth', 'SESSION_SECRET not set — using a random secret; sessions drop on restart. Set SESSION_SECRET in .env.');
}

const pg = new Pool(CFG.pg);
pg.on('error', (e) => logErr('PG', e.message));

const app = express();
// Hinter Caddy: genau EIN Proxy-Hop vertrauenswürdig — req.ip ist damit die
// echte Client-IP (letzter X-Forwarded-For-Eintrag, von Caddy gesetzt).
// Ohne das teilen sich alle Clients Caddys IP und die Login-/Join-Bremsen
// wären global statt je Client.
app.set('trust proxy', 1);
app.use(express.json());

// ── Session helper ────────────────────────────────────────
function sessionFromReq(req) {
  const cookies = A.parseCookies(req.headers.cookie);
  return A.verifyToken(cookies[A.COOKIE_NAME], CFG.sessionSecret);
}

// ── Plattform-Sperre (Login-Block) ────────────────────────
// Sessions sind stateless (HMAC-Cookie, 12 h) — eine Sperre nur beim OAuth
// wuerde eine laufende Session bis zu 12 h weiterarbeiten lassen. Deshalb
// prueft /auth/verify zusaetzlich gegen diesen Cache; die Ban-/Unban-Routen
// mutieren ihn synchron, der Intervall-Refresh faengt manuelle DB-Eingriffe ab.
const bannedLogins = createBanCache();
async function refreshBannedLogins() {
  try {
    const r = await pg.query('SELECT login FROM streamers WHERE banned_at IS NOT NULL');
    bannedLogins.replaceAll(r.rows.map(x => x.login));
  } catch (e) { logErr('Ban', 'refresh failed:', e.message); }
}

// ── Auth routes ───────────────────────────────────────────
// forward_auth target. 200 (+identity headers) if valid, else 302 → login.
app.get('/auth/verify', (req, res) => {
  const sess = sessionFromReq(req);
  if (!sess) {
    // Original-URL (Caddy: X-Forwarded-Uri) als next mitgeben — sonst
    // landet man nach dem Login immer auf der Team-Seite statt der
    // ursprünglich angeforderten Seite. Nur interne Pfade.
    const orig = String(req.get('X-Forwarded-Uri') || '');
    const safe = (orig.startsWith('/') && !orig.startsWith('//') && !orig.startsWith('/\\')) ? orig : '';
    return res.redirect(302, CFG.loginPath + (safe ? '?next=' + encodeURIComponent(safe) : ''));
  }
  if (bannedLogins.has(sess.user)) {
    res.set('Set-Cookie', A.clearSessionCookie({ secure: CFG.cookieSecure }));
    return res.redirect(302, CFG.loginPath + '?err=banned');
  }
  res.set('X-Auth-User', sess.user);
  res.set('X-Auth-Role', sess.role);
  res.status(200).end();
});

// forward_auth target für Superadmin-Pfade (/health, /redis-ui/*). Ohne Session
// 302 → Login, mit Session aber ohne Superadmin-Rolle hart 403 — ein Redirect
// wäre hier irreführend, der Nutzer ist ja bereits angemeldet.
app.get('/auth/verify-superadmin', (req, res) => {
  const sess = sessionFromReq(req);
  if (!sess) return res.redirect(302, CFG.loginPath);
  if (bannedLogins.has(sess.user)) {
    res.set('Set-Cookie', A.clearSessionCookie({ secure: CFG.cookieSecure }));
    return res.redirect(302, CFG.loginPath + '?err=banned');
  }
  if (sess.role !== 'superadmin') {
    return res.status(403).type('text/plain; charset=utf-8')
      .send('403 — Diese Seite ist Plattform-Administratoren vorbehalten.');
  }
  res.set('X-Auth-User', sess.user);
  res.set('X-Auth-Role', sess.role);
  res.status(200).end();
});

app.get('/auth/me', (req, res) => {
  const sess = sessionFromReq(req);
  if (!sess) return res.status(401).json({ error: 'unauthenticated' });
  if (bannedLogins.has(sess.user)) return res.status(401).json({ error: 'banned' });
  res.json({ user: sess.user, role: sess.role });
});

// Bruteforce-Bremse für den Passwort-Login (ChatGPT-Review #5): 5 Fehl-
// versuche je (IP|User) → 15 min Sperre. In-Memory reicht (ein Prozess);
// Map wird bei Überlauf beschnitten. Unbekannte Nutzer kosten denselben
// bcrypt-Aufwand (Dummy-Hash) — kein Username-Oracle über Timing.
const loginFails = new Map();
const LOGIN_DUMMY_HASH = A.hashPassword('nicht-das-passwort');
function loginKey(req, user) { return `${req.ip}|${user}`; }
function loginBlocked(key) {
  const e = loginFails.get(key);
  return !!(e && e.until && e.until > Date.now());
}
function loginFailed(key) {
  if (loginFails.size > 5000) loginFails.clear();   // Überlauf-Schutz
  const e = loginFails.get(key) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= 5) { e.until = Date.now() + 15 * 60 * 1000; e.n = 0; }
  loginFails.set(key, e);
}

app.post('/auth/login', async (req, res) => {
  const user = A.sanitizeUserName(req.body && req.body.username);
  const pass = req.body && req.body.password;
  if (!user || !pass) return res.status(400).json({ error: 'missing_credentials' });
  const lk = loginKey(req, user);
  if (loginBlocked(lk)) return res.status(429).json({ error: 'too_many_attempts' });
  try {
    const r = await pg.query('SELECT username, password_hash, role FROM admin_users WHERE username=$1', [user]);
    const row = r.rows[0];
    const ok = await A.verifyPassword(pass, row ? row.password_hash : await LOGIN_DUMMY_HASH) && !!row;
    if (!ok) { loginFailed(lk); return res.status(401).json({ error: 'invalid_credentials' }); }
    loginFails.delete(lk);
    await pg.query('UPDATE admin_users SET last_login=NOW() WHERE username=$1', [user]);
    const token = A.signToken({ user: row.username, role: row.role }, CFG.sessionSecret);
    res.set('Set-Cookie', A.serializeSessionCookie(token, { secure: CFG.cookieSecure }));
    res.json({ ok: true, user: row.username, role: row.role });
  } catch (e) {
    logErr('Auth', 'login:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.set('Set-Cookie', A.clearSessionCookie({ secure: CFG.cookieSecure }));
  res.json({ ok: true });
});

// ── User management (superadmin only) ─────────────────────
function requireSuperadmin(req, res) {
  const sess = sessionFromReq(req);
  if (!sess) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  if (sess.role !== 'superadmin') { res.status(403).json({ error: 'forbidden' }); return null; }
  return sess;
}

app.get('/api/users', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const r = await pg.query('SELECT username, role, created_at, last_login FROM admin_users ORDER BY username');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const user = A.sanitizeUserName(req.body && req.body.username);
  const pass = req.body && req.body.password;
  const role = A.sanitizeRole(req.body && req.body.role);
  if (!user || !pass || String(pass).length < 8) {
    return res.status(400).json({ error: 'username_and_password_min8_required' });
  }
  try {
    const hash = await A.hashPassword(pass);
    await pg.query(`
      INSERT INTO admin_users (username, password_hash, role)
      VALUES ($1,$2,$3)
      ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role
    `, [user, hash, role]);
    res.json({ ok: true, user, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:username', async (req, res) => {
  const sess = requireSuperadmin(req, res);
  if (!sess) return;
  const target = A.sanitizeUserName(req.params.username);
  if (target === sess.user) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    const cnt = await pg.query(`SELECT COUNT(*)::int AS n FROM admin_users WHERE role='superadmin'`);
    const t   = await pg.query('SELECT role FROM admin_users WHERE username=$1', [target]);
    if (t.rows[0]?.role === 'superadmin' && cnt.rows[0].n <= 1) {
      return res.status(400).json({ error: 'cannot_delete_last_superadmin' });
    }
    await pg.query('DELETE FROM admin_users WHERE username=$1', [target]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Twitch OAuth (open self-registration) ─────────────────
function issueSession(res, login, role) {
  const token = A.signToken({ user: login, role: role || 'streamer' }, CFG.sessionSecret);
  res.set('Set-Cookie', A.serializeSessionCookie(token, { secure: CFG.cookieSecure }));
}

app.get('/auth/twitch', (req, res) => {
  if (!CFG.twitchClientId || !CFG.twitchClientSecret) return res.status(503).send('Twitch OAuth not configured');
  const state = A.signToken({ n: crypto.randomBytes(8).toString('hex') }, CFG.sessionSecret, 600);
  res.set('Set-Cookie', `oauth_state=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${CFG.cookieSecure ? '; Secure' : ''}`);
  const u = new URL('https://id.twitch.tv/oauth2/authorize');
  u.searchParams.set('client_id', CFG.twitchClientId);
  u.searchParams.set('redirect_uri', TWITCH_REDIRECT);
  u.searchParams.set('response_type', 'code');
  // Scope für Follow-Verifizierung des eigenen Kanals (Phase 4).
  u.searchParams.set('scope', 'moderator:read:followers');
  u.searchParams.set('state', state);
  if (req.query.next) {
    res.append('Set-Cookie', `oauth_next=${encodeURIComponent(String(req.query.next)).slice(0, 200)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${CFG.cookieSecure ? '; Secure' : ''}`);
  }
  res.redirect(302, u.toString());
});

app.get('/auth/twitch/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const cookies = A.parseCookies(req.headers.cookie);
    if (!code || !state || state !== cookies.oauth_state || !A.verifyToken(String(state), CFG.sessionSecret)) {
      return res.redirect(302, CFG.loginPath + '?err=state');
    }
    const tokRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CFG.twitchClientId, client_secret: CFG.twitchClientSecret,
        code: String(code), grant_type: 'authorization_code', redirect_uri: TWITCH_REDIRECT,
      }),
    }).then(r => r.json());
    if (!tokRes.access_token) return res.redirect(302, CFG.loginPath + '?err=token');

    const prof = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': 'Bearer ' + tokRes.access_token, 'Client-Id': CFG.twitchClientId },
    }).then(r => r.json());
    const d = prof.data && prof.data[0];
    const login = A.sanitizeUserName(d && d.login);
    if (!login) return res.redirect(302, CFG.loginPath + '?err=profile');

    // Open registration: upsert streamer + Twitch-Token (für Follow-Verify).
    const expires = new Date(Date.now() + (tokRes.expires_in || 14400) * 1000);
    const scopes = Array.isArray(tokRes.scope) ? tokRes.scope.join(' ') : String(tokRes.scope || '');
    await pg.query(`
      INSERT INTO streamers (login, twitch_id, display, avatar, access_token, refresh_token, token_expires, scopes, last_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (login) DO UPDATE SET
        twitch_id = EXCLUDED.twitch_id, display = EXCLUDED.display, avatar = EXCLUDED.avatar,
        access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
        token_expires = EXCLUDED.token_expires, scopes = EXCLUDED.scopes, last_login = NOW()
    `, [login, String(d.id || ''), (d.display_name || login).slice(0, 50), (d.profile_image_url || '').slice(0, 300),
        tokRes.access_token || null, tokRes.refresh_token || null, expires, scopes]);
    const sr = await pg.query('SELECT is_platform_admin, banned_at FROM streamers WHERE login=$1', [login]);
    // Plattform-Sperre: Konto-Daten wurden aktualisiert (Upsert oben), aber
    // eine Session gibt es nicht — der Login endet auf der Fehlermeldung.
    if (sr.rows[0] && sr.rows[0].banned_at) {
      res.append('Set-Cookie', `oauth_state=; Path=/; Max-Age=0`);
      res.append('Set-Cookie', `oauth_next=; Path=/; Max-Age=0`);
      return res.redirect(302, CFG.loginPath + '?err=banned');
    }
    const role = sr.rows[0] && sr.rows[0].is_platform_admin ? 'superadmin' : 'streamer';

    issueSession(res, login, role);
    res.append('Set-Cookie', `oauth_state=; Path=/; Max-Age=0`);
    const next = cookies.oauth_next ? decodeURIComponent(cookies.oauth_next) : '/admin/teams.html';
    res.append('Set-Cookie', `oauth_next=; Path=/; Max-Age=0`);
    // Nur interne Pfade: "//host" und "/\host" werden von Browsern als
    // externe URL interpretiert (Open Redirect nach erfolgreichem Login).
    const safeNext = (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\'))
      ? next : '/admin/teams.html';
    res.redirect(302, safeNext);
  } catch (e) {
    logErr('Auth', 'twitch callback:', e.message);
    res.redirect(302, CFG.loginPath + '?err=server');
  }
});

// ── Nutzungsbedingungen (AGB) ─────────────────────────────
// Jeder Streamer muss zustimmen, bevor er die Plattform nutzen kann. Der
// Glueckspiel-Ausschluss in Paragraf 4 traegt nur, wenn belegbar ist, wer wann
// welcher Fassung zugestimmt hat - deshalb Fassungsnummer + Zeitstempel.
// WICHTIG: Bei jeder inhaltlichen Aenderung von nutzungsbedingungen.md muss
// TOS_VERSION erhoeht werden, sonst gilt die alte Zustimmung weiter.
const TOS_VERSION = 2;

async function tosAcceptedVersion(login) {
  const r = await pg.query(
    'SELECT version, accepted_at FROM tos_acceptances WHERE login=$1 ORDER BY version DESC LIMIT 1', [login]);
  return r.rows[0] || null;
}

app.get('/api/tos/status', async (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const a = await tosAcceptedVersion(s.user);
    res.json({ current: TOS_VERSION, accepted: !!(a && a.version >= TOS_VERSION),
               acceptedVersion: a ? a.version : 0, acceptedAt: a ? a.accepted_at : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tos/accept', async (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'unauthenticated' });
  const v = parseInt((req.body && req.body.version), 10);
  // Nur der aktuellen Fassung laesst sich zustimmen - eine aeltere Nummer waere
  // sonst ein Weg, die Zustimmung an der neuen Fassung vorbeizuschummeln.
  if (v !== TOS_VERSION) return res.status(400).json({ error: 'version_mismatch', current: TOS_VERSION });
  try {
    await pg.query(
      `INSERT INTO tos_acceptances (login, version) VALUES ($1,$2)
       ON CONFLICT (login, version) DO NOTHING`, [s.user, TOS_VERSION]);
    res.json({ ok: true, version: TOS_VERSION });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Teams (multi-tenant) ──────────────────────────────────
function requireSession(req, res) {
  const s = sessionFromReq(req);
  if (!s) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  return s;
}

// Gate fuer alles, was ein Giveaway anlegt oder veraendert. Lesen bleibt frei,
// damit die Zustimmungsseite selbst und der Datenexport erreichbar bleiben.
async function requireTos(req, res, sess) {
  const a = await tosAcceptedVersion(sess.user);
  if (a && a.version >= TOS_VERSION) return true;
  res.status(451).json({ error: 'tos_required', current: TOS_VERSION,
                         acceptedVersion: a ? a.version : 0 });
  return false;
}
function genId(prefix) { return prefix + crypto.randomBytes(6).toString('hex'); }
function genCode() { return crypto.randomBytes(5).toString('hex'); } // 10 hex chars

async function isTeamOwner(teamId, login) {
  const r = await pg.query(`SELECT 1 FROM team_members WHERE team_id=$1 AND login=$2 AND role='owner'`, [teamId, login]);
  return r.rowCount > 0;
}
async function isTeamMember(teamId, login) {
  const r = await pg.query('SELECT 1 FROM team_members WHERE team_id=$1 AND login=$2', [teamId, login]);
  return r.rowCount > 0;
}

// Team-Verwaltungsaktionen sind zustandsändernd → audit_log mit team_id
// (auditGdpr bleibt für die team-losen DSGVO-Vorgänge). Bewusst ohne IP —
// gleiche Zusage wie bei den DSGVO-Zugriffen.
async function auditTeam(teamId, actor, action, target, result, detail) {
  try {
    await pg.query(
      `INSERT INTO audit_log (team_id, actor, action, target, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [teamId, actor, action, target, result || 'ok', JSON.stringify(detail || {})]);
  } catch (e) { logErr('Audit', `WRITE FAILED action=${action} team=${teamId}: ${e.message}`); }
}

// Live-State (Redis) gehört dem giveaway-Service — Aufräumen (Token-Widerruf,
// Team-Wipe) läuft über dessen internen Endpunkt. Shared-Secret INTERNAL_API_KEY;
// ohne Key wird nur übersprungen (die PG-Seite der Aktion gilt trotzdem).
async function giveawayCleanup(teamId, channel = null) {
  const key = process.env.INTERNAL_API_KEY || '';
  if (!key) return { skipped: 'no_internal_key' };
  try {
    const r = await fetch(CFG.services.giveaway + '/internal/team/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
      body: JSON.stringify({ teamId, channel: channel || undefined }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { error: d.error || ('http_' + r.status) };
    return d;
  } catch (e) { logErr('Teams', 'cleanup call failed:', e.message); return { error: e.message }; }
}

// Kanalwechsel/Deaktivierung nicht mitten im laufenden Giveaway — die
// Accrual-Schlüssel hängen am Kanalnamen, ein Wechsel würde Zuschauzeit
// unsichtbar machen. status spiegelt Redis (open/paused/closed).
async function teamHasOpenGiveaway(teamId) {
  const r = await pg.query(
    `SELECT 1 FROM sessions WHERE team_id=$1 AND status IN ('open','paused') LIMIT 1`, [teamId]);
  return r.rowCount > 0;
}

app.post('/api/teams', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const name = String((req.body && req.body.name) || '').replace(/[^\w \-]/g, '').slice(0, 60).trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  const id = genId('team_'); const code = genCode();
  const okey = crypto.randomBytes(8).toString('hex');
  try {
    await pg.query('INSERT INTO teams (id, name, owner_login, invite_code, overlay_key) VALUES ($1,$2,$3,$4,$5)', [id, name, s.user, code, okey]);
    await pg.query(`INSERT INTO team_members (team_id, login, role, channel) VALUES ($1,$2,'owner',$2)`, [id, s.user]);
    res.json({ ok: true, id, name, invite_code: code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/teams/mine', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  try {
    const r = await pg.query(`
      SELECT t.id, t.name, t.owner_login, t.invite_code, t.deactivated_at, m.role
      FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.login = $1 ORDER BY t.created_at DESC
    `, [s.user]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/teams/:id', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  try {
    if (!await isTeamMember(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    const t = await pg.query('SELECT id, name, owner_login, invite_code, overlay_key, deactivated_at, invites_disabled FROM teams WHERE id=$1', [id]);
    if (!t.rowCount) return res.status(404).json({ error: 'not_found' });
    const mem = await pg.query('SELECT login, role, channel, joined_at FROM team_members WHERE team_id=$1 ORDER BY role DESC, joined_at', [id]);
    const owner = await isTeamOwner(id, s.user);
    const row = t.rows[0];
    if (!owner) delete row.overlay_key;   // Overlay-Key nur für Owner
    res.json({ ...row, members: mem.rows, you_owner: owner, you: s.user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Beitritts-Bremse: Einladungscodes sind 10 Hex-Zeichen — 20 Versuche/h je
// IP machen Durchprobieren aussichtslos, stören legitime Beitritte nicht.
const joinAttempts = new Map();
function joinLimited(ip) {
  const now = Date.now();
  if (joinAttempts.size > 5000) joinAttempts.clear();
  const e = joinAttempts.get(ip) || { n: 0, reset: now + 3600000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 3600000; }
  e.n++;
  joinAttempts.set(ip, e);
  return e.n > 20;
}

app.post('/api/teams/join', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  if (joinLimited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
  const code = String((req.body && req.body.code) || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
  if (!code) return res.status(400).json({ error: 'code_required' });
  try {
    const t = await pg.query('SELECT id, deactivated_at, invites_disabled FROM teams WHERE invite_code=$1', [code]);
    if (!t.rowCount) return res.status(404).json({ error: 'invalid_code' });
    if (t.rows[0].deactivated_at) return res.status(403).json({ error: 'team_deactivated' });
    if (t.rows[0].invites_disabled) return res.status(403).json({ error: 'invites_disabled' });
    const id = t.rows[0].id;
    await pg.query(`INSERT INTO team_members (team_id, login, role, channel) VALUES ($1,$2,'member',$2)
                    ON CONFLICT (team_id, login) DO NOTHING`, [id, s.user]);
    await auditTeam(id, s.user, 'team_join', s.user, 'ok', {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/teams/:id/invite', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const id = req.params.id;
  if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  const code = genCode();
  try { await pg.query('UPDATE teams SET invite_code=$1 WHERE id=$2', [code, id]); res.json({ ok: true, invite_code: code }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/teams/:id/members/:login', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id; const target = A.sanitizeUserName(req.params.login);
  if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  const t = await pg.query('SELECT owner_login FROM teams WHERE id=$1', [id]);
  if (t.rows[0] && t.rows[0].owner_login === target) return res.status(400).json({ error: 'cannot_remove_owner' });
  try {
    const m = await pg.query('SELECT channel FROM team_members WHERE team_id=$1 AND login=$2', [id, target]);
    await pg.query('DELETE FROM team_members WHERE team_id=$1 AND login=$2', [id, target]);
    // Ingest-Token des Kanals widerrufen — sonst füttert der Ex-Kanal weiter.
    const cleanup = m.rowCount ? await giveawayCleanup(id, m.rows[0].channel) : null;
    await auditTeam(id, s.user, 'team_member_removed', target, 'ok', { cleanup });
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Team-Lebenszyklus (Issue #1) ──────────────────────────

// Member verlässt das Team selbst. Der Owner kann nicht raus — erst
// Eigentümerschaft übertragen (Impressums-/TOS-Pflichten hängen an ihm).
app.post('/api/teams/:id/leave', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  try {
    if (!await isTeamMember(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    if (await isTeamOwner(id, s.user)) return res.status(409).json({ error: 'owner_must_transfer' });
    const m = await pg.query('SELECT channel FROM team_members WHERE team_id=$1 AND login=$2', [id, s.user]);
    await pg.query('DELETE FROM team_members WHERE team_id=$1 AND login=$2', [id, s.user]);
    const cleanup = m.rowCount ? await giveawayCleanup(id, m.rows[0].channel) : null;
    await auditTeam(id, s.user, 'team_leave', s.user, 'ok', { cleanup });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/teams/:id/name', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const id = req.params.id;
  const name = String((req.body && req.body.name) || '').replace(/[^\w \-]/g, '').slice(0, 60).trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    const old = await pg.query('SELECT name FROM teams WHERE id=$1', [id]);
    await pg.query('UPDATE teams SET name=$1 WHERE id=$2', [name, id]);
    await auditTeam(id, s.user, 'team_rename', id, 'ok',
                    { from: old.rowCount ? old.rows[0].name : null, to: name });
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eigentümerschaft übertragen: Ziel muss Mitglied sein und die AKTUELLEN
// Nutzungsbedingungen akzeptiert haben — sonst stünde das Team sofort vor
// dem TOS-Gate (gw_open prüft den Owner). Impressum bleibt beim Team; der
// neue Owner ist ab jetzt der Veranstalter.
app.post('/api/teams/:id/transfer', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const id = req.params.id;
  const to = A.sanitizeUserName((req.body && req.body.to) || '');
  if (!to) return res.status(400).json({ error: 'target_required' });
  try {
    if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    if (to === s.user) return res.status(400).json({ error: 'already_owner' });
    if (!await isTeamMember(id, to)) return res.status(404).json({ error: 'not_a_member' });
    const a = await tosAcceptedVersion(to);
    if (!a || a.version < TOS_VERSION) return res.status(409).json({ error: 'target_tos_missing' });
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE teams SET owner_login=$1 WHERE id=$2', [to, id]);
      await client.query(`UPDATE team_members SET role='member' WHERE team_id=$1 AND login=$2`, [id, s.user]);
      await client.query(`UPDATE team_members SET role='owner' WHERE team_id=$1 AND login=$2`, [id, to]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    await auditTeam(id, s.user, 'team_transfer', to, 'ok', { from: s.user, to });
    res.json({ ok: true, owner: to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Einladungen pausieren/aktivieren (Code bleibt, Beitritt wird abgelehnt).
app.post('/api/teams/:id/invites', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  const enabled = !!(req.body && req.body.enabled);
  try {
    if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    await pg.query('UPDATE teams SET invites_disabled=$1 WHERE id=$2', [!enabled, id]);
    await auditTeam(id, s.user, 'team_invites_toggle', id, 'ok', { enabled });
    res.json({ ok: true, enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eigenen Kanal ändern — nur der Betroffene selbst, nur ohne laufendes
// Giveaway (Accrual-Schlüssel hängen am Kanalnamen). Alter Ingest-Token
// wird widerrufen; für den neuen Kanal im Dashboard einen neuen erzeugen.
app.put('/api/teams/:id/channel', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  const channel = A.sanitizeUserName((req.body && req.body.channel) || '');
  if (!channel || channel.length < 3) return res.status(400).json({ error: 'channel_invalid' });
  try {
    if (!await isTeamMember(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    if (await teamHasOpenGiveaway(id)) return res.status(409).json({ error: 'giveaway_open' });
    const dup = await pg.query(
      'SELECT 1 FROM team_members WHERE team_id=$1 AND channel=$2 AND login<>$3', [id, channel, s.user]);
    if (dup.rowCount) return res.status(409).json({ error: 'channel_taken' });
    const old = await pg.query('SELECT channel FROM team_members WHERE team_id=$1 AND login=$2', [id, s.user]);
    const oldCh = old.rowCount ? old.rows[0].channel : null;
    if (oldCh === channel) return res.json({ ok: true, channel, unchanged: true });
    await pg.query('UPDATE team_members SET channel=$1 WHERE team_id=$2 AND login=$3', [channel, id, s.user]);
    const cleanup = oldCh ? await giveawayCleanup(id, oldCh) : null;
    await auditTeam(id, s.user, 'team_channel_change', s.user, 'ok', { from: oldCh, to: channel, cleanup });
    res.json({ ok: true, channel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team deaktivieren: Flag statt DELETE (Ziehungsnachweise/Audit referenzieren
// die team_id dauerhaft, Art. 17 Abs. 3 lit. e). Live-State + Ingest-Tokens
// werden abgeräumt; Mitglieder und Texte bleiben — Reaktivieren ist möglich,
// Tokens müssen danach neu erzeugt werden.
app.post('/api/teams/:id/deactivate', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  try {
    if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    const t = await pg.query('SELECT name, deactivated_at FROM teams WHERE id=$1', [id]);
    if (!t.rowCount) return res.status(404).json({ error: 'not_found' });
    if (t.rows[0].deactivated_at) return res.status(409).json({ error: 'already_deactivated' });
    if (String((req.body && req.body.confirmName) || '') !== t.rows[0].name) {
      await auditTeam(id, s.user, 'team_deactivate', id, 'denied', { reason: 'confirm_mismatch' });
      return res.status(400).json({ error: 'confirm_mismatch' });
    }
    if (await teamHasOpenGiveaway(id)) return res.status(409).json({ error: 'giveaway_open' });
    await pg.query('UPDATE teams SET deactivated_at=NOW() WHERE id=$1', [id]);
    const cleanup = await giveawayCleanup(id);
    await auditTeam(id, s.user, 'team_deactivate', id, 'ok', { cleanup });
    res.json({ ok: true, cleanup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/teams/:id/reactivate', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const id = req.params.id;
  try {
    if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
    const r = await pg.query('UPDATE teams SET deactivated_at=NULL WHERE id=$1 AND deactivated_at IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not_deactivated' });
    await auditTeam(id, s.user, 'team_reactivate', id, 'ok', {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Team-Teilnahmebedingungen ─────────────────────────────
app.get('/api/teams/:id/terms', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  if (!await isTeamMember(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await pg.query('SELECT terms FROM teams WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ terms: r.rows[0].terms || TERMS_TEMPLATE, isDefault: !r.rows[0].terms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/teams/:id/terms', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const id = req.params.id;
  if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  const terms = String((req.body && req.body.terms) || '').slice(0, 40000);
  const note  = String((req.body && req.body.note) || '').slice(0, 300).trim();
  try {
    const prev = await pg.query('SELECT terms FROM teams WHERE id=$1', [id]);
    if (!prev.rowCount) return res.status(404).json({ error: 'not_found' });
    const oldTerms = prev.rows[0].terms || TERMS_TEMPLATE;
    const newTerms = terms || TERMS_TEMPLATE;
    if (oldTerms === newTerms) return res.json({ ok: true, unchanged: true });
    const sections = changedSections(oldTerms, newTerms);
    const version  = (await currentTermsVersion(id)) + 1;
    // Fassung und Aenderung gehoeren zusammen - entweder beides oder nichts,
    // sonst zeigt die Historie einen Stand, der nie oeffentlich galt.
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE teams SET terms=$1 WHERE id=$2', [terms || null, id]);
      await client.query(
        `INSERT INTO terms_versions (team_id, version, terms, changed_by, note, sections)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, version, newTerms, s.user, note || null, JSON.stringify(sections)]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    res.json({ ok: true, version, sections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Teilnahmebedingungen: Versionierung ───────────────────
// Teilnehmer muessen nachvollziehen koennen, wann sich die Bedingungen
// geaendert haben und was. Wir speichern jede Fassung und leiten die
// betroffenen Abschnitte aus den Markdown-Ueberschriften ab.
const NL = String.fromCharCode(10);
const NEWLINE_RE = /\r?\n/;
const HEADING_RE = /^#{1,3}\s+(.*)$/;
function splitSections(md) {
  const out = new Map();
  let current = '(Einleitung)', buf = [];
  for (const line of String(md || '').split(NEWLINE_RE)) {
    const h = line.match(HEADING_RE);
    if (h) { out.set(current, buf.join(NL).trim()); current = h[1].trim(); buf = []; }
    else buf.push(line);
  }
  out.set(current, buf.join(NL).trim());
  return out;
}

function changedSections(oldMd, newMd) {
  const a = splitSections(oldMd), b = splitSections(newMd);
  const changed = [];
  for (const [title, body] of b) {
    if (!a.has(title)) changed.push({ section: title, kind: 'neu' });
    else if (a.get(title) !== body) changed.push({ section: title, kind: 'geändert' });
  }
  for (const title of a.keys()) if (!b.has(title)) changed.push({ section: title, kind: 'entfernt' });
  return changed;
}

async function currentTermsVersion(teamId) {
  const r = await pg.query('SELECT MAX(version) AS v FROM terms_versions WHERE team_id=$1', [teamId]);
  return (r.rows[0] && r.rows[0].v) || 0;
}

app.get('/api/teams/:id/imprint', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  if (!await isTeamMember(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await pg.query('SELECT imprint, imprint_url FROM teams WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ imprint: r.rows[0].imprint || '', imprintUrl: r.rows[0].imprint_url || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/teams/:id/imprint', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const id = req.params.id;
  if (!await isTeamOwner(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  const imprint = String((req.body && req.body.imprint) || '').slice(0, 20000).trim();
  const rawUrl  = String((req.body && req.body.imprintUrl) || '').slice(0, 500).trim();
  // Nur http(s) zulassen - ein javascript:-Link waere sonst ein XSS-Vektor
  // auf einer Seite, die Teilnehmer als verbindlich lesen sollen.
  if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ error: 'Der Link muss mit http:// oder https:// beginnen' });
  }
  try {
    const prev = await pg.query('SELECT imprint, imprint_url FROM teams WHERE id=$1', [id]);
    if (!prev.rowCount) return res.status(404).json({ error: 'not_found' });
    const same = (prev.rows[0].imprint || '') === imprint && (prev.rows[0].imprint_url || '') === rawUrl;
    if (same) return res.json({ ok: true, unchanged: true });
    const version = (await currentTermsVersion(id)) + 1;
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE teams SET imprint=$1, imprint_url=$2 WHERE id=$3',
        [imprint || null, rawUrl || null, id]);
      // Impressumsaenderungen laufen durch dieselbe Historie wie die
      // Bedingungen - fuer Teilnehmer ist beides derselbe verbindliche Stand.
      const cur = await client.query('SELECT terms FROM teams WHERE id=$1', [id]);
      await client.query(
        `INSERT INTO terms_versions (team_id, version, terms, changed_by, note, sections)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, version, cur.rows[0].terms || TERMS_TEMPLATE, s.user,
         String((req.body && req.body.note) || '').slice(0, 300).trim() || null,
         JSON.stringify([{ section: 'Impressum des Veranstalters', kind: 'geändert' }])]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    res.json({ ok: true, version });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/teams/:id/terms/history', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  if (!await isTeamMember(id, s.user)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await pg.query(
      `SELECT version, changed_by, note, sections, created_at FROM terms_versions
       WHERE team_id=$1 ORDER BY version DESC LIMIT 50`, [id]);
    res.json({ history: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Betroffenenrechte (DSGVO Art. 15 / 17) ────────────────
// Der Plattformbetreiber muss Auskunfts- und Loeschverlangen beantworten
// koennen, ohne in der Datenbank zu graben. Nur superadmin - hier laesst sich
// jede zu einer Person gespeicherte Zeile einsehen.
function sanitizeViewer(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
}

// Jeder Zugriff auf personenbezogene Daten wird protokolliert - auch der
// lesende und auch der auf eigene Daten. Ohne dieses Protokoll laesst sich
// spaeter nicht belegen, wer wann welche Auskunft erteilt oder erhalten hat.
// Bewusst ohne IP: die Datenschutzerklaerung sagt zu, Zugriffe nicht mit
// IP-Adressen zu protokollieren.
async function auditGdpr(actor, action, target, result, detail) {
  try {
    await pg.query(
      `INSERT INTO audit_log (team_id, actor, action, target, result, detail)
       VALUES (NULL,$1,$2,$3,$4,$5)`,
      [actor, action, target, result || 'ok', JSON.stringify(detail || {})]);
  } catch (e) {
    logErr('Audit', `WRITE FAILED action=${action} actor=${actor}: ${e.message}`);
  }
}

// Alles, was zu einer Person gespeichert ist - Grundlage fuer Art. 15 DSGVO.
async function collectSubjectData(u) {
  const q = (sql, p) => pg.query(sql, p).then(r => r.rows).catch(() => []);
  const [user, events, participation, flags, audit, draws, teams, tos, claims, creditRows, wagerRows, contestEntries, contestVotes, consents, warnings, streamerAcct] = await Promise.all([
    q('SELECT username, display, last_seen FROM users WHERE username=$1', [u]),
    q(`SELECT team_id, channel, event_type, count(*)::int AS n, min(ts) AS first, max(ts) AS last,
              sum(delta_sec)::int AS total_sec
       FROM watchtime_events WHERE username=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`, [u]),
    q(`SELECT session_id, channel, watch_sec, msgs, coins, follows, valid
       FROM campaign_participation WHERE username=$1 ORDER BY session_id`, [u]),
    q('SELECT session_id, team_id, reason, occurrences, first_seen, last_seen, detail FROM abuse_flags WHERE username=$1', [u]),
    q(`SELECT id, ts, team_id, actor, action, result, detail FROM audit_log
       WHERE target=$1 ORDER BY ts DESC LIMIT 500`, [u]),
    q(`SELECT id, session_id, winner, winner_coins, core, prize_id, drawn_at, is_test FROM giveaway_draws
       WHERE winner=$1 ORDER BY drawn_at DESC`, [u]),
    q(`SELECT DISTINCT team_id FROM watchtime_events WHERE username=$1`, [u]),
    q('SELECT version, accepted_at FROM tos_acceptances WHERE login=$1 ORDER BY version', [u]),
    // Die Gewinnermeldung ist der einzige Ort mit Klarnamen und Anschrift -
    // sie gehoert damit zwingend in die Selbstauskunft nach Art. 15 DSGVO.
    q(`SELECT id, team_id, session_id, status, handling, handled_at, deadline_at, claimed_at,
              purge_at, purged_at, real_name, email, street, zip, city, country, note, terms_version
       FROM draw_claims WHERE winner=$1 ORDER BY created_at DESC`, [u]),
    // Guthaben-Journal (CORE_TicketBuy) — personenbezogen, gehoert in die
    // Auskunft nach Art. 15 (Regel aus docs/ARCHITEKTUR-CORES.md §7).
    q(`SELECT team_id, entry_type, amount, ref_session, ref_prize, created_at
       FROM credit_ledger WHERE username=$1 ORDER BY created_at DESC LIMIT 500`, [u]),
    q(`SELECT w.team_id, w.prize_id, p.title, w.amount, w.created_at
       FROM prize_wagers w LEFT JOIN giveaway_prizes p ON p.id = w.prize_id
       WHERE w.username=$1 ORDER BY w.created_at DESC LIMIT 500`, [u]),
    // Screenshot-Contest: eigene Einsendungen (Metadaten, Bild per Hinweis)
    // und abgegebene Wertungen.
    q(`SELECT id, team_id, session_id, title, mime, status, created_at,
              OCTET_LENGTH(image) AS image_bytes
       FROM contest_entries WHERE username=$1 ORDER BY created_at DESC`, [u]),
    q(`SELECT team_id, session_id, entry_id, score, created_at
       FROM contest_votes WHERE voter=$1 ORDER BY created_at DESC LIMIT 500`, [u]),
    // P1c: protokollierte Kenntnisnahmen der Teilnahmebedingungen.
    q(`SELECT team_id, session_id, core, action, terms_version, source, created_at
       FROM participation_consents WHERE username=$1 ORDER BY created_at DESC LIMIT 500`, [u]),
    // Plattform-Verwarnungen, in denen die Person vorkommt (als Betroffener,
    // Aussteller oder Quittierender).
    q(`SELECT id, subject_type, subject_id, reason, created_by, created_at,
              acknowledged_at, acknowledged_by
       FROM platform_warnings
       WHERE subject_id=$1 OR created_by=$1 OR acknowledged_by=$1
       ORDER BY created_at DESC LIMIT 100`, [u]),
    // Streamer-Konto inkl. Plattform-Sperre — bewusst ohne Tokens.
    q(`SELECT login, display, created_at, last_login, banned_at, banned_reason
       FROM streamers WHERE login=$1`, [u]),
  ]);
  return {
    username: u,
    found: !!(user.length || events.length || participation.length || audit.length
              || draws.length || tos.length || claims.length || creditRows.length
              || wagerRows.length || contestEntries.length || contestVotes.length
              || consents.length || warnings.length || streamerAcct.length),
    user: user[0] || null, teams: teams.map(t => t.team_id),
    watchtimeEvents: events, participation, abuseFlags: flags,
    auditEntries: audit, draws, tosAcceptances: tos, winnerClaims: claims,
    creditLedger: creditRows, prizeWagers: wagerRows,
    contestEntries, contestVotes,
    participationConsents: consents,
    platformWarnings: warnings,
    streamerAccount: streamerAcct[0] || null,
  };
}

// Loeschung nach Art. 17. Teilnahmedaten verschwinden; Ziehungsprotokolle und
// Verwaltungsprotokoll werden pseudonymisiert - sie belegen, dass korrekt
// gezogen wurde, und duerfen dafuer nach Art. 17 Abs. 3 lit. e DSGVO bleiben.
async function eraseSubject(u, actor, action) {
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const done = {};
    for (const [key, sql] of [
      ['watchtime_events',       'DELETE FROM watchtime_events WHERE username=$1'],
      ['campaign_participation', 'DELETE FROM campaign_participation WHERE username=$1'],
      ['abuse_flags',            'DELETE FROM abuse_flags WHERE username=$1'],
      ['session_participants',   'DELETE FROM session_participants WHERE username=$1'],
      ['users',                  'DELETE FROM users WHERE username=$1'],
    ]) {
      try { done[key] = (await client.query(sql, [u])).rowCount; }
      catch (e) { done[key] = 'Fehler: ' + e.message; }
    }
    // Konto und Zustimmung nur entfernen, wenn die Person kein Team fuehrt.
    // Bei einem Veranstalter waere die Zustimmung zu den Nutzungsbedingungen
    // Beweismittel fuer ein laufendes Giveaway und der Login noetig, um es zu
    // verwalten - beides darf eine Loeschung nicht unter dem Team wegziehen.
    const ownsTeams = await client.query('SELECT 1 FROM teams WHERE owner_login=$1 LIMIT 1', [u]);
    if (!ownsTeams.rowCount) {
      for (const [key, sql] of [
        ['team_members',    'DELETE FROM team_members WHERE login=$1'],
        ['tos_acceptances', 'DELETE FROM tos_acceptances WHERE login=$1'],
        ['streamers',       'DELETE FROM streamers WHERE login=$1'],
      ]) {
        try { done[key] = (await client.query(sql, [u])).rowCount; }
        catch (e) { done[key] = 'Fehler: ' + e.message; }
      }
    } else {
      done.konto_behalten = 'Person führt ein Team — Login und Zustimmung bleiben';
    }
    const pseudo = 'geloescht_' + crypto.createHash('sha256').update(u).digest('hex').slice(0, 8);
    // Guthaben (CORE_TicketBuy): Restsaldo je Team ausbuchen (Journal bleibt
    // in sich schluessig), dann pseudonymisieren. Sonst wuerde die Loeschung
    // ein herrenloses Konto stehen lassen. Buchung hier statt in der Engine —
    // dokumentierte Ausnahme, siehe services/giveaway/credit.js.
    try {
      const bal = await client.query(
        `SELECT team_id, SUM(amount) AS bal FROM credit_ledger WHERE username=$1
         GROUP BY team_id HAVING SUM(amount) > 0`, [u]);
      for (const row of bal.rows) {
        await client.query(
          `INSERT INTO credit_ledger (team_id, username, entry_type, amount, detail)
           VALUES ($1,$2,'erase',$3,$4)`,
          [row.team_id, u, -parseFloat(row.bal), JSON.stringify({ reason: 'gdpr_erase' })]);
      }
      const cr = await client.query('UPDATE credit_ledger SET username=$2 WHERE username=$1', [u, pseudo]);
      done.credit_ledger_pseudonymisiert = cr.rowCount;
      // Einsätze sind Teil des Ziehungsnachweises (gewichteter Pool) —
      // pseudonymisieren statt löschen, wie giveaway_draws.
      const pw = await client.query('UPDATE prize_wagers SET username=$2 WHERE username=$1', [u, pseudo]);
      done.prize_wagers_pseudonymisiert = pw.rowCount;
      // Contest: eigene Einsendungen HART löschen (das Bild verschwindet;
      // Stimmen darauf fallen per CASCADE mit). Abgegebene Wertungen sind
      // Teil des Ergebnisnachweises → Voter pseudonymisieren, Score bleibt.
      const ce = await client.query('DELETE FROM contest_entries WHERE username=$1', [u]);
      done.contest_entries_geloescht = ce.rowCount;
      const cv = await client.query('UPDATE contest_votes SET voter=$2 WHERE voter=$1', [u, pseudo]);
      done.contest_votes_pseudonymisiert = cv.rowCount;
      // Kenntnisnahme-Protokoll: Nachweis, dass die Teilnahme mit Zustimmung
      // lief → pseudonymisieren statt löschen (Art. 17 Abs. 3 lit. e DSGVO).
      const pc = await client.query('UPDATE participation_consents SET username=$2 WHERE username=$1', [u, pseudo]);
      done.participation_consents_pseudonymisiert = pc.rowCount;
    } catch (e) { done.credit_ledger = 'Fehler: ' + e.message; }
    const dr = await client.query('UPDATE giveaway_draws SET winner=$2 WHERE winner=$1', [u, pseudo]);
    done.giveaway_draws_pseudonymisiert = dr.rowCount;
    const sn = await client.query(
      `UPDATE giveaway_draws SET eligible_snapshot = REPLACE(eligible_snapshot::text, $1, $2)::jsonb
       WHERE eligible_snapshot::text LIKE '%' || $1 || '%'`, [u, pseudo]);
    done.snapshots_pseudonymisiert = sn.rowCount;
    const al = await client.query('UPDATE audit_log SET target=$2 WHERE target=$1', [u, pseudo]);
    done.audit_log_pseudonymisiert = al.rowCount;
    // Plattform-Verwarnungen: Historie bleibt als Nachweis der Moderation,
    // der Personenbezug wird pseudonymisiert (Art. 17 Abs. 3 lit. e DSGVO).
    const pwn = await client.query(
      `UPDATE platform_warnings SET
         subject_id      = CASE WHEN subject_type='streamer' AND subject_id=$1 THEN $2 ELSE subject_id END,
         created_by      = CASE WHEN created_by=$1 THEN $2 ELSE created_by END,
         acknowledged_by = CASE WHEN acknowledged_by=$1 THEN $2 ELSE acknowledged_by END
       WHERE (subject_type='streamer' AND subject_id=$1) OR created_by=$1 OR acknowledged_by=$1`,
      [u, pseudo]);
    done.platform_warnings_pseudonymisiert = pwn.rowCount;
    // Gewinnermeldung: die Kontaktdaten sind echte Klardaten und fallen sofort
    // weg. Der Datensatz selbst bleibt pseudonymisiert stehen, weil er belegt,
    // dass der Gewinn gemeldet und zugestellt wurde (Art. 17 Abs. 3 lit. e).
    const cl = await client.query(
      `UPDATE draw_claims SET winner=$2, real_name=NULL, email=NULL, street=NULL, zip=NULL,
              city=NULL, country=NULL, note=NULL, claim_ip=NULL, purged_at=NOW()
       WHERE winner=$1`, [u, pseudo]);
    done.gewinnermeldung_bereinigt = cl.rowCount;
    // Abwicklungsvermerk (Inbox): handled_by ist der Login des Bearbeiters —
    // wird er selbst gelöscht, bleibt nur das Pseudonym stehen.
    const hb = await client.query(
      `UPDATE draw_claims SET handled_by=$2 WHERE handled_by=$1`, [u, pseudo]);
    done.abwicklung_pseudonymisiert = hb.rowCount;

    await client.query(
      `INSERT INTO audit_log (team_id, actor, action, target, result, detail)
       VALUES (NULL, $1, $2, $3, 'ok', $4)`,
      [actor === u ? pseudo : actor, action, pseudo, JSON.stringify(done)]);
    await client.query('COMMIT');
    return { pseudonym: pseudo, deleted: done };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

// ── Selbstauskunft: eigene Daten einsehen und loeschen ────
// Teilnehmer melden sich mit ihrem Twitch-Konto an und sehen ausschliesslich
// ihren eigenen Datensatz. Die Identitaet ist damit durch Twitch belegt - was
// eine Namensangabe allein nie waere.
app.get('/api/me/data', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const u = sanitizeViewer(s.user);
  if (!u) return res.status(400).json({ error: 'Ungültiger Benutzername' });
  try {
    const data = await collectSubjectData(u);
    await auditGdpr(u, 'gdpr_self_access', u, 'ok',
      { rows: { watchtime: data.watchtimeEvents.length, participation: data.participation.length,
                draws: data.draws.length, flags: data.abuseFlags.length } });
    res.json(data);
  } catch (e) {
    await auditGdpr(u, 'gdpr_self_access', u, 'error', { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Rückmeldung: Fehler melden / Idee schicken ──────────────
// Jede eingeloggte Person darf schreiben. Der Text landet in PG (Nachweis,
// auch wenn Discord klemmt) und geht per Webhook in den Discord-Kanal des
// Betreiberteams — derselbe Kanal wie beim Fleetplanner.
// Ohne DISCORD_FEEDBACK_WEBHOOK wird nur gespeichert, nichts verschickt.
const FEEDBACK_KINDS = { bug: '🐛 Fehler', idea: '💡 Idee', question: '❓ Frage' };
const feedbackSeen = new Map();   // login -> ts der letzten Meldung (Bremse)

app.post('/api/feedback', express.json({ limit: '32kb' }), async (req, res) => {
  const sess = sessionFromReq(req);
  if (!sess) return res.status(401).json({ error: 'unauthenticated' });
  const kind = FEEDBACK_KINDS[req.body && req.body.kind] ? req.body.kind : null;
  const message = String((req.body && req.body.message) || '').trim().slice(0, 2000);
  const page = String((req.body && req.body.page) || '').trim().slice(0, 200);
  if (!kind) return res.status(400).json({ error: 'bad_kind' });
  if (message.length < 10) return res.status(400).json({ error: 'too_short' });
  // Eine Meldung pro Minute je Person — gegen versehentliche Doppelklicks
  // und gegen Flutung des Discord-Kanals.
  const last = feedbackSeen.get(sess.user) || 0;
  if (Date.now() - last < 60000) return res.status(429).json({ error: 'rate_limited' });
  feedbackSeen.set(sess.user, Date.now());

  let id = null;
  try {
    const r = await pg.query(
      `INSERT INTO feedback (login, kind, page, message) VALUES ($1,$2,$3,$4) RETURNING id`,
      [sess.user, kind, page || null, message]);
    id = r.rows[0].id;
  } catch (e) { logErr('Feedback', 'insert:', e.message); }

  const hook = process.env.DISCORD_FEEDBACK_WEBHOOK || '';
  if (!hook) {
    if (id) await pg.query(`UPDATE feedback SET error=$1 WHERE id=$2`,
      ['kein DISCORD_FEEDBACK_WEBHOOK gesetzt', id]).catch(() => {});
    await auditPlatform(sess.user, 'feedback', kind, 'ok', { id, delivered: false });
    return res.json({ ok: true, delivered: false, id });
  }
  try {
    const body = {
      username: 'RDOC Giveaway',
      embeds: [{
        title: FEEDBACK_KINDS[kind] + (id ? ' #' + id : ''),
        description: message,
        color: kind === 'bug' ? 0xC0392B : kind === 'idea' ? 0xC48A4A : 0x5A7D9A,
        fields: [
          { name: 'Von', value: sess.user, inline: true },
          { name: 'Seite', value: page || 'unbekannt', inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    };
    const r = await fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error('Discord HTTP ' + r.status);
    if (id) await pg.query(`UPDATE feedback SET delivered=TRUE WHERE id=$1`, [id]).catch(() => {});
    await auditPlatform(sess.user, 'feedback', kind, 'ok', { id, delivered: true });
    res.json({ ok: true, delivered: true, id });
  } catch (e) {
    logErr('Feedback', 'discord:', e.message);
    if (id) await pg.query(`UPDATE feedback SET error=$1 WHERE id=$2`, [e.message.slice(0, 200), id]).catch(() => {});
    await auditPlatform(sess.user, 'feedback', kind, 'error', { id, error: e.message });
    // Gespeichert ist gespeichert — die Meldung ist nicht verloren.
    res.json({ ok: true, delivered: false, id, note: 'gespeichert, Zustellung fehlgeschlagen' });
  }
});

// Eingegangene Rückmeldungen (Betriebsseite).
app.get('/api/platform/feedback', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pg.query(
      `SELECT id, ts, login, kind, page, message, delivered, error
         FROM feedback ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ rows: r.rows });
  } catch (e) { res.json({ rows: [], error: e.message }); }
});

app.post('/api/me/delete', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const u = sanitizeViewer(s.user);
  if (String((req.body && req.body.confirm) || '').toLowerCase() !== u) {
    await auditGdpr(u, 'gdpr_self_delete', u, 'denied', { reason: 'confirm_mismatch' });
    return res.status(400).json({ error: 'Zur Bestätigung den eigenen Benutzernamen wiederholen' });
  }
  try {
    // Ein Team-Owner darf sich nicht wegloeschen, solange sein Team laeuft -
    // sonst bleibt ein Giveaway ohne Veranstalter und ohne Impressum zurueck.
    const owned = await pg.query(
      `SELECT t.id, t.name FROM teams t WHERE t.owner_login=$1`, [u]);
    if (owned.rowCount) {
      await auditGdpr(u, 'gdpr_self_delete', u, 'denied',
        { reason: 'owns_teams', teams: owned.rows.map(r => r.id) });
      return res.status(409).json({
        error: 'owns_teams',
        message: 'Du bist Veranstalter von ' + owned.rows.map(r => r.name).join(', ')
               + '. Übergib oder lösche das Team zuerst — sonst bliebe ein Giveaway '
               + 'ohne Verantwortlichen zurück.',
        teams: owned.rows });
    }
    const r = await eraseSubject(u, u, 'gdpr_self_delete');
    res.json({ ok: true, ...r });
  } catch (e) {
    await auditGdpr(u, 'gdpr_self_delete', u, 'error', { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gdpr/subject/:username', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const u = sanitizeViewer(req.params.username);
  if (!u) return res.status(400).json({ error: 'Ungültiger Benutzername' });
  try {
    const data = await collectSubjectData(u);
    await auditGdpr(sess.user, 'gdpr_access', u, 'ok', { found: data.found });
    res.json(data);
  } catch (e) {
    await auditGdpr(sess.user, 'gdpr_access', u, 'error', { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gdpr/subject/:username/delete', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const u = sanitizeViewer(req.params.username);
  if (!u) return res.status(400).json({ error: 'Ungültiger Benutzername' });
  if (String((req.body && req.body.confirm) || '') !== u) {
    await auditGdpr(sess.user, 'gdpr_delete', u, 'denied', { reason: 'confirm_mismatch' });
    return res.status(400).json({ error: 'Zur Bestätigung den Benutzernamen wiederholen' });
  }
  try {
    const r = await eraseSubject(u, sess.user, 'gdpr_delete');
    res.json({ ok: true, ...r });
  } catch (e) {
    await auditGdpr(sess.user, 'gdpr_delete', u, 'error', { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Plattform-Verwaltung (superadmin) ─────────────────────
// Moderation der Plattform: Statistik, Teams deaktivieren/reaktivieren,
// Streamer sperren, Verwarnungen. Team-Aktionen laufen über auditTeam (damit
// sie im Team-Audit sichtbar sind), personen-/plattformbezogene über
// auditPlatform (team_id NULL — gleiche Form wie die DSGVO-Vorgänge).
const auditPlatform = auditGdpr;

function sanitizeTeamIdParam(v) {
  return String(v || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
}

app.get('/api/platform/stats', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const n = (sql) => pg.query(sql).then(r => r.rows[0].n).catch(() => null);
    const [teamsActive, teamsDeactivated, streamers, viewers, openGiveaways] = await Promise.all([
      n(`SELECT COUNT(*)::int AS n FROM teams WHERE deactivated_at IS NULL`),
      n(`SELECT COUNT(*)::int AS n FROM teams WHERE deactivated_at IS NOT NULL`),
      // Nur Konten mit echtem Login — vorgemerkte Plattform-Admins ohne
      // ersten Login (ensureSchema) zählen nicht als Benutzer.
      n(`SELECT COUNT(*)::int AS n FROM streamers WHERE last_login IS NOT NULL`),
      n(`SELECT COUNT(*)::int AS n FROM users`),
      n(`SELECT COUNT(*)::int AS n FROM sessions WHERE status IN ('open','paused')`),
    ]);
    res.json({ teamsActive, teamsDeactivated, streamers, viewers, openGiveaways });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Betriebsseite (/admin/betrieb.html), nur Superadmin ────────
// Drei Fragen, die im Betrieb wirklich gestellt werden: laufen die Dienste,
// kommen Zuschauer-Meldungen an, und was ist zuletzt schiefgegangen.

// Fehler und Ablehnungen aus dem Protokoll — teamübergreifend, weil genau
// das der Blick des Plattform-Betreibers ist.
app.get('/api/platform/errors', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const only = req.query.result === 'error' || req.query.result === 'denied'
      ? [req.query.result] : ['error', 'denied'];
    const r = await pg.query(`
      SELECT a.id, a.ts, a.team_id, t.name AS team_name, a.actor, a.action, a.target,
             a.result, a.detail
        FROM audit_log a LEFT JOIN teams t ON t.id = a.team_id
       WHERE a.result = ANY($1) ORDER BY a.id DESC LIMIT $2`, [only, limit]);
    res.json({ rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kennzahlen zum laufenden Betrieb (die Team-/Streamer-Zähler stehen in
// /api/platform/stats — hier geht es um Aktivität und Rückstand).
app.get('/api/platform/activity', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const n = (sql) => pg.query(sql).then(r => r.rows[0].n).catch(() => null);
    const [giveawaysOpen, drawsWeek, claimsOpen, claimsOverdue, eventsDay, flagsWeek,
           errorsDay, deniedDay, wagersWeek, entriesWeek] = await Promise.all([
      n(`SELECT COUNT(*)::int AS n FROM sessions WHERE status IN ('open','paused')`),
      n(`SELECT COUNT(*)::int AS n FROM giveaway_draws WHERE drawn_at > NOW() - INTERVAL '7 days' AND NOT is_test`),
      n(`SELECT COUNT(*)::int AS n FROM draw_claims WHERE status='open'`),
      n(`SELECT COUNT(*)::int AS n FROM draw_claims WHERE status='open' AND deadline_at < NOW()`),
      n(`SELECT COUNT(*)::int AS n FROM watchtime_events WHERE ts > NOW() - INTERVAL '24 hours'`),
      n(`SELECT COUNT(*)::int AS n FROM abuse_flags WHERE last_seen > NOW() - INTERVAL '7 days'`),
      n(`SELECT COUNT(*)::int AS n FROM audit_log WHERE result='error' AND ts > NOW() - INTERVAL '24 hours'`),
      n(`SELECT COUNT(*)::int AS n FROM audit_log WHERE result='denied' AND ts > NOW() - INTERVAL '24 hours'`),
      n(`SELECT COUNT(*)::int AS n FROM prize_wagers WHERE created_at > NOW() - INTERVAL '7 days'`),
      n(`SELECT COUNT(*)::int AS n FROM contest_entries WHERE created_at > NOW() - INTERVAL '7 days'`),
    ]);
    res.json({ giveawaysOpen, drawsWeek, claimsOpen, claimsOverdue, eventsDay, flagsWeek,
               errorsDay, deniedDay, wagersWeek, entriesWeek });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ingest-Puls je Kanal — kommt aus dem giveaway-Service (Redis liegt dort).
app.get('/api/platform/ingest', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const key = process.env.INTERNAL_API_KEY || '';
  if (!key) return res.json({ teams: [], error: 'INTERNAL_API_KEY fehlt — Puls nicht abrufbar' });
  try {
    const r = await fetch(CFG.services.giveaway + '/internal/ingest-pulse',
      { headers: { 'X-Internal-Key': key }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.status(502).json({ error: 'giveaway ' + r.status });
    res.json(await r.json());
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Debug-Zeilen der Streamerbot-Actions (cc_debug), jüngste zuerst.
app.get('/api/platform/debuglog', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pg.query(
      `SELECT id, ts, source, stage, username, info FROM debug_log ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ rows: r.rows });
  } catch (e) { res.json({ rows: [], error: e.message }); }
});

app.get('/api/platform/teams', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const r = await pg.query(`
      SELECT t.id, t.name, t.owner_login, t.created_at, t.deactivated_at,
             (SELECT COUNT(*)::int FROM team_members m WHERE m.team_id = t.id) AS members,
             EXISTS (SELECT 1 FROM sessions s
                      WHERE s.team_id = t.id AND s.status IN ('open','paused')) AS open_giveaway,
             (SELECT COUNT(*)::int FROM platform_warnings w
               WHERE w.subject_type='team' AND w.subject_id = t.id
                 AND w.acknowledged_at IS NULL) AS warnings_open
      FROM teams t ORDER BY t.created_at DESC LIMIT 1000`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/platform/streamers', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    const r = await pg.query(`
      SELECT s.login, s.display, s.created_at, s.last_login, s.is_platform_admin,
             s.banned_at, s.banned_reason,
             (SELECT COUNT(*)::int FROM teams t WHERE t.owner_login = s.login) AS owned_teams,
             (SELECT COUNT(*)::int FROM platform_warnings w
               WHERE w.subject_type='streamer' AND w.subject_id = s.login
                 AND w.acknowledged_at IS NULL) AS warnings_open
      FROM streamers s ORDER BY s.last_login DESC NULLS LAST LIMIT 1000`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/platform/warnings', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const type = String(req.query.type || '');
  if (type !== 'team' && type !== 'streamer') return res.status(400).json({ error: 'bad_type' });
  const id = type === 'team' ? sanitizeTeamIdParam(req.query.id) : A.sanitizeUserName(req.query.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const r = await pg.query(`
      SELECT id, reason, created_by, created_at, acknowledged_at, acknowledged_by
      FROM platform_warnings WHERE subject_type=$1 AND subject_id=$2
      ORDER BY created_at DESC LIMIT 100`, [type, id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/platform/warn', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const type = String((req.body && req.body.subjectType) || '');
  if (type !== 'team' && type !== 'streamer') return res.status(400).json({ error: 'bad_type' });
  const id = type === 'team'
    ? sanitizeTeamIdParam(req.body && req.body.subjectId)
    : A.sanitizeUserName(req.body && req.body.subjectId);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'reason_required' });
  try {
    const exists = type === 'team'
      ? await pg.query('SELECT 1 FROM teams WHERE id=$1', [id])
      : await pg.query('SELECT 1 FROM streamers WHERE login=$1', [id]);
    if (!exists.rowCount) return res.status(404).json({ error: 'not_found' });
    const ins = await pg.query(`
      INSERT INTO platform_warnings (subject_type, subject_id, reason, created_by)
      VALUES ($1,$2,$3,$4) RETURNING id`, [type, id, reason, sess.user]);
    if (type === 'team') await auditTeam(id, sess.user, 'platform_warn', id, 'ok', { reason });
    else await auditPlatform(sess.user, 'platform_warn', id, 'ok', { reason });
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deaktivierung durch die Plattform: wie die Owner-Route, aber ohne
// confirmName (stattdessen Pflicht-Grund). Ein offenes Giveaway blockiert
// weiterhin (409) — mit force werden die PG-Sessions vorher geschlossen,
// denn der Cleanup räumt nur Redis ab, nicht sessions.status.
app.post('/api/platform/teams/:id/deactivate', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const id = sanitizeTeamIdParam(req.params.id);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  const force = !!(req.body && req.body.force);
  if (!reason) return res.status(400).json({ error: 'reason_required' });
  try {
    const t = await pg.query('SELECT name, deactivated_at FROM teams WHERE id=$1', [id]);
    if (!t.rowCount) return res.status(404).json({ error: 'not_found' });
    if (t.rows[0].deactivated_at) return res.status(409).json({ error: 'already_deactivated' });
    const open = await teamHasOpenGiveaway(id);
    if (open && !force) return res.status(409).json({ error: 'giveaway_open' });
    let forcedClosedSessions = 0;
    if (open && force) {
      const r = await pg.query(
        `UPDATE sessions SET status='closed', closed_at=NOW()
         WHERE team_id=$1 AND status IN ('open','paused')`, [id]);
      forcedClosedSessions = r.rowCount;
    }
    await pg.query('UPDATE teams SET deactivated_at=NOW() WHERE id=$1', [id]);
    const cleanup = await giveawayCleanup(id);
    await auditTeam(id, sess.user, 'platform_team_deactivate', id, 'ok',
                    { reason, force, forcedClosedSessions, cleanup });
    res.json({ ok: true, forcedClosedSessions, cleanup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/platform/teams/:id/reactivate', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const id = sanitizeTeamIdParam(req.params.id);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  try {
    const r = await pg.query(
      'UPDATE teams SET deactivated_at=NULL WHERE id=$1 AND deactivated_at IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(409).json({ error: 'not_deactivated' });
    await auditTeam(id, sess.user, 'platform_team_reactivate', id, 'ok', { reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/platform/streamers/:login/ban', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const login = A.sanitizeUserName(req.params.login);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!login) return res.status(400).json({ error: 'bad_login' });
  if (login === sess.user) return res.status(400).json({ error: 'cannot_ban_self' });
  if (!reason) return res.status(400).json({ error: 'reason_required' });
  try {
    const r = await pg.query('SELECT is_platform_admin, banned_at FROM streamers WHERE login=$1', [login]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    if (r.rows[0].is_platform_admin) return res.status(400).json({ error: 'cannot_ban_admin' });
    if (r.rows[0].banned_at) return res.status(409).json({ error: 'already_banned' });
    await pg.query('UPDATE streamers SET banned_at=NOW(), banned_reason=$2 WHERE login=$1', [login, reason]);
    bannedLogins.add(login);
    await auditPlatform(sess.user, 'platform_streamer_ban', login, 'ok', { reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/platform/streamers/:login/unban', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const login = A.sanitizeUserName(req.params.login);
  if (!login) return res.status(400).json({ error: 'bad_login' });
  try {
    const r = await pg.query(
      'UPDATE streamers SET banned_at=NULL, banned_reason=NULL WHERE login=$1 AND banned_at IS NOT NULL', [login]);
    if (!r.rowCount) return res.status(409).json({ error: 'not_banned' });
    bannedLogins.remove(login);
    await auditPlatform(sess.user, 'platform_streamer_unban', login, 'ok', {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Verwarnungen: Sicht des Betroffenen ───────────────────
// Sichtbar sind eigene Streamer-Verwarnungen und Team-Verwarnungen der Teams,
// die man als Owner führt. Dasselbe Prädikat steht in der Ack-UPDATE — sonst
// könnte jeder beliebige IDs quittieren.
app.get('/api/me/warnings', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  try {
    const r = await pg.query(`
      SELECT w.id, w.subject_type, w.reason, w.created_at, t.name AS team_name
      FROM platform_warnings w
      LEFT JOIN teams t ON w.subject_type='team' AND t.id = w.subject_id
      WHERE w.acknowledged_at IS NULL AND (
        (w.subject_type='streamer' AND w.subject_id = $1) OR
        (w.subject_type='team' AND w.subject_id IN (
          SELECT team_id FROM team_members WHERE login=$1 AND role='owner')))
      ORDER BY w.created_at`, [s.user]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/me/warnings/:id/ack', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  try {
    const r = await pg.query(`
      UPDATE platform_warnings SET acknowledged_at=NOW(), acknowledged_by=$2
      WHERE id=$1 AND acknowledged_at IS NULL AND (
        (subject_type='streamer' AND subject_id = $2) OR
        (subject_type='team' AND subject_id IN (
          SELECT team_id FROM team_members WHERE login=$2 AND role='owner')))`, [id, s.user]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await auditPlatform(s.user, 'platform_warning_ack', String(id), 'ok', {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public (kein Login): statische Anleitungen (md) ───────
const PUB_DOCS = { help: 'help.md', setup: 'setup.md', impressum: 'impressum.md',
                   datenschutz: 'datenschutz.md', nutzungsbedingungen: 'nutzungsbedingungen.md',
                   haftungsausschluss: 'haftungsausschluss.md',
                   roadmap: 'roadmap.md', changelog: 'changelog.md',
                   funktionsweise: 'funktionsweise.md' };
app.get('/pub/doc/:name', (req, res) => {
  const file = PUB_DOCS[String(req.params.name || '')];
  if (!file) return res.status(404).json({ error: 'not_found' });
  try { res.json({ content: fs.readFileSync(path.join(__dirname, 'public-docs', file), 'utf8') }); }
  catch (e) { res.status(500).json({ error: 'unavailable' }); }
});

// ── Sitemap + robots.txt ──────────────────────────────────
// Nur Seiten, die ohne Session UND ohne Parameter vollstaendig sind. Bewusst
// draussen: /viewer/status (personenbezogen), /viewer/terms (braucht ?team=),
// /admin/join.html (braucht Einladungscode), /admin/home.html (Dublette zu /).
// Die Liste muss zur `@needsauth not path`-Whitelist in caddy/Caddyfile.team
// passen — was hier steht, aber dort fehlt, liefert Crawlern ein 302 auf Login.
const SITEMAP = [
  { loc: '/',                             prio: '1.0', freq: 'weekly'  },
  { loc: '/viewer/help',                  prio: '0.8', freq: 'monthly' },
  { loc: '/admin/funktionsweise.html',    prio: '0.8', freq: 'monthly' },
  { loc: '/admin/setup.html',             prio: '0.6', freq: 'monthly' },
  { loc: '/admin/changelog.html',         prio: '0.6', freq: 'weekly'  },
  { loc: '/admin/roadmap.html',           prio: '0.5', freq: 'monthly' },
  { loc: '/admin/nutzungsbedingungen.html', prio: '0.4', freq: 'yearly' },
  { loc: '/admin/datenschutz.html',       prio: '0.4', freq: 'yearly'  },
  { loc: '/admin/impressum.html',         prio: '0.3', freq: 'yearly'  },
  { loc: '/admin/haftungsausschluss.html', prio: '0.3', freq: 'yearly' },
];

app.get('/sitemap.xml', (req, res) => {
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const u of SITEMAP) {
    xml.push('  <url>', `    <loc>${CFG.publicUrl}${u.loc}</loc>`,
             `    <changefreq>${u.freq}</changefreq>`,
             `    <priority>${u.prio}</priority>`, '  </url>');
  }
  xml.push('</urlset>');
  res.type('application/xml; charset=utf-8').send(xml.join(NL) + NL);
});

app.get('/robots.txt', (req, res) => {
  // Alles hinter Login ist ohnehin gesperrt — die Disallow-Regeln halten
  // Crawler nur davon ab, sich an 302-Ketten und Personenseiten aufzuhalten.
  res.type('text/plain; charset=utf-8').send([
    'User-agent: *',
    'Disallow: /admin/',
    'Disallow: /giveaway/',
    'Disallow: /redis-ui/',
    'Disallow: /viewer/status',
    'Disallow: /viewer/terms',
    'Disallow: /health',
    'Disallow: /ingest',
    // Die Rechtstexte liegen unter /admin/, muessen aber auffindbar bleiben.
    ...SITEMAP.filter(u => u.loc.startsWith('/admin/')).map(u => `Allow: ${u.loc}`),
    '',
    `Sitemap: ${CFG.publicUrl}/sitemap.xml`,
    '',
  ].join(NL));
});

// ── Public: Streamerbot-C#-Actions (Code zum Kopieren) ────
app.get('/pub/actions', (req, res) => {
  try {
    const dir = path.join(__dirname, 'actions');
    const files = fs.readdirSync(dir).filter(f => /^[A-Za-z0-9_]+\.cs$/.test(f)).sort();
    res.json(files.map(f => ({ name: f, code: fs.readFileSync(path.join(dir, f), 'utf8') })));
  } catch (e) { res.status(500).json({ error: 'unavailable' }); }
});

// ── Public (kein Login): Team-Infos + Teilnahmebedingungen ─
app.get('/pub/team/:id', async (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
  try {
    const t = await pg.query('SELECT name, terms, imprint, imprint_url FROM teams WHERE id=$1', [id]);
    if (!t.rowCount) return res.status(404).json({ error: 'not_found' });
    const mem = await pg.query('SELECT channel FROM team_members WHERE team_id=$1 ORDER BY joined_at', [id]);
    // Aenderungshistorie ist bewusst oeffentlich - sie ist der Beleg dafuer,
    // welche Fassung wann galt. Wer geaendert hat, bleibt intern.
    const hist = await pg.query(
      `SELECT version, note, sections, created_at FROM terms_versions
       WHERE team_id=$1 ORDER BY version DESC LIMIT 20`, [id]);
    // ?version=N liefert genau diese historische Fassung — so bleibt fuer
    // jede Session nachweisbar, welcher Text galt (sessions.terms_version).
    const vReq = parseInt(req.query.version, 10);
    let terms = t.rows[0].terms || TERMS_TEMPLATE;
    let historical = null;
    if (Number.isFinite(vReq) && vReq > 0) {
      const hv = await pg.query(
        `SELECT version, terms, created_at FROM terms_versions WHERE team_id=$1 AND version=$2`, [id, vReq]);
      if (!hv.rowCount) return res.status(404).json({ error: 'version_not_found' });
      terms = hv.rows[0].terms;
      historical = { version: hv.rows[0].version, createdAt: hv.rows[0].created_at,
                     isCurrent: hist.rows[0] ? hist.rows[0].version === hv.rows[0].version : false };
    }
    res.json({ id, name: t.rows[0].name, terms,
               imprint: t.rows[0].imprint || '', imprintUrl: t.rows[0].imprint_url || '',
               isDefault: !t.rows[0].terms && !historical, channels: mem.rows.map(r => r.channel),
               version: hist.rows[0] ? hist.rows[0].version : 0,
               updatedAt: hist.rows[0] ? hist.rows[0].created_at : null,
               historical,
               history: hist.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Liveness (public, ohne Details) ───────────────────────
// Ziel der Docker-Healthchecks. Verrät bewusst nichts über andere Services.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// ── Aggregated health (superadmin) ────────────────────────
// Nennt Namen, URLs und Fehlertexte der internen Services — nicht öffentlich.
// Die Prüfung steht hier UND in Caddy: /admin/health umgeht den Caddy-Matcher.
app.get('/health', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const results = {};
  let allOk = true;
  await Promise.all(Object.entries(CFG.services).map(async ([name, url]) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      results[name] = r.ok ? 'ok' : `error (${r.status})`;
      if (!r.ok) allOk = false;
    } catch(e) {
      results[name] = `unreachable: ${e.message}`;
      allOk = false;
    }
  }));
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', services: results });
});

// ── Static admin pages ────────────────────────────────────
app.use(express.static('public'));
app.get('*', (req, res) => res.sendFile('index.html', { root: 'public' }));

// ── Schema + bootstrap ────────────────────────────────────
async function ensureSchema() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            BIGSERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login    TIMESTAMPTZ
    )`);

  // Multi-tenant: self-registered streamers + teams.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS streamers (
      login             TEXT PRIMARY KEY,
      twitch_id         TEXT,
      display           TEXT,
      avatar            TEXT,
      is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
      access_token      TEXT,
      refresh_token     TEXT,
      token_expires     TIMESTAMPTZ,
      scopes            TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login        TIMESTAMPTZ
    )`);
  for (const col of ['access_token TEXT','refresh_token TEXT','token_expires TIMESTAMPTZ','scopes TEXT']) {
    await pg.query(`ALTER TABLE streamers ADD COLUMN IF NOT EXISTS ${col}`);
  }
  // Plattform-Sperre (Plattform-Verwaltung): Login-Block als Flag, kein
  // Datenlöschen — Löschung läuft weiterhin über die DSGVO-Pfade.
  await pg.query(`ALTER TABLE streamers ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ`);
  await pg.query(`ALTER TABLE streamers ADD COLUMN IF NOT EXISTS banned_reason TEXT`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_login TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      terms       TEXT,
      overlay_key TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS terms TEXT`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS overlay_key TEXT`);
  // Backfill overlay_key für Bestands-Teams (JS, kein pgcrypto nötig).
  const miss = await pg.query(`SELECT id FROM teams WHERE overlay_key IS NULL`);
  for (const row of miss.rows) {
    await pg.query('UPDATE teams SET overlay_key=$1 WHERE id=$2', [crypto.randomBytes(8).toString('hex'), row.id]);
  }
  await pg.query(`
    CREATE TABLE IF NOT EXISTS terms_versions (
      id         BIGSERIAL PRIMARY KEY,
      team_id    TEXT NOT NULL,
      version    INTEGER NOT NULL,
      terms      TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      note       TEXT,
      sections   JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team_id, version)
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_terms_team ON terms_versions(team_id, version DESC)`);
  // Jedes Giveaway braucht ein eigenes Impressum des Veranstalters -
  // entweder als Text oder als Link auf eine bestehende Seite.
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS imprint TEXT`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS imprint_url TEXT`);
  // Team-Lebenszyklus (Issue #1): Deaktivierung ist ein Flag, kein DELETE —
  // Ziehungsnachweise und Audit referenzieren die team_id dauerhaft.
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`);
  await pg.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS invites_disabled BOOLEAN NOT NULL DEFAULT FALSE`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      login     TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'member',
      channel   TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, login)
    )`);
  // Zustimmung zu den Nutzungsbedingungen: wer, welche Fassung, wann.
  // Historie bleibt erhalten (kein UPDATE) - eine frueher erteilte Zustimmung
  // ist Beweismittel und darf durch eine spaetere nicht ueberschrieben werden.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS tos_acceptances (
      login       TEXT NOT NULL,
      version     INTEGER NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (login, version)
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_tos_login ON tos_acceptances(login, version DESC)`);
  // Verwarnungen der Plattform-Verwaltung. Ack-Status ist mutierbarer Zustand
  // und gehört deshalb nicht ins append-only audit_log; die Aktion selbst
  // wird dort zusätzlich protokolliert.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS platform_warnings (
      id              BIGSERIAL PRIMARY KEY,
      subject_type    TEXT NOT NULL CHECK (subject_type IN ('team','streamer')),
      subject_id      TEXT NOT NULL,
      reason          TEXT NOT NULL,
      created_by      TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by TEXT
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_pw_subject ON platform_warnings(subject_type, subject_id)`);
  // Rückmeldungen aus der Oberfläche (Fehler/Wunsch). Wird zusätzlich in den
  // Discord-Kanal des Betreiberteams geschickt; die Zeile hier bleibt auch
  // dann erhalten, wenn Discord gerade nicht erreichbar ist.
  await pg.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      login      TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('bug','idea','question')),
      page       TEXT,
      message    TEXT NOT NULL,
      delivered  BOOLEAN NOT NULL DEFAULT FALSE,
      error      TEXT
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts DESC)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_tm_login ON team_members(login)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_teams_code ON teams(invite_code)`);
  const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM admin_users');
  if (rows[0].n === 0) {
    let pass = CFG.bootstrapPass;
    if (!pass) {
      pass = require('crypto').randomBytes(9).toString('base64url');
      log('Auth', `No admin users + no ADMIN_BOOTSTRAP_PASS — created superadmin "${CFG.bootstrapUser}" with password: ${pass}`);
    }
    const hash = await A.hashPassword(pass);
    await pg.query(
      `INSERT INTO admin_users (username, password_hash, role) VALUES ($1,$2,'superadmin')`,
      [A.sanitizeUserName(CFG.bootstrapUser), hash]
    );
    log('Auth', `Bootstrap superadmin "${CFG.bootstrapUser}" created`);
  }

  // Plattform-Admins (Twitch-Logins) aus der Konfiguration durchsetzen. Der
  // Eintrag wird vorgemerkt, auch wenn sich der Kanal noch nie eingeloggt hat —
  // beim ersten Login greift dann sofort die Superadmin-Rolle.
  for (const login of CFG.platformAdmins) {
    await pg.query(
      `INSERT INTO streamers (login, is_platform_admin) VALUES ($1, TRUE)
       ON CONFLICT (login) DO UPDATE SET is_platform_admin = TRUE`, [login]);
  }
  if (CFG.platformAdmins.length) log('Auth', `Platform admins: ${CFG.platformAdmins.join(', ')}`);
}

async function pgReady() {
  for (let i = 0; i < 30; i++) {
    try { const c = await pg.connect(); c.release(); return; }
    catch(e) { log('PG', `Waiting... (${i + 1}/30)`); await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('PG: could not connect');
}

async function main() {
  await pgReady();
  await ensureSchema();
  // Sperr-Cache VOR listen füllen — sonst gäbe es ein Fenster, in dem ein
  // gebannter Login mit gültigem Cookie durch /auth/verify käme.
  await refreshBannedLogins();
  setInterval(refreshBannedLogins, 60000).unref();
  app.listen(CFG.port, () => log('Admin', `Service on port ${CFG.port}`));
}
main().catch(e => { logErr('FATAL', e.message); process.exit(1); });
