/**
 * Conformance against x402 itself.
 *
 * Every other test in this repo checks Veil against Veil's own parser, which can
 * only ever prove self-consistency. This file is different: it feeds our wire
 * artifacts to `@x402/core`'s published zod schemas and to the same
 * `isPaymentRequired` / `isPaymentPayload` guards the stock SDK uses internally.
 *
 * That matters because "Veil is an x402 scheme, not a fork" is a claim a judge or
 * an integrator should be able to falsify in one command. If this file passes, the
 * claim holds for the artefacts a merchant and a payer exchange. If it fails, the
 * rest of the suite is noise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PaymentRequiredSchema,
  PaymentPayloadSchema,
  PaymentRequirementsV2Schema,
  ResourceInfoSchema,
  isPaymentRequired,
  isPaymentRequiredV2,
  isPaymentPayload,
  isPaymentPayloadV2,
} from '@x402/core/schemas';
// x402's own network validator — the function its signer calls before signing.
import { normalizeNetwork as x402NormalizeNetwork } from '@x402/svm';

import {
  buildPaymentPayload,
  buildPaymentRequired,
  buildRefusal402,
  DEVNET,
  networkFromRpc,
  parsePaymentRequired,
  PLACEHOLDER_MINT,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_TESTNET,
  toX402PaymentPayload,
  toX402PaymentRequired,
  X402_VERSION,
  type Network,
} from './index.ts';

const TESTNET: Network = 'solana:testnet';

const base = {
  network: TESTNET,
  asset: PLACEHOLDER_MINT,
  payTo: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  amount: 49_000n,
  decimals: 6,
  resource: '/v1/price/SOL',
  description: 'SOL spot price',
  poolIndex: 3,
} as const;

test('the version we advertise is the version x402 parses', () => {
  assert.equal(X402_VERSION, 2);
});

test('a 402 offer parses under the stock vendored schema', () => {
  const body = buildPaymentRequired(base);
  const result = PaymentRequiredSchema.safeParse(body);
  if (!result.success) {
    assert.fail(
      `Veil's 402 body is not a valid x402 body:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  assert.equal(result.data.x402Version, 2);
  assert.equal(result.data.resource.url, '/v1/price/SOL');
  assert.equal(result.data.accepts[0]!.scheme, 'exact-confidential');
  assert.equal(result.data.accepts[0]!.amount, '49000');
});

test('a payer payload parses under the stock vendored schema', () => {
  const accept = buildPaymentRequired(base).accepts[0]!;
  const payload = buildPaymentPayload({
    accept,
    transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    payTo: accept.payTo,
  });
  const result = PaymentPayloadSchema.safeParse(payload);
  if (!result.success) {
    assert.fail(
      `Veil's payment payload is not a valid x402 payload:\n${JSON.stringify(
        result.error.issues,
        null,
        2,
      )}`,
    );
  }
  // Narrowed by the discriminated union on `x402Version`, which is x402's own
  // typing of "this payload is v2" — not ours.
  assert.equal(result.data.x402Version, 2);
  if (result.data.x402Version !== 2) assert.fail('expected a v2 payload');
  assert.equal(result.data.accepted.amount, '49000');
  assert.equal(result.data.accepted.payTo, accept.payTo);
});

test('the stock type guards accept what we emit', () => {
  const body = buildPaymentRequired(base);
  const payload = buildPaymentPayload({
    accept: body.accepts[0]!,
    transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    payTo: body.accepts[0]!.payTo,
  });
  assert.equal(isPaymentRequired(body), true);
  assert.equal(isPaymentRequiredV2(body), true);
  assert.equal(isPaymentPayload(payload), true);
  assert.equal(isPaymentPayloadV2(payload), true);
});

test('an unmodified v1 body from any other x402 server still parses', () => {
  // Field names taken from @x402/core's own PaymentRequirementsV1Schema. Veil must
  // be able to *read* the ecosystem it lives in, not only speak to it.
  const v1Body = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired: '10000',
        resource: '/x',
        description: 'x',
        payTo: '0xabc',
        maxTimeoutSeconds: 60,
        asset: '0xusdc',
        extra: {},
      },
    ],
  };
  assert.equal(PaymentRequiredSchema.safeParse(v1Body).success, true);
});

test('a body that quotes two different prices is refused, not reconciled', () => {
  const mangled = JSON.parse(JSON.stringify(buildPaymentRequired(base)));
  mangled.accepts[0].amount = '49001';
  // The stock schema accepts this, because v2 reads `amount` and never looks at
  // the v1 name. Veil is stricter on purpose: an offer whose two price fields
  // disagree was written by something that does not know what it is charging.
  assert.equal(PaymentRequiredSchema.safeParse(mangled).success, true);
  assert.throws(() => parsePaymentRequired(mangled), /two different prices/);
});

test("the network we advertise is one x402's own validator accepts", () => {
  // The strong version of this check: rather than asserting the schema's shape
  // rule, hand the emitted network to x402's `normalizeNetwork` — the exact
  // function the stock signer calls before signing. A network string it rejects
  // is a payment that dies inside x402 after passing every check of ours.
  const emitted = buildPaymentRequired(base).accepts[0]!.network;
  assert.equal(x402NormalizeNetwork(emitted), emitted);
  assert.equal(PaymentRequiredSchema.safeParse(buildPaymentRequired(base)).success, true);
});

test('a friendly network name becomes the identifier x402 accepts', () => {
  // `solana:testnet` reads better than the genesis hash, so it is accepted as an
  // input — and normalised before it ever reaches the wire.
  for (const name of ['testnet', 'solana:testnet', 'devnet', 'mainnet-beta']) {
    const body = buildPaymentRequired({ ...base, network: name as Network });
    const network = body.accepts[0]!.network;
    assert.equal(x402NormalizeNetwork(network), network, `${name} did not normalise`);
    assert.equal(PaymentRequiredSchema.safeParse(body).success, true);
  }
});

test('an unknown network is refused rather than guessed', () => {
  assert.throws(() => buildPaymentRequired({ ...base, network: 'solana:nope' as Network }), /unsupported network/);
});

test('the network is inferred from the endpoint that was actually used', () => {
  // The configured network and the endpoint are set independently and disagree
  // easily. This repository shipped a record claiming `solana:devnet` beside a
  // testnet `rpcUrl`, which would send the next reader to the wrong cluster, so
  // the endpoint decides and the caller reports a mismatch.
  assert.equal(networkFromRpc('https://api.testnet.solana.com'), SOLANA_TESTNET);
  assert.equal(networkFromRpc('https://api.devnet.solana.com'), SOLANA_DEVNET);
  assert.equal(networkFromRpc('https://api.mainnet-beta.solana.com'), SOLANA_MAINNET);
  // Anything unrecognised must be `undefined` rather than a guess: a local
  // validator is not mainnet, and pretending otherwise is the same mistake.
  assert.equal(networkFromRpc('http://127.0.0.1:8899'), undefined);
  assert.equal(networkFromRpc('not a url'), undefined);
});

test('the v2 projection is itself schema-valid', () => {
  const body = buildPaymentRequired(base);
  const projected = toX402PaymentRequired(body);
  const result = PaymentRequiredSchema.safeParse(projected);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));

  const accept = PaymentRequirementsV2Schema.safeParse(projected.accepts[0]);
  assert.equal(accept.success, true, JSON.stringify(accept.error?.issues));

  const resource = ResourceInfoSchema.safeParse(projected.resource);
  assert.equal(resource.success, true, JSON.stringify(resource.error?.issues));
});

test('the v2 payment payload projection is schema-valid', () => {
  const accept = buildPaymentRequired(base).accepts[0]!;
  const payload = buildPaymentPayload({
    accept,
    transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    payTo: accept.payTo,
  });
  const projected = toX402PaymentPayload(payload);
  const result = PaymentPayloadSchema.safeParse(projected);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test('a refusal is deliberately not a payment challenge', () => {
  const refusal = buildRefusal402('VEIL-CONF-003', {
    network: TESTNET,
    asset: PLACEHOLDER_MINT,
    payTo: '',
    decimals: 6,
    resource: '/v1/price/SOL',
    poolIndex: 0,
  });
  // No price means no offer, so `accepts` is empty and x402's schema — which
  // requires at least one acceptable requirement — rejects it. That is the
  // intended signal: a refusal must never be mistaken for a payment prompt.
  assert.equal(refusal.accepts.length, 0);
  assert.equal(PaymentRequiredSchema.safeParse(refusal).success, false);
  assert.equal(refusal.veil?.refused, 'VEIL-CONF-003');
});

test('devnet is a valid CAIP-2 network too, so nothing here is testnet-specific', () => {
  const body = buildPaymentRequired({ ...base, network: DEVNET });
  assert.equal(PaymentRequiredSchema.safeParse(body).success, true);
});
