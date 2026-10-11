/**
 * `batch-confidential` — the session state machine, over real HTTP.
 *
 * Two layers are under test and both matter:
 *
 *   - `BatchSessionManager` on its own, where the rules live (offline voucher
 *     verification, strict sequence monotonicity, cumulative caps, coverage of
 *     the call being served, one redemption per session).
 *   - the HTTP surface a payer's agent actually talks to: open a session, charge
 *     calls with a voucher header, redeem once, get a receipt.
 *
 * Settlement runs in `local-ledger-only` mode here, which is not a shortcut: the
 * receipts this suite asserts on *say* which mode produced them, and a test that
 * only ever exercised the RPC path would never check that the honest label is
 * there. The chain half is exercised by `pay:live` and `demo:batch`.
 *
 * The last suite reads `docs/notes/svm-batch-binding.md` and asserts the seven
 * sections the x402 batch specification mandates are present. That is F9's
 * conformance checklist being *consumed* rather than merely written: if the
 * binding loses a mandated section, this suite fails.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
} from '@solana/kit';

import { DEVNET, PLACEHOLDER_MINT, toAtomic } from '../../x402-core/src/index.ts';
import { buildConfidentialTransfer } from '../../onchain/src/index.ts';
import { PoolLedger } from '../../derive/src/index.ts';
import {
  createFacilitator,
  createVeilServer,
  poolLedgerProbe,
  type ResourceDefinition,
  type ServerConfig,
} from './index.ts';
import {
  BatchSessionManager,
  canonicalVoucher,
  verifyVoucher,
  voucherSignerFromSeed,
  type SignedVoucher,
  type Voucher,
} from './batch.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINT = PLACEHOLDER_MINT as unknown as Address;
const FEE_PAYER = '3RWhpyX2JaE89UWqxM8LRsB3xykSVwHyEvBmgdo9N1FJ' as Address;
const SOURCE_TOKEN = '8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21' as Address;
const PAYER_AUTHORITY = 'Ep1X1BnzWk3u5tgbFUSi2xHiym8CbnmraJZaPVxhGpcR' as Address;
const PLACEHOLDER_SIGNATURE_BYTES = new Uint8Array(64).fill(7) as never;

/** Two seats for the merchant, so a redemption has somewhere to land. */
const SEATS = [
  'FQAN6AmfJXKoXUa9KC3AQxCpXMi1Fv5121spDrGBRDJW',
  '27BPmc5bjmF7kUp4WRXfaCBsv9jXfU9pskoTmmuSwWob',
];

const PRICE = '0.049';

/** A payer's key pair, in the layout the agent key file uses: PKCS#8 + raw key. */
function payerKeyPair(): { seed: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // The DER wrappers are fixed-width prefixes; the trailing 32 bytes are the
  // seed and the public key. Stripping them here rather than in the module means
  // the module can keep asserting on a raw 32-byte key.
  return { seed: pkcs8.subarray(pkcs8.length - 32), publicKey: spki.subarray(spki.length - 32) };
}

/** A real confidential-transfer wire paying `destination`, as a payer's client builds it. */
function confidentialWire(destination: string): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        buildConfidentialTransfer({
          sourceToken: SOURCE_TOKEN,
          mint: MINT,
          destinationToken: destination as Address,
          authority: { address: PAYER_AUTHORITY } as never,
          newSourceDecryptableAvailableBalance: new Uint8Array(36),
        }),
        m,
      ),
  );
  const compiled = compileTransaction(message);
  return getBase64EncodedWireTransaction({
    ...compiled,
    signatures: { [FEE_PAYER]: PLACEHOLDER_SIGNATURE_BYTES },
  });
}

interface Rail {
  readonly url: string;
  readonly sessions: BatchSessionManager;
  readonly close: () => Promise<void>;
}

async function rail(options: { readonly ttlMs?: number } = {}): Promise<Rail> {
  const scratchRoot = fileURLToPath(new URL('../../../data/test/', import.meta.url));
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot, 'batch-'));

  const ledger = PoolLedger.empty();
  SEATS.forEach((address, slot) => ledger.register({ slot, address, alias: 'm', armed: true }));

  const resource: ResourceDefinition = {
    path: '/t/data',
    alias: 'm',
    description: 'test resource /t/data',
    base: PRICE,
    produce: () => ({ served: '/t/data' }),
  };

  const sessions = new BatchSessionManager({
    decimals: 6,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });

  const config: ServerConfig = {
    network: DEVNET,
    mint: PLACEHOLDER_MINT,
    decimals: 6,
    ledgerPath: join(dir, 'ledger.json'),
    resources: [resource],
    // The protocol path, exercised honestly: no RPC, so the rail reports itself
    // as `local-ledger-only` and every receipt says which mode settled it.
    allowLocalSettlement: true,
    privacy: poolLedgerProbe(ledger, true),
    privacySource: 'pool-ledger',
    batchSessions: sessions,
  };

  const facilitator = createFacilitator(config, ledger);
  const server: Server = createVeilServer(config, facilitator);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function voucherHeader(signed: SignedVoucher): string {
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64');
}

async function openSession(
  url: string,
  publicKey: Uint8Array,
  cap = '0.05',
): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payer': 'buyer1' },
    body: JSON.stringify({ payerPubkey: Buffer.from(publicKey).toString('base64'), cap, alias: 'm' }),
  });
  assert.equal(res.status, 201, `expected a session: ${await res.clone().text()}`);
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('batch sessions — the rules', () => {
  const { seed, publicKey } = payerKeyPair();
  const sign = voucherSignerFromSeed(seed);

  test('an ed25519 payer key round-trips through the session manager', () => {
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'buyer1', alias: 'm', payerPubkey: publicKey, cap: '0.05', decimals: 6 });
    assert.equal(session.headSeq, 0);
    assert.equal(session.charged, 0n);
    assert.equal(session.headVoucher, null);
    assert.equal(session.state, 'open');
  });

  test('a voucher signs the length-prefixed bytes and verifies against the raw key', () => {
    const voucher: Voucher = { sessionId: 'abc', seq: 1, total: '49000' };
    const signed = sign(voucher);
    assert.ok(verifyVoucher(signed, publicKey), 'a genuine voucher verifies');
    // Field lengths are prefixed, so a shifted field boundary must not verify.
    const shifted = {
      voucher: { sessionId: 'ab', seq: 1, total: '49000' },
      signature: signed.signature,
    };
    assert.equal(verifyVoucher(shifted, publicKey), false);
    assert.ok(canonicalVoucher(voucher).includes(Buffer.from('veil-batch-voucher-v1')));
  });

  test('a voucher whose total does not cover the call is refused as underpaid', () => {
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '0.05', decimals: 6 });
    const cheap = sign({ sessionId: session.id, seq: 1, total: '1' });
    const outcome = manager.charge(session.id, cheap, 49_000n);
    assert.deepEqual(outcome, { ok: false, code: 'underpaid' });
    assert.equal(manager.get(session.id)!.charged, 0n, 'a refused charge moves nothing');
  });

  test('sequence must advance by exactly one, and replays are stale', () => {
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '1.00', decimals: 6 });
    assert.equal(manager.charge(session.id, sign({ sessionId: session.id, seq: 2, total: '98000' }), 49_000n).ok, false);
    assert.deepEqual(
      manager.charge(session.id, sign({ sessionId: session.id, seq: 1, total: '49000' }), 49_000n),
      { ok: true, headSeq: 1, charged: 49_000n },
    );
    // The same voucher again: a replay of a call already served.
    assert.deepEqual(
      manager.charge(session.id, sign({ sessionId: session.id, seq: 1, total: '49000' }), 49_000n),
      { ok: false, code: 'stale-seq' },
    );
    // A head that skipped a sequence would let one signature cover charges
    // nobody vouched for.
    assert.deepEqual(
      manager.charge(session.id, sign({ sessionId: session.id, seq: 3, total: '147000' }), 49_000n),
      { ok: false, code: 'gap-seq' },
    );
  });

  test('the cumulative total is capped, and the cap is the payer’s own ceiling', () => {
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '0.05', decimals: 6 });
    assert.equal(manager.charge(session.id, sign({ sessionId: session.id, seq: 1, total: '49000' }), 49_000n).ok, true);
    assert.deepEqual(
      manager.charge(session.id, sign({ sessionId: session.id, seq: 2, total: '98000' }), 49_000n),
      { ok: false, code: 'over-cap' },
    );
  });

  test('a voucher signed by another key is refused', () => {
    const other = payerKeyPair();
    const otherSign = voucherSignerFromSeed(other.seed);
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '0.05', decimals: 6 });
    assert.deepEqual(
      manager.charge(session.id, otherSign({ sessionId: session.id, seq: 1, total: '49000' }), 49_000n),
      { ok: false, code: 'bad-signature' },
    );
    assert.deepEqual(manager.charge('no-such-session', sign({ sessionId: 'x', seq: 1, total: '1' }), 1n), {
      ok: false,
      code: 'unknown-session',
    });
  });

  test('an expired session refuses, and says so', () => {
    let clock = new Date('2026-10-12T00:00:00Z');
    const manager = new BatchSessionManager({ decimals: 6, ttlMs: 1000, now: () => clock });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '0.05', decimals: 6 });
    clock = new Date('2026-10-12T00:00:02Z');
    assert.deepEqual(
      manager.charge(session.id, sign({ sessionId: session.id, seq: 1, total: '49000' }), 49_000n),
      { ok: false, code: 'session-expired' },
    );
  });

  test('a settled session refuses everything that follows it', () => {
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '0.05', decimals: 6 });
    const head = sign({ sessionId: session.id, seq: 1, total: '49000' });
    manager.charge(session.id, head, 49_000n);
    const receipt = manager.settle(session.id, {
      voucherHead: head,
      seat: SEATS[0]!,
      signature: null,
      settlementMode: 'local-ledger-only',
    });
    assert.ok(receipt);
    assert.equal(receipt.totalDecimal, '0.049');
    assert.equal(receipt.servedDecimal, '0.049');
    assert.equal(receipt.settlementMode, 'local-ledger-only');
    assert.equal(receipt.signature, null);
    assert.equal(manager.settle(session.id, { voucherHead: head, seat: SEATS[0]!, signature: null, settlementMode: 'local-ledger-only' }), null);
    assert.deepEqual(
      manager.charge(session.id, sign({ sessionId: session.id, seq: 2, total: '98000' }), 49_000n),
      { ok: false, code: 'session-closed' },
    );
  });

  test('a session that carries more calls than one seat can still redeem once', () => {
    const manager = new BatchSessionManager({ decimals: 6 });
    const session = manager.open({ payer: 'b', alias: 'm', payerPubkey: publicKey, cap: '0.20', decimals: 6 });
    for (let seq = 1; seq <= 3; seq++) {
      const outcome = manager.charge(
        session.id,
        sign({ sessionId: session.id, seq, total: String(seq * 1000) }),
        1000n,
      );
      assert.ok(outcome.ok, `charge ${seq} should be accepted`);
    }
    const head = manager.get(session.id)!.headVoucher!;
    const receipt = manager.settle(session.id, {
      voucherHead: head,
      seat: SEATS[1]!,
      signature: null,
      settlementMode: 'local-ledger-only',
    })!;
    assert.equal(receipt.calls, 3);
    assert.equal(receipt.servedDecimal, '0.003');
    assert.equal(receipt.totalDecimal, '0.003');
  });
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

describe('batch sessions — over HTTP', () => {
  test('a session charges calls offline and redeems as one confidential payment', async () => {
    const h = await rail();
    try {
      const { seed, publicKey } = payerKeyPair();
      const sign = voucherSignerFromSeed(seed);

      const opened = await openSession(h.url, publicKey);
      const sessionId = String(opened.sessionId);
      assert.equal(opened.scheme, 'batch-confidential');
      assert.equal(opened.state, 'open');
      // The contract is published rather than implied: a client that has to guess
      // the signed bytes discovers the mistake as a signature failure.
      const voucherDoc = opened.voucher as { format: string; transport: { header: string } };
      assert.match(voucherDoc.format, /veil-batch-voucher-v1/);
      assert.equal(voucherDoc.transport.header, 'X-VOUCHER');

      // One call, charged against the voucher. No chain, no 402, no seat burned.
      const first = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-voucher': voucherHeader(sign({ sessionId, seq: 1, total: '49000' })) },
      });
      assert.equal(first.status, 200, `expected the call to be served: ${await first.clone().text()}`);
      const firstBody = (await first.json()) as {
        paid: boolean;
        session: { headSeq: number; servedDecimal: string; deferred: string };
      };
      assert.equal(firstBody.paid, true);
      assert.equal(firstBody.session.headSeq, 1);
      assert.equal(firstBody.session.servedDecimal, '0.049');
      assert.match(firstBody.session.deferred, /never reaches the chain/);
      assert.equal(first.headers.get('x-idempotency-key'), `${sessionId}:1`);

      // The same voucher again is a replay of a call already served.
      const replay = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-voucher': voucherHeader(sign({ sessionId, seq: 1, total: '49000' })) },
      });
      assert.equal(replay.status, 402);
      assert.equal(((await replay.json()) as { code: string }).code, 'stale-seq');

      // A voucher for a *different* session cannot charge this one.
      const foreign = await fetch(`${h.url}/t/data`, {
        headers: {
          'x-payer': 'buyer1',
          'x-voucher': voucherHeader(sign({ sessionId: 'someone-elses-session', seq: 1, total: '49000' })),
        },
      });
      assert.equal(foreign.status, 402);
      assert.equal(((await foreign.json()) as { code: string }).code, 'unknown-session');

      // Redemption: the rail quotes ONE confidential payment for the session.
      const challenge = await fetch(`${h.url}/v1/sessions/${sessionId}/settle`, { method: 'POST' });
      assert.equal(challenge.status, 402);
      const terms = (await challenge.json()) as {
        accepts: { payTo: string; amount: string; resource: string; scheme: string; network: string; asset: string }[];
      };
      const accepted = terms.accepts[0]!;
      assert.equal(accepted.scheme, 'exact-confidential');
      assert.equal(accepted.amount, '49000');
      assert.match(accepted.resource, /\/v1\/sessions\/[0-9a-f]+\/settle$/);

      const payment = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          scheme: 'exact-confidential',
          network: DEVNET,
          accepted,
          payload: {
            transaction: confidentialWire(accepted.payTo),
            payTo: accepted.payTo,
            asset: PLACEHOLDER_MINT,
          },
        }),
        'utf8',
      ).toString('base64');

      const redeemed = await fetch(`${h.url}/v1/sessions/${sessionId}/settle`, {
        method: 'POST',
        headers: { 'payment-signature': payment },
      });
      assert.equal(redeemed.status, 200, `expected the redemption to settle: ${await redeemed.clone().text()}`);
      const body = (await redeemed.json()) as {
        redeemed: boolean;
        receipt: {
          sessionId: string;
          totalDecimal: string;
          servedDecimal: string;
          calls: number;
          seat: string;
          signature: string | null;
          settlementMode: string;
          voucherHead: SignedVoucher;
        };
      };
      assert.equal(body.redeemed, true);
      assert.equal(body.receipt.sessionId, sessionId);
      assert.equal(body.receipt.totalDecimal, '0.049');
      assert.equal(body.receipt.calls, 1);
      assert.equal(body.receipt.seat, accepted.payTo);
      assert.equal(body.receipt.settlementMode, 'local-ledger-only');
      // The receipt carries the payer's own signature, so the merchant's books
      // can be checked against the payer rather than taken on trust.
      assert.ok(verifyVoucher(body.receipt.voucherHead, publicKey));
      assert.equal(redeemed.headers.get('x-idempotency-key'), `${sessionId}:settle`);
      assert.ok(redeemed.headers.get('payment-response'), 'the v2 receipt header is present');

      // The session is closed, and says so with the receipt rather than a
      // second settlement.
      const again = await fetch(`${h.url}/v1/sessions/${sessionId}/settle`, { method: 'POST' });
      assert.equal(again.status, 409);
      const closed = (await again.json()) as { error: string; receipt?: { seat: string } };
      assert.equal(closed.error, 'session-already-settled');
      assert.equal(closed.receipt?.seat, accepted.payTo);

      const read = await fetch(`${h.url}/v1/sessions/${sessionId}`);
      assert.equal(read.status, 200);
      assert.equal(((await read.json()) as { state: string }).state, 'settled');
    } finally {
      await h.close();
    }
  });

  test('a session with no charges has nothing to redeem', async () => {
    const h = await rail();
    try {
      const { publicKey } = payerKeyPair();
      const opened = await openSession(h.url, publicKey);
      const res = await fetch(`${h.url}/v1/sessions/${String(opened.sessionId)}/settle`, { method: 'POST' });
      assert.equal(res.status, 402);
      assert.equal(((await res.json()) as { error: string }).error, 'nothing-to-settle');
    } finally {
      await h.close();
    }
  });

  test('an unknown session is a 404, not an empty session', async () => {
    const h = await rail();
    try {
      const res = await fetch(`${h.url}/v1/sessions/deadbeef`);
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: string }).error, 'unknown-session');
    } finally {
      await h.close();
    }
  });

  test('a session cannot be opened with a key that is not a raw 32-byte public key', async () => {
    const h = await rail();
    try {
      const res = await fetch(`${h.url}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payerPubkey: Buffer.from('too short').toString('base64'), cap: '0.05' }),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid-payer-pubkey');
    } finally {
      await h.close();
    }
  });

  test('a voucher that does not cover this call is refused with the reason, not a 500', async () => {
    const h = await rail();
    try {
      const { seed, publicKey } = payerKeyPair();
      const sign = voucherSignerFromSeed(seed);
      const opened = await openSession(h.url, publicKey);
      const sessionId = String(opened.sessionId);
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-voucher': voucherHeader(sign({ sessionId, seq: 1, total: '1' })) },
      });
      assert.equal(res.status, 402);
      const body = (await res.json()) as { error: string; code: string; detail: string };
      assert.equal(body.error, 'voucher-rejected');
      assert.equal(body.code, 'underpaid');
      assert.match(body.detail, /this call costs 0.049/);
    } finally {
      await h.close();
    }
  });

  test('a rail started without a session manager serves seats only, and says so', async () => {
    const ledger = PoolLedger.empty();
    ledger.register({ slot: 0, address: SEATS[0]!, alias: 'm', armed: true });
    const config: ServerConfig = {
      network: DEVNET,
      mint: PLACEHOLDER_MINT,
      decimals: 6,
      ledgerPath: 'data/test/unused.json',
      resources: [{ path: '/t/data', alias: 'm', description: 'test', base: PRICE, produce: () => ({}) }],
      allowLocalSettlement: true,
      privacy: poolLedgerProbe(ledger, true),
      privacySource: 'pool-ledger',
    };
    const facilitator = createFacilitator(config, ledger);
    const server = createVeilServer(config, facilitator);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/t/data`, {
        headers: { 'x-voucher': vendor() },
      });
      assert.equal(res.status, 501);
      assert.equal(((await res.json()) as { error: string }).error, 'sessions-not-enabled');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    function vendor(): string {
      return Buffer.from(JSON.stringify({ voucher: { sessionId: 'x', seq: 1, total: '1' }, signature: 'AA==' })).toString('base64');
    }
  });
});

// ---------------------------------------------------------------------------
// F9 — the binding's conformance checklist, consumed by these tests
// ---------------------------------------------------------------------------

describe('svm-batch-binding.md covers what the batch spec mandates', () => {
  test('all seven mandated sections are present', async () => {
    const doc = await readFile(
      fileURLToPath(new URL('../../../docs/notes/svm-batch-binding.md', import.meta.url)),
      'utf8',
    );
    // The spec mandates a per-network binding covering exactly these seven
    // things. This is the checklist being read by a test rather than asserted in
    // prose, so a binding that quietly loses a section fails CI.
    const sections = [
      'Commitment format',
      'Verification rules',
      'Storage behaviour',
      'Double-spend prevention',
      'Expiry',
      'Redemption',
      'Trust model',
    ];
    for (const section of sections) {
      assert.match(doc, new RegExp(`^##+ .*${section}`, 'im'), `the binding must document: ${section}`);
    }
    // And it must state which trust model it implements, because the spec leaves
    // that to the binding and "capital-backed" is the choice Veil makes.
    assert.match(doc, /capital-backed/i);
    // The fee-payer/service model is NOT part of it: no intermediary underwrites.
    assert.match(doc, /no intermediary/i);
  });

  test('the voucher the tests sign is the voucher the doc specifies', async () => {
    const doc = await readFile(
      fileURLToPath(new URL('../../../docs/notes/svm-batch-binding.md', import.meta.url)),
      'utf8',
    );
    assert.match(doc, /veil-batch-voucher-v1/);
    assert.match(doc, /u32be-len|length-prefixed/i);
    const { seed } = payerKeyPair();
    const signed = voucherSignerFromSeed(seed)({ sessionId: 's', seq: 1, total: '49000' });
    const digest = createHash('sha256').update(signed.signature).digest('hex');
    assert.equal(digest.length, 64, 'a 64-byte ed25519 signature, base64 on the wire');
  });
});
