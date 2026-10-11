/**
 * The hardening suite: the tests that try to make Veil settle in public.
 *
 * These are the enforcement proofs for the claims the product makes, and each one
 * is written to *fail* if the corresponding check is removed:
 *
 *   - D-6 / F4 — a payer hands over a real transaction containing a plain,
 *     public transfer. The rail must refuse, the refusal must be a named one, and
 *     the `confidential_assertion_failures` counter must move — because the
 *     counter is the number the product says it will not trade away, and a claim
 *     nobody can read is not a check.
 *   - F7 — a payment captured for one resource, replayed against another. The
 *     seat ledger stops the same payment being *credited* twice; only the
 *     resource binding stops it being *spent* somewhere it was never signed for.
 *   - F8 — cache hygiene on paid responses (arXiv 2605.11781's live result:
 *     paid content leaked through misconfigured caches).
 *   - F3 — the x402 V2 headers, alongside the V1 ones.
 *
 * The rail here is deliberately minimal: a pool of real addresses, no durable
 * store, and `rpcUrl` set to an endpoint that is never contacted. Pointing at an
 * unroutable RPC is the honest way to isolate the *reading* from the *broadcast*:
 * every refusal below happens before any network call, and the suite would time
 * out rather than pass if the rail tried to broadcast something it should have
 * refused.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';

import { DEVNET, PLACEHOLDER_MINT, TOKEN_2022_PROGRAM_ADDRESS } from '../../x402-core/src/index.ts';
import { buildConfidentialTransfer } from '../../onchain/src/index.ts';
import { PoolLedger } from '../../derive/src/index.ts';
import {
  createFacilitator,
  createVeilServer,
  poolLedgerProbe,
  type ResourceDefinition,
  type ServerConfig,
} from './index.ts';

const MINT = PLACEHOLDER_MINT;
const FEE_PAYER = '3RWhpyX2JaE89UWqxM8LRsB3xykSVwHyEvBmgdo9N1FJ' as Address;
const SOURCE_TOKEN = '8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21' as Address;
const PAYER_AUTHORITY = 'Ep1X1BnzWk3u5tgbFUSi2xHiym8CbnmraJZaPVxhGpcR' as Address;
const PLACEHOLDER_SIGNATURE_BYTES = new Uint8Array(64).fill(7) as never;

/** Eight seats for one merchant alias: enough that no test exhausts the pool. */
const SEATS = [
  'FQAN6AmfJXKoXUa9KC3AQxCpXMi1Fv5121spDrGBRDJW',
  '27BPmc5bjmF7kUp4WRXfaCBsv9jXfU9pskoTmmuSwWob',
  '64jdda3xnLRBEh7UwvpNNZct8AxsMYECsMtek9UzPZTr',
  '24gxra9g5FYMJ1oYojtx1kPDKzxTkvcCHrpz3ifhFMnC',
  '5zpSByi2G1u5nRiRNwgi3WHp1Mg2p932gJqddiUoA4oA',
  'EUzJYZrACF3SNmipA5VEkAtjFFEYz2YdHjtdxFFP34Ds',
  'BP2H1EtEmNvg9FPaNwGqgG4SvpuMqLwjFbt5u62WLFsg',
  '5qmTqPBMn7kGJ9hXukVb7TTpz82x2vpkNc6NA2ZsGtKQ',
];

function wireFrom(instructions: readonly Instruction[]): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const compiled = compileTransaction(message);
  return getBase64EncodedWireTransaction({
    ...compiled,
    signatures: { [FEE_PAYER]: PLACEHOLDER_SIGNATURE_BYTES },
  });
}

/** A genuine confidential transfer to `destination`. */
function confidentialWire(destination: string): string {
  return wireFrom(
    buildConfidentialTransfer({
      sourceToken: SOURCE_TOKEN,
      mint: MINT as unknown as Address,
      destinationToken: destination as Address,
      authority: { address: PAYER_AUTHORITY } as never,
      newSourceDecryptableAvailableBalance: new Uint8Array(36),
    }),
  );
}

/**
 * The hostile payment: a plain, public Token-2022 `Transfer` to a real seat.
 *
 * Structurally the same transaction as a confidential one — same payer, same fee
 * payer, same destination, same mint — and different in exactly the one way that
 * matters: the amount is in the clear and the chain will never verify a proof for
 * it.
 */
function publicTransferWire(destination: string): string {
  const instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [
      { address: SOURCE_TOKEN, role: 1 },
      { address: MINT, role: 0 },
      { address: destination, role: 1 },
      // Read-only and not a signer. The reading under test is "does this
      // transaction contain a confidential transfer", and an extra required
      // signature would make the wire undecodable for a boring reason — which
      // would let the test pass without the check actually running.
      { address: PAYER_AUTHORITY, role: 0 },
    ],
    data: new Uint8Array([3, 0xe8, 0x03, 0, 0, 0, 0, 0, 0, 0]),
  } as unknown as Instruction;
  return wireFrom([instruction]);
}

/** A payment header naming `seat`, bound to `resource`. */
function paymentHeader(input: {
  readonly seat: string;
  readonly resource: string;
  readonly transaction?: string;
  readonly amount?: string;
}): string {
  const accept = {
    scheme: 'exact-confidential',
    network: DEVNET,
    asset: MINT,
    payTo: input.seat,
    maxAmountRequired: input.amount ?? '49000',
    amount: input.amount ?? '49000',
    resource: input.resource,
    maxTimeoutSeconds: 60,
    extra: { privacy: 'confidential-balances', decimals: 6, poolIndex: 0, hides: [] },
  };
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: 'exact-confidential',
      network: DEVNET,
      accepted: accept,
      payload: {
        transaction: input.transaction ?? confidentialWire(input.seat),
        payTo: input.seat,
        asset: MINT,
      },
    }),
    'utf8',
  ).toString('base64');
}

interface Rail {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * A rail for the hardening tests.
 *
 * Defaults to the chain-free protocol mode, where a settled payment is an
 * accounting record and every receipt says so. `withRpc` is for the tests that
 * exist precisely because the mode changes the *consequence* of an unreadable
 * transaction — on a rail that can broadcast, `'unknown'` is a refusal.
 */
async function rail(options: { readonly withRpc?: boolean; readonly withPrivacy?: boolean } = {}): Promise<Rail> {
  const scratchRoot = fileURLToPath(new URL('../../../data/test/', import.meta.url));
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot, 'hardening-'));

  const ledger = PoolLedger.empty();
  SEATS.forEach((address, slot) => ledger.register({ slot, address, alias: 'm', armed: true }));

  const resources: readonly ResourceDefinition[] = [
    { path: '/t/data', alias: 'm', description: 'first resource', base: '0.049', produce: () => ({ served: '/t/data' }) },
    // A second endpoint owned by the *same* merchant: the replay scenario the
    // resource binding exists for is one merchant's payment being spent at
    // another of its own endpoints, which attribution alone cannot catch.
    { path: '/t/other', alias: 'm', description: 'second resource', base: '0.049', produce: () => ({ served: '/t/other' }) },
  ];

  const config: ServerConfig = {
    network: DEVNET,
    mint: MINT,
    decimals: 6,
    ledgerPath: join(dir, 'ledger.json'),
    resources,
    allowLocalSettlement: true,
    // Never contacted, and only set by the tests that need the broadcast path to
    // be *possible*: a refusal happens before any network call, so a wire that
    // reached this URL would hang the test rather than pass it.
    ...(options.withRpc === true ? { rpcUrl: 'http://127.0.0.1:1' } : {}),
    ...(options.withPrivacy === false
      ? {}
      : { privacy: poolLedgerProbe(ledger, true), privacySource: 'pool-ledger' as const }),
  };

  const facilitator = createFacilitator(config, ledger);
  const server = createVeilServer(config, facilitator);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function offered(url: string, path: string, payer = 'buyer1'): Promise<string> {
  const res = await fetch(`${url}${path}`, { headers: { 'x-payer': payer } });
  assert.equal(res.status, 402, `expected a quote for ${path}`);
  const body = (await res.json()) as { accepts: { payTo: string }[] };
  return body.accepts[0]!.payTo;
}

async function metricsOf(url: string): Promise<{
  confidential_assertion_failures: number;
  settlements: number;
  broadcasts: number;
}> {
  const res = await fetch(`${url}/api/ledger`);
  const body = (await res.json()) as {
    metrics: { confidential_assertion_failures: number; settlements: number; broadcasts: number };
  };
  return body.metrics;
}

// ---------------------------------------------------------------------------
// D-6 — the enforcement proof
// ---------------------------------------------------------------------------

describe('a public transfer is refused, and the refusal is counted', () => {
  test('a real transaction with a plain Transfer is refused as VEIL-CONF-008', async () => {
    const h = await rail();
    try {
      const seat = await offered(h.url, '/t/data');
      const res = await fetch(`${h.url}/t/data`, {
        headers: {
          'x-payer': 'buyer1',
          'x-payment': paymentHeader({ seat, resource: '/t/data', transaction: publicTransferWire(seat) }),
        },
      });
      assert.equal(res.status, 402);
      const body = (await res.json()) as {
        error: string;
        detail: string;
        refusal?: { code: string; title: string; remedy: string };
      };
      assert.equal(body.error, 'invalid-payment');
      assert.equal(body.refusal?.code, 'VEIL-CONF-008');
      assert.match(body.detail, /no Token-2022 confidential transfer instruction/);
      // The refusal explains what the payer can do, because the alternative is a
      // payer retrying the same broken client forever.
      assert.match(body.refusal?.remedy ?? '', /confidential transfer/);

      // The number the product says it will not trade away.
      const metrics = await metricsOf(h.url);
      assert.equal(metrics.confidential_assertion_failures, 1);
      assert.equal(metrics.settlements, 0, 'nothing settled');
      assert.equal(metrics.broadcasts, 0, 'nothing was broadcast');
    } finally {
      await h.close();
    }
  });

  test('a transaction the rail cannot read is refused when a chain settlement is possible', async () => {
    const h = await rail({ withRpc: true });
    try {
      const seat = await offered(h.url, '/t/data');
      const res = await fetch(`${h.url}/t/data`, {
        headers: {
          'x-payer': 'buyer1',
          // Valid base64, not a transaction. `'unknown'` is never a pass on a
          // rail that is about to broadcast.
          'x-payment': paymentHeader({ seat, resource: '/t/data', transaction: 'AQIDBA==' }),
        },
      });
      assert.equal(res.status, 402);
      const body = (await res.json()) as { refusal?: { code: string }; detail: string };
      assert.equal(body.refusal?.code, 'VEIL-CONF-008');
      assert.match(body.detail, /could not be decoded/);
      assert.equal((await metricsOf(h.url)).confidential_assertion_failures, 1);
    } finally {
      await h.close();
    }
  });

  test('the same unreadable bytes are accepted on a chain-free rail, which reports itself as such', async () => {
    // Not a loophole: a rail with no chain cannot move money, so it claims no
    // chain fact about placeholder bytes — and it says `local-ledger-only`
    // everywhere it is asked. This test exists so that distinction cannot be
    // quietly turned into a silent pass on a rail that *can* settle: the test
    // above is the same bytes on a rail that can.
    const h = await rail();
    try {
      const seat = await offered(h.url, '/t/data');
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ seat, resource: '/t/data', transaction: 'AQIDBA==' }) },
      });
      // It is served, and the settlement says exactly what it is.
      assert.equal(res.status, 200);
      const body = (await res.json()) as { settled: { signature: string | null } };
      assert.equal(body.settled.signature, null, 'no chain fact is claimed');

      const health = (await (await fetch(`${h.url}/v1/health`)).json()) as { settlement: string };
      assert.equal(health.settlement, 'local-ledger-only');
    } finally {
      await h.close();
    }
  });

  test('a precondition the deployment cannot check is a refusal, not an assumption', async () => {
    const h = await rail({ withPrivacy: false });
    try {
      const res = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'buyer1' } });
      assert.equal(res.status, 402);
      const body = (await res.json()) as { veil?: { refused: string } };
      assert.equal(body.veil?.refused, 'VEIL-CONF-003');
      assert.equal((await metricsOf(h.url)).confidential_assertion_failures, 1);
    } finally {
      await h.close();
    }
  });

  test('a budget refusal is not a confidentiality assertion failure', async () => {
    // The counter has to mean one thing. If it counted every refusal, it would
    // report alarming numbers on a healthy rail and stop being evidence.
    const scratchRoot = fileURLToPath(new URL('../../../data/test/', import.meta.url));
    await mkdir(scratchRoot, { recursive: true });
    const dir = await mkdtemp(join(scratchRoot, 'budget-'));
    const ledger = PoolLedger.empty();
    SEATS.forEach((address, slot) => ledger.register({ slot, address, alias: 'm', armed: true }));
    const config: ServerConfig = {
      network: DEVNET,
      mint: MINT,
      decimals: 6,
      ledgerPath: join(dir, 'ledger.json'),
      resources: [{ path: '/t/data', alias: 'm', description: 'x', base: '0.049', produce: () => ({}) }],
      spendCap: '0.010',
      allowLocalSettlement: true,
      privacy: poolLedgerProbe(ledger, true),
      privacySource: 'pool-ledger',
    };
    const server = createVeilServer(config, createFacilitator(config, ledger));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${url}/t/data`, { headers: { 'x-payer': 'buyer1' } });
      assert.equal(res.status, 402);
      assert.equal(((await res.json()) as { veil?: { refused: string } }).veil?.refused, 'VEIL-CONF-004');
      assert.equal((await metricsOf(url)).confidential_assertion_failures, 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F7 — resource binding and replay
// ---------------------------------------------------------------------------

describe('a payment is bound to the resource it was signed for', () => {
  test('a payment captured for one resource is refused at another', async () => {
    const h = await rail();
    try {
      const seat = await offered(h.url, '/t/data');
      const captured = paymentHeader({ seat, resource: '/t/data' });

      // Same payment, different endpoint. The seat ledger alone would allow this
      // — it is a different payment identity, so it is a different seat — and the
      // attribution check cannot catch it either, because both endpoints belong to
      // the same merchant.
      const replayed = await fetch(`${h.url}/t/other`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': captured },
      });
      assert.equal(replayed.status, 402);
      const body = (await replayed.json()) as { refusal?: { code: string }; detail: string };
      assert.equal(body.refusal?.code, 'VEIL-CONF-007');
      assert.match(body.detail, /bound to \/t\/data/);
    } finally {
      await h.close();
    }
  });

  test('the payment it was signed for is served, with an idempotency key', async () => {
    const h = await rail();
    try {
      const seat = await offered(h.url, '/t/data');
      const header = paymentHeader({ seat, resource: '/t/data' });
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': header },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { paid: boolean; settled: { seat: string } };
      assert.equal(body.paid, true);
      assert.equal(body.settled.seat, seat);
      // Derived from the payment identity, so both sides compute it without
      // telling each other.
      assert.match(res.headers.get('x-idempotency-key') ?? '', /^[0-9a-f]{64}$/);

      // Replaying it is refused deterministically: one payment is one grant.
      const replay = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': header },
      });
      assert.equal(replay.status, 402);
      const replayBody = (await replay.json()) as { error: string; detail: string };
      assert.equal(replayBody.error, 'settlement-failed');
      assert.match(replayBody.detail, /already settled/);

      const metrics = await metricsOf(h.url);
      assert.equal(metrics.settlements, 1, 'exactly one settlement for one payment');
      assert.equal(metrics.broadcasts, 0, 'local-ledger-only mode broadcasts nothing');
    } finally {
      await h.close();
    }
  });

  test('a payment presented against another resource is refused before anything is read', async () => {
    const h = await rail();
    try {
      const seat = await offered(h.url, '/t/other');
      // Correctly bound to /t/other, but the transaction pays a different
      // account than the one that resource offered — and the binding is checked
      // first, so the reason names the binding rather than the transfer.
      const res = await fetch(`${h.url}/t/other`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ seat, resource: '/t/data' }) },
      });
      assert.equal(res.status, 402);
      const body = (await res.json()) as { refusal?: { code: string } };
      assert.equal(body.refusal?.code, 'VEIL-CONF-007');
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F8 — cache hygiene
// ---------------------------------------------------------------------------

describe('paid answers are never cacheable', () => {
  test('the 402 challenge and the granted response both carry no-store, and say what they vary on', async () => {
    const h = await rail();
    try {
      const res = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'buyer1' } });
      assert.equal(res.status, 402);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('vary') ?? '', /x-payer/);
      const seat = ((await res.json()) as { accepts: { payTo: string }[] }).accepts[0]!.payTo;

      const paid = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ seat, resource: '/t/data' }) },
      });
      assert.equal(paid.status, 200);
      assert.equal(paid.headers.get('cache-control'), 'no-store');
      assert.match(paid.headers.get('vary') ?? '', /x-payer/);
      assert.match(paid.headers.get('vary') ?? '', /payment-signature/);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F3 — the V2 headers, alongside V1
// ---------------------------------------------------------------------------

describe('x402 v2 headers work beside the v1 spelling', () => {
  test('a payment arrives on PAYMENT-SIGNATURE and the challenge leaves as PAYMENT-REQUIRED', async () => {
    const h = await rail();
    try {
      const challenge = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'buyer1' } });
      assert.equal(challenge.status, 402);
      const header = challenge.headers.get('payment-required');
      assert.ok(header, 'the v2 challenge header is present');
      const body = (await challenge.json()) as { accepts: { payTo: string }[] };
      // The header is the same terms as the body, not a second opinion.
      const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8')) as {
        accepts: { payTo: string }[];
      };
      assert.equal(decoded.accepts[0]!.payTo, body.accepts[0]!.payTo);

      const paid = await fetch(`${h.url}/t/data`, {
        headers: {
          'x-payer': 'buyer1',
          'payment-signature': paymentHeader({ seat: body.accepts[0]!.payTo, resource: '/t/data' }),
        },
      });
      assert.equal(paid.status, 200, `expected the v2 header to be read: ${await paid.clone().text()}`);
      const receipt = paid.headers.get('payment-response');
      assert.ok(receipt, 'the v2 settlement receipt header is present');
      const settlement = JSON.parse(Buffer.from(receipt!, 'base64').toString('utf8')) as {
        success: boolean;
        payer: string;
      };
      assert.equal(settlement.success, true);
      assert.equal(settlement.payer, 'buyer1');
    } finally {
      await h.close();
    }
  });

  test('the capability surface publishes both header sets and the trust model', async () => {
    const h = await rail();
    try {
      const body = (await (await fetch(`${h.url}/.well-known/veil`)).json()) as {
        paymentHeaders: { v1: { request: string }; v2: { request: string; challenge: string } };
        trust: { model: string; intermediates: string[]; verifier: { command: string } };
        privacy: string;
      };
      assert.equal(body.paymentHeaders.v1.request, 'X-PAYMENT');
      assert.equal(body.paymentHeaders.v2.request, 'PAYMENT-SIGNATURE');
      assert.equal(body.paymentHeaders.v2.challenge, 'PAYMENT-REQUIRED');
      // The differentiator, published as a machine-readable fact: chain-verified
      // privacy has no operator set, no threshold and no gateway in the path.
      assert.equal(body.trust.model, 'chain-verified');
      assert.deepEqual(body.trust.intermediates, []);
      assert.match(body.trust.verifier.command, /replay/);
      // And the honest boundary is still stated next to it.
      assert.equal(body.privacy, 'confidential-balances');
    } finally {
      await h.close();
    }
  });
});
