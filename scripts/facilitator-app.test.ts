/**
 * Tests for the settlement record the x402 `/settle` path writes.
 *
 * That path broadcasts through x402's own scheme, and for the whole life of the
 * rail it stopped there: the payment landed on chain while no instance ever
 * heard about it, so the dashboard and `/v1/health` showed nothing while money
 * moved. What matters here is that a successful broadcast always leaves the two
 * traces every reader depends on — the seat stamped `settledAt` (the shared
 * pool, and the health count) and the appended row carrying the signature (the
 * settlement log) — and that an already-settled seat is refused *before*
 * anything is broadcast.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { PaymentRequirements } from '@x402/core/types';

import {
  PoolLedger,
  type PaymentIdentity,
  type StoredSettlement,
} from '../packages/derive/src/index.ts';
import { recordSettlement, settleRefusal } from './facilitator-app.ts';
import type { RedisLedgerStore } from './ledger-store.ts';

const ALIAS = 'payee.test';
const SIGNATURE = '35M48fBJEbiFZ4NZuD92zr15G2s8LXTxaZXU2tSyVxZftP5f6NrqQHSFUBb5sUPYsvEf8DhZG1tqrbYEE9qKLedM';
const AT = '2026-10-04T12:00:00.000Z';
const ID: PaymentIdentity = {
  resource: '/v1/oracle/tide',
  payer: 'Payer111111111111111111111111111111111111111',
  nonce: 7,
};

/** A pool with four armed seats under one alias, none consumed. */
function ledgerWith(): PoolLedger {
  const ledger = PoolLedger.empty();
  for (let slot = 0; slot < 4; slot++) {
    ledger.register({
      slot,
      address: `Address${slot}${'x'.repeat(24)}`,
      alias: ALIAS,
      armed: true,
    });
  }
  return ledger;
}

/**
 * An in-memory stand-in for the durable store, recording what was written.
 *
 * The point is the two writes in different places — `save` (the seat map the
 * pool and health read) and `appendSettlement` (the log the dashboard reads) —
 * so the stub counts them rather than merely accepting them.
 */
function fakeStore(initial?: PoolLedger) {
  const settlements: StoredSettlement[] = [];
  let saves = 0;
  const store: RedisLedgerStore = {
    load: async () => initial ?? null,
    save: async () => {
      saves += 1;
    },
    loadSettlements: async () => settlements,
    appendSettlement: async (row) => {
      settlements.push(row);
    },
  };
  return { store, settlements, saves: () => saves };
}

/**
 * The fields this path reads, and nothing else.
 *
 * `PaymentRequirements` has many more fields, but `/settle`'s recording only
 * ever looks at the destination, the price and the resource — so the fixture
 * carries exactly those, and the cast keeps a schema change from breaking a
 * test whose subject is unrelated to the schema.
 */
function requirements(
  payTo: string,
  over: { amount?: string; resource?: string } = {},
): PaymentRequirements {
  return {
    scheme: 'exact-confidential',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    asset: 'H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p',
    payTo,
    maxAmountRequired: over.amount ?? '49000',
    resource: over.resource ?? '/v1/oracle/tide',
  } as unknown as PaymentRequirements;
}

test('a settled payment stamps the seat and appends the row the dashboard reads', async () => {
  const ledger = ledgerWith();
  const seat = ledger.reserve(ALIAS, ID);
  const { store, settlements, saves } = fakeStore(ledger);

  const line = await recordSettlement({
    ledger,
    store,
    // The offer publishes the resource absolute when it knew its origin; every
    // dashboard row is a path, so the origin must be stripped on the way in.
    requirements: requirements(seat.address, {
      resource: 'https://rail.example/v1/oracle/tide',
    }),
    signature: SIGNATURE,
    at: AT,
  });

  assert.match(line, /^recorded /);
  assert.equal(ledger.resolve(seat.address)?.settledAt, AT, 'seat stamped');
  assert.equal(saves(), 1, 'seat map persisted');
  assert.deepEqual(settlements, [
    {
      paymentId: seat.consumedBy,
      alias: ALIAS,
      address: seat.address,
      amount: '49000',
      resource: '/v1/oracle/tide',
      at: AT,
      signature: SIGNATURE,
    },
  ]);
});

test('a payment that never quoted claims the free seat under its settlement identity', async () => {
  const ledger = ledgerWith();
  const address = ledger.allFor()[0]!.address;
  const { store, settlements } = fakeStore(ledger);

  const line = await recordSettlement({
    ledger,
    store,
    requirements: requirements(address),
    signature: SIGNATURE,
    at: AT,
  });

  assert.match(line, /^recorded /);
  const entry = ledger.resolve(address);
  assert.equal(entry?.consumedBy, `settle:${SIGNATURE}`, 'claimed');
  assert.equal(entry?.settledAt, AT, 'stamped');
  assert.equal(settlements[0]?.paymentId, `settle:${SIGNATURE}`);
});

test('an already-settled seat is refused before the broadcast, and a reserved one is not', () => {
  const ledger = ledgerWith();
  const reserved = ledger.reserve(ALIAS, ID);

  // Reserved but not settled: the normal case, and it must pass — every real
  // payment settles into a seat the quote already claimed.
  assert.equal(settleRefusal(ledger, reserved.address), null);
  assert.equal(settleRefusal(ledger, ledger.allFor()[1]!.address), null, 'free seat passes');

  ledger.settle(reserved.address, reserved.consumedBy!, AT);
  const refusal = settleRefusal(ledger, reserved.address);
  assert.ok(refusal, 'a settled seat refuses');
  assert.match(refusal, /^payment-already-settled/);
  assert.match(refusal, new RegExp(AT), 'says when it settled');

  // An address this pool has never heard of is the scheme's to refuse at
  // verify; the seat map alone cannot vouch either way.
  assert.equal(settleRefusal(ledger, 'NotAPoolAddress1111111111111111111111111111'), null);
});

test('re-recording an already-stamped seat never double-stamps and skips the seat-map write', async () => {
  const ledger = ledgerWith();
  const seat = ledger.reserve(ALIAS, ID);
  const { store, saves } = fakeStore(ledger);
  const input = {
    ledger,
    store,
    requirements: requirements(seat.address),
    signature: SIGNATURE,
    at: AT,
  };

  await recordSettlement(input);
  const line = await recordSettlement(input);

  assert.match(line, /seat not stamped/, 'the second stamp is refused');
  assert.match(line, /^recorded /, 'the settlement itself is still reported');
  assert.equal(ledger.resolve(seat.address)?.settledAt, AT, 'settledAt not re-stamped');
  assert.equal(saves(), 1, 'no second seat-map write for a seat that did not change');
});

test('without a store the record stays in this process and nothing throws', async () => {
  const ledger = ledgerWith();
  const address = ledger.allFor()[0]!.address;

  const line = await recordSettlement({
    ledger,
    requirements: requirements(address),
    signature: SIGNATURE,
    at: AT,
  });

  assert.match(line, /no durable store/);
  assert.equal(ledger.resolve(address)?.settledAt, AT, 'the in-memory view still records it');
});
