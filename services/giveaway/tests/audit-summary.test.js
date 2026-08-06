'use strict';

// ── P5 (Restpunkte): CORE-Einheiten in den Audit-Zusammenfassungen ───────
// giveaway-shared.js exportiert CC.audit.summary auch unter node
// (globalThis-Fallback, Navigations-Teil bricht ohne DOM sauber ab).

const test = require('node:test');
const assert = require('node:assert');
require('../public/giveaway-shared.js');
const summary = globalThis.CC.audit.summary;

function draw(extra) {
  return { action: 'gw_draw_winner',
           detail: Object.assign({ winner: 'bob', winnerCoins: 4, eligibleCount: 3 }, extra) };
}

test('audit-summary: Kampagne (und Altbestand ohne core) sagt Coins', () => {
  assert.match(summary(draw({})), /4\.00 Coins von 3 Teilnehmern/);
  assert.match(summary(draw({ core: 'CORE_WatchtimeChatActivity' })), /Coins von 3/);
});

test('audit-summary: Sofortverlosung nennt keine Coins, sondern gleiche Chance', () => {
  const s = summary(draw({ core: 'CORE_CurrentViewers', winnerCoins: 1 }));
  assert.match(s, /gleiche Chance, 3 im Topf/);
  assert.doesNotMatch(s, /Coins/);
});

test('audit-summary: TicketBuy sagt gesetzte Lose und Setzer', () => {
  const s = summary(draw({ core: 'CORE_TicketBuy', winnerCoins: 7 }));
  assert.match(s, /7 Lose gesetzt, 3 Setzer/);
  assert.doesNotMatch(s, /Coins/);
});

test('audit-summary: Contest sagt Voting-Punkte', () => {
  const s = summary(draw({ core: 'CORE_ScreenshotContest', winnerCoins: 42 }));
  assert.match(s, /42 Punkte \(Voting\)/);
  assert.doesNotMatch(s, /Coins/);
});

test('audit-summary: Ersatzziehung nennt die Ursprungsziehung', () => {
  assert.match(summary(draw({ rerollOf: 17 })), /Ersatz für Ziehung #17/);
});

test('audit-summary: Reset/Bann sprechen vom Kampagnenstand, nicht pauschal Coins', () => {
  assert.match(summary({ action: 'gw_reset', detail: { wipedParticipants: 5, wipedCoins: 12 } }),
               /Punkte \(Kampagnenstand\)/);
  assert.match(summary({ action: 'gw_ban', detail: { coinsAtBan: 2.5, wasEligible: true } }),
               /Punkte Kampagnenstand.*Lostopf/);
});
