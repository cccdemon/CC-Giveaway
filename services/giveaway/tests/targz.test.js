'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { tar, targz, BLOCK } = require('../targz.js');

// Header-Felder so lesen, wie tar sie liest.
function readEntries(buf) {
  const out = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every(b => b === 0)) break;              // Endblock
    const str = (s, l) => h.subarray(s, s + l).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(str(124, 12), 8);
    const body = buf.subarray(off + BLOCK, off + BLOCK + size).toString('utf8');
    out.push({ name: str(0, 100), size, body, magic: str(257, 6), typeflag: str(156, 1) || '0',
               chksum: parseInt(str(148, 8), 8), header: h });
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

test('tar: Name, Groesse und Inhalt kommen unveraendert wieder raus', () => {
  const files = [
    { name: 'MANIFEST.txt', content: 'hallo\nwelt\n' },
    { name: 'audit.csv',    content: 'id;actor\n1;deimos\n' },
  ];
  const e = readEntries(tar(files, 1700000000));
  assert.equal(e.length, 2);
  assert.equal(e[0].name, 'MANIFEST.txt');
  assert.equal(e[0].body, 'hallo\nwelt\n');
  assert.equal(e[0].size, Buffer.byteLength(files[0].content));
  assert.equal(e[1].name, 'audit.csv');
  assert.equal(e[1].body, files[1].content);
});

test('tar: ustar-Magic und Typeflag gesetzt', () => {
  const e = readEntries(tar([{ name: 'a.txt', content: 'x' }], 1700000000));
  assert.equal(e[0].magic, 'ustar');
  assert.equal(e[0].typeflag, '0');
});

test('tar: Header-Pruefsumme stimmt', () => {
  const e = readEntries(tar([{ name: 'a.txt', content: 'x'.repeat(1000) }], 1700000000));
  const h = Buffer.from(e[0].header);
  h.write('        ', 148, 8, 'utf8');            // chksum-Feld neutralisieren
  let sum = 0; for (const b of h) sum += b;
  assert.equal(e[0].chksum, sum);
});

test('tar: endet mit zwei Nullbloecken und ist 512-Byte-aligned', () => {
  const buf = tar([{ name: 'a.txt', content: 'kurz' }], 1700000000);
  assert.equal(buf.length % BLOCK, 0);
  assert.ok(buf.subarray(buf.length - BLOCK * 2).every(b => b === 0));
});

test('tar: UTF-8-Inhalt bleibt byte-genau', () => {
  const content = 'Gewinner: Müller — 3,50 Coins ✓\n';
  const e = readEntries(tar([{ name: 'u.txt', content }], 1700000000));
  assert.equal(e[0].body, content);
  assert.equal(e[0].size, Buffer.byteLength(content, 'utf8'));
});

test('targz: gzip-Header und identischer Inhalt nach gunzip', () => {
  const gz = targz([{ name: 'a.txt', content: 'inhalt' }], 1700000000);
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  const e = readEntries(zlib.gunzipSync(gz));
  assert.equal(e[0].body, 'inhalt');
});

test('tar: zu langer Dateiname wird abgelehnt statt still abgeschnitten', () => {
  assert.throws(() => tar([{ name: 'x'.repeat(120), content: 'a' }], 1700000000),
                /zu lang/);
});
