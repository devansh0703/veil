import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEVNET, PLACEHOLDER_MINT, SOLANA_DEVNET } from '../../x402-core/src/index.ts';
import { PoolLedger, type StoredSettlement } from '../../derive/src/index.ts';
import {
  HOSTED_DEFAULTS,
  createFacilitator,
  createVeilServer,
  defaultConfig,
  poolLedgerProbe,
  veil,
  type LedgerStore,
  type ResourceDefinition,
  type ServerConfig,
} from './index.ts';

// A real 32-byte address with no account behind it, so the tests exercise the
// same validation path a deployment does.
const MINT = PLACEHOLDER_MINT;

function resource(
  path: string,
  alias: string,
  base: string,
): ResourceDefinition {
  return {
    path,
    alias,
    description: `test resource ${path}`,
    base,
    produce: () => ({ served: path }),
  };
}

interface Harness {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly rpcCalls: string[];
  /** Every ledger a durable store was asked to persist, in order. */
  readonly saves: PoolLedger[];
}

/**
 * Start a Veil server with a real pool ledger on disk.
 *
 * When `withStubRpc` is set, a local HTTP endpoint stands in for the devnet RPC
 * so the broadcast path can be exercised without chain funds. The stub is a test
 * double for a *remote service*, and is labelled as such — it is not a stand-in
 * for Veil's own logic, which runs for real in every case.
 */
async function harness(options: {
  readonly withStubRpc?: boolean;
  readonly spendCap?: string;
  readonly pool?: readonly { slot: number; address: string; alias: string }[];
  /** Omit the precondition probe, to exercise the fail-closed default. */
  readonly withoutPrivacy?: boolean;
  readonly mintConfidential?: boolean | 'unknown';
  /** Accounts that exist but are not configured for confidential credits. */
  readonly unarmedAliases?: readonly string[];
  /** A friendly network name, to prove what the server publishes on the wire. */
  readonly network?: string;
  /**
   * Install a recording durable store in place of the local file.
   *
   * A store changes *when* the ledger is written, not only where: a reservation
   * is a promise not to reuse a seat, and on a deployment that promise has to be
   * written down when the offer is made, because the next quote is answered by a
   * different instance. `saves` is that write log.
   */
  readonly withStore?: boolean;
  /**
   * A store to share, so two harnesses can act as two instances of one rail.
   * `saves` is not populated in this case — the caller owns the store and its
   * records.
   */
  readonly store?: LedgerStore;
  /**
   * Make the first (or every) write lose to another instance.
   *
   * The store's write keeps the earliest claim, so a second instance's
   * reservation is discarded by the merge while it has already been told to pay
   * that address. `once` is that race: the seat this instance picked comes back
   * owned by a different payment, which it must notice and retry. `always` is the
   * same race with no way to win, which must end in a refusal rather than an
   * offer nobody can honour.
   */
  readonly contend?: 'once' | 'always';
}): Promise<Harness> {
  // Scratch space stays inside the project: nothing this suite writes may land
  // outside the repository.
  const scratchRoot = fileURLToPath(new URL('../../../data/test/', import.meta.url));
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot, 'run-'));
  const ledger = PoolLedger.empty();
  for (const e of options.pool ?? []) {
    // `armed: false` is a real state the ledger models: the account exists but
    // has not been configured to receive confidential credits. It is what the
    // VEIL-CONF-002 gate has to catch.
    ledger.register({
      slot: e.slot,
      address: e.address,
      alias: e.alias,
      armed: !options.unarmedAliases?.includes(e.alias),
    });
  }

  const rpcCalls: string[] = [];
  let stubRpc: Server | undefined;
  let rpcUrl: string | undefined;

  if (options.withStubRpc) {
    stubRpc = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      rpcCalls.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'StubSig111' }));
    });
    await new Promise<void>((r) => stubRpc!.listen(0, '127.0.0.1', () => r()));
    const addr = stubRpc!.address();
    rpcUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  const saves: PoolLedger[] = [];
  let store: LedgerStore | undefined = options.store;
  if (!store && options.withStore) {
    const records: StoredSettlement[] = [];
    store = {
      load: async (): Promise<PoolLedger | null> => saves.at(-1) ?? null,
      save: async (next: PoolLedger): Promise<void> => {
        // The contender claims the seat this instance just picked, for a payment
        // that is not this one — exactly what a concurrent instance's write does
        // through the merge.
        const claimant = `payment-from-another-instance-${saves.length}`;
        const contested = next.toJSON().map((entry) =>
          entry.consumedBy !== null ? { ...entry, consumedBy: claimant } : entry,
        );
        const shouldContend =
          options.contend === 'always' || (options.contend === 'once' && saves.length === 0);
        saves.push(PoolLedger.fromJSON(shouldContend ? contested : next.toJSON()));
      },
      loadSettlements: async (): Promise<readonly StoredSettlement[]> => [...records],
      appendSettlement: async (settlement: StoredSettlement): Promise<void> => {
        if (!records.some((row) => row.address === settlement.address)) {
          records.push(settlement);
        }
      },
    };
  }

  const config: ServerConfig = {
    network: (options.network ?? DEVNET) as ServerConfig['network'],
    mint: MINT,
    decimals: 6,
    ledgerPath: join(dir, 'ledger.json'),
    resources: [
      resource('/t/data', 'm', '0.049'),
      resource('/t/other', 'other', '0.010'),
      resource('/t/one', 'one', '0.001'),
    ],
    ...(options.spendCap !== undefined ? { spendCap: options.spendCap } : {}),
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
    ...(store ? { ledgerStore: store } : {}),
    ...(options.withoutPrivacy
      ? {}
      : {
          privacy: poolLedgerProbe(ledger, options.mintConfidential ?? true),
          privacySource: 'pool-ledger' as const,
        }),
  };

  const facilitator = createFacilitator(config, ledger);
  const server = createVeilServer(config, facilitator);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    rpcCalls,
    saves,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (stubRpc) await new Promise<void>((r) => stubRpc!.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const pool = [
  ...Array.from({ length: 8 }, (_, i) => ({ slot: i, address: `mA${i}`, alias: 'm' })),
  { slot: 0, address: 'oA0', alias: 'other' },
  { slot: 1, address: 'oA1', alias: 'other' },
  { slot: 0, address: 'oneA0', alias: 'one' },
];

/** Ask for a price and return the one-time address the server offered. */
async function quoteFor(url: string, path: string, payer: string): Promise<string> {
  const res = await fetch(`${url}${path}`, { headers: { 'x-payer': payer } });
  const body = (await res.json()) as { accepts: { payTo: string }[] };
  assert.equal(res.status, 402, 'expected a quote');
  const offered = body.accepts[0]?.payTo;
  assert.ok(offered, 'expected a payment account to be offered');
  return offered;
}

/**
 * base64 of a payment payload echoing the destination it paid.
 *
 * Hand-assembled on purpose. Unlike `scripts/demo-local.ts`, whose payloads must
 * be well-formed, this helper exists to produce payloads that are *wrong* in one
 * specific way — a bad mint, a foreign account, a foreign scheme, a missing
 * `accepted`. A strict builder refuses to construct those, so it would defeat the
 * tests that need them. `accepted` is still emitted by default, since x402 v2
 * requires it; `omitAccepted` is how the tests for its absence work.
 */
function paymentHeader(input: {
  payTo: string;
  asset?: string;
  transaction?: string;
  scheme?: string;
  network?: string;
  version?: number;
  acceptedPayTo?: string;
  omitAccepted?: boolean;
}): string {
  const accept = {
    scheme: 'exact-confidential',
    network: DEVNET,
    asset: input.asset ?? MINT,
    payTo: input.acceptedPayTo ?? input.payTo,
    maxAmountRequired: '49000',
    amount: '49000',
    resource: '/x',
    maxTimeoutSeconds: 60,
    extra: { privacy: 'confidential-balances', decimals: 6, poolIndex: 0, hides: [] },
  };
  return Buffer.from(
    JSON.stringify({
      x402Version: input.version ?? 2,
      scheme: input.scheme ?? 'exact-confidential',
      network: input.network ?? DEVNET,
      ...(input.omitAccepted ? {} : { accepted: accept }),
      payload: {
        transaction: input.transaction ?? 'AQIDBA==',
        payTo: input.payTo,
        asset: input.asset ?? MINT,
      },
    }),
    'utf8',
  ).toString('base64');
}

describe('capability surface', () => {
  let h: Harness;
  before(async () => {
    h = await harness({ pool });
  });
  after(async () => h.close());

  test('health reports honestly whether settlement is possible', async () => {
    const res = await fetch(`${h.url}/v1/health`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.settlement, 'unavailable', 'no RPC was configured');
    assert.equal(body.poolSize, 11);
  });

  test('a friendly network name is published as the identifier x402 speaks', async () => {
    // Regression: the server used to publish whatever it was configured with
    // (`solana:devnet`), which parses fine and is then refused by x402's own
    // signer. A 402 body a payer cannot act on is not an offer.
    const friendly = await harness({ pool, network: 'devnet' });
    try {
      const quote = await fetch(`${friendly.url}/t/data`, { headers: { 'x-payer': 'b' } });
      const body = (await quote.json()) as { accepts: { network: string }[] };
      assert.equal(body.accepts[0]!.network, SOLANA_DEVNET);
      const health = await fetch(`${friendly.url}/v1/health`);
      assert.equal(((await health.json()) as { network: string }).network, SOLANA_DEVNET);
    } finally {
      await friendly.close();
    }
  });

  test('.well-known/veil states what is hidden and what is exposed', async () => {
    const res = await fetch(`${h.url}/.well-known/veil`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body.hides, ['on-chain-amount', 'on-chain-balance']);
    // Stating the exposed side matters: a privacy claim that omits it is
    // misleading even when every word of it is true.
    assert.ok((body.exposes as string[]).includes('destination-account'));
    const codes = (body.refusals as { code: string }[]).map((r) => r.code);
    assert.ok(codes.includes('VEIL-CONF-003'));
  });
});

describe('issuing a 402', () => {
  let h: Harness;
  before(async () => {
    h = await harness({ pool });
  });
  after(async () => h.close());

  test('an unpaid call gets a price and a one-time payment account', async () => {
    const res = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'buyer1' } });
    const body = (await res.json()) as {
      x402Version: number;
      accepts: { payTo: string; maxAmountRequired: string; extra: { poolIndex: number; hides: string[] } }[];
    };
    assert.equal(res.status, 402);
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts.length, 1);
    assert.equal(body.accepts[0]!.maxAmountRequired, '49000');
    assert.equal(body.accepts[0]!.extra.poolIndex >= 0, true);
    assert.deepEqual(body.accepts[0]!.extra.hides, ['on-chain-amount', 'on-chain-balance']);
  });

  test('two payments never receive the same address', async () => {
    // Two payments means two identities: same resource and payer, different
    // nonce. The nonce is what makes them two payments rather than one.
    const first = await (
      await fetch(`${h.url}/t/other?nonce=1`, { headers: { 'x-payer': 'b1' } })
    ).json() as { accepts: { payTo: string }[] };
    const second = await (
      await fetch(`${h.url}/t/other?nonce=2`, { headers: { 'x-payer': 'b1' } })
    ).json() as { accepts: { payTo: string }[] };
    // Distinct destinations are the whole point of the second privacy layer.
    assert.notEqual(first.accepts[0]!.payTo, second.accepts[0]!.payTo);
  });

  test('re-quoting one payment identity reuses its own account, not another', async () => {
    // A retry of the same payment must not consume a second seat: the pool is
    // non-recyclable rent, and two offers naming two addresses for one payment
    // id would make one payment look like two on the public graph. /t/data is
    // alias 'm', whose pool has room for this beside the other tests here.
    const first = await (
      await fetch(`${h.url}/t/data?nonce=7`, { headers: { 'x-payer': 'b1' } })
    ).json() as { accepts?: { payTo: string }[] };
    const retry = await (
      await fetch(`${h.url}/t/data?nonce=7`, { headers: { 'x-payer': 'b1' } })
    ).json() as { accepts?: { payTo: string }[] };
    assert.ok(first.accepts?.[0], 'the first quote must offer');
    assert.ok(retry.accepts?.[0], 'the retry must offer the same seat, not a refusal');
    assert.equal(retry.accepts[0]!.payTo, first.accepts[0]!.payTo);
  });

  test('a nonce that is not an integer is refused before it can collide identities', async () => {
    const res = await fetch(`${h.url}/t/other?nonce=not-a-number`, {
      headers: { 'x-payer': 'b1' },
    });
    const body = (await res.json()) as { error: string };
    assert.equal(res.status, 400);
    assert.equal(body.error, 'invalid-nonce');
  });

  test('a 404 for an unknown resource is not confused with a 402', async () => {
    const res = await fetch(`${h.url}/nope`);
    assert.equal(res.status, 404);
  });
});

describe('refusals', () => {
  let h: Harness;
  before(async () => {
    h = await harness({ pool, spendCap: '0.020' });
  });
  after(async () => h.close());

  test('a price above the declared spend cap is refused as VEIL-CONF-004', async () => {
    // 0.049 > the 0.020 cap, so the server will not offer the resource at all.
    const res = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'b1' } });
    const body = (await res.json()) as { veil: { refused: string }; accepts: unknown[] };
    assert.equal(res.status, 402);
    assert.equal(body.veil.refused, 'VEIL-CONF-004');
    assert.equal(body.accepts.length, 0);
  });

  test('a resource inside the cap is still served', async () => {
    const res = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { veil?: unknown; accepts: unknown[] };
    assert.equal(body.veil, undefined);
    assert.equal(body.accepts.length, 1);
  });
});

describe('the confidential precondition gate', () => {
  test('a mint a client could not parse is rejected at construction', async () => {
    assert.throws(
      () =>
        createFacilitator(
          { ...defaultConfig({ ledgerPath: 'data/test/none.json' }), mint: 'VeilUSD11111111' },
          PoolLedger.empty(),
        ),
      /not a valid 32-byte base58 address/,
    );
  });

  test('a server with no probe refuses rather than assume privacy', async () => {
    // This is VEIL-CONF-003 doing its actual job: with nothing able to vouch for
    // the mint or the destination, Veil will not offer a settlement at all.
    const h = await harness({ pool, withoutPrivacy: true });
    try {
      const res = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
      const body = (await res.json()) as { veil: { refused: string }; accepts: unknown[] };
      assert.equal(res.status, 402);
      assert.equal(body.veil.refused, 'VEIL-CONF-003');
      assert.equal(body.accepts.length, 0, 'no offer is made when privacy cannot be guaranteed');
    } finally {
      await h.close();
    }
  });

  test('a mint without the confidential extension is VEIL-CONF-001', async () => {
    const h = await harness({ pool, mintConfidential: false });
    try {
      const res = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
      const body = (await res.json()) as { veil: { refused: string } };
      assert.equal(body.veil.refused, 'VEIL-CONF-001');
    } finally {
      await h.close();
    }
  });

  test('an unverifiable mint is refused, not assumed good', async () => {
    const h = await harness({ pool, mintConfidential: 'unknown' });
    try {
      const res = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
      const body = (await res.json()) as { veil: { refused: string } };
      assert.equal(body.veil.refused, 'VEIL-CONF-003');
    } finally {
      await h.close();
    }
  });

  test('an account that cannot receive confidential credits is VEIL-CONF-002', async () => {
    const h = await harness({ pool, unarmedAliases: ['one'] });
    try {
      const res = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
      const body = (await res.json()) as { veil: { refused: string } };
      assert.equal(body.veil.refused, 'VEIL-CONF-002');
    } finally {
      await h.close();
    }
  });

  test('the capability surface publishes where the preconditions came from', async () => {
    const h = await harness({ pool });
    try {
      const body = (await (await fetch(`${h.url}/.well-known/veil`)).json()) as {
        privacySource: string;
        privacyGate: { mode: string; checks?: string[] };
        hides: string[];
        exposes: string[];
      };
      assert.equal(body.privacySource, 'pool-ledger');
      assert.equal(body.privacyGate.mode, 'enforcing');
      assert.deepEqual(body.privacyGate.checks, [
        'mint-confidential-extension',
        'destination-confidential-credits',
      ]);
      // The boundary is published in both directions, so an integrator cannot
      // read the claim and miss what stays visible.
      assert.deepEqual(body.hides, ['on-chain-amount', 'on-chain-balance']);
      assert.ok(body.exposes.includes('destination-account'));
    } finally {
      await h.close();
    }
  });

  test('a deployment that never checked its own claim refuses, and says so', async () => {
    const h = await harness({ pool, withoutPrivacy: true });
    try {
      const body = (await (await fetch(`${h.url}/.well-known/veil`)).json()) as {
        privacySource: string;
        privacyGate: { mode: string; note?: string };
      };
      assert.equal(body.privacySource, 'none');
      assert.equal(body.privacyGate.mode, 'refusing');
      assert.match(String(body.privacyGate.note), /VEIL-CONF-003/);
    } finally {
      await h.close();
    }
  });
});

describe('exhaustion is refused, never worked around', () => {
  let h: Harness;
  before(async () => {
    h = await harness({ pool });
  });
  after(async () => h.close());

  test('the second payment on a one-account pool is VEIL-CONF-005', async () => {
    const first = await fetch(`${h.url}/t/one?nonce=1`, { headers: { 'x-payer': 'b1' } });
    assert.equal(first.status, 402);
    const firstBody = (await first.json()) as { veil?: unknown; accepts: { payTo: string }[] };
    assert.equal(firstBody.veil, undefined);

    // A *different* payment (nonce 2) has nowhere to land: reusing the spent
    // address would relink the two payments, so Veil refuses.
    const second = await fetch(`${h.url}/t/one?nonce=2`, { headers: { 'x-payer': 'b1' } });
    const secondBody = (await second.json()) as { veil: { refused: string } };
    assert.equal(second.status, 503);
    assert.equal(secondBody.veil.refused, 'VEIL-CONF-005');

    // The first payment still gets its own offer on a retry — exhaustion is
    // about the pool having no free seat for a new payment, not about refusing
    // the payment that already holds one.
    const retry = await fetch(`${h.url}/t/one?nonce=1`, { headers: { 'x-payer': 'b1' } });
    const retryBody = (await retry.json()) as { veil?: unknown; accepts: { payTo: string }[] };
    assert.equal(retry.status, 402);
    assert.equal(retryBody.veil, undefined);
    assert.equal(retryBody.accepts[0]!.payTo, firstBody.accepts[0]!.payTo);
  });
});

describe('verification rejects payments that do not add up', () => {
  let h: Harness;
  before(async () => {
    h = await harness({ pool });
  });
  after(async () => h.close());

  async function pay(header: string, path = '/t/data') {
    return fetch(`${h.url}${path}`, {
      headers: { 'x-payer': 'buyer1', 'x-payment': header },
    });
  }

  test('a malformed header is rejected before any parsing assumptions', async () => {
    const res = await pay('not-base64-json');
    const body = (await res.json()) as { error: string };
    assert.equal(res.status, 402);
    assert.equal(body.error, 'malformed-payment-header');
  });

  test('a payment in the wrong mint is rejected', async () => {
    const res = await pay(paymentHeader({ payTo: 'mA0', asset: 'SomeOtherMint111' }));
    const body = (await res.json()) as { detail: string };
    assert.equal(res.status, 402);
    assert.match(body.detail, /wrong mint/);
  });

  test('a payment to an address Veil never issued is rejected', async () => {
    const res = await pay(paymentHeader({ payTo: 'stranger' }));
    const body = (await res.json()) as { detail: string };
    assert.equal(res.status, 402);
    assert.match(body.detail, /not a payment account Veil issued/);
  });

  test("a payment to another merchant's account is rejected", async () => {
    // oA0 belongs to alias 'other', so crediting it against /t/data would pay the
    // wrong party. This is the check that keeps attribution honest.
    const res = await pay(paymentHeader({ payTo: 'oA0' }));
    const body = (await res.json()) as { detail: string };
    assert.equal(res.status, 402);
    assert.match(body.detail, /belongs to other/);
  });

  test('a foreign scheme is rejected', async () => {
    const res = await pay(paymentHeader({ payTo: 'mA0', scheme: 'exact' }));
    const body = (await res.json()) as { detail: string };
    assert.equal(res.status, 402);
    assert.match(body.detail, /scheme must be/);
  });

  test('a v2 payload without the terms it agreed to is rejected', async () => {
    // x402 v2 makes `accepted` mandatory. A payload that omits it is not a
    // version we can verify, so it is refused rather than assumed to mean the
    // right thing.
    const res = await pay(paymentHeader({ payTo: 'mA0', omitAccepted: true }));
    const body = (await res.json()) as { detail: string };
    assert.equal(res.status, 402);
    assert.match(body.detail, /accepted is required/);
  });

  test('terms that name one account while the payload pays another are rejected', async () => {
    // The two halves of the payload must agree. A payment whose declared terms
    // point somewhere else is a contradiction, and crediting it would let a payer
    // pick which merchant hears about a payment independently of where it went.
    const res = await pay(paymentHeader({ payTo: 'mA0', acceptedPayTo: 'mA1' }));
    const body = (await res.json()) as { detail: string };
    assert.equal(res.status, 402);
    assert.match(body.detail, /does not match the account paid/);
  });
});

describe('settlement never claims more than it did', () => {
  test('with no RPC the server refuses instead of reporting success', async () => {
    const h = await harness({ pool });
    try {
      const offered = await quoteFor(h.url, '/t/data', 'buyer1');
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: offered }) },
      });
      const body = (await res.json()) as { error: string; detail: string };
      assert.equal(res.status, 503);
      assert.equal(body.error, 'settlement-failed');
      assert.match(body.detail, /settlement-unavailable/);

      // The important half: nothing was recorded as settled.
      const ledger = (await (await fetch(`${h.url}/api/ledger`)).json()) as {
        settled: unknown[];
      };
      assert.deepEqual(ledger.settled, []);
    } finally {
      await h.close();
    }
  });

  test('with an RPC the broadcast happens and the result is recorded', async () => {
    const h = await harness({ pool, withStubRpc: true });
    try {
      const offered = await quoteFor(h.url, '/t/data', 'buyer1');
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: offered }) },
      });
      const body = (await res.json()) as {
        paid: boolean;
        settled: { signature: string; amount: string; confid: string };
        data: { served: string };
      };
      assert.equal(res.status, 200);
      assert.equal(body.paid, true);
      assert.equal(body.settled.signature, 'StubSig111');
      assert.equal(body.settled.amount, '49000');
      assert.equal(body.data.served, '/t/data');

      // The server really did call out, with the payer's own signed bytes.
      assert.equal(h.rpcCalls.length, 1);
      assert.match(h.rpcCalls[0]!, /sendTransaction/);

      const ledger = (await (await fetch(`${h.url}/api/ledger`)).json()) as {
        settled: { resource: string; alias: string }[];
      };
      assert.equal(ledger.settled.length, 1);
      assert.equal(ledger.settled[0]!.resource, '/t/data');
      assert.equal(ledger.settled[0]!.alias, 'm');
    } finally {
      await h.close();
    }
  });

  test('a settled address is not offered to the next caller', async () => {
    const h = await harness({ pool, withStubRpc: true });
    try {
      const offered = await quoteFor(h.url, '/t/other', 'b1');
      const paid = await fetch(`${h.url}/t/other`, {
        headers: {
          'x-payer': 'b1',
          'x-payment': paymentHeader({ payTo: offered }),
        },
      });
      assert.equal(paid.status, 200);

      // The next *payment* (nonce 1) must not be offered the settled account.
      const next = await (
        await fetch(`${h.url}/t/other?nonce=1`, { headers: { 'x-payer': 'b1' } })
      ).json() as { accepts?: { payTo: string }[] };
      assert.ok(next.accepts?.[0], 'a second payment still gets an offer');
      assert.notEqual(next.accepts[0]!.payTo, offered);

      // Quoting the *settled* identity itself is the payer retrying a payment it
      // already made. Re-offering the spent address would move its funds into an
      // account whose settle is refused next, so the identity is reported spent
      // instead: a second payment needs a second nonce.
      const retry = await fetch(`${h.url}/t/other`, { headers: { 'x-payer': 'b1' } });
      assert.equal(retry.status, 409);
      const retryBody = (await retry.json()) as { error: string; settledAt?: string };
      assert.equal(retryBody.error, 'payment-already-settled');
      assert.ok(
        typeof retryBody.settledAt === 'string' && retryBody.settledAt.length > 0,
        'the refusal names when it settled rather than leaving the payer guessing',
      );
    } finally {
      await h.close();
    }
  });

  test('a payment into our own free seat is recorded, not dropped', async () => {
    // A hosted rail routes quote and payment to whatever instance answers, and
    // they need not be the same one. The instance that settles may never have
    // seen the quote's reservation. The money is already in our account by then,
    // so refusing would take a real payment and book nothing — the seat is ours
    // and still free, so the settlement adopts it.
    const h = await harness({ pool, withStubRpc: true });
    try {
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: 'mA3' }) },
      });
      assert.equal(res.status, 200);
      const ledger = (await (await fetch(`${h.url}/api/ledger`)).json()) as {
        settled: { alias: string }[];
      };
      assert.ok(
        ledger.settled.some((s) => s.alias === 'm'),
        'the adopted seat is recorded against its merchant',
      );
    } finally {
      await h.close();
    }
  });

  test('a second payment into an address one payment already took is refused', async () => {
    // The one thing the pool must never do is put two payments into one
    // one-time address, because that is the relinking the pool exists to
    // prevent. Adoption is allowed for a free seat only.
    const h = await harness({ pool, withStubRpc: true });
    try {
      const offered = await quoteFor(h.url, '/t/data', 'buyer1');
      const first = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: offered }) },
      });
      assert.equal(first.status, 200);

      // A different payer pays the same address the first one already used.
      const second = await fetch(`${h.url}/t/data?nonce=2`, {
        headers: { 'x-payer': 'buyer2', 'x-payment': paymentHeader({ payTo: offered }) },
      });
      const body = (await second.json()) as { error: string };
      assert.equal(second.status, 402);
      assert.equal(body.error, 'settlement-failed');
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// x402 interop surface
// ---------------------------------------------------------------------------

describe('x402 interop surface', () => {
  test('the offer names an absolute resource URL a client can fetch back', async () => {
    const h = await harness({ pool });
    try {
      const res = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'b' } });
      assert.equal(res.status, 402);
      const body = (await res.json()) as {
        resource: { url: string };
        accepts: { resource: string }[];
      };
      // x402 v2's `resource.url` is a URL. A bare path is not one, and reads as a
      // different resource to a stock x402 client than the one at the origin it
      // actually called.
      assert.equal(body.resource.url, `${h.url}/t/data`);
      assert.equal(body.accepts[0]!.resource, `${h.url}/t/data`);
    } finally {
      await h.close();
    }
  });

  test('discovery lists an absolute URL per resource', async () => {
    const h = await harness({ pool });
    try {
      const body = (await (await fetch(`${h.url}/.well-known/veil`)).json()) as {
        resources: { path: string; url: string }[];
      };
      const entry = body.resources.find((r) => r.path === '/t/data');
      assert.ok(entry, 'discovery lists the resource');
      assert.equal(entry.url, `${h.url}/t/data`);
    } finally {
      await h.close();
    }
  });

  test('the preflight allows x-payer, so a browser payer is not forced anonymous', async () => {
    const h = await harness({ pool });
    try {
      const res = await fetch(`${h.url}/t/data`, { method: 'OPTIONS' });
      assert.equal(res.status, 204);
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      // Without x-payer, a same-site fetch from a browser fails the preflight,
      // and every browser payer collapses onto the `anonymous` identity.
      assert.match(allowed, /x-payer/);
      assert.match(allowed, /x-payment/);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Minimal setup: a wallet and a price, nothing else
// ---------------------------------------------------------------------------

describe('minimal setup (veil)', () => {
  async function merchant(
    overrides: Parameters<typeof veil>[0] = { payTo: 'MerchantWallet1111111111111111111111111111' },
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'veil-min-'));
    const m = await veil({
      ledgerPath: join(dir, 'pool.json'),
      ...overrides,
    });
    await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', () => r()));
    const addr = m.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      merchant: m,
      close: async () => {
        await new Promise<void>((r) => m.server.close(() => r()));
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  test('a wallet and a price are enough to quote a paid resource', async () => {
    const h = await merchant({ payTo: 'MerchantWallet1111111111111111111111111111', price: '0.25', path: '/api/x' });
    try {
      assert.equal(h.merchant.provisioned, 8, 'first run provisions the pool');
      const res = await fetch(`${h.url}/api/x`, { headers: { 'x-payer': 'buyer' } });
      assert.equal(res.status, 402);
      const body = (await res.json()) as {
        network: string;
        resource: { url: string };
        accepts: {
          asset: string;
          payTo: string;
          maxAmountRequired: string;
          extra: { decimals: number };
        }[];
      };
      const accept = body.accepts[0]!;
      assert.ok(accept.payTo, 'a one-time account was offered');
      assert.equal(accept.maxAmountRequired, '250000', 'the price is priced at mint precision');
      // Everything beside payTo came from the hosted rail's public defaults.
      assert.equal(accept.asset, HOSTED_DEFAULTS.asset);
      assert.equal(accept.extra.decimals, HOSTED_DEFAULTS.decimals);
      assert.equal(body.resource.url, `${h.url}/api/x`);
    } finally {
      await h.close();
    }
  });

  test('a second run reuses the pool instead of minting new accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veil-min-reuse-'));
    const ledgerPath = join(dir, 'pool.json');
    try {
      const first = await veil({ payTo: 'MerchantWallet1111111111111111111111111111', ledgerPath });
      const second = await veil({ payTo: 'MerchantWallet1111111111111111111111111111', ledgerPath });
      assert.equal(first.provisioned, 8);
      assert.equal(second.provisioned, 0, 'the pool was already provisioned');
      assert.equal(
        second.ledger.armedFor('MerchantWallet1111111111111111111111111111').length,
        8,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('discovery describes the merchant without extra configuration', async () => {
    const h = await merchant({ payTo: 'MerchantWallet1111111111111111111111111111', path: '/api/y' });
    try {
      const body = (await (await fetch(`${h.url}/.well-known/veil`)).json()) as {
        scheme: string;
        resources: { path: string; url: string }[];
      };
      assert.equal(body.scheme, 'exact-confidential');
      const entry = body.resources.find((r) => r.path === '/api/y');
      assert.ok(entry, 'the merchant resource is discoverable');
      assert.equal(entry.url, `${h.url}/api/y`);
    } finally {
      await h.close();
    }
  });

  test('payTo is the one field that is not optional', async () => {
    await assert.rejects(
      () => veil({ payTo: '' }),
      /payTo is required/,
    );
  });
});

describe('a durable ledger records the reservation, not only the settlement', () => {
  test('quoting writes the seat it just offered, so another instance cannot offer it too', async () => {
    const h = await harness({ pool, withStore: true });
    try {
      const offered = await quoteFor(h.url, '/t/data', 'buyer1');

      // The unpaid request is the moment the seat stops being available.
      assert.ok(h.saves.length >= 1, 'the quote must be written down');
      const last = h.saves.at(-1)!;
      const entry = last.resolve(offered);
      assert.ok(entry, 'the offered seat is in the persisted ledger');
      assert.ok(entry.consumedBy !== null, 'and it is marked consumed by this payment');

      // A different payment asking next gets a different seat, from the same
      // written-down state another instance would read.
      const second = await quoteFor(h.url, '/t/data', 'buyer2');
      assert.notEqual(second, offered);
      assert.equal(h.saves.at(-1)!.resolve(second)?.consumedBy !== null, true);
    } finally {
      await h.close();
    }
  });

  test('without a store a quote is not a disk write, so the seeded pool stays clean', async () => {
    // The local file is the committed seed; dirtying it on every unpaid GET
    // would make a quote look like a settlement in git.
    const h = await harness({ pool });
    try {
      await quoteFor(h.url, '/t/data', 'buyer1');
      assert.equal(h.saves.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe('health counts what the ledger knows, not what this process did', () => {
  test('a reservation is not a settlement, and a settlement is one', async () => {
    const h = await harness({ pool, withStubRpc: true });
    try {
      const offered = await quoteFor(h.url, '/t/data', 'buyer1');
      const afterQuote = (await (await fetch(`${h.url}/v1/health`)).json()) as {
        settled: number;
      };
      // Quoting consumes a seat. It is not a settlement, and a count that used
      // `consumedBy` would call it one — which is why it counts `settledAt`.
      assert.equal(afterQuote.settled, 0);

      const paid = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: offered }) },
      });
      assert.equal(paid.status, 200);

      const afterPay = (await (await fetch(`${h.url}/v1/health`)).json()) as {
        settled: number;
      };
      assert.equal(afterPay.settled, 1);

      const dashboard = (await (await fetch(`${h.url}/api/ledger`)).json()) as {
        settled: { address: string; resource: string | null }[];
      };
      assert.equal(dashboard.settled.length, 1);
      assert.equal(dashboard.settled[0]!.address, offered);
      assert.equal(dashboard.settled[0]!.resource, '/t/data');
    } finally {
      await h.close();
    }
  });
});

describe('a seat is claimed before it is offered', () => {
  test('an offer that lost the race is retried onto a seat this payment does own', async () => {
    const h = await harness({ pool, withStore: true, contend: 'once' });
    try {
      const offered = await quoteFor(h.url, '/t/data', 'buyer1');

      const persisted = h.saves.at(-1)!;
      const foreign = persisted.allFor().filter((e) => e.consumedBy?.startsWith('payment-from-another-instance'));
      // The other instance's claim survived — it was first — and the seat this
      // instance was told to pay is not that one.
      assert.equal(foreign.length, 1, 'the other instance kept exactly the seat it took');
      assert.notEqual(offered, foreign[0]!.address);
      assert.ok(
        persisted.resolve(offered)!.consumedBy !== null,
        'the seat actually offered is owned by this payment',
      );
      assert.equal(persisted.armedFor('m').length, 6, 'two of the eight seats are now spent');
    } finally {
      await h.close();
    }
  });

  test('a race that cannot be won is refused, never offered', async () => {
    // Every write loses. Offering any seat here would sell an address this
    // instance does not hold, which the payer would pay into and then be refused
    // for — money moved, nothing credited. Refusing is the only honest answer.
    const h = await harness({ pool, withStore: true, contend: 'always' });
    try {
      const res = await fetch(`${h.url}/t/data`, { headers: { 'x-payer': 'buyer1' } });
      const body = (await res.json()) as {
        accepts: { payTo: string }[];
        veil: { refused: string };
      };
      assert.equal(res.status, 503);
      assert.equal(body.veil.refused, 'VEIL-CONF-006');
      assert.equal(body.accepts.length, 0, 'no address is ever named');
    } finally {
      await h.close();
    }
  });
});

describe('one dashboard for a rail that answers on many instances', () => {
  test('a settlement one instance broadcast is listed by another, signature included', async () => {
    // Two harnesses over one store are two deployments of the same rail: the
    // seat map is shared, and until now the settlement record was not, so the
    // second instance could show the seat as spent but not what settled it.
    const records: StoredSettlement[] = [];
    let persisted: PoolLedger | null = null;
    const shared: LedgerStore = {
      load: async () => persisted,
      save: async (next) => {
        persisted = PoolLedger.fromJSON(next.toJSON());
      },
      loadSettlements: async () => [...records],
      appendSettlement: async (settlement) => {
        if (!records.some((row) => row.address === settlement.address)) records.push(settlement);
      },
    };

    const payer = await harness({ pool, withStubRpc: true, store: shared });
    const other = await harness({ pool, store: shared });
    try {
      const offered = await quoteFor(payer.url, '/t/data', 'buyer1');
      const paid = await fetch(`${payer.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: offered }) },
      });
      assert.equal(paid.status, 200);

      // Health first, on the instance that did NOT take the payment: the count
      // comes from the shared seat map, so it only agrees across instances once
      // this one has read the shared copy — a stale snapshot here showed 0.
      const health = (await (await fetch(`${other.url}/v1/health`)).json()) as {
        settled: number;
      };
      assert.equal(health.settled, 1, 'health agrees without this instance having settled anything');

      const dashboard = (await (await fetch(`${other.url}/api/ledger`)).json()) as {
        settled: { address: string; signature: string | null; amount: string }[];
      };
      const row = dashboard.settled.find((s) => s.address === offered);
      assert.ok(row, 'the other instance lists the settled seat');
      assert.equal(row.signature, 'StubSig111', 'and it has the signature it never produced');
      assert.equal(row.amount, '49000');
    } finally {
      await payer.close();
      await other.close();
    }
  });
});
