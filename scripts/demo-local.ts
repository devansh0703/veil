/**
 * The local protocol demo: the whole payment flow, no chain funds required.
 *
 *   npm run demo:local
 *
 * This runs the real server, the real 402 issuance, the real pool reservation,
 * the real verification, and the real settlement accounting — over HTTP, with
 * real generated keypairs as the one-time payment accounts. It drives a
 * workload of payments across three merchants and records every outcome it
 * actually observed: settlements, reservations that stayed in flight, and
 * refusals with their codes.
 *
 * What it does not do is broadcast. On a machine without devnet funds the
 * on-chain half cannot execute, so the run reports itself as `local-ledger-only`
 * and writes that fact into every artefact it produces. Rather than fake a
 * settlement to make a nicer demo, this exercises everything that does work and
 * states plainly what it skipped. `npm run setup:devnet` is the funded path.
 *
 * The data this writes is what the web surfaces render. Nothing on those pages
 * is invented: if a figure appears there, it came out of this run.
 */

import { rm } from 'node:fs/promises';

import { generateKeyPairSigner } from '@solana/kit';

import {
  createFacilitator,
  createVeilServer,
  DEFAULT_RESOURCES,
  type ResourceDefinition,
} from '../packages/server/src/index.ts';
import { PoolLedger, derivePaymentId } from '../packages/derive/src/index.ts';
import {
  buildPaymentPayload,
  formatAtomic,
  priceFor,
  type Atomic,
  type VeilAccept,
  type VeilPaymentPayload,
} from '../packages/x402-core/src/index.ts';
import {
  configFrom,
  DEMO_DIR,
  DEMO_LEDGER_PATH,
  DEMO_RUN_PATH,
  optionsFromEnv,
  relative,
  saveLedger,
  saveJSON,
  table,
} from './lib.ts';

/**
 * The demo declares its preconditions instead of reading them.
 *
 * A run with no chain access cannot verify that the mint carries the
 * confidential-transfer extension, so it does not pretend to: it declares the
 * value, the server publishes it as coming from `pool-ledger` and not from
 * `chain`, and the run file records the same thing. The phase below proves the
 * fail-closed default by starting a server with nothing to vouch for it.
 */
const PRECONDITIONS_DECLARED = { mintConfidential: true } as const;

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

/** One settled payment, exactly as the server accounted for it. */
interface SettledEvent {
  readonly kind: 'settled';
  readonly paymentId: string;
  readonly alias: string;
  readonly label: string;
  readonly address: string;
  readonly slot: number;
  readonly resource: string;
  readonly amount: string;
  readonly amountFormatted: string;
  readonly at: string;
  readonly payer: string;
  readonly nonce: number;
}

/** A reservation that was quoted and never paid: a real in-flight row. */
interface InFlightEvent {
  readonly kind: 'in-flight';
  readonly paymentId: string;
  readonly alias: string;
  readonly label: string;
  readonly address: string;
  readonly slot: number;
  readonly resource: string;
  readonly amount: string;
  readonly amountFormatted: string;
  readonly quotedAt: string;
  readonly payer: string;
  readonly nonce: number;
}

/** A refusal, with the code the server actually returned. */
interface RefusedEvent {
  readonly kind: 'refused';
  readonly code: string;
  readonly title: string;
  readonly remedy: string;
  readonly resource: string;
  readonly alias: string;
  readonly at: string;
  readonly httpStatus: number;
  readonly detail: string;
}

type VeilEvent = SettledEvent | InFlightEvent | RefusedEvent;

const cli = optionsFromEnv(process.argv.slice(2));

/**
 * How many payments each merchant receives in this run.
 *
 * Bounded by the pool: an address is used once, so a merchant cannot settle
 * more payments than it has accounts. The slack below the pool size is what
 * leaves room for the in-flight and exhaustion phases to demonstrate different
 * real outcomes.
 */
const settledPerResource = Math.max(4, Math.min(cli.poolSize + 8, 24) - 5);

/**
 * The session cap the buyer declares for this run.
 *
 * Derived from the workload rather than picked for effect: twice the total the
 * run intends to spend, so the cap is a real ceiling the buyer would plausibly
 * set and not a number chosen to avoid tripping it. `VEIL_SPEND_CAP` overrides.
 */
const plannedSpend = DEFAULT_RESOURCES.reduce(
  (sum, r) =>
    sum +
    priceFor(
      {
        base: r.base,
        ...(r.perUnit !== undefined ? { perUnit: r.perUnit } : {}),
        ...(r.units !== undefined ? { units: r.units } : {}),
      },
      cli.decimals,
    ) *
      BigInt(settledPerResource),
  0n,
);

const options = {
  ...cli,
  spendCap: process.env.VEIL_SPEND_CAP ?? formatAtomic(plannedSpend * 2n, cli.decimals, ''),
  allowLocalSettlement: true,
  ledgerPath: DEMO_LEDGER_PATH,
};

interface Scenario {
  readonly name: string;
  readonly outcome: string;
  readonly detail: string;
  readonly pass: boolean;
}
const scenarios: Scenario[] = [];
function check(name: string, pass: boolean, detail: string, outcome = ''): void {
  scenarios.push({ name, pass, detail, outcome: outcome || (pass ? 'ok' : 'FAILED') });
}

const events: VeilEvent[] = [];

// ---------------------------------------------------------------------------
// 0. A fresh pool, because a consumed address is never reusable
// ---------------------------------------------------------------------------

await rm(DEMO_DIR, { recursive: true, force: true });

const ledger = PoolLedger.empty();
const aliases = [...new Set(DEFAULT_RESOURCES.map((r) => r.alias))];
const poolSize = Math.max(options.poolSize, 16);

for (const alias of aliases) {
  for (let slot = 0; slot < poolSize; slot++) {
    // Real keypairs: the addresses are genuine and would be createable on chain.
    // Their secrets are discarded immediately — a token account's authority is
    // the merchant's wallet, so the account key is needed once, at creation, and
    // never again. Keeping it would be a liability with no benefit.
    const signer = await generateKeyPairSigner();
    ledger.register({ slot, address: signer.address, alias, armed: true });
  }
}
await saveLedger(ledger, DEMO_LEDGER_PATH);

check(
  'pool provisioned',
  ledger.size > 0,
  `${ledger.size} one-time accounts across ${aliases.length} merchants (${poolSize} each)`,
);

// ---------------------------------------------------------------------------
// 1. Serve it for real, over HTTP
// ---------------------------------------------------------------------------

const config = configFrom({ ...options, ...PRECONDITIONS_DECLARED }, ledger);
const facilitator = createFacilitator(config, ledger);
const server = createVeilServer(config, facilitator);
await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', () => resolve()));
const base = `http://127.0.0.1:${options.port}`;

/**
 * Base64 of a well-formed payment for an offer we were quoted.
 *
 * Built by `buildPaymentPayload` rather than by hand, so the payload carries the
 * same `accepted` terms the server quoted and stays valid under x402's own
 * schema. The transaction is a placeholder: local mode does not broadcast, and
 * the demo never claims otherwise.
 */
function payload(accept: VeilAccept): string {
  return Buffer.from(
    JSON.stringify(
      buildPaymentPayload({
        accept,
        transaction: Buffer.from('veil-local-demo').toString('base64'),
        payTo: accept.payTo,
      }),
    ),
    'utf8',
  ).toString('base64');
}

/**
 * Base64 of a payload that has been *tampered with after signing*.
 *
 * The negative cases below deliberately pay the wrong mint or the wrong
 * merchant's account. Those payloads must be assembled by mutating a good one,
 * because that is exactly the attack being tested: the offer is honest and the
 * payload is not. `accepted` keeps saying what was quoted, which is the point —
 * the merchant must reject on the payload, never on the claim.
 */
function tamperedPayload(
  accept: VeilAccept,
  overrides: { readonly asset?: string; readonly payTo?: string },
): string {
  const good = buildPaymentPayload({
    accept,
    transaction: Buffer.from('veil-local-demo').toString('base64'),
    payTo: accept.payTo,
  }) as VeilPaymentPayload;
  const tampered = {
    ...good,
    payload: { ...good.payload, ...overrides },
  };
  return Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64');
}

interface HttpResult {
  readonly status: number;
  readonly body: any;
}

async function quote(
  path: string,
  payer: string,
  nonce = 0,
): Promise<HttpResult> {
  const res = await fetch(`${base}${path}?nonce=${nonce}`, { headers: { 'x-payer': payer } });
  return { status: res.status, body: await res.json() };
}

async function pay(
  path: string,
  payer: string,
  accept: VeilAccept,
  nonce = 0,
  tamper?: { readonly asset?: string; readonly payTo?: string },
): Promise<HttpResult> {
  const payment = tamper ? tamperedPayload(accept, tamper) : payload(accept);
  const res = await fetch(`${base}${path}?nonce=${nonce}`, {
    headers: { 'x-payer': payer, 'x-payment': payment },
  });
  return { status: res.status, body: await res.json() };
}

/** What this resource costs, computed by the same code the server prices with. */
function amountOf(resource: ResourceDefinition): Atomic {
  return priceFor(
    {
      base: resource.base,
      ...(resource.perUnit !== undefined ? { perUnit: resource.perUnit } : {}),
      ...(resource.units !== undefined ? { units: resource.units } : {}),
    },
    config.decimals,
  );
}

function recordRefusal(
  resource: ResourceDefinition,
  result: HttpResult,
  fallbackDetail: string,
): RefusedEvent {
  const veil = result.body?.veil ?? {};
  const event: RefusedEvent = {
    kind: 'refused',
    code: String(veil.refused ?? result.body?.error ?? 'unknown'),
    title: String(veil.message ?? result.body?.error ?? 'refused'),
    remedy: String(veil.remedy ?? ''),
    resource: resource.path,
    alias: resource.alias,
    at: new Date().toISOString(),
    httpStatus: result.status,
    detail: String(result.body?.detail ?? fallbackDetail).slice(0, 200),
  };
  events.push(event);
  return event;
}

// ---------------------------------------------------------------------------
// 2. A workload: many payments, so the ledger has something real in it
// ---------------------------------------------------------------------------

let settledCount = 0;

for (const resource of DEFAULT_RESOURCES) {
  for (let i = 0; i < settledPerResource; i++) {
    const payer = `agent-${resource.alias.replace(/\W+/g, '-')}-${i}`;
    const asked = await quote(resource.path, payer, i);
    const offer = asked.body?.accepts?.[0];
    if (asked.status !== 402 || !offer) {
      recordRefusal(resource, asked, `quote returned ${asked.status}`);
      continue;
    }

    const settled = await pay(resource.path, payer, offer, i);
    if (settled.status !== 200 || settled.body?.paid !== true) {
      recordRefusal(resource, settled, `pay returned ${settled.status}`);
      continue;
    }

    const amount = amountOf(resource);
    events.push({
      kind: 'settled',
      // The same identity the server used: resource + payer + nonce. The server
      // does not echo it back, because the payer can recompute it — which is the
      // point of a deterministic id.
      paymentId: derivePaymentId({ resource: resource.path, payer, nonce: i }),
      alias: resource.alias,
      label: resource.description,
      address: offer.payTo,
      slot: Number(offer.extra?.poolIndex ?? 0),
      resource: resource.path,
      amount: amount.toString(),
      amountFormatted: formatAtomic(amount, config.decimals),
      at: String(settled.body?.settled?.at ?? new Date().toISOString()),
      payer,
      nonce: i,
    });
    settledCount += 1;
  }
}

check(
  'workload settled confidentially',
  settledCount >= DEFAULT_RESOURCES.length * 4,
  `${settledCount} payments across ${DEFAULT_RESOURCES.length} resources, every one into its own pre-configured account`,
);

// ---------------------------------------------------------------------------
// 3. In-flight: quoted, reserved, not yet settled — a real state, shown as one
// ---------------------------------------------------------------------------

let inFlightCount = 0;
for (const resource of DEFAULT_RESOURCES) {
  for (let i = 0; i < 2; i++) {
    const payer = `agent-late-${resource.alias.replace(/\W+/g, '-')}-${i}`;
    const asked = await quote(resource.path, payer, 900 + i);
    const offer = asked.body?.accepts?.[0];
    if (asked.status !== 402 || !offer) continue;
    const amount = amountOf(resource);
    events.push({
      kind: 'in-flight',
      paymentId: derivePaymentId({ resource: resource.path, payer, nonce: 900 + i }),
      alias: resource.alias,
      label: resource.description,
      address: offer.payTo,
      slot: Number(offer.extra?.poolIndex ?? 0),
      resource: resource.path,
      amount: amount.toString(),
      amountFormatted: formatAtomic(amount, config.decimals),
      quotedAt: new Date().toISOString(),
      payer,
      nonce: 900 + i,
    });
    inFlightCount += 1;
  }
}

check(
  'in-flight reservations are tracked separately',
  inFlightCount === DEFAULT_RESOURCES.length * 2,
  `${inFlightCount} reserved accounts awaiting settlement — never counted as settled`,
);

// ---------------------------------------------------------------------------
// 4. The two privacy layers, asserted against the run itself
// ---------------------------------------------------------------------------

const firstAccept = (await quote(DEFAULT_RESOURCES[0]!.path, 'agent-south', 1)).body.accepts[0];
const secondAccept = (await quote(DEFAULT_RESOURCES[0]!.path, 'agent-south', 2)).body.accepts[0];
const first = firstAccept.payTo;
const second = secondAccept.payTo;
check(
  'two payments never share a destination',
  first !== second,
  `${first.slice(0, 8)}… vs ${second.slice(0, 8)}…`,
);

const destinations = new Set(events.flatMap((e) => ('address' in e ? [e.address] : [])));
const addressCount = events.filter((e) => 'address' in e).length;
check(
  'no address was ever used twice',
  destinations.size === addressCount,
  `${destinations.size} distinct addresses for ${addressCount} payments`,
);

// ---------------------------------------------------------------------------
// 5. The things that must be refused
// ---------------------------------------------------------------------------

// A payment in the wrong mint.
const wrongMint = await pay(
  DEFAULT_RESOURCES[0]!.path,
  'agent-south',
  firstAccept,
  1,
  // Wrapped SOL: a real, valid, different mint. Using an unparseable string here
  // would test address validation rather than the mint mismatch this asserts.
  { asset: 'So11111111111111111111111111111111111111112' },
);
check(
  'wrong mint rejected',
  wrongMint.status === 402,
  String(wrongMint.body.detail ?? '').slice(0, 88),
  `http ${wrongMint.status}`,
);

// A payment to another merchant's account.
const other = ledger.allFor().find((e) => e.alias !== DEFAULT_RESOURCES[0]!.alias)!;
const wrongMerchant = await pay(DEFAULT_RESOURCES[0]!.path, 'agent-south', firstAccept, 1, {
  payTo: other.address,
});
recordRefusal(DEFAULT_RESOURCES[0]!, wrongMerchant, 'payment to an account owned by another merchant');
check(
  "another merchant's account rejected",
  wrongMerchant.status === 402,
  String(wrongMerchant.body.detail ?? '').slice(0, 88),
  `http ${wrongMerchant.status}`,
);

// Exhausting a merchant's pool must refuse, never reuse.
const victim = DEFAULT_RESOURCES[2]!;
let exhausted: RefusedEvent | undefined;
for (let i = 0; i < poolSize * 3 && !exhausted; i++) {
  const q = await quote(victim.path, `drain-${i}`, 5000 + i);
  if (q.body?.veil?.refused) {
    exhausted = recordRefusal(victim, q, 'pool exhausted while quoting');
  }
}
check(
  'exhausted pool refuses (never reuses an address)',
  exhausted?.code === 'VEIL-CONF-005',
  `after draining ${ledger.allFor(victim.alias).length} accounts: ${exhausted?.code ?? 'no refusal seen'}`,
  exhausted?.code ?? 'none',
);

// ---------------------------------------------------------------------------
// 6. The spend cap, proven on a second run of the same server code
// ---------------------------------------------------------------------------

// The cap is enforced server-side from the config, so proving it means running
// the same code under a tighter cap. A fresh in-memory ledger keeps this phase
// from disturbing the run above.
const tightOptions = { ...options, port: options.port + 1, spendCap: '0.001' };
const tightLedger = PoolLedger.empty();
const tightSigner = await generateKeyPairSigner();
for (let slot = 0; slot < 4; slot++) {
  const signer = await generateKeyPairSigner();
  tightLedger.register({ slot, address: signer.address, alias: victim.alias, armed: true });
}
tightLedger.register({
  slot: 4,
  address: tightSigner.address,
  alias: victim.alias,
  armed: true,
});
const tightConfig = configFrom({ ...tightOptions, ...PRECONDITIONS_DECLARED }, tightLedger);
const tightFacilitator = createFacilitator(tightConfig, tightLedger);
const tightServer = createVeilServer(tightConfig, tightFacilitator);
await new Promise<void>((resolve) => tightServer.listen(tightOptions.port, '127.0.0.1', () => resolve()));

let capped: RefusedEvent | undefined;
try {
  const res = await fetch(`http://127.0.0.1:${tightOptions.port}${victim.path}`, {
    headers: { 'x-payer': 'agent-over-cap' },
  });
  const body = await res.json();
  if ((body as any)?.veil?.refused) {
    capped = recordRefusal(victim, { status: res.status, body }, 'spend cap exceeded while quoting');
  }
} finally {
  await new Promise<void>((resolve) => tightServer.close(() => resolve()));
}
check(
  'spend cap enforced server-side',
  capped?.code === 'VEIL-CONF-004',
  `declared cap 0.001 VeilUSD against a ${formatAtomic(amountOf(victim), config.decimals)} resource: ${capped?.code ?? 'no refusal seen'}`,
  capped?.code ?? 'none',
);

// ---------------------------------------------------------------------------
// 7. With nothing to vouch for its own claim, the server refuses
// ---------------------------------------------------------------------------

// No probe at all: a process that has not been told how to check the
// confidential preconditions. This is the fail-closed default a fresh
// deployment starts from, and it produces a real VEIL-CONF-003.
const unverifiedLedger = PoolLedger.empty();
for (let slot = 0; slot < 2; slot++) {
  const signer = await generateKeyPairSigner();
  unverifiedLedger.register({ slot, address: signer.address, alias: victim.alias, armed: true });
}
const unverifiedConfig = configFrom(
  { ...options, port: options.port + 2, mintConfidential: 'unknown' },
  // Deliberately no ledger: the probe stays unwired.
);
const unverifiedFacilitator = createFacilitator(unverifiedConfig, unverifiedLedger);
const unverifiedServer = createVeilServer(unverifiedConfig, unverifiedFacilitator);
await new Promise<void>((resolve) => unverifiedServer.listen(options.port + 2, '127.0.0.1', () => resolve()));

let failClosed: RefusedEvent | undefined;
try {
  const res = await fetch(`http://127.0.0.1:${options.port + 2}${victim.path}`, {
    headers: { 'x-payer': 'agent-unverified' },
  });
  const body = await res.json();
  if ((body as any)?.veil?.refused) {
    failClosed = recordRefusal(victim, { status: res.status, body }, 'no precondition probe configured');
  }
} finally {
  await new Promise<void>((resolve) => unverifiedServer.close(() => resolve()));
}
check(
  'a server with no precondition probe refuses (VEIL-CONF-003)',
  failClosed?.code === 'VEIL-CONF-003',
  `no probe configured: ${failClosed?.code ?? 'no refusal seen'}`,
  failClosed?.code ?? 'none',
);

// ---------------------------------------------------------------------------
// 8. Persist what really happened, and report
// ---------------------------------------------------------------------------

const ledgerView = (await (await fetch(`${base}/api/ledger`)).json()) as {
  settled: { paymentId: string; resource: string; alias: string; address: string; amount: string; at: string }[];
  pool: unknown[];
};

const settled = events.filter((e): e is SettledEvent => e.kind === 'settled');
const inFlight = events.filter((e): e is InFlightEvent => e.kind === 'in-flight');
const refused = events.filter((e): e is RefusedEvent => e.kind === 'refused');

const vendorTotals = aliases.map((alias) => {
  const own = settled.filter((e) => e.alias === alias);
  const total = own.reduce((sum, e) => sum + BigInt(e.amount), 0n);
  return {
    alias,
    label: DEFAULT_RESOURCES.find((r) => r.alias === alias)?.description ?? alias,
    total: total.toString(),
    totalFormatted: formatAtomic(total, config.decimals),
    payments: own.length,
    inFlight: inFlight.filter((e) => e.alias === alias).length,
    lastAt: own.reduce<string | null>((latest, e) => (latest === null || e.at > latest ? e.at : latest), null),
  };
});

const settledTotal = settled.reduce((sum, e) => sum + BigInt(e.amount), 0n);

const run = {
  mode: 'local-ledger-only' as const,
  chain: 'not-executed' as const,
  note:
    'Produced by npm run demo:local. Every settled row is an accounting record from a real run of the ' +
    'protocol code against a real local HTTP server, with real generated keypairs as the one-time payment ' +
    'accounts. No transaction was broadcast and no devnet account was touched, so no figure here is a chain fact.',
  // Stated explicitly so nothing downstream has to infer it: the confidential
  // preconditions were declared by this run, not read from devnet.
  privacyGate: {
    mode: 'enforcing',
    preconditions: 'declared, not chain-read',
    source: 'pool-ledger',
    note:
      'The run cannot read devnet, so the mint extension and the account credit flags are declared. The ' +
      'server publishes this as privacySource: pool-ledger. A devnet deployment that verifies the mint ' +
      'reports privacySource: chain instead.',
  },
  producedAt: new Date().toISOString(),
  network: String(config.network),
  mint: config.mint,
  decimals: config.decimals,
  spendCap: options.spendCap,
  poolSize,
  aliases: [...aliases],
  vendorTotals,
  totals: {
    settled: settledTotal.toString(),
    settledFormatted: formatAtomic(settledTotal, config.decimals),
    settledCount: settled.length,
    inFlightCount: inFlight.length,
    refusedCount: refused.length,
    poolAccounts: ledgerView.pool.length,
  },
  settled,
  inFlight,
  refused,
  scenarios: scenarios.map((s) => ({ name: s.name, outcome: s.outcome, detail: s.detail, pass: s.pass })),
  endpoints: {
    capabilities: `${base}/.well-known/veil`,
    health: `${base}/v1/health`,
    ledger: `${base}/api/ledger`,
  },
};

await saveJSON(DEMO_RUN_PATH, run);
await new Promise<void>((resolve) => server.close(() => resolve()));

const passed = scenarios.filter((s) => s.pass).length;
process.stdout.write(
  [
    '',
    'Veil — local protocol demo (no chain funds used)',
    '',
    table([
      ['scenario', 'outcome', 'detail'],
      ...scenarios.map((s) => [s.name, s.outcome, s.detail.slice(0, 60)]),
    ]),
    '',
    `${passed}/${scenarios.length} scenarios passed`,
    '',
    table([
      ['settled', `${settled.length} payments · ${run.totals.settledFormatted}`],
      ['in flight', `${inFlight.length} reserved, unsettled`],
      ['refused', `${refused.length} recorded with codes: ${[...new Set(refused.map((r) => r.code))].join(', ')}`],
      ['pool', `${ledgerView.pool.length} one-time accounts, no reuse`],
      ['chain', 'not-executed (local-ledger-only settlement)'],
      ['run file', relative(DEMO_RUN_PATH)],
    ]),
    '',
    'Render this run into the web surfaces:',
    '  npm run pages',
    '',
  ].join('\n'),
);

process.exit(passed === scenarios.length ? 0 : 1);
