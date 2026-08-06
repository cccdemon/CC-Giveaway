'use strict';

// ── P6 (Restpunkte): Ersatzziehungs-Sperre ───────────────────────────────
// Ein wirksam abgewickelter Gewinn (gemeldet oder in Abwicklung) darf nicht
// per Ersatzziehung dupliziert werden; pending/expired/replaced sind frei.

const test = require('node:test');
const assert = require('node:assert');
const { rerollBlocked, REROLL_BLOCK_MSG } = require('../claim-rules.js');

test('reroll-sperre: pending, expired und replaced sind frei', () => {
  assert.equal(rerollBlocked({ status: 'pending',  handling: null }), null);
  assert.equal(rerollBlocked({ status: 'expired',  handling: null }), null);
  assert.equal(rerollBlocked({ status: 'replaced', handling: null }), null);
  assert.equal(rerollBlocked(null), null);   // kein Claim (z.B. Testziehung)
});

test('reroll-sperre: gemeldeter Claim blockiert', () => {
  assert.equal(rerollBlocked({ status: 'claimed', handling: null }), 'claimed');
  assert.ok(REROLL_BLOCK_MSG.claimed);
});

test('reroll-sperre: begonnene Abwicklung blockiert (contacted/shipped/done)', () => {
  assert.equal(rerollBlocked({ status: 'claimed', handling: 'contacted' }), 'contacted');
  assert.equal(rerollBlocked({ status: 'claimed', handling: 'shipped' }),  'shipped');
  assert.equal(rerollBlocked({ status: 'claimed', handling: 'done' }),     'done');
  // Abwicklung zaehlt auch, wenn der Status (extern erfasst o.ae.) abweicht.
  assert.equal(rerollBlocked({ status: 'pending', handling: 'contacted' }), 'contacted');
  assert.ok(REROLL_BLOCK_MSG.shipped && REROLL_BLOCK_MSG.done && REROLL_BLOCK_MSG.contacted);
});

test('reroll-sperre: unbekannte handling-Werte blockieren nicht faelschlich', () => {
  assert.equal(rerollBlocked({ status: 'pending', handling: 'irgendwas' }), null);
});
