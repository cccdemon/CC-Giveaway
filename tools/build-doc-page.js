#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════
// Erzeugt aus docs/SOFTWARE-ARCHITEKTUR.md die Seite
// services/admin/public/doku.html (Menuepunkt "Doku").
//
// Warum generiert statt handgepflegt: das Markdown im Repo bleibt die eine
// Quelle. Wer die Architektur aendert, aendert das Markdown und laesst
// danach `node tools/build-doc-page.js` laufen — sonst laufen Doku im Repo
// und Doku auf der Website auseinander.
//
// Bewusst OHNE Markdown-Paket: der Konverter deckt genau die Teilmenge ab,
// die das Dokument benutzt (Ueberschriften, Absaetze, Listen, Tabellen,
// Zitate, Code- und Mermaid-Bloecke, Inline-Auszeichnung). Weniger
// Abhaengigkeiten, vorhersehbares Ergebnis.
// ════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'docs', 'SOFTWARE-ARCHITEKTUR.md');
const OUT  = path.join(ROOT, 'services', 'admin', 'public', 'doku.html');
const GH   = 'https://github.com/cccdemon/CC-Giveaway/blob/main/';

const MARK = '\u0000';   // Platzhalter fuer herausgenommenen Inline-Code
const PIPE = '\u0001';   // maskiertes | innerhalb einer Tabellenzelle

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slug(t) {
  return t.replace(/[`*[\]().:,/·—]/g, '').trim().toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Inline-Auszeichnung. Code kommt zuerst heraus, damit **fett** und Links
// innerhalb von `code` nicht interpretiert werden.
function inline(s) {
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => MARK + (codes.push(c) - 1) + MARK);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => {
    let h = href;
    if (!/^(#|https?:)/.test(h)) h = GH + (h.startsWith('../') ? h.slice(3) : 'docs/' + h);
    const ext = /^https?:/.test(h) ? ' target="_blank" rel="noopener"' : '';
    return '<a href="' + h + '"' + ext + '>' + txt + '</a>';
  });
  return out.replace(new RegExp(MARK + '(\\d+)' + MARK, 'g'),
    (_, i) => '<code>' + codes[Number(i)] + '</code>');
}

// In einer Tabellenzelle steht ein maskiertes Rohr als Backslash-Pipe.
const cellText = (s) => inline(s.split('\\|').join(PIPE)).split(PIPE).join('|');

function convert(md) {
  const lines = md.split('\n');
  const html = [];
  const nav = [];
  let i = 0, inSection = false;
  const closeSection = () => { if (inSection) { html.push('</section>'); inSection = false; } };

  const RE_BULLET = /^\s*[-*]\s+/;
  const RE_NUM = /^\s*\d+\.\s+/;

  while (i < lines.length) {
    const ln = lines[i];

    // Code- und Diagrammbloecke
    if (ln.startsWith('```')) {
      const lang = ln.slice(3).trim();
      const buf = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) buf.push(lines[i]);
      i++;
      const code = esc(buf.join('\n'));
      html.push(lang === 'mermaid'
        ? '<figure class="dia"><pre class="mermaid">' + code + '</pre></figure>'
        : '<pre class="code"><code>' + code + '</code></pre>');
      continue;
    }

    // Ueberschriften
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length, txt = h[2].trim(), id = slug(txt);
      if (lvl === 1) {
        html.push('<h1 class="doc-title">' + inline(txt) + '</h1>');
      } else if (lvl === 2) {
        closeSection();
        html.push('<section id="' + id + '">');
        inSection = true;
        const m = txt.match(/^(\d+)\.\s+(.*)$/);
        const num = m ? m[1] : '';
        const label = m ? m[2] : txt;
        html.push('<h2>' + (num ? '<span class="num">' + num + '</span>' : '') + inline(label) + '</h2>');
        nav.push({ id: id, txt: label, num: num, lvl: 2 });
      } else {
        html.push('<h' + lvl + ' id="' + id + '">' + inline(txt) + '</h' + lvl + '>');
        if (lvl === 3) nav.push({ id: id, txt: txt, num: '', lvl: 3 });
      }
      i++;
      continue;
    }

    if (ln.trim() === '---') { i++; continue; }   // Trenner macht das CSS

    // Tabellen
    if (ln.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      const head = rows[0] || [];
      const body = rows.slice(2);
      html.push('<div class="tw"><table><thead><tr>'
        + head.map((c) => '<th>' + cellText(c) + '</th>').join('')
        + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c) => '<td>' + cellText(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // Listen
    if (RE_BULLET.test(ln) || RE_NUM.test(ln)) {
      const ordered = RE_NUM.test(ln);
      const re = ordered ? RE_NUM : RE_BULLET;
      const items = [];
      while (i < lines.length && (re.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i])))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push('<' + tag + '>' + items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    // Zitate
    if (ln.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    if (!ln.trim()) { i++; continue; }

    // Absatz
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(\||#|```|>)/.test(lines[i])
           && !RE_BULLET.test(lines[i]) && !RE_NUM.test(lines[i]) && lines[i].trim() !== '---') {
      para.push(lines[i].trim());
      i++;
    }
    html.push('<p>' + inline(para.join(' ')) + '</p>');
  }

  closeSection();
  return { body: html.join('\n'), nav: nav };
}

// Der Inhalts-Absatz des Markdowns waere auf der Seite doppelt — die
// Seitenleiste leistet dasselbe und bleibt beim Scrollen stehen.
const stripInlineToc = (body) => body.replace(/<p>Inhalt:[\s\S]*?<\/p>\n?/, '');

const md = fs.readFileSync(SRC, 'utf8');
const res = convert(md);
const body = stripInlineToc(res.body);

const navHtml = res.nav.map((x) => x.lvl === 2
  ? '<a class="n2" href="#' + x.id + '"><span class="k">' + (x.num || '·') + '</span>' + esc(x.txt) + '</a>'
  : '<a class="n3" href="#' + x.id + '">' + esc(x.txt) + '</a>').join('\n      ');

const page = '<!DOCTYPE html>\n'
  + '<html lang="de">\n'
  + '<head>\n'
  + '<meta charset="UTF-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  + '<title>RDOC Giveaway: Doku</title>\n'
  + '<link rel="stylesheet" href="/admin/rdoc.css">\n'
  + '<link rel="stylesheet" href="/admin/doku.css">\n'
  + '<script src="/admin/rdoc-theme.js"></script>\n'
  + '<link rel="icon" href="/admin/favicon.ico" sizes="32x32">\n'
  + '<link rel="icon" href="/admin/favicon.svg" type="image/svg+xml">\n'
  + '<link rel="apple-touch-icon" href="/admin/icons/apple-touch-icon.png">\n'
  + '<link rel="manifest" href="/admin/site.webmanifest">\n'
  + '<meta name="theme-color" content="#121416" media="(prefers-color-scheme: dark)">\n'
  + '<meta name="theme-color" content="#F2F2F0" media="(prefers-color-scheme: light)">\n'
  + '<!-- ERZEUGTE DATEI - nicht von Hand bearbeiten.\n'
  + '     Quelle: docs/SOFTWARE-ARCHITEKTUR.md - Generator: tools/build-doc-page.js -->\n'
  + '</head>\n'
  + '<body data-app>\n'
  + '<script src="/giveaway/cc-defs.js"></script>\n'
  + '<script src="admin-shared.js"></script>\n\n'
  + '<div class="dk-shell">\n'
  + '  <aside class="dk-rail">\n'
  + '    <div class="dk-railhead">ARCHITEKTUR-REFERENZ</div>\n'
  + '    <nav class="dk-nav">\n      ' + navHtml + '\n    </nav>\n'
  + '    <div class="dk-railfoot">Quelle im Repo:<br>\n'
  + '      <a href="' + GH + 'docs/SOFTWARE-ARCHITEKTUR.md" target="_blank" rel="noopener">docs/SOFTWARE-ARCHITEKTUR.md</a>\n'
  + '    </div>\n'
  + '  </aside>\n'
  + '  <main class="dk-main">\n' + body + '\n  </main>\n'
  + '</div>\n\n'
  + '<script src="/admin/vendor/mermaid.min.js"></script>\n'
  + '<script src="/admin/doku.js"></script>\n'
  + '</body>\n</html>\n';

fs.writeFileSync(OUT, page, 'utf8');

const sections = res.nav.filter((x) => x.lvl === 2).length;
const diagrams = (body.match(/class="mermaid"/g) || []).length;
const tables = (body.match(/<table>/g) || []).length;
console.log('[Doku] ' + path.relative(ROOT, OUT) + ' geschrieben - ' + sections + ' Abschnitte, '
  + diagrams + ' Diagramme, ' + tables + ' Tabellen, ' + Math.round(page.length / 1024) + ' KB');
