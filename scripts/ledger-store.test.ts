/**
 * Tests for the durable ledger store.
 *
 * The store talks to Upstash over HTTP, so the tests stand a stub in front of it
 * rather than reaching the network: what matters here is the *merge* and the
 * compare-and-set, and those are precisely the parts a real account would not
 * exercise deterministically (you cannot ask Redis to lose a race on demand).
 *
 * The property under test is the one the pool exists for: a concurrent
 * settlement must never drop another instance's consumed seat, because dropping
 * it means handing out an address that has already been paid.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import {
  PoolLedger,
  derivePaymentId,
  type PaymentIdentity,
} from '../packages/derive/src/index.ts';
import { mergeLedgers, redisLedgerStore } from './ledger-store.ts';

const ALIAS = 'payee.test';

/** A ledger with `count` seats for one alias, none consumed. */
function ledgerWith(count: number, alias = ALIAS): PoolLedger {
  const ledger = PoolLedger.empty();
  for (let slot = 0; slot < count; slot++) {
    ledger.register({
      slot,
      address: `Address${slot}${'x'.repeat(24)}`,
      alias,
      armed: true,
    });
  }
  return ledger;
}

/**
 * Reserve and settle one seat, the way a real payment does.
 *
 * `settle` refuses a seat that was never reserved — the column this guards is
 * "consumed by a payment that exists" — so the test has to walk the same two
 * steps the server does rather than writing `consumedBy` directly.
 */
function consume(
  ledger: PoolLedger,
  payer: string,
): { address: string; paymentId: string; settledAt: string } {
  const id: PaymentIdentity = { resource: '/v1/payee/test', payer, nonce: 0 };
  const paymentId = derivePaymentId(id);
  const settledAt = '2026-10-04T00:00:00.000Z';
  const seat = ledger.reserve(ALIAS, id, 4);
  ledger.settle(seat.address, paymentId, settledAt);
  return { address: seat.address, paymentId, settledAt };
}

/**
 * A minimal Upstash stand-in: `GET`, `SET` and `EVAL` against one in-memory
 * value, with the EVAL semantics the store depends on (write only when the
 * caller's previous value still matches).
 *
 * `race(value)` arms a write that lands from *another instance* in the window
 * between our read and our EVAL. That window is the only place the retry logic
 * can be observed, and no real server will produce it on request.
 */
async function stubRedis() {
  const values = new Map<string, string>();
  let evals = 0;
  let raceWith: string | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (string | number)[];
      const [cmd] = body;
      let result: unknown = null;

      // Keyed, because the store now keeps two records: the seat map and the
      // settlement log. A stub with one value would let a wrong key pass.
      const key = String(body[1] ?? '');
      if (cmd === 'GET') {
        result = values.get(key) ?? null;
      } else if (cmd === 'SET') {
        values.set(key, String(body[2]));
        result = 'OK';
      } else if (cmd === 'EVAL') {
        evals += 1;
        const evalKey = String(body[3] ?? '');
        if (raceWith !== null) {
          values.set(evalKey, raceWith);
          raceWith = null;
        }
        const previous = String(body[4]);
        const next = String(body[5]);
        result = (values.get(evalKey) ?? '') === previous
          ? (values.set(evalKey, next), 1)
          : 0;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    evals: () => evals,
    keys: () => [...values.keys()],
    race: (next: string) => {
      raceWith = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('no credentials means no store, so a deployment keeps the local behaviour', () => {
  assert.equal(redisLedgerStore({ url: '', token: '' }), null);
});

test('load reports null before anything has been stored', async () => {
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({ url: redis.url, token: 'test' })!;
    assert.equal(await store.load(), null);
  } finally {
    await redis.close();
  }
});

test('a saved ledger round-trips through the store', async () => {
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({ url: redis.url, token: 'test' })!;
    await store.save(ledgerWith(4));

    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.size, 4);
    assert.equal(loaded.allFor(ALIAS)[0]?.address, `Address0${'x'.repeat(24)}`);
  } finally {
    await redis.close();
  }
});

test('a seat consumed remotely survives a save that never saw it', () => {
  // This is the whole point: instance A consumed a seat, instance B holds a
  // stale copy and writes. B's write must not resurrect the seat.
  const local = ledgerWith(4);
  const remote = ledgerWith(4);
  const paid = consume(remote, 'payer-a');

  const merged = mergeLedgers(remote, local);
  const seat = merged.allFor().find((entry) => entry.address === paid.address)!;
  assert.equal(seat.consumedBy, paid.paymentId);
  assert.equal(seat.settledAt, paid.settledAt);

  // And the other seats are untouched, so the pool did not shrink.
  assert.equal(merged.size, 4);
  assert.equal(merged.allFor().filter((entry) => entry.consumedBy === null).length, 3);
});

test('a lost compare-and-set race is retried and loses no settlement', async () => {
  // A second instance settles between our read and our EVAL. Our write must
  // fail, re-read, merge, and succeed — with both seats consumed.
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({ url: redis.url, token: 'test' })!;
    await store.save(ledgerWith(4));

    const local = ledgerWith(4);
    const ours = consume(local, 'payer-local');

    // Stand in for the other instance: a ledger where a *different* seat is
    // already consumed. Written straight into the stub, so it lands while our
    // EVAL is in flight.
    const otherInstance = ledgerWith(4);
    const theirs = consume(otherInstance, 'payer-other-instance');
    assert.notEqual(theirs.address, ours.address);
    redis.race(JSON.stringify(otherInstance.toJSON()));

    await store.save(local);

    // One seed write, then our write loses once and succeeds on the retry.
    assert.equal(redis.evals(), 3);

    const final = await store.load();
    assert.ok(final);
    const consumed = final.allFor().map((entry) => entry.consumedBy);
    assert.ok(
      consumed.includes(theirs.paymentId),
      "the other instance's settlement must survive our write",
    );
    assert.ok(consumed.includes(ours.paymentId), 'our own settlement must survive too');
  } finally {
    await redis.close();
  }
});

// ---------------------------------------------------------------------------
// Merging a store with the seed it was seeded from
// ---------------------------------------------------------------------------

test('a seat the store consumed survives a seed that never heard of it', () => {
  // The store is where an instance records its settlements; the seed is only the
  // bundle. Forgetting the store's consumption is how a pool hands a paid
  // one-time address to a second payer.
  const seed = ledgerWith(4);
  const stored = ledgerWith(4);
  const theirs = consume(stored, 'payer-from-another-instance');

  const merged = mergeLedgers(stored, seed);
  assert.equal(merged.resolve(theirs.address)?.consumedBy, theirs.paymentId);
  assert.equal(merged.resolve(theirs.address)?.settledAt, theirs.settledAt);
});

test('seats armed since the store was written still appear', () => {
  // A redeploy that grew the pool must not silently shrink back to whatever
  // existed the first time the store was written.
  const stored = ledgerWith(2);
  const seed = ledgerWith(5);

  const merged = mergeLedgers(stored, seed);
  assert.equal(merged.armedFor(ALIAS).length, 5);
});

test('the seed decides structure while the store decides consumption', () => {
  const seed = ledgerWith(4);
  const stored = ledgerWith(4);
  const theirs = consume(stored, 'payer-from-another-instance');
  // The seed disagrees about *which* seat exists at that slot: it is the version
  // the code defines, so it wins, and no consumption is invented for a seat that
  // no longer exists.
  const merged = mergeLedgers(stored, seed);
  assert.deepEqual(
    merged.allFor().map((e) => e.address),
    seed.allFor().map((e) => e.address),
  );
  assert.equal(merged.resolve(theirs.address)?.consumedBy, theirs.paymentId);
});

test('an empty store leaves the seed exactly as it was', () => {
  const seed = ledgerWith(3);
  const merged = mergeLedgers(null, seed);
  assert.equal(merged.size, seed.size);
  assert.equal(merged.armedFor(ALIAS).length, 3);
});

test('loading takes consumption from the store and structure from the seed', async () => {
  // The end-to-end of the two rules above, through the function the server
  // actually calls at build and on every read-through.
  const { loadLedgerFor } = await import('../packages/server/src/index.ts');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'veil-merge-'));
  try {
    const seedPath = join(dir, 'pool-ledger.json');
    await writeFile(seedPath, JSON.stringify(ledgerWith(5).toJSON()));

    const stored = ledgerWith(4);
    const theirs = consume(stored, 'payer-from-another-instance');

    const loaded = await loadLedgerFor({
      ledgerPath: seedPath,
      ledgerStore: { load: async () => stored, save: async () => {} },
    });

    // All five seats exist — the fourth came from the seed, not the store — and
    // exactly the one the store consumed is out of rotation.
    assert.equal(loaded.size, 5, 'seats armed since the store was written are pooled');
    assert.equal(loaded.armedFor(ALIAS).length, 4);
    assert.equal(loaded.resolve(theirs.address)?.consumedBy, theirs.paymentId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Settlement records
// ---------------------------------------------------------------------------

const RECORD = {
  paymentId: 'payment-1',
  alias: 'payee.test',
  address: 'Address0xxxxxxxxxxxxxxxxxxxxxxxx',
  amount: '49000',
  resource: '/v1/payee/test',
  at: '2026-10-04T12:00:00.000Z',
  signature: 'SigFromAnotherInstance',
};

test('the settlement log starts empty and round-trips', async () => {
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({ url: redis.url, token: 'test' })!;
    assert.deepEqual(await store.loadSettlements(), []);
    await store.appendSettlement(RECORD);
    assert.deepEqual(await store.loadSettlements(), [RECORD]);
  } finally {
    await redis.close();
  }
});

test('recording the same settlement twice is not two rows', async () => {
  // A retried broadcast must not turn one payment into two on the dashboard.
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({ url: redis.url, token: 'test' })!;
    await store.appendSettlement(RECORD);
    await store.appendSettlement(RECORD);
    assert.equal((await store.loadSettlements()).length, 1);
  } finally {
    await redis.close();
  }
});

test('the settlement key is derived from the ledger key, so it is per cluster', async () => {
  // One Upstash database serves both deployments. A shared settlement key would
  // put devnet payments on the testnet dashboard.
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({
      url: redis.url,
      token: 'test',
      key: 'veil:pool-ledger:v1.devnet',
    })!;
    await store.appendSettlement(RECORD);
    assert.deepEqual(redis.keys(), [
      'veil:pool-ledger:v1.devnet:settlements',
    ]);
  } finally {
    await redis.close();
  }
});

test('a settlement written concurrently is not lost', async () => {
  const redis = await stubRedis();
  try {
    const store = redisLedgerStore({ url: redis.url, token: 'test' })!;
    await store.appendSettlement(RECORD);
    // Another instance appends in the window between our read and our write. It
    // read the same log we did, so its array is ours plus its own row — which is
    // what a real concurrent append looks like, and why losing the race costs
    // nothing once the retry re-reads.
    const theirs = { ...RECORD, paymentId: 'payment-2', address: 'Address1yyyyyyyyyyyyyyyyyyyyyyyy' };
    redis.race(JSON.stringify([RECORD, theirs]));
    await store.appendSettlement({ ...RECORD, paymentId: 'payment-3', address: 'Address2zzzzzzzzzzzzzzzzzzzzzzzz' });
    const rows = await store.loadSettlements();
    assert.deepEqual(
      rows.map((r) => r.paymentId).sort(),
      ['payment-1', 'payment-2', 'payment-3'],
    );
  } finally {
    await redis.close();
  }
});
