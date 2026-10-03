/**
 * Shared plumbing for the hosted (Vercel) deployment.
 *
 * The pool ledger is *written* after every settlement (seat consumption), but
 * a hosted function's filesystem is read-only except `/tmp` — so each warm
 * instance works against a seeded copy there. A cold start re-seeds from the
 * value inlined below, which means hosted seat-consumption memory is
 * per-instance; the chain balances themselves are unaffected. This is a
 * documented limitation of the hosted demo (see README), not of the protocol:
 * the local server writes the real ledger file as always.
 *
 * The ledger is imported as JSON (bundled into the function by esbuild)
 * rather than read from a path: file-tracing a runtime-computed path is the
 * exact class of failure that broke the first deployment.
 */

import { rename, stat, writeFile } from 'node:fs/promises';
import ledgerSource from '../data/pool-ledger.json' with { type: 'json' };

/** Writable per-instance copy. */
export const HOSTED_LEDGER = '/tmp/veil-pool-ledger.json';

/**
 * Seed /tmp from the inlined ledger if absent (atomic: stage, then rename, so
 * a concurrent cold start can never read a half-written file).
 */
export async function seedHostedLedger(): Promise<string> {
  try {
    await stat(HOSTED_LEDGER);
  } catch {
    const staging = `${HOSTED_LEDGER}.seed-${process.pid}`;
    await writeFile(staging, `${JSON.stringify(ledgerSource, null, 2)}\n`, 'utf8');
    await rename(staging, HOSTED_LEDGER);
  }
  return HOSTED_LEDGER;
}

/**
 * Recover the logical route a vercel.json rewrite carried in `?route=`.
 *
 * Rewrites deliver the *destination* path (`/api/veil?route=/v1/...`), so the
 * original path must be restored before the shared handler's exact-match
 * router runs. Returns null when no rewrite marker is present (the local
 * server never has one and passes URLs through untouched).
 */
export function rewriteRoute(reqUrl: string | undefined): string | null {
  try {
    const route = new URL(reqUrl ?? '/', 'http://localhost').searchParams.get('route');
    return route !== null && route.length > 0 ? route : null;
  } catch {
    return null;
  }
}
