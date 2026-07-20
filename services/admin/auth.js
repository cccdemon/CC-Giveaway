'use strict';

// ════════════════════════════════════════════════════════
// Auth helpers — pure, testable (no express/pg/redis).
// Stateless signed-cookie sessions (HMAC-SHA256), bcrypt passwords.
// ════════════════════════════════════════════════════════

const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');

const COOKIE_NAME = 'cc_session';
const DEFAULT_TTL = 12 * 3600;   // 12h

function b64url(buf)      { return Buffer.from(buf).toString('base64url'); }
function b64urlDecode(s)  { return Buffer.from(s, 'base64url').toString('utf8'); }

// ── Token: base64url(payload).hmac ────────────────────────
function signToken(payload, secret, ttl = DEFAULT_TTL) {
  const body = { ...payload, exp: nowSec() + ttl };
  const data = b64url(JSON.stringify(body));
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  // constant-time compare
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(data)); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < nowSec()) return null;
  return payload;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// ── Cookies ───────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeSessionCookie(token, { ttl = DEFAULT_TTL, secure = true } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${ttl}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie({ secure = true } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ── Passwords ─────────────────────────────────────────────
function hashPassword(plain)          { return bcrypt.hash(String(plain), 12); }
function verifyPassword(plain, hash)  { return bcrypt.compare(String(plain), String(hash || '')); }

// ── Input ─────────────────────────────────────────────────
function sanitizeUserName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
}
const ROLES = ['superadmin', 'admin'];
function sanitizeRole(r) { return ROLES.indexOf(r) !== -1 ? r : 'admin'; }

module.exports = {
  COOKIE_NAME, DEFAULT_TTL, ROLES,
  signToken, verifyToken, nowSec,
  parseCookies, serializeSessionCookie, clearSessionCookie,
  hashPassword, verifyPassword,
  sanitizeUserName, sanitizeRole,
};
