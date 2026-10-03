/**
 * Bundle the serverless entries in `api-src/` into self-contained ESM files
 * in `api/`.
 *
 *   node scripts/build-api.mjs     (npm run build:api)
 *
 * Why this exists: Vercel's first deploy compiled `api/*.ts` but its file
 * tracer did not follow this repo's NodeNext `.ts`-extension imports into
 * `scripts/` and `packages/`, so the functions crashed with
 * ERR_MODULE_NOT_FOUND. Bundling removes the ambiguity — every generated
 * `api/*.js` has zero local imports left, only external packages, which the
 * tracer handles reliably. The pool ledger (data/pool-ledger.json) is inlined
 * as JSON by esbuild; see scripts/hosted.ts.
 *
 * The `api/*.js` outputs are committed artifacts: a deploy must not depend on
 * build-command ordering. Regenerate after editing api-src/, scripts/hosted.ts,
 * or anything those import.
 */

import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';

const entryPoints = [
  'api-src/facilitator.ts',
  'api-src/veil.ts',
  'api-src/ledger.ts',
];

await mkdir('api', { recursive: true });

await build({
  entryPoints,
  outdir: 'api',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node_modules stay external: the platform's tracer handles plain JS
  // packages reliably, and bundling @solana/kit would explode the artifact.
  packages: 'external',
  logLevel: 'info',
});

const built = (await readdir('api')).sort();
console.log(`api build complete: ${built.join(', ')}`);
