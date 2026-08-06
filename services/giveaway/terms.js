'use strict';

// ── Unveränderliche Teilnahmebedingungen-Fassung je Session ──────────────
// Kein Giveaway startet ohne eingefrorene Fassung (> 0): existiert noch
// keine terms_versions-Zeile für das Team, wird die effektive Fassung vom
// admin-Service geholt und als v1 gespeichert. Schlägt das fehl, wirft
// snapshotTermsVersion — der Aufrufer bricht den Start ab, BEVOR Redis-
// oder DB-Zustand angelegt wird.
//
// Eigenes Modul, damit die Logik ohne laufenden Server testbar ist:
// pg und fetch werden injiziert (Tests: In-Memory-Mock + Stub).

class TermsSnapshotError extends Error {
  constructor(reason) {
    super('Teilnahmebedingungen-Fassung konnte nicht eingefroren werden: ' + reason);
    this.name = 'TermsSnapshotError';
    this.code = 'terms_snapshot_failed';
    this.reason = reason;
  }
}

async function snapshotTermsVersion(pg, teamId, { adminUrl, fetchFn = globalThis.fetch, timeoutMs = 3000 } = {}) {
  // Vorhandene Fassung wiederverwenden — Fassungen sind unveränderlich.
  const r = await pg.query(
    `SELECT COALESCE(MAX(version),0) AS v FROM terms_versions WHERE team_id=$1`, [teamId]);
  const v = parseInt(r.rows[0] && r.rows[0].v, 10) || 0;
  if (v > 0) return v;

  // Erste Fassung: effektive Bedingungen (Team-Text oder Vorlage) über die
  // öffentliche Team-Seite des admin-Service holen.
  let info;
  try {
    const resp = await fetchFn(`${adminUrl}/pub/team/${encodeURIComponent(teamId)}`,
      { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error(`admin-Service antwortet ${resp.status}`);
    info = await resp.json();
  } catch (e) {
    throw new TermsSnapshotError('admin-Service nicht erreichbar (' + e.message + ')');
  }
  if (!info || !info.terms) throw new TermsSnapshotError('keine Bedingungen lieferbar');

  // WHERE NOT EXISTS: parallele Starts desselben Teams erzeugen keine zwei v1.
  await pg.query(`
    INSERT INTO terms_versions (team_id, version, terms, changed_by, note, sections)
    SELECT $1, 1, $2, 'system', 'Automatischer Snapshot beim ersten Giveaway-Start', $3
    WHERE NOT EXISTS (SELECT 1 FROM terms_versions WHERE team_id=$1)`,
    [teamId, info.terms, JSON.stringify([{ section: '(alle)', kind: 'neu' }])]);

  // Nachlesen statt annehmen: war ein Parallelstart schneller, gilt dessen
  // Fassung; steht danach immer noch nichts in der Tabelle, ist das ein Fehler.
  const r2 = await pg.query(
    `SELECT COALESCE(MAX(version),0) AS v FROM terms_versions WHERE team_id=$1`, [teamId]);
  const v2 = parseInt(r2.rows[0] && r2.rows[0].v, 10) || 0;
  if (v2 <= 0) throw new TermsSnapshotError('Snapshot wurde nicht gespeichert');
  return v2;
}

module.exports = { snapshotTermsVersion, TermsSnapshotError };
