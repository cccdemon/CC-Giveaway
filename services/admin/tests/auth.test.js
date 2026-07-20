'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../auth.js');

const SECRET = 'test-secret-123';

test('signToken/verifyToken roundtrip', () => {
  const tok = A.signToken({ user: 'bob', role: 'admin' }, SECRET);
  const p = A.verifyToken(tok, SECRET);
  assert.equal(p.user, 'bob');
  assert.equal(p.role, 'admin');
  assert.equal(typeof p.exp, 'number');
});

test('verifyToken rejects wrong secret', () => {
  const tok = A.signToken({ user: 'bob', role: 'admin' }, SECRET);
  assert.equal(A.verifyToken(tok, 'other-secret'), null);
});

test('verifyToken rejects tampered payload', () => {
  const tok = A.signToken({ user: 'bob', role: 'admin' }, SECRET);
  const [, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ user: 'bob', role: 'superadmin', exp: A.nowSec() + 100 })).toString('base64url') + '.' + sig;
  assert.equal(A.verifyToken(forged, SECRET), null);
});

test('verifyToken rejects expired token', () => {
  const tok = A.signToken({ user: 'bob', role: 'admin' }, SECRET, -1);
  assert.equal(A.verifyToken(tok, SECRET), null);
});

test('verifyToken rejects garbage', () => {
  assert.equal(A.verifyToken('', SECRET), null);
  assert.equal(A.verifyToken('nodot', SECRET), null);
  assert.equal(A.verifyToken(null, SECRET), null);
});

test('parseCookies', () => {
  const c = A.parseCookies('cc_session=abc.def; other=1');
  assert.equal(c.cc_session, 'abc.def');
  assert.equal(c.other, '1');
  assert.deepEqual(A.parseCookies(''), {});
});

test('serialize/clear session cookie flags', () => {
  const set = A.serializeSessionCookie('tok', { secure: true });
  assert.match(set, /cc_session=tok/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(A.clearSessionCookie({ secure: true }), /Max-Age=0/);
  assert.doesNotMatch(A.serializeSessionCookie('t', { secure: false }), /Secure/);
});

test('sanitizeUserName + sanitizeRole', () => {
  assert.equal(A.sanitizeUserName('Bob_123!!'), 'bob_123');
  assert.equal(A.sanitizeRole('superadmin'), 'superadmin');
  assert.equal(A.sanitizeRole('hacker'), 'admin');
});

test('hashPassword/verifyPassword', async () => {
  const h = await A.hashPassword('secret123');
  assert.ok(await A.verifyPassword('secret123', h));
  assert.equal(await A.verifyPassword('wrong', h), false);
});
