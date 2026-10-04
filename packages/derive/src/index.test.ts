import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PoolExhaustedError,
  PoolLedger,
  derivePaymentId,
  deriveSlot,
  type PaymentIdentity,
} from './index.ts';

describe('payment identity', () => {
  test('is stable for the same inputs', () => {
    const id: PaymentIdentity = { resource: '/v1/quote', payer: 'BuyerA', nonce: 1 };
    assert.equal(derivePaymentId(id), derivePaymentId({ ...id }));
    assert.match(derivePaymentId(id), /^[0-9a-f]{64}$/);
  });

  test('field lengths are delimited, so strings cannot be slid across fields', () => {
    // Without length prefixes these two would concatenate identically and two
    // different payments would share an identity.
    const a = derivePaymentId({ resource: 'ab', payer: 'c', nonce: 0 });
    const b = derivePaymentId({ resource: 'a', payer: 'bc', nonce: 0 });
    assert.notEqual(a, b);
  });

  test('nonzero nonce changes the identity', () => {
    const base = { resource: '/v1/quote', payer: 'BuyerA' };
    assert.notEqual(
      derivePaymentId({ ...base, nonce: 0 }),
      derivePaymentId({ ...base, nonce: 1 }),
    );
  });
});

describe('slot derivation (AR8: both sides agree without coordination)', () => {
  const id: PaymentIdentity = { resource: '/v1/quote', payer: 'BuyerA', nonce: 3 };

  test('the payer and the merchant independently compute the same slot', () => {
    // This is the agreement property. Two independent call sites, same answer.
    const payerSide = deriveSlot(id, 32);
    const merchantSide = deriveSlot({ ...id }, 32);
    assert.equal(payerSide, merchantSide);
  });

  test('stays inside the pool', () => {
    for (let nonce = 0; nonce < 500; nonce++) {
      const slot = deriveSlot({ ...id, nonce }, 16);
      assert.ok(slot >= 0 && slot < 16, `slot ${slot} out of range`);
    }
  });

  test('spreads across the pool instead of clustering on one slot', () => {
    const counts = new Array(16).fill(0);
    for (let nonce = 0; nonce < 4_000; nonce++) {
      counts[deriveSlot({ ...id, nonce }, 16)]++;
    }
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    // A correct power-of-two modulo on a 32-bit digest is within a few percent.
    // A clustering bug would show up here as a near-empty bucket.
    assert.ok(min > 150, `most-ignored slot got ${min} of 4000`);
    assert.ok(max < 400, `busiest slot got ${max} of 4000`);
  });

  test('refuses a non-power-of-two pool rather than skewing the distribution', () => {
    assert.throws(() => deriveSlot(id, 10), /power of two/);
    assert.throws(() => deriveSlot(id, 0), /positive integer/);
  });
});

describe('pool ledger', () => {
  function ledgerOf(n: number, alias = 'merchant.tide'): PoolLedger {
    const l = PoolLedger.empty();
    for (let i = 0; i < n; i++) {
      l.register({ slot: i, address: `acct${i}`, alias, armed: true });
    }
    return l;
  }

  test('resolves an incoming destination back to its merchant', () => {
    const l = ledgerOf(8);
    assert.equal(l.aliasFor('acct3'), 'merchant.tide');
    assert.equal(l.resolve('acct3')?.slot, 3);
    assert.equal(l.resolve('nobody'), undefined);
  });

  test('reserving consumes exactly one account and records which payment took it', () => {
    const l = ledgerOf(8);
    const id = { resource: '/v1/quote', payer: 'BuyerA', nonce: 1 };
    const entry = l.reserve('merchant.tide', id);
    assert.equal(entry.consumedBy, derivePaymentId(id));
    assert.equal(l.armedFor('merchant.tide').length, 7);
    // Two payments must never share a destination.
    const second = l.reserve('merchant.tide', { ...id, nonce: 2 });
    assert.notEqual(second.address, entry.address);
  });

  test('refuses when the pool is exhausted instead of reusing an address', () => {
    const l = ledgerOf(4);
    for (let i = 0; i < 4; i++) {
      l.reserve('merchant.tide', { resource: '/r', payer: 'B', nonce: i });
    }
    assert.throws(
      () => l.reserve('merchant.tide', { resource: '/r', payer: 'B', nonce: 99 }),
      PoolExhaustedError,
    );
    // Reusing one would relink two payments on the public graph, so this error
    // is the privacy guarantee doing its job.
    try {
      l.reserve('merchant.tide', { resource: '/r', payer: 'B', nonce: 100 });
    } catch (e) {
      assert.equal((e as PoolExhaustedError).code, 'VEIL-CONF-005');
    }
  });

  test('an exhausted pool still returns the seat its own payment already holds', () => {
    const l = ledgerOf(1);
    const id = { resource: '/r', payer: 'B', nonce: 3 };
    const only = l.reserve('merchant.tide', id);
    assert.throws(
      () => l.reserve('merchant.tide', { ...id, nonce: 4 }),
      PoolExhaustedError,
    );
    // Re-quoting the payment that holds the last seat is not a new payment:
    // it must get its own account back rather than a VEIL-CONF-005 refusal.
    const retry = l.reserve('merchant.tide', id);
    assert.equal(retry.address, only.address);
    assert.equal(l.armedFor('merchant.tide').length, 0, 'no second seat was burned');
  });

  test('entryFor reports the seat an identity holds, before and after settle', () => {
    const l = ledgerOf(2);
    const id = { resource: '/r', payer: 'B', nonce: 0 };
    assert.equal(l.entryFor('merchant.tide', id), null, 'nothing before a reservation');
    const held = l.reserve('merchant.tide', id);
    const found = l.entryFor('merchant.tide', id);
    assert.equal(found?.address, held.address);
    assert.equal(found?.settledAt, undefined);
    l.settle(held.address, derivePaymentId(id), '2026-01-01T00:00:00Z');
    assert.equal(
      l.entryFor('merchant.tide', id)?.settledAt,
      '2026-01-01T00:00:00Z',
      'a caller must be able to tell a spent identity from a free pool',
    );
    // Read-only: the lookup cannot consume a seat for a payment that never
    // reserved one.
    assert.equal(l.entryFor('merchant.tide', { ...id, nonce: 9 }), null);
  });

  test('rejects a duplicate address, which would make two aliases linkable', () => {
    const l = PoolLedger.empty();
    l.register({ slot: 0, address: 'same', alias: 'a', armed: true });
    assert.throws(
      () => l.register({ slot: 1, address: 'same', alias: 'b', armed: true }),
      /already registered/,
    );
  });

  test('rejects a duplicate slot', () => {
    const l = PoolLedger.empty();
    l.register({ slot: 0, address: 'x', alias: 'a', armed: true });
    assert.throws(
      () => l.register({ slot: 0, address: 'y', alias: 'a', armed: true }),
      /already occupied/,
    );
  });

  test('survives a JSON round trip and re-checks its invariants on load', () => {
    const l = ledgerOf(8);
    l.reserve('merchant.tide', { resource: '/r', payer: 'B', nonce: 1 });
    const revived = PoolLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
    assert.equal(revived.size, 8);
    assert.equal(revived.allFor('merchant.tide').length, 8);
    assert.equal(revived.armedFor('merchant.tide').length, 7);
  });

  test('a hand-edited ledger that claims an unarmed slot settled is rejected on load', () => {
    const poisoned = [
      { slot: 0, address: 'a', alias: 'm', armed: false, consumedBy: 'deadbeef' },
    ];
    assert.throws(() => PoolLedger.fromJSON(poisoned), /not armed/);
  });

  test('settling stamps the time and never frees the address for reuse', () => {
    const l = ledgerOf(2);
    const id = { resource: '/r', payer: 'B', nonce: 1 };
    const entry = l.reserve('merchant.tide', id);
    l.settle(entry.address, derivePaymentId(id), '2026-10-02T10:00:00Z');

    const after = l.resolve(entry.address)!;
    assert.equal(after.settledAt, '2026-10-02T10:00:00Z');
    // The account stays consumed. Re-arming it would let a second payment reuse a
    // destination that already has history, relinking the two on the public graph.
    assert.equal(after.consumedBy, derivePaymentId(id));
    assert.ok(
      !l.armedFor('merchant.tide').some((e) => e.address === entry.address),
      'a settled address must not be offered again',
    );
    assert.equal(l.armedFor('merchant.tide').length, 1);
  });

  test('settling an account that was never reserved is rejected', () => {
    const l = ledgerOf(2);
    assert.throws(
      () => l.settle('acct1', 'somepayment', '2026-10-02T10:00:00Z'),
      /never reserved/,
    );
  });

  test('settling the same account twice is rejected, so a retry cannot double-count', () => {
    const l = ledgerOf(2);
    const id = { resource: '/r', payer: 'B', nonce: 1 };
    const entry = l.reserve('merchant.tide', id);
    l.settle(entry.address, derivePaymentId(id), '2026-10-02T10:00:00Z');
    assert.throws(
      () => l.settle(entry.address, derivePaymentId(id), '2026-10-02T11:00:00Z'),
      /already settled/,
    );
    // The original stamp survives the rejected retry.
    assert.equal(l.resolve(entry.address)!.settledAt, '2026-10-02T10:00:00Z');
  });

  test('settleable decides without mutating, so a broadcast can be gated on it', () => {
    const l = ledgerOf(2);
    const id = { resource: '/r', payer: 'B', nonce: 1 };
    const entry = l.reserve('merchant.tide', id);

    // A payment nobody reserved is refused before anything is sent.
    assert.throws(() => l.settleable('acct1', 'somepayment'), /never reserved/);

    // A legitimate payment passes, and checking left the ledger untouched —
    // that is what makes check-before-broadcast safe to do.
    l.settleable(entry.address, derivePaymentId(id));
    assert.equal(l.resolve(entry.address)!.settledAt, undefined);
  });

  test('claim adopts a free seat so a hosted settle that missed the quote still lands', () => {
    // The quote ran on one instance and reserved nothing this one can see; the
    // payment then arrives here. The seat is still free, so it may be claimed —
    // otherwise the rail would take the money and record nothing.
    const l = ledgerOf(2);
    l.claim('acct1', 'payment-from-another-instance');
    assert.equal(l.resolve('acct1')!.consumedBy, 'payment-from-another-instance');
    // Claiming is idempotent for the payment that owns the seat.
    l.claim('acct1', 'payment-from-another-instance');
    assert.equal(l.resolve('acct1')!.consumedBy, 'payment-from-another-instance');
  });

  test('claim refuses a seat a different payment already owns', () => {
    // Two payments into one one-time address is the relinking the pool exists to
    // prevent, so this is the one case where refusing is the right answer.
    const l = ledgerOf(2);
    const id = { resource: '/r', payer: 'B', nonce: 1 };
    const entry = l.reserve('merchant.tide', id);
    assert.throws(
      () => l.claim(entry.address, 'a-second-payment'),
      /was consumed by/,
    );
    assert.equal(l.resolve(entry.address)!.consumedBy, derivePaymentId(id));
  });

  test('claim refuses an unarmed seat rather than quietly handing it out', () => {
    const l = PoolLedger.empty();
    l.register({ slot: 0, address: 'acct0', alias: 'merchant.tide', armed: false });
    assert.throws(() => l.claim('acct0', 'somepayment'), /not armed/);
    assert.equal(l.resolve('acct0')!.consumedBy, null);
  });
});
