// Navigationslogik (services/admin/public/nav.js) — pure Funktionen, kein DOM.
// Geprüft werden die Zusagen aus dem UI-Review vom 18.8.26: Rollenmatrix,
// aktive Markierung je Route, keine Sackgassen für Anonyme, Dropdown-Grösse.
const { test } = require('node:test');
const assert = require('node:assert');

const nav = require('../public/nav.js');
const { SECTIONS, visibleSections, activeFor, normPath, canSee, homeFor } = nav;

const ANON = null;
const VIEWER = { user: 'zuschauer', role: 'streamer', teams: 0 };
const ORG    = { user: 'streamer1', role: 'streamer', teams: 1 };
const SA     = { user: 'admin1',    role: 'superadmin', teams: 0 };

const ids = (secs) => secs.map(s => s.id);
const itemIds = (secs, secId) =>
  (secs.find(s => s.id === secId) || { items: [] }).items.filter(i => !i.head).map(i => i.id);

test('nav: Rollenmatrix — wer sieht welche Bereiche', () => {
  // Anonym: nur oeffentlich erreichbare Ziele, kein Veranstalter-/Plattformkram.
  assert.deepEqual(ids(visibleSections(SECTIONS, ANON)), ['team', 'part', 'help']);
  assert.deepEqual(itemIds(visibleSections(SECTIONS, ANON), 'team'), ['tm-setup']);

  // Eingeloggt ohne Team: Teilnehmer-Sicht, keine GIVEAWAYS-Betriebsziele.
  assert.deepEqual(ids(visibleSections(SECTIONS, VIEWER)), ['team', 'part', 'help']);

  // Mit Team: Veranstalter-Bereich kommt dazu, Plattform bleibt weg.
  assert.deepEqual(ids(visibleSections(SECTIONS, ORG)), ['giveaways', 'team', 'part', 'help']);

  // Superadmin sieht alles, auch ohne eigenes Team.
  assert.deepEqual(ids(visibleSections(SECTIONS, SA)),
    ['giveaways', 'team', 'part', 'help', 'platform']);
});

test('nav: canSee — audience-Regeln', () => {
  assert.equal(canSee('all', ANON), false);
  assert.equal(canSee('all', VIEWER), true);
  assert.equal(canSee('org', VIEWER), false);
  assert.equal(canSee('org', ORG), true);
  assert.equal(canSee('org', SA), true);      // Superadmin gilt als Veranstalter
  assert.equal(canSee('sa', ORG), false);
  assert.equal(canSee('sa', SA), true);
});

test('nav: keine leeren Gruppen-Ueberschriften', () => {
  for (const session of [ANON, VIEWER, ORG, SA]) {
    for (const sec of visibleSections(SECTIONS, session)) {
      sec.items.forEach((it, i) => {
        if (!it.head) return;
        const next = sec.items[i + 1];
        assert.ok(next && !next.head,
          `Kopfzeile "${it.head}" in ${sec.id} ohne folgenden Eintrag`);
      });
    }
  }
});

test('nav: hoechstens sieben ungruppierte Ziele je Dropdown', () => {
  // Akzeptanzkriterium P0 des Reviews: laenger als sieben wird unscannbar,
  // darum braucht ein volleres Menue Gruppen-Ueberschriften.
  for (const sec of visibleSections(SECTIONS, SA)) {
    let run = 0;
    for (const it of sec.items) {
      run = it.head ? 0 : run + 1;
      assert.ok(run <= 7, `${sec.id}: ${run} Ziele ohne Gruppenkopf`);
    }
  }
});

test('nav: aktive Markierung je Route', () => {
  const secs = visibleSections(SECTIONS, SA);
  const cases = [
    ['/giveaway/giveaway-admin.html', 'giveaways', 'gw-dash'],
    ['/giveaway/claims.html',         'giveaways', 'gw-claims'],
    ['/giveaway/audit.html',          'giveaways', 'gw-audit'],
    ['/admin/teams.html',             'team',      'tm-teams'],
    ['/admin/setup.html',             'team',      'tm-setup'],
    ['/giveaway/wager.html',          'part',      'pt-wager'],
    ['/admin/meine-daten.html',       'part',      'pt-data'],
    ['/admin/doku.html',              'help',      'hp-doku'],
    ['/admin/impressum.html',         'help',      'hp-imp'],
    ['/admin/betrieb.html',           'platform',  'pf-betrieb'],
    ['/admin/tests/test-runner.html', 'platform',  'pf-suite'],
  ];
  for (const [path, section, item] of cases) {
    assert.deepEqual(activeFor(secs, path), { section, item }, path);
  }
});

test('nav: Alias-Pfade treffen denselben Eintrag', () => {
  const secs = visibleSections(SECTIONS, ORG);
  // /viewer/status ist ein Caddy-Rewrite auf status.html — beide Wege fuehren
  // auf denselben Menuepunkt, sonst verliert die Seite ihre Standortanzeige.
  assert.deepEqual(activeFor(secs, '/viewer/status'), { section: 'part', item: 'pt-status' });
  assert.deepEqual(activeFor(secs, '/admin/status.html'), { section: 'part', item: 'pt-status' });
  assert.deepEqual(activeFor(secs, '/viewer/help'), { section: 'help', item: 'hp-guide' });
  assert.deepEqual(activeFor(secs, '/admin/help.html'), { section: 'help', item: 'hp-guide' });
  // Query und Anker aendern den Standort nicht (Archiv-Detailseiten).
  assert.deepEqual(activeFor(secs, '/giveaway/archive.html?session=sess_1#top'),
    { section: 'giveaways', item: 'gw-archive' });
  // Verzeichnis-Ziel und index.html sind dasselbe.
  assert.deepEqual(activeFor(visibleSections(SECTIONS, SA), '/admin/index.html'),
    { section: 'platform', item: 'pf-cc' });
});

test('nav: unbekannter Pfad markiert nichts', () => {
  const secs = visibleSections(SECTIONS, ORG);
  assert.equal(activeFor(secs, '/admin/login.html'), null);
  assert.equal(activeFor(secs, '/'), null);
  assert.equal(activeFor(secs, '/gibt-es-nicht'), null);
  // Ziel ausserhalb der eigenen Rolle markiert ebenfalls nichts.
  assert.equal(activeFor(visibleSections(SECTIONS, VIEWER), '/giveaway/audit.html'), null);
});

test('nav: normPath vereinheitlicht Pfade', () => {
  assert.equal(normPath('/admin/teams.html?x=1'), '/admin/teams.html');
  assert.equal(normPath('admin/teams.html'), '/admin/teams.html');
  assert.equal(normPath('/admin/'), '/admin');
  assert.equal(normPath('/'), '/');
  assert.equal(normPath(''), '/');
});

test('nav: Startseite je Rolle', () => {
  assert.equal(homeFor(ORG), '/giveaway/giveaway-admin.html');
  assert.equal(homeFor(SA),  '/giveaway/giveaway-admin.html');
  assert.equal(homeFor(VIEWER), '/viewer/status');
  assert.equal(homeFor(ANON), '/viewer/status');
});

test('nav: jedes Ziel hat id, Label und Pfad', () => {
  const seen = new Set();
  for (const sec of SECTIONS) {
    for (const it of sec.items) {
      if (it.head) continue;
      assert.ok(it.id && it.label && it.href, `unvollstaendiger Eintrag in ${sec.id}`);
      assert.ok(!seen.has(it.id), `doppelte id ${it.id}`);
      seen.add(it.id);
      assert.equal(it.href.charAt(0), '/', `${it.id}: Pfad muss absolut sein`);
    }
  }
});
