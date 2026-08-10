'use strict';
// Doku-Seite: Diagramme rendern und die Abschnittsleiste mitführen.
// Mermaid liegt lokal (/admin/vendor/mermaid.min.js) — die CSP erlaubt nur
// Skripte vom eigenen Host, und ein Diagramm soll nicht davon abhängen,
// dass ein fremdes CDN erreichbar ist.

(function () {
  // ── Diagramme ───────────────────────────────────────────
  // Farben aus den RDOC-Tokens, damit die Diagramme zur Seite passen und
  // in Hell wie Dunkel lesbar bleiben.
  function tokens() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n, fallback) { return (cs.getPropertyValue(n) || fallback).trim(); };
    return {
      bg:      v('--rdoc-surface', '#2B3135'),
      line:    v('--rdoc-border-strong', '#76828D'),
      text:    v('--rdoc-text', '#F2F2F0'),
      accent:  v('--rdoc-accent', '#C48A4A'),
      muted:   v('--rdoc-text-muted', '#76828D'),
      page:    v('--rdoc-bg', '#121416'),
      mono:    v('--rdoc-font-mono', 'monospace'),
      text2:   v('--rdoc-text', '#F2F2F0')
    };
  }

  function mermaidConfig() {
    var t = tokens();
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      fontFamily: t.mono,
      theme: 'base',
      themeVariables: {
        background: t.page,
        primaryColor: t.bg,
        primaryTextColor: t.text,
        primaryBorderColor: t.accent,
        secondaryColor: t.bg,
        tertiaryColor: t.page,
        lineColor: t.line,
        textColor: t.text,
        mainBkg: t.bg,
        nodeBorder: t.accent,
        clusterBkg: 'transparent',
        clusterBorder: t.line,
        edgeLabelBackground: t.bg,
        titleColor: t.text,
        noteBkgColor: t.bg,
        noteTextColor: t.muted,
        noteBorderColor: t.line,
        actorBkg: t.bg,
        actorBorder: t.accent,
        actorTextColor: t.text,
        signalColor: t.line,
        signalTextColor: t.text,
        labelBoxBkgColor: t.bg,
        labelBoxBorderColor: t.line,
        labelTextColor: t.text,
        loopTextColor: t.text,
        sequenceNumberColor: t.page
      },
      flowchart: { curve: 'basis', nodeSpacing: 42, rankSpacing: 52, useMaxWidth: true },
      sequence: { useMaxWidth: true, mirrorActors: false, wrap: true },
      er: { useMaxWidth: true },
      class: { useMaxWidth: true }
    };
  }

  // Quelltext je Diagramm merken: beim Theme-Wechsel wird neu gerendert,
  // und mermaid ersetzt den Inhalt des Elements durch das fertige SVG.
  var blocks = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
  var sources = blocks.map(function (el) { return el.textContent; });

  function render() {
    if (typeof mermaid === 'undefined') {
      blocks.forEach(function (el) { el.setAttribute('data-processed', 'failed'); });
      return;
    }
    blocks.forEach(function (el, i) {
      el.removeAttribute('data-processed');
      el.textContent = sources[i];
    });
    mermaid.initialize(mermaidConfig());
    try {
      mermaid.run({ nodes: blocks });
    } catch (e) {
      blocks.forEach(function (el) { el.setAttribute('data-processed', 'failed'); });
    }
  }

  render();

  // Theme-Umschalter (rdoc-theme.js) und Systemwechsel → neu zeichnen.
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', render);
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      if (muts[i].attributeName === 'data-theme') { render(); return; }
    }
  }).observe(document.documentElement, { attributes: true });

  // ── Abschnittsleiste ────────────────────────────────────
  var links = Array.prototype.slice.call(document.querySelectorAll('.dk-nav a'));
  var targets = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });

  function spy() {
    var best = 0, bestTop = -1e9;
    for (var i = 0; i < targets.length; i++) {
      if (!targets[i]) continue;
      var top = targets[i].getBoundingClientRect().top - 130;
      if (top <= 0 && top > bestTop) { bestTop = top; best = i; }
    }
    for (var j = 0; j < links.length; j++) links[j].classList.toggle('active', j === best);
  }

  window.addEventListener('scroll', spy, { passive: true });
  window.addEventListener('hashchange', spy);
  spy();
})();
