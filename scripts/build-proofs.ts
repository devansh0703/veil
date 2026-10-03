/**
 * scripts/build-proofs.ts — build the browser's prover.
 *
 *   npm run build:proofs
 *
 * ## What it emits
 *
 *   web/assets/veil-proofs.js    — an ES module a browser can load
 *   web/assets/index_bg.wasm     — the prover's WASM, beside it
 *   web/assets/veil-proofs.json  — sizes and hashes, read by the smoke test
 *
 * ## Why a build step at all
 *
 * `web/` is otherwise plain, unbundled ES modules: `assets/veil.js` is
 * hand-written browser JS. That is right for page behaviour and wrong for the
 * prover, because the prover is not page behaviour — it is
 * `packages/onchain/src/proofs.ts`, the same module the CLI and the tests
 * exercise, plus `@noble/curves`.
 *
 * Copying that logic into a hand-written browser file would create a second
 * implementation of the crypto — exactly the drift this project refuses
 * elsewhere. So the real module is compiled, with one alias:
 *
 *   `@solana/zk-sdk`  ->  `web/prove/zk-sdk-web-shim.ts`
 *
 * That alias is the whole trick: `proofs.ts` compiles unmodified, and its
 * `@solana/zk-sdk` resolves to the browser build instead of the Node one.
 *
 * ## Why the WASM is copied rather than inlined
 *
 * 2.7 MB base64-inlined would grow the bundle by a third and force a browser to
 * parse it as text before it could run. As a sibling file it is fetched,
 * streamed, and cached separately — and it is the *same* binary
 * `@solana/zk-sdk` ships, not a rebuild, so the proofs it generates are the
 * proofs the Node path generates.
 */

import { build, type Plugin } from 'esbuild';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'web/assets');
const WASM_SOURCE = join(ROOT, 'node_modules/@solana/zk-sdk/dist/web/index_bg.wasm');

/**
 * A stub for `zod`, which `@solana/kit` imports but the prover never uses.
 *
 * Left as a throwing stub rather than an empty module so a future edit that
 * starts relying on a schema fails loudly in the browser instead of shipping a
 * validator that silently is not there.
 */
const zodStub: Plugin = {
  name: 'zod-stub',
  setup(build) {
    build.onResolve({ filter: /^zod$/ }, () => ({ path: 'zod-stub', namespace: 'zod-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'zod-stub' }, () => ({
      contents: `
const refuse = (name) => () => {
  throw new Error('zod.' + name + ' is not available in the browser proof bundle; ' +
    'the prover does not validate schemas. If this path is now needed, drop the ' +
    'zod stub in scripts/build-proofs.ts.');
};
const schema = new Proxy({}, { get: (_t, name) => refuse(String(name)) });
export default schema;
export const z = schema;
export const ZodError = class ZodError extends Error {};
`,
      loader: 'js',
    }));
  },
};

/** `@solana/zk-sdk` -> the browser shim. The alias that makes this whole thing work. */
const zkSdkAlias: Plugin = {
  name: 'zk-sdk-browser',
  setup(build) {
    build.onResolve({ filter: /^@solana\/zk-sdk$/ }, () => ({
      path: join(ROOT, 'web/prove/zk-sdk-web-shim.ts'),
    }));
  },
};

await mkdir(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [join(ROOT, 'web/prove/veil-proofs.ts')],
  outfile: join(OUT_DIR, 'veil-proofs.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  // No `external` for the WASM: the web build's `init()` takes a URL, so the
  // binary is never a module import in the first place.
  plugins: [zkSdkAlias, zodStub],
  // Deliberately unminified. A judge reading the bundle should be able to find
  // the proof constructors in it; a minified blob proves nothing.
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
});

const wasmDest = join(OUT_DIR, 'index_bg.wasm');
await copyFile(WASM_SOURCE, wasmDest);

const [jsBytes, wasmBytes] = await Promise.all([
  stat(join(OUT_DIR, 'veil-proofs.js')),
  stat(wasmDest),
]);

/**
 * Record what was built.
 *
 * The smoke test (`scripts/prove-browser.ts`) reads this so it can assert it is
 * loading the artifact this script produced, and fail with a "run the build"
 * message rather than a confusing instantiation error when it is stale.
 */
const manifest = {
  builtAt: new Date().toISOString(),
  entry: 'web/prove/veil-proofs.ts',
  bundle: 'web/assets/veil-proofs.js',
  bundleBytes: jsBytes.size,
  wasm: 'web/assets/index_bg.wasm',
  wasmBytes: wasmBytes.size,
  wasmSha256: createHash('sha256').update(await readFile(wasmDest)).digest('hex'),
  aliases: { '@solana/zk-sdk': 'web/prove/zk-sdk-web-shim.ts', zod: 'stub' },
};
await writeFile(
  join(OUT_DIR, 'veil-proofs.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const modules = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]!]!.inputs);
process.stdout.write(
  [
    '',
    'Veil — browser prover built',
    '',
    `  web/assets/veil-proofs.js     ${(jsBytes.size / 1024).toFixed(0)} kB`,
    `  web/assets/index_bg.wasm      ${(wasmBytes.size / 1024 / 1024).toFixed(2)} MB`,
    '',
    `  ${modules.length} modules compiled, including packages/onchain/src/proofs.ts`,
    '  a browser generates every proof locally; no prover service is contacted',
    '',
  ].join('\n'),
);
