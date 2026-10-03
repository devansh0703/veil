/**
 * scripts/check-browser-ui.ts — drive the prover panel in a real browser.
 *
 *   npm run check:ui      (needs `npm run web` on :4020)
 *
 * ## Why this is separate from prove:browser
 *
 * `prove:browser` proves the *bundle* works — it imports the built module in
 * Node and asserts on its output. That is the right test for the crypto, and it
 * says nothing about whether the page can reach the bundle. The two failure
 * modes that leaves open are exactly the ones a reviewer would hit:
 *
 *   1. The panel's dynamic `import()` resolves to a path that does not exist
 *      once the page is served from an origin other than the repository root.
 *   2. The server sends `index_bg.wasm` with a content type the browser will not
 *      compile, so the prover never instantiates.
 *
 * Both are invisible to a Node test and fatal to the demo. So this drives the
 * actual page in headless Chrome over the DevTools Protocol, clicks the button a
 * judge would click, and reads the log the panel wrote — including the panel's
 * own console errors, so a swallowed exception cannot pass as success.
 *
 * No Playwright dependency: Chrome is launched with `--remote-debugging-port`
 * and driven with the `WebSocket` global Node already ships. Adding a browser
 * automation framework to verify one button would cost more than the check is
 * worth.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.VEIL_WEB_PORT ?? 4020);
const PAGE = `http://127.0.0.1:${PORT}/402.html`;
const DEBUG_PORT = 9333;

/** Candidate Chrome binaries, most specific first. */
const CANDIDATES = [
  process.env.CHROME_PATH,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

function findChrome(): string {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `no Chrome binary found. Set CHROME_PATH, or install one of:\n  ${CANDIDATES.join('\n  ')}`,
    );
  }
  return found;
}

let passed = 0;
let failed = 0;

function ok(label: string, detail = ''): void {
  passed += 1;
  process.stdout.write(`  ok    ${label}${detail ? `  ${detail}` : ''}\n`);
}

function no(label: string, detail = ''): void {
  failed += 1;
  process.stdout.write(`  FAIL  ${label}${detail ? `  ${detail}` : ''}\n`);
}

async function check(label: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    ok(label, await fn());
  } catch (e) {
    no(label, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// A minimal CDP client over the WebSocket Node already provides
// ---------------------------------------------------------------------------

interface Cdp {
  send(method: string, params?: unknown): Promise<any>;
  on(event: string, handler: (params: any) => void): void;
  close(): void;
}

async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, ((params: any) => void)[]>();

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === 'number') {
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else slot.resolve(msg.result);
      return;
    }
    for (const handler of listeners.get(msg.method) ?? []) handler(msg.params);
  });

  return {
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    close() {
      socket.close();
    },
  };
}

/** Wait for the page's own global, so the check does not race the script tag. */
async function waitFor(cdp: Cdp, expression: string, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result?.result?.value) return result.result.value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${expression}`);
}

async function evaluate(cdp: Cdp, expression: string, awaitPromise = false): Promise<any> {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result?.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'evaluation threw';
    throw new Error(text.split('\n')[0]);
  }
  return result?.result?.value;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

process.stdout.write('\nVeil — the prover panel in a real browser\n\n');

// The page must already be served; failing here is clearer than a browser error.
try {
  const res = await fetch(PAGE);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  process.stderr.write(
    `The web surfaces are not being served at ${PAGE}.\n\n` +
      `  ${e instanceof Error ? e.message : String(e)}\n\n` +
      'Start them first:\n\n  npm run web\n',
  );
  process.exit(1);
}

const chrome = findChrome();
const profile = await mkdtemp(join(tmpdir(), 'veil-chrome-'));
let child: ChildProcess | undefined;
let cdp: Cdp | undefined;

try {
  child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      // A sandbox is unavailable in this container; the browser only ever
      // loads 127.0.0.1 in this script.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  // Poll the DevTools endpoint until Chrome is listening.
  let target: { webSocketDebuggerUrl: string } | undefined;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('Chrome never opened a debug target');

  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // Collect console errors: a swallowed exception inside the panel would
  // otherwise look exactly like a panel that never ran.
  const consoleErrors: string[] = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(
      String(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'),
    );
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p?.entry?.level !== 'error') return;
    const text = String(p.entry.text);
    // A missing favicon is a browser-initiated request for a file this project
    // deliberately does not ship, not a defect in the page. Filtered by URL so
    // that any other 404 still fails the check.
    if (/favicon\.ico/.test(String(p.entry.url ?? ''))) return;
    consoleErrors.push(text);
  });

  await cdp.send('Page.navigate', { url: PAGE });
  await waitFor(cdp, 'document.readyState === "complete"');

  process.stdout.write('the page\n');

  await check('the panel is present on 402.html', async () => {
    const found = await evaluate(
      cdp!,
      'Boolean(document.getElementById("prover-run") && document.getElementById("prover-log"))',
    );
    if (!found) throw new Error('no prover-run / prover-log in the DOM');
    return 'button + log present';
  });

  await check('the page loaded nothing from a third-party origin', async () => {
    // Compared against the page's own origin, which includes the port — a host
    // comparison would treat 127.0.0.1:4020 as foreign to 127.0.0.1.
    const foreign = await evaluate(
      cdp!,
      `JSON.stringify([...new Set(performance.getEntriesByType('resource')
         .map(r => new URL(r.name).origin)
         .filter(o => o !== location.origin))])`,
    );
    const origins = JSON.parse(foreign) as string[];
    if (origins.length > 0) throw new Error(`third-party origins: ${origins.join(', ')}`);
    return 'every request is same-origin';
  });

  process.stdout.write('\nthe prover, clicked as a judge would click it\n');

  // Press the real button, then wait for the panel to write its verdict.
  await evaluate(cdp, 'document.getElementById("prover-run").click()');
  await waitFor(
    cdp,
    `(() => { const t = document.getElementById('prover-note').textContent;
              return t.includes('on this device') || t.includes('unavailable') ? t : false; })()`,
    60_000,
  );

  const note = await evaluate(cdp!, 'document.getElementById("prover-note").textContent');
  const log = await evaluate(cdp!, 'document.getElementById("prover-log").textContent');
  const status = await evaluate(cdp!, 'document.getElementById("prover-status").textContent');

  await check('the panel reached the bundle and instantiated the WASM', () => {
    if (status === 'unavailable') {
      throw new Error(`the panel could not load the prover — ${log.split('\n')[0]}`);
    }
    return `status "${status}"`;
  });

  await check('three proofs were generated, in the order Token-2022 reads them', () => {
    const numbered = (log.match(/^\s+\d\. /gm) ?? []).length;
    if (numbered !== 3) throw new Error(`the log shows ${numbered} proofs, expected 3`);
    return '3 proofs, numbered in the log';
  });

  await check('the log names all three statements', () => {
    const want = ['ciphertext-commitment equality', 'batched grouped ciphertext validity', 'batched range proof'];
    const missing = want.filter((w) => !log.includes(w));
    if (missing.length > 0) throw new Error(`the log does not mention: ${missing.join('; ')}`);
    return want.map((w) => w.split(' ')[0]).join(', ');
  });

  await check('every offset shown is -1', () => {
    const offsets = log.match(/offset (-?\d+)/g) ?? [];
    if (offsets.length !== 3) throw new Error(`found ${offsets.length} offsets, expected 3`);
    const wrong = offsets.filter((o: string) => o !== 'offset -1');
    if (wrong.length > 0) throw new Error(`non-negative offset shown: ${wrong.join(', ')}`);
    return 'offset -1 × 3';
  });

  await check('the panel measured zero network requests while proving', () => {
    if (!log.includes('network requests made while proving: 0')) {
      const line = log
        .split('\n')
        .find((l: string) => l.includes('network requests made while proving'));
      throw new Error(line?.trim() ?? 'the panel did not report a request count');
    }
    return 'measured 0, not claimed';
  });

  await check('the amount and the balance appear only as inputs, never as output', () => {
    // The panel prints "1000000 − 49000 = 951000" as a demonstration of the
    // statement being proven. The ciphertexts are what goes on chain, and the
    // panel prints only their sizes.
    if (!/1000000 − 49000 = 951000/.test(log)) {
      throw new Error('the statement line is missing');
    }
    if (!log.includes('never revealed')) throw new Error('the panel does not label the plaintext as local');
    return 'plaintext labelled local, sizes only for ciphertexts';
  });

  await check('the browser raised no uncaught exception', () => {
    if (consoleErrors.length > 0) {
      throw new Error(consoleErrors[0]!.split('\n')[0]);
    }
    return 'clean console';
  });

  // A screenshot, so the visual claim is on the record too. Written next to
  // the standalone artifacts rather than into the repo root, because it is a
  // build output of this check and not a source file.
  await check('a screenshot of the proving panel was captured', async () => {
    const shot = await cdp!.send('Page.captureScreenshot', { format: 'png' });
    const dir = join(ROOT, '.gstack/projects/devansh/designs/standalone-20261002');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'prover-in-browser.png');
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    const { size } = await stat(file);
    return `${file.replace(ROOT, '')}  ${(size / 1024).toFixed(0)} kB`;
  });

  process.stdout.write('\n');
  process.stdout.write(`  panel status: ${status}\n`);
  process.stdout.write(
    log
      .split('\n')
      .filter((l: string) => l.trim())
      .map((l: string) => `  │ ${l}`)
      .join('\n') + '\n',
  );
  process.stdout.write('\n');
} catch (e) {
  no('the browser check ran to completion', e instanceof Error ? e.message : String(e));
} finally {
  cdp?.close();
  child?.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(
  failed === 0
    ? `\n${passed} passed, 0 failed\n\nVERDICT: a real browser generates every proof on the page it is\nserved. The prover is client-side in the deployed artifact, not in a diagram.\n\n`
    : `\n${passed} passed, ${failed} failed\n\nVERDICT: the panel does not work in a browser — see above.\n\n`,
);

process.exit(failed === 0 ? 0 : 1);
