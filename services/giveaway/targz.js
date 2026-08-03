'use strict';

// ════════════════════════════════════════════════════════
// Minimaler tar.gz-Writer (ustar) — fuer Audit-Archive.
// Kein npm-Paket noetig: ein Archiv besteht hier aus wenigen Textdateien,
// und tar ist ein 512-Byte-Header plus auf 512 aufgefuellte Nutzdaten.
// Rein und testbar: rein Buffer, kein Dateisystem, kein Netz.
// ════════════════════════════════════════════════════════

const zlib = require('zlib');

const BLOCK = 512;

function padOctal(num, len) {
  // ustar-Zahlenfelder: oktal, rechtsbuendig mit Nullen, danach ein NUL.
  return num.toString(8).padStart(len - 1, '0') + '\0';
}

function writeStr(buf, str, offset, len) {
  buf.write(String(str).slice(0, len - 1), offset, len - 1, 'utf8');
}

// Ein tar-Header. mtime in Sekunden seit Epoch.
function header(name, size, mtimeSec) {
  const h = Buffer.alloc(BLOCK, 0);
  if (Buffer.byteLength(name, 'utf8') > 99) {
    throw new Error(`Dateiname zu lang fuer ustar: ${name}`);
  }
  writeStr(h, name, 0, 100);
  h.write(padOctal(0o644, 8), 100, 8, 'utf8');   // mode
  h.write(padOctal(0, 8), 108, 8, 'utf8');       // uid
  h.write(padOctal(0, 8), 116, 8, 'utf8');       // gid
  h.write(padOctal(size, 12), 124, 12, 'utf8');
  h.write(padOctal(Math.floor(mtimeSec), 12), 136, 12, 'utf8');
  h.write('        ', 148, 8, 'utf8');           // chksum-Feld: erst Leerzeichen
  h.write('0', 156, 1, 'utf8');                  // typeflag: normale Datei
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  writeStr(h, 'root', 265, 32);                  // uname
  writeStr(h, 'root', 297, 32);                  // gname

  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

function padTo512(buf) {
  const rest = buf.length % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest, 0);
}

// files: [{ name, content }] — content als String oder Buffer.
function tar(files, mtimeSec) {
  const parts = [];
  for (const f of files) {
    const body = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    parts.push(header(f.name, body.length, mtimeSec), body, padTo512(body));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));   // zwei Nullbloecke = Ende
  return Buffer.concat(parts);
}

function targz(files, mtimeSec) {
  return zlib.gzipSync(tar(files, mtimeSec), { level: 9 });
}

module.exports = { tar, targz, header, BLOCK };
