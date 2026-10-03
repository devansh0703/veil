import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVNET,
  PaymentRequiredError,
  buildPaymentRequired,
  buildRefusal402,
  checkBudget,
  formatAtomic,
  fromAtomic,
  isRefusalCode,
  parsePaymentRequired,
  priceFor,
  refusal,
  toAtomic,
  toX402Requirements,
  VEIL_SCHEME,
  TOKEN_2022_PROGRAM_ADDRESS,
} from './index.ts';

describe('money is exact or it fails', () => {
  test('atomic round-trips at the mint precision', () => {
    assert.equal(toAtomic('247.80', 6), 247_800_000n);
    assert.equal(toAtomic('0.000001', 6), 1n);
    assert.equal(toAtomic('0', 6), 0n);
    assert.equal(fromAtomic(247_800_000n, 6), '247.8');
    assert.equal(fromAtomic(1n, 6), '0.000001');
  });

  test('refuses precision it cannot represent rather than rounding money', () => {
    // 7 decimal places cannot be held at 6dp. Rounding here would silently move
    // a fraction of a cent, which is exactly the class of bug that gets a
    // payment system disqualified.
    assert.throws(() => toAtomic('1.0000001', 6), RangeError);
    assert.throws(() => toAtomic('abc', 6), TypeError);
    assert.throws(() => toAtomic('1.0', -1), RangeError);
  });

  test('formats for a human without losing the decimals a ledger needs', () => {
    assert.equal(formatAtomic(247_800_000n, 6), '$247.800000');
    assert.equal(formatAtomic(1_234_567_890_000n, 6), '$1,234,567.890000');
    assert.equal(formatAtomic(0n, 6), '$0.000000');
  });

  test('prices a call from a base plus measured usage', () => {
    assert.equal(priceFor({ base: '0.01' }, 6), 10_000n);
    assert.equal(priceFor({ base: '0.01', perUnit: '0.0005', units: 20 }, 6), 20_000n);
    assert.equal(priceFor({}, 6), 0n);
    assert.throws(() => priceFor({ perUnit: '0.1', units: -1 }, 6), RangeError);
  });
});

describe('budget guard', () => {
  test('passes a payment inside the declared cap and reports the remainder', () => {
    const verdict = checkBudget(10n, { spendCap: 100n, alreadySpent: 40n });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.remainingAfter, 50n);
  });

  test('refuses with a code when the cap would be exceeded', () => {
    const verdict = checkBudget(10n, { spendCap: 100n, alreadySpent: 95n });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.refusal.code, 'VEIL-CONF-004');
    // The buyer keeps the ability to act on it.
    assert.equal(verdict.ok === false && verdict.refusal.recoverable, true);
  });

  test('a cap of exactly the remaining amount is allowed', () => {
    assert.equal(checkBudget(5n, { spendCap: 5n, alreadySpent: 0n }).ok, true);
  });
});

describe('402 body', () => {
  const base = {
    network: DEVNET,
    asset: 'VeilUSDmint111111111111111111111111111111',
    payTo: 'oneTimeAccount11111111111111111111111111111',
    decimals: 6,
    resource: '/v1/oracle/tide',
    poolIndex: 7,
  } as const;

  test('states what is hidden, so integrators cannot assume the wrong boundary', () => {
    const body = buildPaymentRequired({ ...base, amount: 4_900_000n });
    const accept = body.accepts[0]!;
    assert.deepEqual(accept.extra.hides, ['on-chain-amount', 'on-chain-balance']);
    assert.equal(accept.extra.privacy, 'confidential-balances');
    assert.equal(accept.scheme, VEIL_SCHEME);
    assert.equal(accept.extra.tokenProgram, TOKEN_2022_PROGRAM_ADDRESS);
    assert.equal(accept.maxAmountRequired, '4900000');
  });

  test('round-trips through JSON without losing the atomic amount', () => {
    const body = buildPaymentRequired({ ...base, amount: 4_900_000n });
    const parsed = parsePaymentRequired(JSON.parse(JSON.stringify(body)));
    assert.equal(parsed.accepts[0]!.maxAmountRequired, '4900000');
    assert.equal(parsed.accepts[0]!.extra.poolIndex, 7);
  });

  test('refuses a non-positive price', () => {
    assert.throws(() => buildPaymentRequired({ ...base, amount: 0n }), RangeError);
  });

  test('rejects an offer whose privacy claim it cannot check', () => {
    const body = buildPaymentRequired({ ...base, amount: 1n });
    const mangled = JSON.parse(JSON.stringify(body));
    mangled.accepts[0].extra.privacy = 'trust-me';
    assert.throws(() => parsePaymentRequired(mangled), PaymentRequiredError);
  });

  test('rejects a foreign scheme or a mismatched version', () => {
    const body = buildPaymentRequired({ ...base, amount: 1n });
    const wrongScheme = JSON.parse(JSON.stringify(body));
    wrongScheme.accepts[0].scheme = 'exact';
    assert.throws(() => parsePaymentRequired(wrongScheme), /scheme must be/);

    const wrongVersion = JSON.parse(JSON.stringify(body));
    wrongVersion.x402Version = 1;
    assert.throws(() => parsePaymentRequired(wrongVersion), /x402Version/);
  });

  test('rejects a non-integer atomic amount rather than coercing it', () => {
    const body = buildPaymentRequired({ ...base, amount: 1n });
    const mangled = JSON.parse(JSON.stringify(body));
    // Both names for the price, because the body carries both and a mangled one
    // has to disagree with nothing — the integer check is what is under test.
    mangled.accepts[0].maxAmountRequired = '4.9';
    mangled.accepts[0].amount = '4.9';
    assert.throws(() => parsePaymentRequired(mangled), /integer string/);

    // And a body whose two price fields contradict each other is refused before
    // the value is even looked at.
    const contradictory = JSON.parse(JSON.stringify(body));
    contradictory.accepts[0].amount = '49001';
    assert.throws(() => parsePaymentRequired(contradictory), /two different prices/);
  });

  test('a refusal body carries the code the caller must act on', () => {
    const body = buildRefusal402('VEIL-CONF-003', { ...base, decimals: 6 });
    assert.equal(body.veil?.refused, 'VEIL-CONF-003');
    assert.equal(body.accepts.length, 0);
    const parsed = parsePaymentRequired(JSON.parse(JSON.stringify(body)));
    assert.equal(parsed.veil?.refused, 'VEIL-CONF-003');
    assert.match(parsed.veil!.remedy, /never downgrades/);
  });

  test('VEIL-CONF-003 is not recoverable: it is a refusal, not a retry hint', () => {
    const r = refusal('VEIL-CONF-003');
    assert.equal(r.recoverable, false);
    assert.ok(isRefusalCode('VEIL-CONF-003'));
    assert.equal(isRefusalCode('NOT-A-CODE'), false);
  });

  test('adapts to x402 requirements at exactly one seam', () => {
    const accept = buildPaymentRequired({ ...base, amount: 1n }).accepts[0]!;
    const req = toX402Requirements(accept);
    assert.equal(req.scheme, accept.scheme);
    assert.equal(req.maxAmountRequired, accept.maxAmountRequired);
    assert.equal(req.payTo, accept.payTo);
  });
});
