'use strict';

// ── P1 (Restpunkte): Start-Gate für die Bedingungen-Fassung ──────────────
// snapshotTermsVersion liefert IMMER eine Fassung > 0 oder wirft — kein
// Giveaway ohne eingefrorene Teilnahmebedingungen. In-Memory-pg + Fetch-Stub,
// keine Infrastruktur (Repo-Regel: tests/ fasst weder Redis noch Netz an).

const test = require('node:test');
const assert = require('node:assert');
const { snapshotTermsVersion, TermsSnapshotError } = require('../terms.js');

const TEAM = 'team_test';
const ADMIN = 'http://admin:3005';

// In-Memory terms_versions: genau die drei Query-Formen des Moduls.
function makePg() {
  const rows = [];
  return {
    rows,
    async query(sql, p = []) {
      if (/SELECT COALESCE\(MAX\(version\),0\)/.test(sql)) {
        const v = rows.filter(r => r.team_id === p[0]).reduce((m, r) => Math.max(m, r.version), 0);
        return { rows: [{ v }] };
      }
      if (/INSERT INTO terms_versions/.test(sql)) {
        // WHERE NOT EXISTS — wie in Postgres: nur einfügen, wenn Team leer.
        if (!rows.some(r => r.team_id === p[0])) {
          rows.push({ team_id: p[0], version: 1, terms: p[1], changed_by: 'system' });
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
      throw new Error('unerwartete Query: ' + sql);
    },
  };
}

function okFetch(terms) {
  return async () => ({ ok: true, json: async () => ({ terms }) });
}

test('terms: erster Start friert v1 aus den effektiven Bedingungen ein', async () => {
  const pg = makePg();
  const v = await snapshotTermsVersion(pg, TEAM, { adminUrl: ADMIN, fetchFn: okFetch('# Regeln') });
  assert.equal(v, 1);
  assert.equal(pg.rows.length, 1);
  assert.equal(pg.rows[0].terms, '# Regeln');
  assert.equal(pg.rows[0].changed_by, 'system');
});

test('terms: vorhandene Fassung wird wiederverwendet, kein Fetch noetig', async () => {
  const pg = makePg();
  pg.rows.push({ team_id: TEAM, version: 3, terms: 'alt' });
  let fetched = 0;
  const v = await snapshotTermsVersion(pg, TEAM, {
    adminUrl: ADMIN, fetchFn: async () => { fetched++; throw new Error('darf nicht passieren'); } });
  assert.equal(v, 3);
  assert.equal(fetched, 0);
  assert.equal(pg.rows.length, 1);          // nichts Neues eingefroren
});

test('terms: admin-Service nicht erreichbar -> wirft, nichts gespeichert', async () => {
  const pg = makePg();
  await assert.rejects(
    snapshotTermsVersion(pg, TEAM, { adminUrl: ADMIN, fetchFn: async () => { throw new Error('ECONNREFUSED'); } }),
    (e) => e instanceof TermsSnapshotError && e.code === 'terms_snapshot_failed');
  assert.equal(pg.rows.length, 0);
});

test('terms: HTTP-Fehler und leere Antwort werfen ebenfalls', async () => {
  const pg = makePg();
  await assert.rejects(
    snapshotTermsVersion(pg, TEAM, { adminUrl: ADMIN, fetchFn: async () => ({ ok: false, status: 502 }) }),
    TermsSnapshotError);
  await assert.rejects(
    snapshotTermsVersion(pg, TEAM, { adminUrl: ADMIN, fetchFn: okFetch('') }),
    TermsSnapshotError);
  assert.equal(pg.rows.length, 0);
});

test('terms: parallele Erststarts erzeugen genau EINE Fassung', async () => {
  const pg = makePg();
  const opts = { adminUrl: ADMIN, fetchFn: okFetch('# Regeln') };
  const [a, b, c] = await Promise.all([
    snapshotTermsVersion(pg, TEAM, opts),
    snapshotTermsVersion(pg, TEAM, opts),
    snapshotTermsVersion(pg, TEAM, opts),
  ]);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(pg.rows.length, 1);          // WHERE NOT EXISTS greift
});

test('terms: Teams sind getrennt — v1 je Team, keine Vermischung', async () => {
  const pg = makePg();
  const opts = { adminUrl: ADMIN, fetchFn: okFetch('x') };
  assert.equal(await snapshotTermsVersion(pg, 'team_a', opts), 1);
  assert.equal(await snapshotTermsVersion(pg, 'team_b', opts), 1);
  assert.equal(pg.rows.length, 2);
});
