import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEVNET, PLACEHOLDER_MINT, SOLANA_DEVNET } from '../../x402-core/src/index.ts';
import { PoolLedger } from '../../derive/src/index.ts';
import {
  createFacilitator,
  createVeilServer,
  defaultConfig,
  poolLedgerProbe,
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
    const first = await (
      await fetch(`${h.url}/t/other`, { headers: { 'x-payer': 'b1' } })
    ).json() as { accepts: { payTo: string }[] };
    const second = await (
      await fetch(`${h.url}/t/other`, { headers: { 'x-payer': 'b1' } })
    ).json() as { accepts: { payTo: string }[] };
    // Distinct destinations are the whole point of the second privacy layer.
    assert.notEqual(first.accepts[0]!.payTo, second.accepts[0]!.payTo);
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

  test('the second call on a one-account pool is VEIL-CONF-005', async () => {
    const first = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
    assert.equal(first.status, 402);
    const firstBody = (await first.json()) as { veil?: unknown };
    assert.equal(firstBody.veil, undefined);

    const second = await fetch(`${h.url}/t/one`, { headers: { 'x-payer': 'b1' } });
    const secondBody = (await second.json()) as { veil: { refused: string } };
    // Reusing the spent address would relink the two payments, so Veil refuses.
    assert.equal(second.status, 503);
    assert.equal(secondBody.veil.refused, 'VEIL-CONF-005');
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

      const next = await quoteFor(h.url, '/t/other', 'b1');
      assert.notEqual(next, offered);
    } finally {
      await h.close();
    }
  });

  test('paying an address that was never reserved is rejected', async () => {
    const h = await harness({ pool, withStubRpc: true });
    try {
      // mA3 exists in the pool but no quote ever offered it for this call, so
      // there is no offer to reconcile the settlement against.
      const res = await fetch(`${h.url}/t/data`, {
        headers: { 'x-payer': 'buyer1', 'x-payment': paymentHeader({ payTo: 'mA3' }) },
      });
      const body = (await res.json()) as { error: string; detail: string };
      // A payer mistake is a client error, not a server fault.
      assert.equal(res.status, 402);
      assert.equal(body.error, 'settlement-failed');
      assert.match(body.detail, /never reserved/);
    } finally {
      await h.close();
    }
  });
});
