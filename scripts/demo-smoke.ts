#!/usr/bin/env node
/**
 * `npm run demo:smoke` — fifty confidential payments, checked as a set.
 *
 * One payment proves the path works. Fifty prove the *properties* hold at volume,
 * which is where the interesting failures live: a pool that reuses a seat, a
 * counter that reports zero because a branch forgot to increment it, a payment
 * that is accepted while carrying a readable amount. Each of those passes a
 * single-payment test and fails this one.
 *
 * The three assertions are the deliverable's own:
 *
 *   - **exactly N distinct seat addresses** — the pool never reuses a one-time
 *     account, which is the property that keeps two payments from sitting next to
 *     each other on the public graph;
 *   - **zero publicly readable amounts** — every transaction the rail accepted
 *     carried a Token-2022 confidential transfer, checked by re-reading each wire
 *     with the same inspector the rail uses;
 *   - **zero confidentiality assertion failures** — the counter D-4 publishes.
 *
 * Settlement runs in `local-ledger-only` mode, and the report says so: fifty
 * devnet broadcasts are not something a checkout should be able to spend, and a
 * run that cannot broadcast must not report a settlement it did not make. The
 * broadcast leg is proven by `npm run pay:live` and re-derived by `npm run replay`;
 * this script proves the protocol at volume.
 *
 *   npm run demo:smoke                  # 50 payments
 *   npm run demo:smoke -- --count 100 --pace 50
 */

import { DEFAULT_RESOURCES } from '../packages/server/src/index.ts';
import { inspectPaymentTransaction } from '../packages/server/src/inspect.ts';
import { PLACEHOLDER_MINT } from '../packages/x402-core/src/index.ts';
import { table } from './lib.ts';
import { ensureScratch, paymentHeaderFrom, provisionSeats, startLocalRail } from './rail-testkit.ts';

const argv = process.argv.slice(2);
const countFlag = argv.indexOf('--count');
const paceFlag = argv.indexOf('--pace');
const count = countFlag === -1 ? 50 : Number(argv[countFlag + 1]);
const pace = paceFlag === -1 ? 0 : Number(argv[paceFlag + 1]);

if (!Number.isSafeInteger(count) || count < 1) throw new Error('--count must be a positive integer');
if (!Number.isFinite(pace) || pace < 0) throw new Error('--pace must be a non-negative number of ms');

// The cheapest resource in the catalogue: a smoke run buys N seats, and the pool
// has to hold them all.
const RESOURCE_PATH = '/v1/payee/test';
const resource = DEFAULT_RESOURCES.find((r) => r.path === RESOURCE_PATH)!;
// Eight seats more than the run needs, because the pool is consumed permanently
// by design — seats are never re-armed — so a pool sized exactly to the run would
// make the *last* payment the one that fails.
const POOL_SIZE = count + 8;

const out = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

await ensureScratch();
const { ledger, addresses } = await provisionSeats(resource.alias, POOL_SIZE);
const rail = await startLocalRail({ ledger, seats: addresses, resources: DEFAULT_RESOURCES, sessions: false });

out('Veil — payment smoke');
out(
  table([
    ['', 'rail', `${rail.url} (started here, real HTTP)`],
    ['', 'resource', `${RESOURCE_PATH} at ${resource.base} per call`],
    ['', 'payments', String(count)],
    ['', 'pace', pace === 0 ? 'none (no chain endpoint is contacted in this mode)' : `${pace} ms`],
    ['', 'pool', `${POOL_SIZE} seats provisioned, consumed permanently`],
    ['', 'settlement', 'local-ledger-only — no broadcast, and every row says so'],
  ]),
);
out();

interface Attempt {
  readonly i: number;
  readonly seat: string;
  readonly status: number;
  readonly ms: number;
  readonly confidential: boolean;
  readonly detail: string;
}

const attempts: Attempt[] = [];

for (let i = 1; i <= count; i++) {
  const started = Date.now();
  // A fresh payment identity per call: a different nonce is a different payment,
  // which is what makes the pool hand out a different seat.
  const quoteRes = await fetch(`${rail.url}${RESOURCE_PATH}?nonce=${i}`, {
    headers: { 'x-payer': 'smoke-agent' },
  });
  const quote = (await quoteRes.json()) as {
    accepts: readonly {
      readonly scheme: string;
      readonly network: string;
      readonly asset: string;
      readonly payTo: string;
      readonly amount: string;
      readonly maxAmountRequired: string;
      readonly resource: string;
      readonly maxTimeoutSeconds: number;
      readonly extra: Record<string, unknown>;
    }[];
    veil?: { refused: string };
  };
  if (quoteRes.status !== 402 || quote.accepts.length === 0) {
    out(`payment ${i}: the rail refused to quote (${quoteRes.status} ${quote.veil?.refused ?? ''})`);
    break;
  }
  const accept = quote.accepts[0]!;
  const header = paymentHeaderFrom({ accept, destination: accept.payTo });

  const res = await fetch(`${rail.url}${RESOURCE_PATH}?nonce=${i}`, {
    headers: { 'x-payer': 'smoke-agent', 'x-payment': header },
  });
  const body = (await res.json()) as { paid?: boolean; detail?: string };

  // Re-read the wire we are about to hand over, with the rail's own inspector.
  // A payment whose transaction is not a confidential transfer would be a
  // publicly readable amount, and this is where that shows up as a number
  // instead of as a claim.
  const transaction = (JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
    payload: { transaction: string };
  }).payload.transaction;
  const reading = inspectPaymentTransaction(transaction, {
    payTo: accept.payTo,
    mint: PLACEHOLDER_MINT,
  });

  attempts.push({
    i,
    seat: accept.payTo,
    status: res.status,
    ms: Date.now() - started,
    confidential: reading.ok,
    detail: reading.ok && body.paid !== true ? (body.detail ?? '') : '',
  });

  if (pace > 0) await new Promise((r) => setTimeout(r, pace));
  if (i % 10 === 0) out(`  … ${i}/${count} payments`);
}

const ledgerBody = (await (await fetch(`${rail.url}/api/ledger`)).json()) as {
  settled: readonly { address: string; resource: string; amount: string; alias: string }[];
  metrics: { confidential_assertion_failures: number; settlements: number; broadcasts: number };
};
const health = (await (await fetch(`${rail.url}/v1/health`)).json()) as { settlement: string };

const served = attempts.filter((a) => a.status === 200);
const seats = new Set(attempts.map((a) => a.seat));
const durations = attempts.map((a) => a.ms).sort((a, b) => a - b);
const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : 0;
const readable = attempts.filter((a) => !a.confidential);

out();
out('Result');
out(
  table([
    ['', 'payments served', `${served.length}/${count}`],
    ['', 'settlement rows', String(ledgerBody.settled.length)],
    ['', 'distinct seat addresses', String(seats.size)],
    ['', 'publicly readable amounts', String(readable.length)],
    ['', 'confidential assertion failures', String(ledgerBody.metrics.confidential_assertion_failures)],
    ['', 'broadcasts claimed', String(ledgerBody.metrics.broadcasts)],
    ['', 'settlement mode reported', health.settlement],
    ['', 'median payment (client)', `${median} ms`],
    ['', 'slowest payment (client)', `${durations.at(-1) ?? 0} ms`],
  ]),
);
out();

const checks: [boolean, string][] = [
  [served.length === count, `all ${count} payments were served`],
  [seats.size === count, `exactly ${count} distinct seats were offered — no seat reused`],
  [ledgerBody.settled.length === count, `the rail recorded exactly ${count} settlements`],
  [readable.length === 0, 'zero publicly readable amounts: every accepted transaction was a confidential transfer'],
  [ledgerBody.metrics.confidential_assertion_failures === 0, 'zero confidentiality assertion failures'],
  [ledgerBody.metrics.broadcasts === 0, 'no broadcast was claimed in local-ledger-only mode'],
  [health.settlement === 'local-ledger-only', 'the rail reports its own mode rather than implying a chain'],
];
out('Checks');
for (const [ok, label] of checks) out(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
out();

const failed = checks.filter(([ok]) => !ok).length;
out(
  failed === 0
    ? [
        `VERDICT: ${count} payments, ${seats.size} distinct seats, no readable amount, no assertion failure.`,
        '',
        'What this run does not prove: that any of it was broadcast. Local-ledger-only mode',
        'records settlements as accounting, not as chain facts, and this script says so',
        'rather than letting the numbers imply otherwise. The chain leg is proven by',
        '  npm run pay:live     (one real funded payment on devnet)',
        '  npm run replay -- <signature>   (re-derived from chain state)',
      ].join('\n')
    : `VERDICT: ${failed} check(s) failed.`,
);
out();

await rail.close();
if (failed > 0) process.exitCode = 1;
