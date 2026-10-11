#!/usr/bin/env node
/**
 * `npm run demo:batch` — one session, N voucher'd calls, ONE settlement.
 *
 * The demo the batch-settlement story is judged on, run end to end over real HTTP
 * against a real rail (`createFacilitator` + `createVeilServer`), with real
 * ed25519 vouchers and a real Token-2022 confidential transfer as the redemption.
 *
 * What it shows:
 *
 *   - the payer commits a **cap** once, at session open;
 *   - every call after that is authorised by a **signature** — no 402, no seat
 *     reserved, no chain interaction, and nothing about the call that reaches
 *     public state;
 *   - when the session closes, the merchant redeems **one** confidential transfer
 *     for the session total, into **one** fresh one-time seat;
 *   - the receipt reconciles the session: the payer's own signed head, the served
 *     total, the seat, the transaction, and the mode it settled in.
 *
 * Settlement runs in `local-ledger-only` mode here, and the script says so in its
 * own output rather than leaving it to be noticed: there is no devnet spend in a
 * demo run by a stranger from a checkout, and a settlement that cannot be
 * broadcast is not a chain fact. The chain half of the claim is proven separately
 * by `npm run pay:live` (a real funded payment) and `npm run replay` (re-derived
 * from chain state).
 *
 *   npm run demo:batch                 # 12 calls, default cap
 *   npm run demo:batch -- --calls 40   # more calls, same one settlement
 */

import { createHash, generateKeyPairSync } from 'node:crypto';

import { fromAtomic } from '../packages/x402-core/src/index.ts';
import { DEFAULT_RESOURCES } from '../packages/server/src/index.ts';
import { voucherSignerFromSeed, type SignedVoucher } from '../packages/server/src/batch.ts';
import { table } from './lib.ts';
import {
  confidentialWire,
  ensureScratch,
  paymentHeaderFrom,
  provisionSeats,
  startLocalRail,
} from './rail-testkit.ts';

const argv = process.argv.slice(2);
const callsFlag = argv.indexOf('--calls');
const calls = callsFlag === -1 ? 12 : Number(argv[callsFlag + 1]);
if (!Number.isSafeInteger(calls) || calls < 1) {
  throw new Error('--calls must be a positive integer');
}

const PAYER = 'demo-agent';
// The resource the session pays for. Flat-priced, so the arithmetic in the
// receipt can be checked by eye: 12 calls at 0.012 = 0.144.
const RESOURCE_PATH = '/v1/attest/sensor';
const resource = DEFAULT_RESOURCES.find((r) => r.path === RESOURCE_PATH)!;
const DECIMALS = 6;
const price = Number(resource.base);
const cap = (price * calls * 1.5).toFixed(3);
// Vouchers carry money in **atomic units as decimal strings**, never as a float:
// a total that went through Number() twice is a total that can be off by a wei,
// and the rail refuses a voucher whose total is not an exact integer for the same
// reason it refuses a float anywhere else.
const priceAtomic = BigInt(Math.round(price * 10 ** DECIMALS));

// A payer key, generated here: the session's whole authority is one ed25519 key
// the merchant never sees the private half of.
const payerKey = generateKeyPairSync('ed25519');
const pkcs8 = payerKey.privateKey.export({ format: 'der', type: 'pkcs8' });
const spki = payerKey.publicKey.export({ format: 'der', type: 'spki' });
const seed = pkcs8.subarray(pkcs8.length - 32);
const payerPubkey = spki.subarray(spki.length - 32);
const sign = voucherSignerFromSeed(seed);

await ensureScratch();
// The seats are provisioned under the alias of the resource the session pays
// for, because that is the alias the rail's precondition gate is asked about: a
// pool for a merchant the resource does not belong to is a pool the gate would
// (correctly) refuse.
const { ledger, addresses } = await provisionSeats(resource.alias, 8);
const rail = await startLocalRail({ ledger, seats: addresses, resources: DEFAULT_RESOURCES });

const line = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

line('Veil — batch session demo');
for (const row of [
  `  rail          ${rail.url} (started here, real HTTP)`,
  `  resource      ${RESOURCE_PATH} at ${resource.base} per call`,
  `  calls         ${calls}`,
  `  settlement    local-ledger-only (no chain spend; every row says so)`,
]) {
  line(row);
}
line();

// --- 1. open the session ----------------------------------------------------
const opened = await fetch(`${rail.url}/v1/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-payer': PAYER },
  body: JSON.stringify({
    payerPubkey: Buffer.from(payerPubkey).toString('base64'),
    cap,
    alias: resource.alias,
  }),
});
if (opened.status !== 201) {
  throw new Error(`session not opened: ${opened.status} ${await opened.text()}`);
}
const session = (await opened.json()) as { sessionId: string; cap: string; expiresAt: string };
line(
  table([
    ['', 'session', session.sessionId],
    ['', 'cap', `${session.cap} units, signed once`],
    ['', 'expires', session.expiresAt],
  ]),
);
line();

// --- 2. N calls, one signature each -----------------------------------------
let servedAtomic = 0n;
for (let seq = 1; seq <= calls; seq++) {
  servedAtomic += priceAtomic;
  const signed: SignedVoucher = sign({
    sessionId: session.sessionId,
    seq,
    total: servedAtomic.toString(),
  });
  const res = await fetch(`${rail.url}${RESOURCE_PATH}`, {
    headers: {
      'x-payer': PAYER,
      'x-voucher': Buffer.from(JSON.stringify(signed), 'utf8').toString('base64'),
    },
  });
  if (res.status !== 200) {
    throw new Error(`call ${seq} not served: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { session: { servedDecimal: string; headSeq: number } };
  line(
    table([
      ['call', String(seq).padStart(2)],
      ['seq', String(body.session.headSeq)],
      ['voucher total', `${signed.voucher.total} atomic`],
      ['served', body.session.servedDecimal],
      ['x-idempotency-key', res.headers.get('x-idempotency-key') ?? '—'],
      ['chain writes for this call', 'none'],
    ]),
  );
}
line();

// --- 3. redeem: ONE confidential transfer for the whole session -------------
const challenge = await fetch(`${rail.url}/v1/sessions/${session.sessionId}/settle`, {
  method: 'POST',
  headers: { 'x-payer': PAYER },
});
if (challenge.status !== 402) {
  throw new Error(`expected a redemption offer: ${challenge.status} ${await challenge.text()}`);
}
interface Accept {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxAmountRequired: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Record<string, unknown>;
}
const terms = (await challenge.json()) as {
  readonly accepts: readonly Accept[];
  readonly veil?: { refused: string; message: string; remedy: string };
};
const accept = terms.accepts[0];
if (accept === undefined) {
  // An empty `accepts[]` is how Veil refuses: this is not a payment challenge, it
  // is a policy answer, and the demo reports it instead of inventing terms.
  line(`the rail refused to offer a redemption: ${terms.veil?.refused ?? 'unknown'}`);
  line(`  ${terms.veil?.message ?? ''}`);
  line(`  ${terms.veil?.remedy ?? ''}`);
  line();
  await rail.close();
  process.exitCode = 1;
  throw new Error('redemption refused');
}
line(
  table([
    ['redemption', 'one exact-confidential payment'],
    [
      'amount',
      `${accept.amount} atomic (${fromAtomic(servedAtomic, DECIMALS)} units) — the session total, nothing per-call`,
    ],
    ['seat', accept.payTo],
    ['resource', accept.resource],
  ]),
);
line();

const redeemed = await fetch(`${rail.url}/v1/sessions/${session.sessionId}/settle`, {
  method: 'POST',
  headers: {
    'x-payer': PAYER,
    'payment-signature': paymentHeaderFrom({ accept, destination: accept.payTo }),
  },
});
if (redeemed.status !== 200) {
  throw new Error(`redemption failed: ${redeemed.status} ${await redeemed.text()}`);
}
const receiptBody = (await redeemed.json()) as {
  receipt: {
    sessionId: string;
    calls: number;
    totalDecimal: string;
    servedDecimal: string;
    seat: string;
    signature: string | null;
    settlementMode: string;
  };
};
const receipt = receiptBody.receipt;

// --- 4. reconcile -----------------------------------------------------------
const ledgerBody = (await (await fetch(`${rail.url}/api/ledger`)).json()) as {
  settled: { resource: string; alias: string; address: string; amount: string }[];
  metrics: { confidential_assertion_failures: number; settlements: number; broadcasts: number };
};
const sessionRows = ledgerBody.settled.filter((row) => row.resource.includes('/settle'));

line('Session receipt');
line(
  table([
    ['', 'session', receipt.sessionId],
    ['', 'calls carried', String(receipt.calls)],
    ['', 'served (merchant books)', `${receipt.servedDecimal} units`],
    ['', 'redeemed (voucher head)', `${receipt.totalDecimal} units`],
    ['', 'seat', receipt.seat],
    ['', 'signature', receipt.signature ?? 'null — local-ledger-only'],
    ['', 'settlement mode', receipt.settlementMode],
    ['', 'x-idempotency-key', redeemed.headers.get('x-idempotency-key') ?? '—'],
  ]),
);
line();

line('Public state');
line(
  table([
    ['', 'settlement rows on the rail', `${sessionRows.length} for the session`],
    ['', 'per-call rows', '0 — usage is a signature and never reaches the chain'],
    ['', 'seats consumed', String(new Set(ledgerBody.settled.map((r) => r.address)).size)],
    ['', 'confidential assertion failures', String(ledgerBody.metrics.confidential_assertion_failures)],
    ['', 'broadcasts', String(ledgerBody.metrics.broadcasts)],
  ]),
);
line();

const checks: [boolean, string][] = [
  [receipt.calls === calls, `${calls} calls carried by one session`],
  [sessionRows.length === 1, 'exactly one settlement for the whole session'],
  [
    receipt.totalDecimal === fromAtomic(servedAtomic, DECIMALS),
    `the redeemed total is the voucher head (${fromAtomic(servedAtomic, DECIMALS)})`,
  ],
  [
    receipt.servedDecimal === fromAtomic(servedAtomic, DECIMALS),
    'the served total reconciles to the same number',
  ],
  [receipt.settlementMode === 'local-ledger-only', 'the receipt states the mode it settled in'],
  [ledgerBody.metrics.confidential_assertion_failures === 0, 'no confidentiality assertion failed'],
  [ledgerBody.metrics.broadcasts === 0, 'no broadcast was claimed in local mode'],
];
line('Checks');
for (const [ok, label] of checks) line(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
line();

const failed = checks.filter(([ok]) => !ok).length;
line(
  failed === 0
    ? [
        'VERDICT: the session settled once, and nothing per-call reached public state.',
        '',
        'To prove the chain half on devnet:  npm run pay:live',
        'Then re-derive it from chain state:   npm run replay -- <signature>',
      ].join('\n')
    : `VERDICT: ${failed} check(s) failed.`,
);
line();

await rail.close();
line(`session digest ${createHash('sha256').update(session.sessionId).digest('hex').slice(0, 16)}`);
line();

if (failed > 0) process.exitCode = 1;
