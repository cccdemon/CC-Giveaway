// ── Browser-Fehlerberichte: Aufbereitung (pur, ohne express/pg) ────────────
// Die Server-Logs sehen nur, was den Server erreicht. Ein kaputtes Skript im
// Browser ist dort unsichtbar — genau so blieb /viewer/help am 23.8.26 im
// Ladezustand stehen, waehrend Caddy zufrieden 200 lieferte.
//
// Bewusst OHNE Personenbezug: kein Nutzername, keine IP, kein Cookie. Fuer die
// Fehlersuche reichen Seite, Meldung, Datei/Zeile und die Browser-Familie.
// Damit bleibt `debug_log` frei von personenbezogenen Daten und die
// DSGVO-Pfade (Auskunft/Loeschung) muessen nichts mitziehen.
'use strict';

const LIMITS = {
  msg: 300,      // Fehlertext
  file: 200,     // Datei/Pfad, in dem es knallte
  stack: 700,    // gekuerzter Stack
  path: 200,     // Seite, auf der es passierte
  ua: 120,       // Browser-Kennung
  info: 1600,    // Gesamtlaenge der gespeicherten Zeile
};

// Alles, was wie ein Geheimnis aussieht, fliegt raus, BEVOR etwas gespeichert
// wird: Bild-Tokens (unerratbar, rotierend), Einladungscodes, Session-Reste in
// Query-Strings. Lieber eine unschaerfere Fehlermeldung als ein Token im Log.
function maskSecrets(s) {
  return String(s == null ? '' : s)
    // /giveaway/api/prize/image/<token> und contest/image/<token>
    .replace(/\/(prize|contest)\/image\/[A-Za-z0-9_-]+/g, '/$1/image/<token>')
    // Query-Werte, die nach Schluessel klingen
    .replace(/([?&](?:token|key|code|secret|auth|session|next)=)[^&\s"']+/gi, '$1<entfernt>')
    // freistehende lange Hex-/Base64-Ketten (Tokens, Hashes)
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<token>');
}

function clean(s, max) {
  return maskSecrets(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

// Browser-Familie statt vollstaendigem User-Agent: hilft bei "nur im Safari",
// taugt aber nicht als Wiedererkennungsmerkmal.
function browserFamily(ua) {
  const s = String(ua || '');
  if (/Edg\//.test(s)) return 'Edge';
  if (/OPR\//.test(s)) return 'Opera';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Chrome\//.test(s)) return 'Chrome';
  if (/Safari\//.test(s)) return 'Safari';
  if (/bot|crawler|spider/i.test(s)) return 'Bot';
  return 'unbekannt';
}

// Fremd-Origin-Fehler liefern nur "Script error." ohne Datei und Zeile — die
// sind zum Debuggen wertlos und wuerden das Log fuellen.
function isUseless(msg, file) {
  const m = String(msg || '').trim();
  if (!m) return true;
  if (/^script error\.?$/i.test(m) && !file) return true;
  return false;
}

// Aus dem Rohbericht des Browsers wird eine Zeile fuer debug_log — oder null,
// wenn nichts Brauchbares drinsteht.
function sanitizeReport(body, ua) {
  const b = (body && typeof body === 'object') ? body : {};
  const kind = b.kind === 'promise' ? 'promise' : 'error';
  const msg = clean(b.msg, LIMITS.msg);
  const file = clean(b.file, LIMITS.file);
  if (isUseless(msg, file)) return null;

  const path = clean(b.path, LIMITS.path) || '?';
  const line = Number.isFinite(+b.line) && +b.line > 0 ? Math.min(+b.line | 0, 999999) : null;
  const col = Number.isFinite(+b.col) && +b.col > 0 ? Math.min(+b.col | 0, 999999) : null;
  const stack = clean(b.stack, LIMITS.stack);

  const where = file ? `${file}${line ? ':' + line : ''}${line && col ? ':' + col : ''}` : '';
  const parts = [msg];
  if (where) parts.push('@ ' + where);
  parts.push('[' + browserFamily(ua) + ']');
  if (stack && stack !== msg) parts.push('| ' + stack);

  return {
    source: 'client',
    stage: path.slice(0, LIMITS.path),
    kind,
    info: parts.join(' ').slice(0, LIMITS.info),
  };
}

// Gleiche Meldung an gleicher Stelle auf gleicher Seite = ein Eintrag. Ohne
// das schreibt eine Fehlerschleife in einer Render-Funktion das Log voll —
// genau so entstanden im Audit-Log schon einmal Millionen Zeilen.
function fingerprint(rep) {
  return [rep.stage, rep.kind, rep.info.slice(0, 120)].join('|');
}

// Dedupe-Fenster im Prozessspeicher. `seen` ist eine Map fingerprint -> ts;
// abgelaufene Eintraege werden dabei aufgeraeumt (kein Zustand ohne TTL).
function shouldStore(seen, fp, now, windowMs = 10 * 60 * 1000, maxEntries = 500) {
  const last = seen.get(fp);
  if (last && now - last < windowMs) return false;
  if (seen.size >= maxEntries) {
    for (const [k, ts] of seen) if (now - ts >= windowMs) seen.delete(k);
    if (seen.size >= maxEntries) seen.clear();   // Notbremse
  }
  seen.set(fp, now);
  return true;
}

// Grobe Mengenbremse je Absender-IP (die IP wird NICHT gespeichert, nur
// gezaehlt): mehr als `max` Berichte im Fenster werden verworfen.
function allowFrom(counters, ip, now, windowMs = 60 * 1000, max = 10) {
  const c = counters.get(ip);
  if (!c || now - c.start >= windowMs) {
    if (counters.size > 2000) counters.clear();
    counters.set(ip, { start: now, n: 1 });
    return true;
  }
  if (c.n >= max) return false;
  c.n++;
  return true;
}

module.exports = { sanitizeReport, fingerprint, shouldStore, allowFrom,
                   maskSecrets, browserFamily, isUseless, LIMITS };
