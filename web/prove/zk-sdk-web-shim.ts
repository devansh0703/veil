/**
 * web/prove/zk-sdk-web-shim.ts — points the prover at the browser build.
 *
 * ## Why a shim instead of an import
 *
 * `packages/onchain/src/proofs.ts` — the real, tested prover — imports its proof
 * generators from `@solana/zk-sdk`. That package's `exports` map resolves to
 * `dist/node/index.js` by default, which loads a WASM binary through Node's
 * filesystem. A browser cannot use it.
 *
 * The browser build is a sibling entry (`@solana/zk-sdk/web`), and the two
 * export the same named classes with the same methods. So rather than fork the
 * prover, `scripts/build-proofs.ts` aliases the specifier `@solana/zk-sdk` to
 * *this* module during the browser build. `proofs.ts` is then compiled
 * unmodified and resolves to the web build.
 *
 * That matters beyond tidiness: a forked prover is a second copy of the crypto
 * that silently drifts from the one `npm test` and `npm run prove:check`
 * exercise. Aliasing means the browser runs the same statements.
 *
 * ## The one difference this shim has to absorb
 *
 * The web build cannot fetch its own `index_bg.wasm` once bundled: it would
 * resolve `import.meta.url` to a path that no longer sits beside the binary. So
 * this shim owns instantiation and exposes it as `ready()`, and every consumer
 * must await it before constructing any proof type.
 */

import init, { initSync } from '@solana/zk-sdk/web';

export * from '@solana/zk-sdk/web';

let instantiated: Promise<void> | undefined;

/** The URL a browser fetches the WASM from, relative to the page. */
export const DEFAULT_WASM_URL = 'index_bg.wasm';

/**
 * Instantiate from a URL. Idempotent — the WASM is a singleton, so a second
 * caller joins the first promise rather than allocating a second instance.
 */
export function ready(wasmUrl: string = DEFAULT_WASM_URL): Promise<void> {
  instantiated ??= Promise.resolve(init({ module_or_path: wasmUrl })).then(() => undefined);
  return instantiated;
}

/**
 * Instantiate from bytes already in memory.
 *
 * Exists so a headless run — the Node smoke test that loads the built browser
 * bundle and generates real proofs — exercises the same artifact a page loads,
 * without needing a DOM or a network. `initSync` is synchronous, so this still
 * returns a promise to keep one call shape for both paths.
 */
export function readyFromBytes(bytes: Uint8Array): Promise<void> {
  instantiated ??= Promise.resolve(initSync({ module: bytes })).then(() => undefined);
  return instantiated;
}
