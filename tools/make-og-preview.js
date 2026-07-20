// Erzeugt og-preview.png (1200x630) ohne externe Abhängigkeiten.
// Blockschrift passend zum Terminal-Look des Panels (Share Tech Mono / Cyan auf Dunkel).
const zlib = require('zlib');
const fs = require('fs');

const W = 1200, H = 630;

// ── 5x7 Bitmapfont ────────────────────────────────────────
const F = {
  A:['01110','10001','10001','11111','10001','10001','10001'],
  B:['11110','10001','10001','11110','10001','10001','11110'],
  C:['01110','10001','10000','10000','10000','10001','01110'],
  D:['11110','10001','10001','10001','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'],
  F:['11111','10000','10000','11110','10000','10000','10000'],
  G:['01110','10001','10000','10111','10001','10001','01111'],
  H:['10001','10001','10001','11111','10001','10001','10001'],
  I:['11111','00100','00100','00100','00100','00100','11111'],
  J:['00111','00010','00010','00010','00010','10010','01100'],
  K:['10001','10010','10100','11000','10100','10010','10001'],
  L:['10000','10000','10000','10000','10000','10000','11111'],
  M:['10001','11011','10101','10101','10001','10001','10001'],
  N:['10001','11001','10101','10011','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'],
  P:['11110','10001','10001','11110','10000','10000','10000'],
  Q:['01110','10001','10001','10001','10101','10010','01101'],
  R:['11110','10001','10001','11110','10100','10010','10001'],
  S:['01111','10000','10000','01110','00001','00001','11110'],
  T:['11111','00100','00100','00100','00100','00100','00100'],
  U:['10001','10001','10001','10001','10001','10001','01110'],
  V:['10001','10001','10001','10001','10001','01010','00100'],
  W:['10001','10001','10001','10101','10101','11011','10001'],
  X:['10001','10001','01010','00100','01010','10001','10001'],
  Y:['10001','10001','01010','00100','00100','00100','00100'],
  Z:['11111','00001','00010','00100','01000','10000','11111'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00110','01000','10000','11111'],
  '3':['11111','00010','00100','00010','00001','10001','01110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],
  '5':['11111','10000','11110','00001','00001','10001','01110'],
  '6':['00110','01000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00010','01100'],
  '.':['00000','00000','00000','00000','00000','01100','01100'],
  ',':['00000','00000','00000','00000','01100','01100','01000'],
  '-':['00000','00000','00000','11111','00000','00000','00000'],
  ':':['00000','01100','01100','00000','01100','01100','00000'],
  '/':['00001','00010','00010','00100','01000','01000','10000'],
  '!':['00100','00100','00100','00100','00100','00000','00100'],
  ' ':['00000','00000','00000','00000','00000','00000','00000'],
};

const buf = Buffer.alloc(W * H * 3);
const px = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
};
const rect = (x, y, w, h, r, g, b) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, r, g, b);
};
const textW = (s, scale, gap) => s.length * (5 * scale + gap) - gap;
const text = (s, x, y, scale, r, g, b, gap = scale * 2) => {
  let cx = x;
  for (const raw of s.toUpperCase()) {
    const glyph = F[raw] || F[' '];
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++)
        if (glyph[row][col] === '1') rect(cx + col * scale, y + row * scale, scale, scale, r, g, b);
    cx += 5 * scale + gap;
  }
  return cx;
};

// ── Hintergrund: dunkel mit leichtem Verlauf nach oben-links ──
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 180, y - 120) / 900;
    const glow = Math.max(0, 1 - d) ** 2;
    px(x, y, Math.round(4 + glow * 6), Math.round(6 + glow * 26), Math.round(10 + glow * 42));
  }
}

// Rasterlinien (dezent)
for (let y = 0; y < H; y += 30) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; buf[i + 1] += 6; buf[i + 2] += 10; }
for (let x = 0; x < W; x += 30) for (let y = 0; y < H; y++) { const i = (y * W + x) * 3; buf[i + 1] += 6; buf[i + 2] += 10; }

const CYAN = [0, 212, 255], GOLD = [240, 165, 0], INK = [220, 234, 243], MUTE = [120, 150, 168];

// Rahmen + Akzentkante links
rect(0, 0, W, 4, ...CYAN);
rect(0, H - 4, W, 4, ...GOLD);
rect(0, 0, 6, H, ...CYAN);

// ── Inhalt ──
const MARGIN = 92, MAXW = W - MARGIN * 2;
// Grösste Stufe wählen, die noch in die Breite passt — nie über den Rand laufen.
const fit = (s, want) => { let sc = want; while (sc > 1 && textW(s, sc, sc * 2) > MAXW) sc--; return sc; };
const line = (s, y, want, col) => { text(s, MARGIN, y, fit(s, want), ...col); return 7 * fit(s, want); };

let y = 120;
y += line('TEAM GIVEAWAY', y, 12, CYAN) + 48;
y += line('LOSE FUER ECHTE ZUSCHAUZEIT', y, 6, INK) + 36;
y += line('FUER EINEN KANAL ODER EIN GANZES', y, 4, MUTE) + 18;
y += line('TEAM. ALLE REGELN FREI EINSTELLBAR.', y, 4, MUTE) + 18;
y += line('ZIEHUNG GEWICHTET, NACHVOLLZIEHBAR.', y, 4, MUTE);

// Fusszeile: Domain, goldener Marker davor
rect(MARGIN, H - 96, 14, 30, ...GOLD);
text('TEAM.RAUMDOCK.ORG', MARGIN + 30, H - 96, 5, ...GOLD);

// ── PNG schreiben ─────────────────────────────────────────
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y2 = 0; y2 < H; y2++) {
  raw[y2 * (W * 3 + 1)] = 0;
  buf.copy(raw, y2 * (W * 3 + 1) + 1, y2 * W * 3, (y2 + 1) * W * 3);
}
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(process.argv[2], png);
console.log('written', process.argv[2], png.length, 'bytes');
