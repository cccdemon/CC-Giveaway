(function() {
  'use strict';

  // ════════════════════════════════════════════════════════
  // CHAOS CREW – Browser Unit Tests
  // Testet client-seitige Logik OHNE echte Daten zu verändern:
  //   • CC.validate (admin-shared.js) – Sanitizing/Validation
  //   • Giveaway-Admin (giveaway-admin.js) – WS-Payloads, State, Rendering-Mathe
  //   • Navigation (admin-shared.js)
  // WS wird gestubbt (gwWs), DOM-Seiteneffekte werden isoliert.
  // ════════════════════════════════════════════════════════

  var resultsEl = document.getElementById('test-results');
  var summaryEl = document.getElementById('summary');
  var tests = [];

  function it(name, fn) { tests.push({ name: name, fn: fn }); }

  function expect(actual) {
    return {
      toBe: function(expected) {
        if (actual !== expected) throw new Error('Expected ' + JSON.stringify(actual) + ' to be ' + JSON.stringify(expected));
      },
      toBeNull: function() {
        if (actual !== null) throw new Error('Expected null, got ' + JSON.stringify(actual));
      },
      toBeUndefined: function() {
        if (actual !== undefined) throw new Error('Expected undefined, got ' + JSON.stringify(actual));
      },
      toContain: function(expected) {
        if (!String(actual).includes(expected)) throw new Error('Expected ' + JSON.stringify(actual) + ' to contain ' + JSON.stringify(expected));
      },
      toBeTruthy: function() {
        if (!actual) throw new Error('Expected value to be truthy, got ' + JSON.stringify(actual));
      },
      toBeFalsy: function() {
        if (actual) throw new Error('Expected value to be falsy, got ' + JSON.stringify(actual));
      },
      toBeCloseTo: function(expected, eps) {
        var d = Math.abs(actual - expected);
        if (d > (eps == null ? 1e-9 : eps)) throw new Error('Expected ' + actual + ' to be close to ' + expected);
      }
    };
  }

  function addResult(name, passed, message) {
    var item = document.createElement('div');
    item.className = 'test-case ' + (passed ? 'pass' : 'fail');
    item.innerHTML =
      '<div class="test-header"><span class="test-name">' + escHtml(name) + '</span>' +
      '<span class="test-status">' + (passed ? 'PASS' : 'FAIL') + '</span></div>' +
      '<div class="test-body">' + escHtml(message || '') + '</div>';
    resultsEl.appendChild(item);
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  function runTests() {
    var passed = 0, failed = 0;
    resultsEl.innerHTML = '';
    tests.forEach(function(test) {
      try {
        test.fn();
        addResult(test.name, true, '');
        passed += 1;
      } catch (err) {
        addResult(test.name, false, err.message || String(err));
        failed += 1;
      }
    });
    summaryEl.textContent = passed + ' passed, ' + failed + ' failed';
    summaryEl.className = 'summary ' + (failed === 0 ? 'pass' : 'fail');
  }

  // ── Test-Helfer ───────────────────────────────────────────
  function updateQuery(search) {
    history.replaceState(null, '', window.location.pathname + search);
  }

  function withMutedConsole(fn) {
    var orig = console.warn;
    console.warn = function() {};
    try { fn(); } finally { console.warn = orig; }
  }

  // Erzeugt temporäre DOM-Elemente, ruft fn, räumt garantiert wieder auf.
  function withEls(ids, fn) {
    var made = ids.map(function(id) {
      var el = document.getElementById(id);
      if (el) return { el: el, owned: false };
      el = document.createElement('input');
      el.id = id;
      document.body.appendChild(el);
      return { el: el, owned: true };
    });
    try { return fn(made.map(function(m) { return m.el; })); }
    finally { made.forEach(function(m) { if (m.owned) document.body.removeChild(m.el); }); }
  }

  // Stubbt gwWs (Giveaway-Admin nutzt gwWs, NICHT ws), sammelt gesendete Payloads.
  function withGwSocket(fn) {
    var sent = [];
    var prev = (typeof gwWs !== 'undefined') ? gwWs : null;
    gwWs = { readyState: 1, send: function(s) { sent.push(JSON.parse(s)); } };
    var origReq = window.requestData;
    window.requestData = function() {};
    try { fn(sent); } finally { gwWs = prev; window.requestData = origReq; }
  }

  function withStubbed(names, fn) {
    var saved = names.map(function(n) { return window[n]; });
    names.forEach(function(n) { window[n] = function() {}; });
    try { fn(); } finally { names.forEach(function(n, i) { window[n] = saved[i]; }); }
  }

  // ════════════════════════════════════════════════════════
  // CC.validate – Sanitizing & Validation
  // ════════════════════════════════════════════════════════
  it('escHtml escapes HTML special chars', function() {
    expect(CC.validate.escHtml('<b>Test & "OK"</b>')).toBe('&lt;b&gt;Test &amp; &quot;OK&quot;&lt;&#x2F;b&gt;');
  });

  it('sanitize cleans usernames and truncates to 25 chars', function() {
    expect(CC.validate.sanitize('bad$user!name', 'username')).toBe('badusername');
    expect(CC.validate.sanitize('abcdefghijklmnopqrstuvwxYz123456', 'username').length).toBe(25);
  });

  it('validate enforces rules for keywords and usernames', function() {
    expect(CC.validate.validate('good_keyword', 'keyword')).toBeTruthy();
    expect(CC.validate.validate('<script>', 'keyword')).toBeFalsy();
    expect(CC.validate.validate('user_name1', 'username')).toBeTruthy();
    expect(CC.validate.validate('bad user', 'username')).toBeFalsy();
  });

  it('sanitizeInt clamps to range and respects fallback', function() {
    expect(CC.validate.sanitizeInt('123', 1, 50, 7)).toBe(50);
    expect(CC.validate.sanitizeInt('abc', 1, 10, 5)).toBe(5);
  });

  it('sanitizeFloat parses comma decimals and clamps bounds', function() {
    expect(CC.validate.sanitizeFloat('1,5', 0, 2, 0)).toBe(1.5);
    expect(CC.validate.sanitizeFloat('9.9', 0, 5, 0)).toBe(5);
  });

  it('safeJsonParse returns null for invalid JSON and strips prototype keys', function() {
    expect(CC.validate.safeJsonParse('{invalid:json}')).toBeNull();
    var obj = CC.validate.safeJsonParse('{"a":1,"__proto__":{"polluted":true}}');
    expect(obj.a).toBe(1);
    expect(Object.prototype.polluted).toBeUndefined();
    expect(Object.isFrozen(obj)).toBeTruthy();
  });

  it('validateWsPayload allows known events/cmds and blocks unknown ones', function() {
    expect(CC.validate.validateWsPayload({ event: 'gw_cmd', cmd: 'gw_open', user: 'valid_user' })).toBeTruthy();
    expect(CC.validate.validateWsPayload({ event: 'gw_cmd', cmd: 'gw_draw_winner' })).toBeTruthy();
    expect(CC.validate.validateWsPayload({ event: 'gw_overlay', winner: null })).toBeTruthy();
    withMutedConsole(function() {
      expect(CC.validate.validateWsPayload({ event: 'gw_cmd', cmd: 'rm_rf_db' })).toBeFalsy();
      expect(CC.validate.validateWsPayload({ event: 'bad_event' })).toBeFalsy();
      expect(CC.validate.validateWsPayload({ event: 'gw_cmd', cmd: 'gw_ban', user: 'bad user!' })).toBeFalsy();
    });
  });

  it('getUrlParam returns sanitized params from the current URL', function() {
    updateQuery('?x=123&host=example.com');
    expect(CC.validate.getUrlParam('x', 'int')).toBe(123);
    expect(CC.validate.getUrlParam('host', 'host')).toBe('example.com');
    updateQuery('');
  });

  // ════════════════════════════════════════════════════════
  // Giveaway-Admin – State, WS-Payloads, Render-Mathe
  // ════════════════════════════════════════════════════════
  it('parseDec handles decimal inputs and invalid values', function() {
    expect(parseDec('1,5')).toBe(1.5);
    expect(parseDec('3.0000')).toBe(3);
    expect(parseDec('abc')).toBe(0);
    expect(parseDec(null)).toBe(0);
  });

  it('handle(gw_data) builds participant state keyed by lowercased username', function() {
    withStubbed(['updateGwStatus', 'renderTable', 'updateStats'], function() {
      participants = {};
      gwIsOpen = false;
      handle({
        event: 'gw_data',
        open: true,
        participants: [
          { username: 'Alpha', watchSec: '10', msgs: '5', coins: '1,5', banned: false },
          { username: 'Bravo', watchSec: '7200', msgs: '2', coins: 1, banned: true }
        ]
      });
      expect(gwIsOpen).toBeTruthy();
      expect(participants.alpha.coins).toBe(1.5);
      expect(participants.alpha.watchSec).toBe(10);
      expect(participants.alpha.display).toBe('Alpha');
      expect(participants.alpha.banned).toBeFalsy();
      expect(participants.bravo.banned).toBeTruthy();
    });
  });

  it('manualAdd sanitizes username and sends one gw_add_ticket per amount', function() {
    withEls(['m-name', 'm-amount'], function(els) {
      els[0].value = 'Bad$User';
      els[1].value = '2';
      withGwSocket(function(sent) {
        manualAdd();
        expect(sent.length).toBe(2);
        expect(sent[0].event).toBe('gw_cmd');
        expect(sent[0].cmd).toBe('gw_add_ticket');
        expect(sent[0].user).toBe('BadUser');
      });
    });
  });

  it('manualSub sends gw_sub_ticket with sanitized username', function() {
    withEls(['m-name', 'm-amount'], function(els) {
      els[0].value = 'Eve_99!';            // '!' wird entfernt; Client lowercased NICHT
      els[1].value = '3';
      withGwSocket(function(sent) {
        manualSub();
        expect(sent.length).toBe(3);
        expect(sent[0].cmd).toBe('gw_sub_ticket');
        expect(sent[0].user).toBe('Eve_99');
      });
    });
  });

  it('clearOverlay sends a winner-null gw_overlay (clears OBS overlay)', function() {
    withGwSocket(function(sent) {
      clearOverlay();
      expect(sent.length).toBe(1);
      expect(sent[0].event).toBe('gw_overlay');
      expect(sent[0].winner).toBeNull();
    });
  });

  it('drawWinner sends gw_draw_winner with the entered prize', function() {
    withEls(['prize-input'], function(els) {
      els[0].value = '  Steam-Key  ';
      withGwSocket(function(sent) {
        drawWinner();
        expect(sent.length).toBe(1);
        expect(sent[0].event).toBe('gw_cmd');
        expect(sent[0].cmd).toBe('gw_draw_winner');
        expect(sent[0].prize).toBe('Steam-Key');   // getrimmt
      });
    });
  });

  it('toggleBan toggles ban/unban based on current participant state', function() {
    participants = { villain: { display: 'Villain', coins: 1, watchSec: 0, msgs: 0, banned: false } };
    withGwSocket(function(sent) {
      toggleBan('villain');                 // not banned -> ban
      expect(sent[0].cmd).toBe('gw_ban');
      participants.villain.banned = true;
      toggleBan('villain');                 // banned -> unban
      expect(sent[1].cmd).toBe('gw_unban');
    });
  });

  it('updateStats aggregates only non-banned participants into the DOM', function() {
    withEls(['s-total', 's-tickets', 's-msgs'], function(els) {
      participants = {
        a: { coins: 1.5, msgs: 4, banned: false },
        b: { coins: 2.5, msgs: 6, banned: false },
        c: { coins: 99,  msgs: 99, banned: true }   // ausgeschlossen
      };
      updateStats();
      expect(els[0].textContent).toBe('2');     // s-total: aktive
      expect(els[1].textContent).toBe('4');     // s-tickets: 1.5 + 2.5
      expect(els[2].textContent).toBe('10');    // s-msgs: 4 + 6
    });
  });

  it('fmtTime formats seconds as H:MM:SS', function() {
    expect(fmtTime(0)).toBe('0:00:00');
    expect(fmtTime(3665)).toBe('1:01:05');
    expect(fmtTime(59)).toBe('0:00:59');
  });

  // ════════════════════════════════════════════════════════
  // Navigation (admin-shared.js)
  // ════════════════════════════════════════════════════════
  it('navigation is injected and marks the current test page active', function() {
    var nav = document.querySelector('nav.cc-nav');
    expect(!!nav).toBeTruthy();
    var active = nav.querySelector('.cc-nav-item.active');
    expect(!!active).toBeTruthy();
    expect(active.href).toContain('tests/test-runner.html');
  });

  runTests();
})();
