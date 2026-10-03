(function () {
  'use strict';

  var P = window.Pretext;
  var host = document.documentElement;
  var prepared = new Map();
  var MO = window.MutationObserver;

  function fontOf(el) { return getComputedStyle(el).font; }

  function lineHeightOf(el) {
    var cs = getComputedStyle(el);
    var lh = parseFloat(cs.lineHeight);
    if (!isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.5;
    return lh;
  }

  /* Pattern 1 — one-time measurement, cheap relayout on resize.
     Heights are exact, so a row never clips its note and the amount column
     never collides with wrapped text at 375px. */
  function prepareAll() {
    prepared.clear();
    document.querySelectorAll('[data-pretext]').forEach(function (el) {
      prepared.set(el, P.prepare(el.textContent.trim(), fontOf(el)));
    });
  }

  function relayout() {
    prepared.forEach(function (handle, el) {
      var res = P.layout(handle, el.clientWidth, lineHeightOf(el));
      if (res && isFinite(res.height) && res.height > 0) el.style.height = res.height + 'px';
    });
    layoutHonestLimits();
  }

  /* Pattern 3 — per-line widths, so the refusal prose flows around the checks
     panel instead of being pushed below it. */
  var OBSTACLE_GAP = 28;

  var REFUSAL_TEXT = 'The dashboard will not print a total it cannot stand behind. It reads the recipient token account, confirms the confidential extension is present, and confirms that non-confidential credits are disabled. If either check is false it renders this panel and no figure at all, because a negative claim like "the observer cannot read this amount" is only worth anything when the product refuses to lie the moment it stops being true. The same rule governs the ledger up the page: a row whose key version cannot be resolved keeps its ciphertext, keeps its settled count, and stays out of the reconciled figure rather than being quietly folded into it.';

  function layoutHonestLimits() {
    var hostEl = document.getElementById('obstacle-host');
    var obstacle = document.getElementById('obstacle');
    if (!hostEl || !obstacle) return;

    hostEl.style.height = '';
    hostEl.querySelectorAll('.line').forEach(function (n) { n.remove(); });

    var font = getComputedStyle(hostEl).font;
    var lh = lineHeightOf(hostEl) || 24;
    var totalWidth = hostEl.clientWidth;
    var hostRect = hostEl.getBoundingClientRect();
    var obsRect = obstacle.getBoundingClientRect();

    /* Full-width obstacle (the static, narrower-viewport layout): start the
       text underneath it. Otherwise reserve a right-hand band. */
    var stacked = obsRect.width >= totalWidth - 8;
    var startY = 0;
    var bandTop = 0;
    var bandBottom = 0;
    var obstacleWidth = 0;

    if (stacked) {
      startY = (obsRect.bottom - hostRect.top) + OBSTACLE_GAP;
    } else {
      obstacleWidth = (hostRect.right - obsRect.left) + OBSTACLE_GAP;
      bandTop = obsRect.top - hostRect.top;
      bandBottom = bandTop + obsRect.height;
    }

    var segs = P.prepareWithSegments(REFUSAL_TEXT, font);
    /* Cursor shape for this build: {segmentIndex, graphemeIndex}. The initial
       cursor is the zero cursor and the next cursor is the returned end -
       there is no `state` field and `null` throws inside the walk. */
    var cursor = { segmentIndex: 0, graphemeIndex: 0 };
    var y = startY;
    var lines = [];
    var guard = 0;

    while (guard++ < 240) {
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
    hostEl.appendChild(frag);

    var textBottom = y;
    var obstacleBottom = stacked ? 0 : (bandBottom + OBSTACLE_GAP);
    hostEl.style.height = Math.max(textBottom, obstacleBottom, lh) + 'px';
  }

  /* contenteditable: re-prepare and re-layout when the text changes */
  function watchEditable(el) {
    if (!MO) return;
    new MO(function () {
      prepared.set(el, P.prepare(el.textContent.trim(), fontOf(el)));
      relayout();
    }).observe(el, { characterData: true, subtree: true, childList: true });
  }

  /* the one authored motion: the redaction bars lift, staggered */
  function indexBars() {
    document.querySelectorAll('.redact').forEach(function (wrap, i) {
      wrap.style.setProperty('--i', String(i));
    });
  }

  var btnPublic = document.getElementById('btn-public');
  var btnAuditor = document.getElementById('btn-auditor');
  var status = document.getElementById('view-status');

  function setView(view) {
    var auditor = view === 'auditor';
    document.body.classList.toggle('auditor-view', auditor);
    document.body.classList.toggle('public-view', !auditor);
    btnPublic.setAttribute('aria-pressed', String(!auditor));
    btnAuditor.setAttribute('aria-pressed', String(auditor));
    if (status) {
      status.textContent = auditor
        ? 'Auditor view: amounts revealed. This is what the holder of the decryption key sees.'
        : 'Public view: every amount is redacted.';
    }
  }

  btnPublic.addEventListener('click', function () { setView('public'); });
  btnAuditor.addEventListener('click', function () { setView('auditor'); });

  /* seed the ground from the platform preference; graphite is canonical */
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    host.setAttribute('data-ground', 'paper');
  }

  function start() {
    indexBars();
    prepareAll();
    document.querySelectorAll('[contenteditable="true"]').forEach(watchEditable);
    relayout();
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(document.body);
    window.addEventListener('resize', relayout, { passive: true });
    document.fonts.ready.then(function () { prepareAll(); relayout(); });
  }

  if (P) {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(start);
    } else {
      window.addEventListener('load', start);
    }
  } else {
    /* Pretext missing: the page still works, it just cannot compute exact
       heights. Amounts stay redacted, which is the safe failure. */
    console.warn('Pretext unavailable — falling back to natural text flow.');
  }
})();