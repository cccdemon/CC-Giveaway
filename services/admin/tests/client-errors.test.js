// Aufbereitung der Browser-Fehlerberichte (services/admin/client-errors.js).
// Wichtigste Zusagen: keine Geheimnisse im Log, kein Personenbezug, und eine
// Fehlerschleife im Browser darf die Tabelle nicht fluten.
const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeReport, fingerprint, shouldStore, allowFrom,
        maskSecrets, browserFamily, isUseless, LIMITS } = require('../client-errors.js');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

test('client-errors: echter Fehler wird zu einer Log-Zeile', () => {
  const rep = sanitizeReport({
    kind: 'error', msg: 'CCDoc is not defined', file: '/viewer/help',
    line: 30, col: 9, path: '/viewer/help', stack: 'at help:30:9'
  }, CHROME);
  assert.equal(rep.source, 'client');
  assert.equal(rep.stage, '/viewer/help');
  assert.equal(rep.kind, 'error');
  assert.match(rep.info, /CCDoc is not defined/);
  assert.match(rep.info, /@ \/viewer\/help:30:9/);
  assert.match(rep.info, /\[Chrome\]/);
});

test('client-errors: Tokens und Schluessel landen nie im Log', () => {
  // Bild-Tokens sind unerratbar und rotieren — sie duerfen nicht ueber einen
  // Fehlerbericht in ein Log wandern, das Superadmins lesen.
  assert.equal(maskSecrets('GET /giveaway/api/prize/image/abc123XYZ_-def fehlgeschlagen'),
    'GET /giveaway/api/prize/image/<token> fehlgeschlagen');
  assert.equal(maskSecrets('/giveaway/api/contest/image/tok_9f8e7d'),
    '/giveaway/api/contest/image/<token>');
  assert.match(maskSecrets('/admin/login.html?next=/geheim&token=SUPERSECRET'), /token=<entfernt>/);
  assert.match(maskSecrets('hash 0123456789abcdef0123456789abcdef'), /<hex>/);
  assert.match(maskSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaaaaaaaaaaaaa'), /<token>/);

  const rep = sanitizeReport({
    msg: 'Bild fehlt', file: '/giveaway/api/prize/image/geheimeslangestoken',
    path: '/giveaway/wager.html?token=abcdef', line: 1
  }, CHROME);
  assert.ok(!/geheimeslangestoken/.test(rep.info), 'Token im info-Feld');
  assert.ok(!/abcdef/.test(rep.stage), 'Token im stage-Feld');
});

test('client-errors: nutzlose Fremd-Origin-Fehler werden verworfen', () => {
  assert.equal(isUseless('Script error.', ''), true);
  assert.equal(isUseless('', ''), true);
  assert.equal(isUseless('Script error.', '/admin/nav.js'), false);
  assert.equal(sanitizeReport({ msg: 'Script error.', path: '/admin/teams.html' }, CHROME), null);
  assert.equal(sanitizeReport({}, CHROME), null);
  assert.equal(sanitizeReport(null, CHROME), null);
});

test('client-errors: Laengen sind gedeckelt', () => {
  const rep = sanitizeReport({
    msg: 'x'.repeat(5000), file: 'f'.repeat(5000), path: 'p'.repeat(5000),
    stack: 's'.repeat(9000), line: 10
  }, CHROME);
  assert.ok(rep.info.length <= LIMITS.info, 'info zu lang: ' + rep.info.length);
  assert.ok(rep.stage.length <= LIMITS.path);
});

test('client-errors: nur die Browser-Familie, nicht der ganze User-Agent', () => {
  assert.equal(browserFamily(CHROME), 'Chrome');
  assert.equal(browserFamily('Mozilla/5.0 ... Firefox/130.0'), 'Firefox');
  assert.equal(browserFamily('Mozilla/5.0 (Macintosh) Version/17 Safari/605.1'), 'Safari');
  assert.equal(browserFamily('Mozilla/5.0 ... Edg/140.0'), 'Edge');
  assert.equal(browserFamily(''), 'unbekannt');
  const rep = sanitizeReport({ msg: 'kaputt', file: 'a.js', line: 2, path: '/x' }, CHROME);
  assert.ok(!/AppleWebKit|537\.36/.test(rep.info), 'voller User-Agent im Log');
});

test('client-errors: derselbe Fehler wird im Zeitfenster nur einmal gespeichert', () => {
  const seen = new Map();
  const rep = sanitizeReport({ msg: 'boom', file: 'a.js', line: 1, path: '/x' }, CHROME);
  const fp = fingerprint(rep);
  const t0 = 1000000;
  assert.equal(shouldStore(seen, fp, t0), true);
  assert.equal(shouldStore(seen, fp, t0 + 1000), false);        // Schleife im Browser
  assert.equal(shouldStore(seen, fp, t0 + 60000), false);
  assert.equal(shouldStore(seen, fp, t0 + 11 * 60 * 1000), true); // Fenster vorbei
  // Anderer Fehler auf derselben Seite bleibt eigenstaendig.
  const other = sanitizeReport({ msg: 'anders', file: 'a.js', line: 1, path: '/x' }, CHROME);
  assert.equal(shouldStore(seen, fingerprint(other), t0 + 1000), true);
});

test('client-errors: Dedupe-Map waechst nicht unbegrenzt', () => {
  const seen = new Map();
  const t0 = 5000000;
  for (let i = 0; i < 1200; i++) shouldStore(seen, 'fp' + i, t0 + i, 10 * 60 * 1000, 500);
  assert.ok(seen.size <= 500, 'Map zu gross: ' + seen.size);
});

test('client-errors: Mengenbremse je Absender', () => {
  const c = new Map();
  const t0 = 2000000;
  for (let i = 0; i < 10; i++) assert.equal(allowFrom(c, '1.2.3.4', t0 + i), true, 'Bericht ' + i);
  assert.equal(allowFrom(c, '1.2.3.4', t0 + 11), false);         // 11. im Fenster
  assert.equal(allowFrom(c, '5.6.7.8', t0 + 11), true);          // anderer Absender
  assert.equal(allowFrom(c, '1.2.3.4', t0 + 61000), true);       // neues Fenster
});

test('client-errors: Bericht enthaelt keinen Personenbezug', () => {
  // Selbst wenn der Client etwas mitschickt, wird es nicht uebernommen.
  const rep = sanitizeReport({
    msg: 'kaputt', file: 'a.js', line: 3, path: '/admin/teams.html',
    username: 'justcallmedeimos', ip: '1.2.3.4', cookie: 'sess=abc'
  }, CHROME);
  assert.deepEqual(Object.keys(rep).sort(), ['info', 'kind', 'source', 'stage']);
  assert.ok(!/justcallmedeimos|1\.2\.3\.4|sess=/.test(JSON.stringify(rep)));
});
