/**
 * Shared plumbing for the hosted (Vercel) deployment.
 *
 * The pool ledger is *written* after every settlement (seat consumption). Two
 * things make that durable on a serverless runtime:
 *
 * 1. A **store** (`scripts/ledger-store.ts`, wired in `api-src/veil.ts`) is the
 *    authority whenever its credentials are set, and it is one record shared by
 *    every instance.
 * 2. A **seed** for the first request, which is this file's job. A hosted
 *    function's filesystem is read-only except `/tmp`, so the seeded copy is
 *    staged there; with no store configured, that copy is still per-instance and
 *    a cold start re-seeds from the bundle.
 *
 * The seed is **cluster-aware**. Veil runs on both clusters, the two pools are
 * different addresses, and a devnet deployment that seeded itself from the
 * testnet bundle would offer seats that are empty — or worse, already paid — on
 * the chain its payers are on.
 *
 * The ledgers are imported as JSON (bundled into the function by esbuild) rather
 * than read from a path: file-tracing a runtime-computed path is the exact class
 * of failure that broke the first deployment.
 */

import { rename, stat, writeFile } from 'node:fs/promises';

import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  networkFromRpc,
  normalizeNetwork,
} from '../packages/x402-core/src/index.ts';
import devnetLedger from '../data/pool-ledger.devnet.json' with { type: 'json' };
import testnetLedger from '../data/pool-ledger.json' with { type: 'json' };

/**
 * Which cluster this deployment is for, decided the way `scripts/lib.ts`
 * decides it: the RPC endpoint is authoritative when it names a cluster, and
 * the configured network is the fallback. Both spellings of devnet resolve —
 * `solana:devnet` and the genesis hash are the same network, and a deployment
 * written either way must seed the same ledger.
 */
export function clusterTagForEnv(): '.devnet' | '.mainnet' | '' {
  const resolve = (): string | undefined => {
    const rpc = process.env.VEIL_RPC_URL;
    if (rpc) {
      try {
        const fromRpc = networkFromRpc(rpc);
        if (fromRpc) return fromRpc;
      } catch {
        // Fall through to the configured network.
      }
    }
    const network = process.env.VEIL_NETWORK;
    if (!network) return undefined;
    try {
      return normalizeNetwork(network);
    } catch {
      return undefined;
    }
  };
  const resolved = resolve();
  if (resolved === SOLANA_DEVNET) return '.devnet';
  if (resolved === SOLANA_MAINNET) return '.mainnet';
  return '';
}

function seedFor(env: string): unknown {
  // Mainnet has no pool in this repo and no funded seats, so the honest seed is
  // empty: the rail then refuses every paid resource (VEIL-CONF-005) instead of
  // offering addresses it cannot back on the chain the payer is on.
  if (env === '.mainnet') return [];
  return env === '.devnet' ? devnetLedger : testnetLedger;
}

/** Writable per-instance copy, suffixed by cluster so the two never collide. */
export const HOSTED_LEDGER = `/tmp/veil-pool-ledger${clusterTagForEnv()}.json`;

/**
 * Where this deployment's shared ledger lives, when the store is configured.
 *
 * Scoped by cluster for the same reason the seeded file is: the two clusters
 * have different seats, and two pools under one key would collide on
 * `alias#slot` — the devnet rail writing a devnet seat at `payee.test#0` on top
 * of the testnet one. Suffixing the key keeps one durable ledger *per cluster*,
 * which is what "durable" has to mean when the value it describes is per-chain.
 */
export const HOSTED_LEDGER_KEY = `veil:pool-ledger:v1${clusterTagForEnv()}`;

/**
 * Where this deployment's settlement records live, when the store keeps them.
 *
 * Separate from the seat map on purpose: the seat map is the promise (an address
 * is spent once) and must stay small, while this is a log that is read whole by
 * the dashboard and aged out when it grows. Scoped by cluster for the same
 * reason — a devnet settlement must not appear on the testnet dashboard.
 */
export const HOSTED_SETTLEMENTS_KEY = `veil:settlements:v1${clusterTagForEnv()}`;

/**
 * Seed /tmp from the inlined ledger for this cluster if absent (atomic: stage,
 * then rename, so a concurrent cold start can never read a half-written file).
 */
export async function seedHostedLedger(): Promise<string> {
  try {
    await stat(HOSTED_LEDGER);
  } catch {
    const staging = `${HOSTED_LEDGER}.seed-${process.pid}`;
    const body = JSON.stringify(seedFor(clusterTagForEnv()), null, 2);
    await writeFile(staging, `${body}\n`, 'utf8');
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
 *
 * Every param except the marker rides along: `?nonce=` is half a payment's
 * identity, and restoring only the path silently dropped it, collapsing every
 * hosted payment from one payer onto nonce 0. The marker is the one param
 * Vercel adds; the rest belongs to the handler.
 */
export function rewriteRoute(reqUrl: string | undefined): string | null {
  try {
    const url = new URL(reqUrl ?? '/', 'http://localhost');
    const route = url.searchParams.get('route');
    if (route === null || route.length === 0) return null;
    url.searchParams.delete('route');
    const rest = url.searchParams.toString();
    if (rest.length === 0) return route;
    return `${route}${route.includes('?') ? '&' : '?'}${rest}`;
  } catch {
    return null;
  }
}
