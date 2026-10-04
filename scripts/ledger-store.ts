/**
 * A durable home for the pool ledger, on Upstash Redis over its HTTP REST API.
 *
 * ## Why this exists
 *
 * A hosted function's disk is read-only except `/tmp`, and `/tmp` belongs to one
 * instance. So a seat consumed on one instance was forgotten by the next cold
 * start, which re-seeded from the bundle: "already settled" and "which seats are
 * spent" depended on which instance answered, and a caller could walk a pool to
 * exhaustion within one instance's lifetime. Chain balances were never affected —
 * this was accounting memory — but the answers were not consistent.
 *
 * ## Why Redis over HTTP, and why no client library
 *
 * The ledger is read on every quote and written once per settlement, from a
 * serverless function that has no connection to pool. Upstash's REST API is one
 * HTTPS request per command, which is exactly the shape a function wants, and it
 * has a free tier. The REST subset used here is three commands — `GET`, `SET`,
 * `EVAL` — so this is implemented against `fetch` rather than pulling a client
 * package into a deployment that needs none of its surface.
 *
 * ## Why compare-and-set
 *
 * Two instances can settle at the same moment. A plain `SET` would let the
 * slower writer silently drop the faster one's consumed seat, and the pool would
 * then hand out an address that had already been paid — the exact relinking the
 * pool exists to prevent.
 *
 * Seat consumption is **monotonic**: `consumedBy` only ever goes from null to a
 * payment id, and `settledAt` is set once and never cleared. That makes the
 * merge rule trivial and safe — take the remote value whenever the remote has
 * one — and it means a conflicting write loses nothing, because the union of two
 * consumption records is just the remote's plus ours. So `save` reads, merges,
 * and CASes; on a lost race it re-reads and merges again.
 */

import {
  PoolLedger,
  mergeLedgers,
  type StoredSettlement,
} from '../packages/derive/src/index.ts';

// The merge rule belongs with the ledger it merges, so `packages/server` can
// apply it when it loads a store over a seed without reaching up into `scripts`.
// Re-exported here because this is where it is used and tested.
export { mergeLedgers };

export interface RedisLedgerStoreOptions {
  readonly url: string;
  readonly token: string;
  /** The key the ledger lives under. */
  readonly key?: string;
  /** The key the settlement records live under. Derived from `key` when absent. */
  readonly settlementKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  /** How many settlement records to keep. The oldest are dropped first. */
  readonly settlementLimit?: number;
}

/**
 * Compare-and-set, in Redis's own language.
 *
 * Returns 1 when it wrote and 0 when the value had moved under us, which is the
 * signal to merge again rather than a failure. `GET` on a missing key returns
 * false, normalised to `''` so "absent" compares equal on both sides — the
 * ledger value is always JSON, so it can never collide with the sentinel.
 */
const CAS = [
  "local current = redis.call('GET', KEYS[1])",
  "if current == false then current = '' end",
  "if current ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  'return 1',
].join('\n');

/** The sentinel for "nothing stored yet". Never a valid ledger value. */
const ABSENT = '';

/**
 * A ledger store backed by Upstash, or `null` when it is not configured.
 *
 * Returning null rather than throwing is the point: a deployment that has not
 * set the credentials keeps working exactly as before (per-instance `/tmp`),
 * and the difference is reported, not silent.
 */
export function redisLedgerStore(
  options?: Partial<RedisLedgerStoreOptions>,
): RedisLedgerStore | null {
  const url = options?.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = options?.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const key = options?.key ?? 'veil:pool-ledger:v1';
  // Derived, not a second argument the caller has to remember, so the two keys
  // are always scoped to the same cluster. Getting this wrong would put devnet
  // settlements in the testnet dashboard.
  const settlementKey = options?.settlementKey ?? `${key}:settlements`;
  const call = options?.fetchImpl ?? fetch;
  const maxAttempts = options?.maxAttempts ?? 5;
  // Records are read whole on every dashboard request, so the list is bounded:
  // an unbounded one turns a free-tier key into a growing payload for a page
  // nobody scrolls to the bottom of. The seat map, which is the part the promise
  // depends on, is never truncated.
  const settlementLimit = options?.settlementLimit ?? 500;
  // Trailing slash trimmed once, into a plain string, so the closure below does
  // not depend on narrowing that does not survive being captured.
  const endpoint: string = url.replace(/\/$/, '');

  async function command(args: readonly (string | number)[]): Promise<unknown> {
    // Upstash takes a command as a JSON array at the root, or the same array as
    // the body of a POST — the shape that works for `EVAL` and its arguments.
    const response = await call(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(`upstash: ${body.error}`);
    if (!response.ok) throw new Error(`upstash: ${response.status} ${response.statusText}`);
    return body.result;
  }

  async function read(redisKey: string): Promise<string> {
    const result = await command(['GET', redisKey]);
    return typeof result === 'string' ? result : ABSENT;
  }

  return {
    async load(): Promise<PoolLedger | null> {
      const raw = await read(key);
      if (raw === ABSENT) return null;
      // Through fromJSON, so a hand-edited or half-written value fails loudly
      // instead of starting the server with a pool it cannot trust.
      return PoolLedger.fromJSON(JSON.parse(raw));
    },

    async loadSettlements(): Promise<StoredSettlement[]> {
      const raw = await read(settlementKey);
      if (raw === ABSENT) return [];
      const parsed: unknown = JSON.parse(raw);
      // Checked rather than trusted: a dashboard that silently renders nothing
      // because the value is the wrong shape hides a real fault.
      if (!Array.isArray(parsed)) {
        throw new Error('upstash: the settlement record is not an array');
      }
      return parsed as StoredSettlement[];
    },

    async appendSettlement(settlement: StoredSettlement): Promise<void> {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const previous = await read(settlementKey);
        const current: StoredSettlement[] =
          previous === ABSENT ? [] : (JSON.parse(previous) as StoredSettlement[]);
        // Recording the same settlement twice is not an error — a retried
        // broadcast must not become two rows on the dashboard — but it is also
        // not a write, so the compare-and-set is skipped.
        if (current.some((row) => row.address === settlement.address)) return;
        const appended = [...current, settlement];
        const next = appended.length > settlementLimit
          ? appended.slice(-settlementLimit)
          : appended;
        const wrote = await command([
          'EVAL',
          CAS,
          1,
          settlementKey,
          previous,
          JSON.stringify(next),
        ]);
        if (wrote === 1) return;
      }
      throw new Error(
        `upstash: could not record the settlement after ${maxAttempts} attempts — ` +
          'another instance is writing faster than this one can merge',
      );
    },

    async save(ledger: PoolLedger): Promise<void> {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const previous = await read(key);
        const remote =
          previous === ABSENT ? null : PoolLedger.fromJSON(JSON.parse(previous));
        const next = mergeLedgers(remote, ledger);
        const wrote = await command([
          'EVAL',
          CAS,
          1,
          key,
          previous,
          JSON.stringify(next.toJSON()),
        ]);
        if (wrote === 1) return;
      }
      throw new Error(
        `upstash: could not persist the ledger after ${maxAttempts} attempts — ` +
          'another instance is writing faster than this one can merge',
      );
    },
  };
}

/** Structural type, so this module does not depend on the server package. */
export interface RedisLedgerStore {
  load(): Promise<PoolLedger | null>;
  save(ledger: PoolLedger): Promise<void>;
  loadSettlements(): Promise<StoredSettlement[]>;
  appendSettlement(settlement: StoredSettlement): Promise<void>;
}
