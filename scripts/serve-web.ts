/**
 * scripts/serve-web.ts — serve the web surfaces over HTTP.
 *
 *   npm run web            # http://127.0.0.1:4020
 *   npm run web -- --port 8080
 *
 * ## Why this exists
 *
 * The four pages under `web/` are designed to render from `file://` with no
 * sibling files, and `npm run standalone` produces a single-file artifact of
 * each one for exactly that. But one surface cannot work that way: the prover on
 * `402.html` imports an ES module, and a browser refuses module imports from the
 * filesystem under the `file://` origin. The panel says so on the page rather
 * than failing silently, and this script is the other half of that — a real
 * origin where the prover runs.
 *
 * It is also the shape a deployment takes. Whatever a host does, it ends up
 * serving these files with correct content types, and `application/wasm` is the
 * one that matters here: a server that returns `application/octet-stream` for
 * `index_bg.wasm` makes `WebAssembly.instantiateStreaming` fall back to a
 * buffering path, which is a silent performance loss rather than an error.
 *
 * ## Scope
 *
 * Deliberately small and read-only. It serves `web/` and nothing else: no
 * directory listing beyond the index, no uploads, and any path that resolves
 * outside `web/` is refused. A demo server that can read arbitrary files is a
 * worse demo.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = resolve(join(ROOT, 'web'));

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag !== -1 ? Number(args[portFlag + 1]) : Number(process.env.VEIL_WEB_PORT ?? 4020);
const HOST = '127.0.0.1';

/**
 * Content types, with `application/wasm` as the one that earns its keep.
 *
 * `.js` is `text/javascript` rather than the legacy `application/javascript`:
 * a module script is only executed if the browser accepts the type, and
 * `text/javascript` is the value the HTML spec names.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a request path to a file inside `web/`, or refuse. */
function resolveRequest(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname.split('?')[0]!);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = resolve(join(WEB, normalize(relative)));
  // Traversal guard: a path that escapes `web/` is not served, however it was
  // spelled. Compared against the resolved root plus a separator so that a
  // sibling directory whose name merely starts with "web" cannot slip through.
  if (target !== WEB && !target.startsWith(WEB + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  const target = resolveRequest(req.url ?? '/');
  if (target === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('refused: that path is outside the served directory\n');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${req.url!.replace(/\/?$/, '')}/index.html` });
      res.end();
      return;
    }
    const body = await readFile(target);
    const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.byteLength,
      // The prover bundle and its WASM are build outputs, so they change
      // whenever the build runs. `no-cache` revalidates instead of pinning a
      // stale prover into a reviewer's browser for the rest of the session.
      'cache-control': 'no-cache',
      // Needed for SharedArrayBuffer in a browser that would otherwise isolate
      // the page; harmless where it is not required.
      'cross-origin-opener-policy': 'same-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`not found: ${req.url}\n`);
  }
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  process.stdout.write(
    [
      '',
      'Veil — web surfaces',
      '',
      `  landing          ${base}/index.html`,
      `  merchant ledger  ${base}/dashboard.html`,
      `  the 402 body     ${base}/402.html`,
      `  honest limits    ${base}/limits.html`,
      '',
      'The prover on 402.html loads over HTTP; it cannot run from file://,',
      'which the panel reports rather than failing silently.',
      '',
    ].join('\n'),
  );
});
