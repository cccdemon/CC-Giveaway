'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const registry = require('../cores');
const campaign = require('../cores/watchtime-chat');
const instant = require('../cores/current-viewers');
const ticketBuy = require('../cores/ticket-buy');
const contest = require('../cores/screenshot-contest');

test('negative: unbekannte Core-ID aktiviert keinen fremden Core', () => {
  assert.strictEqual(registry.getCore('__proto__'), campaign);
  assert.strictEqual(registry.getCore('constructor'), campaign);
  assert.strictEqual(registry.getCore('CORE_Quiz'), campaign);
});

test('negative: Sofortverlosung sperrt unregistrierte, gebannte und unqualifizierte Nutzer', () => {
  const base = { username: 'alice', registered: true, banned: false,
                 present: true, watchSec: 600, follows: true, cfg: {} };
  for (const change of [
    { registered: false },
    { banned: true },
    { watchSec: 599 },
    { follows: false },
  ]) {
    const p = instant.aggregate({ ...base, ...change });
    assert.equal(p.eligible, false, JSON.stringify(change));
    assert.equal(p.weight, 0, JSON.stringify(change));
    assert.deepEqual(instant.buildPool([p]), [], JSON.stringify(change));
  }
});

test('negative: TicketBuy akzeptiert keine partiellen, negativen oder mehrdeutigen Betraege', () => {
  for (const msg of [
    '!setzen -1', '!setzen +1', '!setzen 1.5', '!setzen 2abc',
    '!setzen 2 extra', '!setzen NaN', '!setzen Infinity',
    '!setzen 9007199254740992',
  ]) {
    assert.deepEqual(ticketBuy.parseWager(msg, '!setzen'), { help: true }, msg);
  }
  assert.equal(ticketBuy.parseWager('text !setzen 2', '!setzen'), null);
  assert.deepEqual(ticketBuy.parseWager('!setzen 0', '!setzen'), { amount: 0 });
  assert.deepEqual(ticketBuy.parseWager('!setzen 2', '!setzen'), { amount: 2 });
});

test('negative: TicketBuy-Pool verwirft Null- und Negativ-Einsaetze', () => {
  const pool = ticketBuy.buildPool([
    { username: 'negative', stake: -5 },
    { username: 'zero', stake: 0 },
    { username: 'valid', stake: 2 },
  ]);
  assert.deepEqual(pool.map(p => [p.username, p.weight]), [['valid', 2]]);
});

test('negative: Contest akzeptiert nur vollstaendige endliche Ganzzahlen als Vote', () => {
  for (const value of [null, undefined, {}, [], '', ' ', '10abc', '1.5', NaN, Infinity]) {
    assert.equal(contest.clampScore(value), null, String(value));
  }
  // Echte Ganzzahlen werden weiterhin auf den vertraglichen Bereich 1..10 begrenzt.
  assert.equal(contest.clampScore('-1'), 1);
  assert.equal(contest.clampScore('11'), 10);
  assert.equal(contest.clampScore('7'), 7);
});

test('negative: Contest-Pool ignoriert ungepruefte und unbewertete Einsendungen', () => {
  const pool = contest.buildPool([
    { entryId: 1, username: 'pending', title: 'P', score: 99, votes: 10, status: 'pending' },
    { entryId: 2, username: 'novotes', title: 'N', score: 0, votes: 0, status: 'approved' },
    { entryId: 3, username: 'valid', title: 'V', score: 5, votes: 1, status: 'approved' },
  ]);
  assert.deepEqual(pool.map(p => p.username), ['valid']);
});

