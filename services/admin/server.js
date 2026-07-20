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
app.use(express.json());

// ── Session helper ────────────────────────────────────────
function sessionFromReq(req) {
  const cookies = A.parseCookies(req.headers.cookie);
  return A.verifyToken(cookies[A.COOKIE_NAME], CFG.sessionSecret);
}

// ── Auth routes ───────────────────────────────────────────
// forward_auth target. 200 (+identity headers) if valid, else 302 → login.
app.get('/auth/verify', (req, res) => {
  const sess = sessionFromReq(req);
  if (!sess) return res.redirect(302, CFG.loginPath);
  res.set('X-Auth-User', sess.user);
  res.set('X-Auth-Role', sess.role);
  res.status(200).end();
});

app.get('/auth/me', (req, res) => {
  const sess = sessionFromReq(req);
  if (!sess) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ user: sess.user, role: sess.role });
});

app.post('/auth/login', async (req, res) => {
  const user = A.sanitizeUserName(req.body && req.body.username);
  const pass = req.body && req.body.password;
  if (!user || !pass) return res.status(400).json({ error: 'missing_credentials' });
  try {
    const r = await pg.query('SELECT username, password_hash, role FROM admin_users WHERE username=$1', [user]);
    const row = r.rows[0];
    const ok = row && await A.verifyPassword(pass, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
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
    const sr = await pg.query('SELECT is_platform_admin FROM streamers WHERE login=$1', [login]);
    const role = sr.rows[0] && sr.rows[0].is_platform_admin ? 'superadmin' : 'streamer';

    issueSession(res, login, role);
    res.append('Set-Cookie', `oauth_state=; Path=/; Max-Age=0`);
    const next = cookies.oauth_next ? decodeURIComponent(cookies.oauth_next) : '/admin/teams.html';
    res.append('Set-Cookie', `oauth_next=; Path=/; Max-Age=0`);
    res.redirect(302, next.startsWith('/') ? next : '/admin/teams.html');
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
const TOS_VERSION = 1;

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
      SELECT t.id, t.name, t.owner_login, t.invite_code, m.role
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
    const t = await pg.query('SELECT id, name, owner_login, invite_code, overlay_key FROM teams WHERE id=$1', [id]);
    if (!t.rowCount) return res.status(404).json({ error: 'not_found' });
    const mem = await pg.query('SELECT login, role, channel, joined_at FROM team_members WHERE team_id=$1 ORDER BY role DESC, joined_at', [id]);
    const owner = await isTeamOwner(id, s.user);
    const row = t.rows[0];
    if (!owner) delete row.overlay_key;   // Overlay-Key nur für Owner
    res.json({ ...row, members: mem.rows, you_owner: owner });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/teams/join', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (!await requireTos(req, res, s)) return;
  const code = String((req.body && req.body.code) || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
  if (!code) return res.status(400).json({ error: 'code_required' });
  try {
    const t = await pg.query('SELECT id FROM teams WHERE invite_code=$1', [code]);
    if (!t.rowCount) return res.status(404).json({ error: 'invalid_code' });
    const id = t.rows[0].id;
    await pg.query(`INSERT INTO team_members (team_id, login, role, channel) VALUES ($1,$2,'member',$2)
                    ON CONFLICT (team_id, login) DO NOTHING`, [id, s.user]);
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
  try { await pg.query('DELETE FROM team_members WHERE team_id=$1 AND login=$2', [id, target]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

app.get('/api/gdpr/subject/:username', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const u = sanitizeViewer(req.params.username);
  if (!u) return res.status(400).json({ error: 'Ungültiger Benutzername' });
  try {
    const q = (sql, p) => pg.query(sql, p).then(r => r.rows).catch(() => []);
    const [user, events, participation, flags, audit, draws, teams] = await Promise.all([
      q('SELECT username, display, last_seen FROM users WHERE username=$1', [u]),
      q(`SELECT team_id, channel, event_type, count(*)::int AS n, min(ts) AS first, max(ts) AS last,
                sum(delta_sec)::int AS total_sec
         FROM watchtime_events WHERE username=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`, [u]),
      q(`SELECT session_id, channel, watch_sec, msgs, coins, follows, valid
         FROM campaign_participation WHERE username=$1 ORDER BY session_id`, [u]),
      q('SELECT session_id, team_id, reason, occurrences, first_seen, last_seen, detail FROM abuse_flags WHERE username=$1', [u]),
      q(`SELECT id, ts, team_id, actor, action, result, detail FROM audit_log
         WHERE target=$1 ORDER BY ts DESC LIMIT 500`, [u]),
      q(`SELECT id, session_id, winner, winner_coins, drawn_at, is_test FROM giveaway_draws
         WHERE winner=$1 ORDER BY drawn_at DESC`, [u]),
      q(`SELECT DISTINCT team_id FROM watchtime_events WHERE username=$1`, [u]),
    ]);
    res.json({ username: u, found: !!(user.length || events.length || participation.length || audit.length || draws.length),
               user: user[0] || null, teams: teams.map(t => t.team_id),
               watchtimeEvents: events, participation, abuseFlags: flags,
               auditEntries: audit, draws });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/gdpr/subject/:username/delete', async (req, res) => {
  const sess = requireSuperadmin(req, res); if (!sess) return;
  const u = sanitizeViewer(req.params.username);
  if (!u) return res.status(400).json({ error: 'Ungültiger Benutzername' });
  if (String((req.body && req.body.confirm) || '') !== u) {
    return res.status(400).json({ error: 'Zur Bestätigung den Benutzernamen wiederholen' });
  }
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
    // Ziehungsprotokolle werden NICHT geloescht, sondern pseudonymisiert:
    // sie belegen, dass korrekt gezogen wurde (Art. 17 Abs. 3 lit. e DSGVO).
    // Der Name verschwindet, der Nachweis bleibt.
    const pseudo = 'geloescht_' + require('crypto').createHash('sha256').update(u).digest('hex').slice(0, 8);
    const dr = await client.query('UPDATE giveaway_draws SET winner=$2 WHERE winner=$1', [u, pseudo]);
    done.giveaway_draws_pseudonymisiert = dr.rowCount;
    const sn = await client.query(
      `UPDATE giveaway_draws SET eligible_snapshot = REPLACE(eligible_snapshot::text, $1, $2)::jsonb
       WHERE eligible_snapshot::text LIKE '%' || $1 || '%'`, [u, pseudo]);
    done.snapshots_pseudonymisiert = sn.rowCount;
    const al = await client.query('UPDATE audit_log SET target=$2 WHERE target=$1', [u, pseudo]);
    done.audit_log_pseudonymisiert = al.rowCount;

    await client.query(
      `INSERT INTO audit_log (team_id, actor, action, target, result, detail)
       VALUES (NULL, $1, 'gdpr_delete', $2, 'ok', $3)`,
      [sess.user, pseudo, JSON.stringify(done)]);
    await client.query('COMMIT');
    res.json({ ok: true, pseudonym: pseudo, deleted: done });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Public (kein Login): statische Anleitungen (md) ───────
const PUB_DOCS = { help: 'help.md', setup: 'setup.md', impressum: 'impressum.md',
                   datenschutz: 'datenschutz.md', nutzungsbedingungen: 'nutzungsbedingungen.md' };
app.get('/pub/doc/:name', (req, res) => {
  const file = PUB_DOCS[String(req.params.name || '')];
  if (!file) return res.status(404).json({ error: 'not_found' });
  try { res.json({ content: fs.readFileSync(path.join(__dirname, 'public-docs', file), 'utf8') }); }
  catch (e) { res.status(500).json({ error: 'unavailable' }); }
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
    res.json({ id, name: t.rows[0].name, terms: t.rows[0].terms || TERMS_TEMPLATE,
               imprint: t.rows[0].imprint || '', imprintUrl: t.rows[0].imprint_url || '',
               isDefault: !t.rows[0].terms, channels: mem.rows.map(r => r.channel),
               version: hist.rows[0] ? hist.rows[0].version : 0,
               updatedAt: hist.rows[0] ? hist.rows[0].created_at : null,
               history: hist.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Aggregated health (public) ────────────────────────────
app.get('/health', async (req, res) => {
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
  app.listen(CFG.port, () => log('Admin', `Service on port ${CFG.port}`));
}
main().catch(e => { logErr('FATAL', e.message); process.exit(1); });
