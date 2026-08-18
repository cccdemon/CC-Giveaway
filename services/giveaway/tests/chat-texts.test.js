'use strict';

// Chat-Ansagen-Katalog: editierbare Vorlagen je (Core, Nachricht) mit
// Platzhaltern und Link-Anhang. Pure Funktionen — keine Infrastruktur.

const { test } = require('node:test');
const assert = require('node:assert');
const { renderTemplate, resolveChatText, listChatTexts, SAMPLE_CTX } = require('../chat-texts.js');

test('renderTemplate ersetzt Platzhalter, unbekannte werden leer', () => {
  assert.equal(renderTemplate('Hi {name}, {x} Lose', { name: 'bob' }), 'Hi bob,  Lose');
  assert.equal(renderTemplate('ohne Platzhalter', {}), 'ohne Platzhalter');
  assert.equal(renderTemplate('', { a: 1 }), '');
});

test('resolveChatText: ohne Override kommt der eingebaute Standardtext', () => {
  const t = resolveChatText('CORE_WatchtimeChatActivity', 'pause', {});
  assert.equal(t, '⏸ Giveaway pausiert — Zuschauzeit zählt gerade nicht. Euer Punktestand bleibt erhalten.');
});

test('resolveChatText: Override ersetzt den Text, Platzhalter werden gefüllt', () => {
  const t = resolveChatText('CORE_TicketBuy', 'open',
    { keyword: 'los', befehl: '!setzen' },
    { text: 'Eigenes Los-Giveaway! Keyword {keyword}, Befehl {befehl}.' });
  assert.equal(t, 'Eigenes Los-Giveaway! Keyword los, Befehl !setzen.');
});

test('resolveChatText: Haken hängen Links an (Teilnahmebedingungen + Seite)', () => {
  const ctx = { termsUrl: 'https://x/terms', pageUrl: 'https://x/wager' };
  const t = resolveChatText('CORE_TicketBuy', 'open', ctx,
    { text: 'Kurz.', appendTerms: true, appendPage: true });
  assert.equal(t, 'Kurz. Teilnahmebedingungen: https://x/terms → https://x/wager');
  const nur = resolveChatText('CORE_TicketBuy', 'open', ctx, { text: 'Kurz.', appendPage: true });
  assert.equal(nur, 'Kurz. → https://x/wager');
});

test('resolveChatText: leerer Override fällt auf den Standard zurück (fail-open)', () => {
  const std = resolveChatText('CORE_CurrentViewers', 'reopened', {});
  assert.equal(resolveChatText('CORE_CurrentViewers', 'reopened', {}, { text: '   ' }), std);
  assert.equal(resolveChatText('CORE_Unbekannt', 'gibtsnicht', {}), '');
});

test('resolveChatText: Boost-Ansagen liegen in der Gruppe _common', () => {
  const t = resolveChatText('_common', 'boostStart', { minuten: 15, faktor: 2 });
  assert.match(t, /15 Minuten/);
  assert.match(t, /×2/);
});

test('resolveChatText: Winner-Texte kommen aus dem jeweiligen Core', () => {
  const cv = resolveChatText('CORE_CurrentViewers', 'winner', { gewinner: 'bob' });
  assert.match(cv, /@bob/);
  const tb = resolveChatText('CORE_TicketBuy', 'winner', { gewinner: 'bob', preis: 'Headset' });
  assert.match(tb, /Headset/);
});

test('listChatTexts liefert Katalog je Gruppe mit gerenderten Beispielen', () => {
  const l = listChatTexts('CORE_TicketBuy');
  assert.ok(l.length >= 6);
  const open = l.find(e => e.key === 'open');
  assert.ok(open.label);
  assert.ok(Array.isArray(open.placeholders));
  assert.ok(open.defaultText.length > 10);
  assert.ok(SAMPLE_CTX.keyword);
  // Gruppen ohne Katalog sind leer, nicht kaputt
  assert.deepEqual(listChatTexts('CORE_Unbekannt'), []);
});
