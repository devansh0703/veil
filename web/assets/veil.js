/* ─────────────────────────────────────────────────────────────────────────────
   Veil shared behaviour. Pretext does the text layout: exact heights so a row
   never clips its note, and per-line widths so the refusal prose can flow
   around the checks panel instead of being pushed below it.

   API notes for this vendored build (verified by reading the bundle, not from
   memory — the published cheatsheet differs in two places):
     * exports are `{prepare, layout, prepareWithSegments, layoutWithLines,
       layoutNextLine, walkLineRanges, clearCache, setLocale, profilePrepare}`
     * `layoutNextLine(segs, cursor, maxWidth)` returns `{text, width, start, end}`.
       There is NO `state` field. The cursor is `{segmentIndex, graphemeIndex}`,
       the initial cursor is `{segmentIndex: 0, graphemeIndex: 0}`, and passing
       `null` throws inside the walk.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var P = window.Pretext;
  var root = document.documentElement;
  var prepared = new Map();
  var OBSTACLE_GAP = 28;

  function fontOf(el) { return getComputedStyle(el).font; }

  function lineHeightOf(el) {
    var cs = getComputedStyle(el);
    var lh = parseFloat(cs.lineHeight);
    if (!isFinite(lh) || lh <= 0) lh = parseFloat(cs.fontSize) * 1.55;
    return lh || 20;
  }

  /* Pattern 1 — measure once, relayout cheaply on every resize. */
  function prepareAll() {
    prepared.clear();
    document.querySelectorAll('[data-pretext]').forEach(function (el) {
      var text = el.textContent.trim();
      if (text) prepared.set(el, P.prepare(text, fontOf(el)));
    });
  }

  function relayoutBlocks() {
    prepared.forEach(function (handle, el) {
      var res = P.layout(handle, el.clientWidth, lineHeightOf(el));
      if (res && isFinite(res.height) && res.height > 0) el.style.height = res.height + 'px';
    });
  }

  /* Pattern 3 — different maxWidth per line, so text wraps around a real
     obstacle that sits inside the same box. */
  function relayoutFlow() {
    var host = document.getElementById('obstacle-host');
    if (!host) return;
    var obstacle = document.getElementById('obstacle');
    var text = (host.getAttribute('data-flow-text') || '').trim();
    if (!obstacle || !text) return;

    host.style.height = '';
    host.querySelectorAll('.line').forEach(function (n) { n.remove(); });

    var font = fontOf(host);
    var lh = lineHeightOf(host);
    var totalWidth = host.clientWidth;
    var hostRect = host.getBoundingClientRect();
    var obsRect = obstacle.getBoundingClientRect();

    /* A full-width obstacle means the static, narrow-viewport layout: start the
       text underneath it. Otherwise reserve a right-hand band. */
    var stacked = obsRect.width >= totalWidth - 8;
    var startY = 0, bandTop = 0, bandBottom = 0, obstacleWidth = 0;

    if (stacked) {
      startY = (obsRect.bottom - hostRect.top) + OBSTACLE_GAP;
    } else {
      obstacleWidth = (hostRect.right - obsRect.left) + OBSTACLE_GAP;
      bandTop = obsRect.top - hostRect.top;
      bandBottom = bandTop + obsRect.height;
    }

    var segs = P.prepareWithSegments(text, font);
    var cursor = { segmentIndex: 0, graphemeIndex: 0 };
    var y = startY, lines = [], guard = 0;

    while (guard++ < 400) {
      var available = totalWidth;
      if (obstacleWidth > 0 && y >= bandTop - lh * 0.5 && y < bandBottom) {
        available = Math.max(180, totalWidth - obstacleWidth);
      }
      var next = P.layoutNextLine(segs, cursor, available);
      if (!next || !next.text || !next.end) break;
      var end = next.end;
      if (end.segmentIndex === cursor.segmentIndex &&
          end.graphemeIndex === cursor.graphemeIndex) break;
      lines.push({ text: next.text, y: y });
      cursor = { segmentIndex: end.segmentIndex, graphemeIndex: end.graphemeIndex };
      y += lh;
    }

    var frag = document.createDocumentFragment();
    lines.forEach(function (line) {
      var span = document.createElement('span');
      span.className = 'line';
      span.textContent = line.text;
      span.style.top = line.y + 'px';
      frag.appendChild(span);
    });
    host.appendChild(frag);

    host.style.height = Math.max(y, stacked ? 0 : bandBottom + OBSTACLE_GAP, lh) + 'px';
  }

  function relayout() { relayoutBlocks(); relayoutFlow(); }

  /* contenteditable: re-measure when the text itself changes */
  function watchEditable(el) {
    if (!window.MutationObserver) return;
    new MutationObserver(function () {
      prepared.set(el, P.prepare(el.textContent.trim(), fontOf(el)));
      relayout();
    }).observe(el, { characterData: true, subtree: true, childList: true });
  }

  /* index the redaction bars so the lift staggers down the ledger */
  function indexBars() {
    document.querySelectorAll('.redact').forEach(function (wrap, i) {
      wrap.style.setProperty('--i', String(i));
    });
  }

  /* ── the one authored moment ─────────────────────────────────────────── */
  function initView() {
    var btns = document.querySelectorAll('[data-view-toggle]');
    if (!btns.length) return;
    var status = document.getElementById('view-status');

    function setView(view) {
      var auditor = view === 'auditor';
      root.setAttribute('data-view', view);
      document.querySelectorAll('[data-view-toggle]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-view-toggle') === view));
      });
      if (status) {
        status.textContent = auditor
          ? 'Auditor view: amounts revealed. This is what the holder of the decryption key sees.'
          : 'Public view: every amount is redacted.';
      }
    }

    btns.forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view-toggle')); });
    });
    setView(root.getAttribute('data-view') || 'public');
  }

  /* ── ground: paper by default, graphite on request, remembered ────────────

     The site is read in daylight, so paper is the default on every page and
     the choice is the reader's to make rather than the platform's — a theme
     switch follows the person, not `prefers-color-scheme`, and each ground
     keeps the composition it was designed with. Both are full token sets
     (see tokens.css); nothing here inverts a surface.

     Two controls share one setter: `data-theme-toggle` in the masthead is the
     standing switch (short label — it is chrome), `data-ground-toggle` in the
     flow is the inline "inspect on the other ground" affordance. */
  var GROUND_KEY = 'veil:ground';

  function storedGround() {
    try {
      var value = window.localStorage.getItem(GROUND_KEY);
      return value === 'graphite' || value === 'paper' ? value : null;
    } catch (error) {
      /* Private mode and file:// can refuse storage; the default stands. */
      return null;
    }
  }

  function setGround(next) {
    root.setAttribute('data-ground', next);
    try {
      window.localStorage.setItem(GROUND_KEY, next);
    } catch (error) {
      /* The switch still works for this page even when it cannot persist. */
    }
    var other = next === 'graphite' ? 'paper' : 'graphite';
    var label = other.charAt(0).toUpperCase() + other.slice(1);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.textContent = label;
      button.setAttribute('aria-pressed', next === 'graphite' ? 'true' : 'false');
      button.setAttribute('aria-label', 'Switch the site to the ' + other + ' ground');
    });
    document.querySelectorAll('[data-ground-toggle]').forEach(function (button) {
      button.textContent = 'Inspect on ' + other;
    });
    requestAnimationFrame(relayout);
  }

  function initGround() {
    if (!document.querySelector('[data-theme-toggle],[data-ground-toggle]')) return;
    var saved = storedGround();
    var initial = saved || root.getAttribute('data-ground') || 'paper';
    setGround(initial);
    document.querySelectorAll('[data-theme-toggle],[data-ground-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        setGround(root.getAttribute('data-ground') === 'graphite' ? 'paper' : 'graphite');
      });
    });
  }

  /* ── export: the rows on screen, and nothing the view is hiding ─────────── */
  function csvCell(value) {
    var s = String(value == null ? '' : value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function initExport() {
    var button = document.querySelector('[data-export-ledger]');
    var table = document.querySelector('table.ledger');
    if (!button || !table) return;
    var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
    if (!rows.length) return;

    button.disabled = false;
    button.title = 'Download the rows on screen as CSV';

    button.addEventListener('click', function () {
      try {
        /* The export follows the view. In public view the amount cell holds its
           real value in the DOM behind a redaction bar, so exporting it raw
           would hand back exactly the number the page is hiding. */
        var auditor = root.getAttribute('data-view') === 'auditor';
        var cell = function (tr, sel) {
          var el = tr.querySelector(sel);
          return el ? el.textContent.trim() : '';
        };
        var lines = [['payment', 'vendor', 'time', 'state', 'reason', 'amount'].join(',')];
        rows.forEach(function (tr) {
          var amountValue = cell(tr, '.amount-value');
          var amount = amountValue
            ? (auditor ? amountValue : 'redacted')
            : (cell(tr, '.cipher') || '');
          lines.push([
            csvCell(cell(tr, '.pay')),
            csvCell(cell(tr, 'td:nth-child(2)')),
            csvCell(cell(tr, '.when')),
            csvCell(cell(tr, '.pill')),
            csvCell(cell(tr, '.reason')),
            csvCell(amount),
          ].join(','));
        });
        var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
        var href = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = href;
        link.download = 'veil-ledger.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(href);
      } catch (e) {
        button.title = 'Export failed: ' + (e && e.message ? e.message : e) +
          ' — nothing was written';
      }
    });
  }

  function start() {
    indexBars();
    prepareAll();
    document.querySelectorAll('[contenteditable="true"]').forEach(watchEditable);
    relayout();
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(document.body);
    window.addEventListener('resize', relayout, { passive: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { prepareAll(); relayout(); });
    }
  }

  initView();
  initGround();
  initExport();

  if (!P) {
    /* Fail closed: amounts stay redacted, the page still reads, it just cannot
       compute exact heights. */
    console.warn('Pretext unavailable — falling back to natural text flow.');
    return;
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(start);
  } else {
    window.addEventListener('load', start);
  }
})();
