'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createBanCache } = require('../ban-cache.js');

test('leer nach Erzeugung', () => {
  const c = createBanCache();
  assert.strictEqual(c.size(), 0);
  assert.strictEqual(c.has('alice'), false);
});

test('add/remove wirken sofort', () => {
  const c = createBanCache();
  c.add('alice');
  assert.strictEqual(c.has('alice'), true);
  c.remove('alice');
  assert.strictEqual(c.has('alice'), false);
});

test('add ignoriert leere Werte', () => {
  const c = createBanCache();
  c.add('');
  c.add(null);
  c.add(undefined);
  assert.strictEqual(c.size(), 0);
});

test('replaceAll ersetzt den kompletten Bestand', () => {
  const c = createBanCache();
  c.add('alice');
  c.replaceAll(['bob', 'carol']);
  assert.strictEqual(c.has('alice'), false);
  assert.strictEqual(c.has('bob'), true);
  assert.strictEqual(c.has('carol'), true);
  assert.strictEqual(c.size(), 2);
});

test('replaceAll mit leerer/fehlender Liste leert den Cache', () => {
  const c = createBanCache();
  c.add('alice');
  c.replaceAll([]);
  assert.strictEqual(c.size(), 0);
  c.add('bob');
  c.replaceAll(null);
  assert.strictEqual(c.size(), 0);
});

test('replaceAll filtert leere Eintraege', () => {
  const c = createBanCache();
  c.replaceAll(['alice', '', null]);
  assert.strictEqual(c.size(), 1);
  assert.strictEqual(c.has('alice'), true);
});

test('remove auf unbekanntem Login ist ein No-Op', () => {
  const c = createBanCache();
  assert.doesNotThrow(() => c.remove('nie_gesehen'));
  assert.strictEqual(c.size(), 0);
});
