'use strict';

// ── Oeffentliche Markdown-Seiten ──────────────────────────
// Laedt einen Text aus PUB_DOCS und rendert ihn. Bewusst ohne
// Markdown-Bibliothek: der Umfang ist klein, und die Seiten muessen ohne
// Login und ohne externe Quelle laden (CSP, Ladezeit).
// Genutzt von impressum/datenschutz/nutzungsbedingungen/haftungsausschluss/
// roadmap/changelog — Aenderungen hier wirken auf alle.
(function (global) {

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function mdToHtml(md) {
    var lines = String(md).split(/\r?\n/), out = [], inList = false, inCode = false;
    function cl() { if (inList) { out.push('</ul>'); inList = false; } }

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^```/.test(l)) {
        if (inCode) { out.push('</pre>'); inCode = false; }
        else { cl(); out.push('<pre>'); inCode = true; }
        continue;
      }
      if (inCode) { out.push(esc(l)); continue; }

      var h = l.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        cl();
        // Anker-ID aus der Überschrift — für Direktlinks wie #sofortverlosung.
        var hid = h[2].toLowerCase()
          .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        out.push('<h' + h[1].length + (hid ? ' id="' + hid + '"' : '') + '>' + inline(h[2]) + '</h' + h[1].length + '>');
        continue;
      }

      if (/^\s*(---|___|\*\*\*)\s*$/.test(l)) { cl(); out.push('<hr>'); continue; }

      // Markdown-Tabellen: | a | b | mit Trennzeile |---|---|
      if (/^\s*\|.*\|\s*$/.test(l)) {
        cl();
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          var cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
          if (!/^[\s:|-]+$/.test(lines[i])) rows.push(cells);   // Trennzeile ueberspringen
          i++;
        }
        i--;
        if (rows.length) {
          var head = '<tr>' + rows[0].map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr>';
          var body = rows.slice(1).map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('');
          out.push('<table>' + head + body + '</table>');
        }
        continue;
      }

      if (/^\s*[-*]\s+/.test(l)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>');
        continue;
      }
      // Aufeinanderfolgende Zitatzeilen sind EIN Block, sonst stapeln sich
      // bei einem dreizeiligen Hinweis drei geraendete Kaesten uebereinander.
      if (/^\s*>\s?/.test(l)) {
        cl();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(inline(lines[i].replace(/^\s*>\s?/, '')));
          i++;
        }
        i--;
        out.push('<blockquote>' + quote.join(' ') + '</blockquote>');
        continue;
      }
      if (/^\s*$/.test(l)) { cl(); continue; }
      cl(); out.push('<p>' + inline(l) + '</p>');
    }
    cl();
    if (inCode) out.push('</pre>');
    return out.join('\n');
  }

  function load(name, elId) {
    var el = document.getElementById(elId || 'doc');
    if (!el) return Promise.resolve();
    return fetch('/admin/pub/doc/' + encodeURIComponent(name))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        el.innerHTML = d && d.content ? mdToHtml(d.content) : '<span class="err">Nicht verfügbar.</span>';
        // Anker aus der URL erst NACH dem Rendern anspringen.
        if (location.hash) {
          var t = document.getElementById(location.hash.slice(1));
          if (t) t.scrollIntoView();
        }
      })
      .catch(function () { el.innerHTML = '<span class="err">Ladefehler.</span>'; });
  }

  // Theme-Umschalter rechts in der Krümelnavigation (rdoc-theme.js liefert RDOC).
  function mountTheme() {
    var crumbs = document.querySelector('.crumbs');
    if (crumbs && global.RDOC && global.RDOC.mountToggle) global.RDOC.mountToggle(crumbs);
  }
  if (document.body) mountTheme();
  else document.addEventListener('DOMContentLoaded', mountTheme);

  global.CCDoc = { load: load, mdToHtml: mdToHtml };
})(window);
