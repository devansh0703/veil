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

  /* ── ground: seeded from the use scene, toggle for inspection ─────────── */
  function initGround() {
    var toggle = document.querySelector('[data-ground-toggle]');
    if (!toggle) return;
    /* The ground is fixed by the use scene, not by prefers-color-scheme —
       DESIGN.md rejects inverting a surface for a platform preference. This
       control exists so a reviewer can see both grounds, nothing more. */
    function label() {
      toggle.textContent = root.getAttribute('data-ground') === 'graphite'
        ? 'Inspect on paper' : 'Inspect on graphite';
    }
    label();
    toggle.addEventListener('click', function () {
      root.setAttribute('data-ground',
        root.getAttribute('data-ground') === 'graphite' ? 'paper' : 'graphite');
      label();
      requestAnimationFrame(relayout);
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
