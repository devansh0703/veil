/**
 * Live-exercise the hosted `/settle` refusal of an already-settled seat.
 *
 * `settleRefusal` is unit-tested, but a unit test proves the string — not that
 * the hosted rail reaches it. The refusal sits *before* x402's scheme is asked
 * to cosign, which is the whole point: paying a one-time address a second time
 * would link two payments to one public account, and the second payment must
 * die before anything is signed or sent. That ordering is only real if the
 * deployed function returns the refusal instead of handing the payload to the
 * scheme, so this posts a schema-valid x402 settle against an address the
 * shared pool has already settled and requires the refusal back.
 *
 * The control matters as much as the case: the same payload aimed at a free
 * seat must NOT come back `payment-already-settled`, or this check would pass
 * against a facilitator that refuses everything. The payload is deliberately
 * un-broadcastable — all-zero message bytes, no signatures — so the control
 * can never settle the seat it points at.
 *
 * Both x402 shapes are covered. Veil's own builders emit v2, which would only
 * ever exercise one arm of the `PaymentRequirementsSchema` union — so a
 * hand-written v1 body (`maxAmountRequired`, `resource`, `description`, no
 * `amount`) is sent too, because that is the shape the rest of the ecosystem
 * still speaks.
 *
 *   npm run check:refusal
 *   VEIL_FACILITATOR_URL=https://veil-devnet.vercel.app/facilitator npm run check:refusal
 *   VEIL_LEDGER_URL=http://127.0.0.1:4021/api/ledger \
 *     VEIL_FACILITATOR_URL=http://127.0.0.1:4022 npm run check:refusal
 */

import { buildPaymentPayload, buildPaymentRequired } from '../packages/x402-core/src/index.ts';
import { table } from './lib.ts';

/** Where the x402 surface lives. The hosted deployment mounts it under /facilitator. */
const base = (process.env.VEIL_FACILITATOR_URL ??
  'https://veil-devnet.vercel.app/facilitator').replace(/\/$/, '');
/** The dashboard feed, which is the shared pool the refusal reads. */
const ledgerUrl = process.env.VEIL_LEDGER_URL ?? `${new URL(base).origin}/api/ledger`;

/** A transaction no scheme can broadcast: zero message bytes, no signatures. */
const UNBROADCASTABLE = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

interface PoolRow {
  readonly address: string;
  readonly slot: number;
  readonly alias: string;
  readonly settledAt?: string;
}

interface LedgerView {
  /** CAIP-2, exactly what `buildPaymentRequired` refuses to guess. */
  readonly network: `solana:${string}`;
  readonly mint: string;
  readonly decimals: number;
  readonly pool: PoolRow[];
  readonly settled: unknown[];
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} — ${detail}\n`);
}

async function readLedger(): Promise<LedgerView> {
  const res = await fetch(ledgerUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${ledgerUrl} → http ${res.status}`);
  return (await res.json()) as LedgerView;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  // x402 answers JSON, and so does the hosted 500 wrapper — but a transport
  // layer that answers HTML must not crash the check that is reading it.
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
}

/**
 * The settle body a retrying x402 client sends: the offer echoed verbatim, with
 * a payload that parses under x402's own schema but can never be broadcast.
 */
function settleBody(payTo: string, slot: number, ledger: LedgerView): unknown {
  const offer = buildPaymentRequired({
    network: ledger.network,
    asset: ledger.mint,
    payTo,
    amount: 49_000n,
    decimals: ledger.decimals,
    resource: '/v1/price/SOL',
    description: 'SOL spot price',
    poolIndex: slot,
  }).accepts[0]!;
  const payload = buildPaymentPayload({ accept: offer, transaction: UNBROADCASTABLE, payTo });
  return {
    x402Version: payload.x402Version,
    paymentPayload: payload,
    paymentRequirements: offer,
  };
}

/**
 * The same retry as a hand-written x402 **v1** body.
 *
 * Veil's own builders emit v2, so the path above only ever proves the v2 arm.
 * `PaymentRequirementsSchema` is a union that matches v1 first, and a client
 * written against the original x402 spec sends `x402Version: 1` with
 * `maxAmountRequired`, `resource` and `description` and no `amount` at all —
 * so the refusal is exercised against the shape that actually arrives from the
 * rest of the ecosystem, built by hand rather than by our own code.
 */
function v1SettleBody(payTo: string, ledger: LedgerView): unknown {
  return {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact-confidential',
      network: ledger.network,
      payload: {
        transaction: UNBROADCASTABLE,
        payTo,
        asset: ledger.mint,
      },
    },
    paymentRequirements: {
      scheme: 'exact-confidential',
      network: ledger.network,
      maxAmountRequired: '49000',
      resource: '/v1/price/SOL',
      description: 'SOL spot price',
      payTo,
      maxTimeoutSeconds: 60,
      asset: ledger.mint,
      extra: { privacy: 'confidential-balances' },
    },
  };
}

process.stdout.write(`\nChecking the settled-seat refusal at ${base}\n\n`);

// ---------------------------------------------------------------------------
// 1. The shared pool decides — read it the way the facilitator does
// ---------------------------------------------------------------------------

const before = await readLedger();
const settledSeat = before.pool.find((row) => row.settledAt !== undefined);
const freeSeat = before.pool.find((row) => row.settledAt === undefined);
check(
  'the rail has a settled seat to retry',
  settledSeat !== undefined,
  settledSeat ? `${settledSeat.address} settled ${settledSeat.settledAt}` : 'no seat is settled yet',
);
if (!settledSeat) {
  process.stdout.write('\nNothing has settled on this rail yet; run `npm run pay:live -- --apply` first.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. The retry — a schema-valid payment to an address that already took one
// ---------------------------------------------------------------------------

const refusal = await post('/settle', settleBody(settledSeat.address, settledSeat.slot, before));
const reason = String(refusal.body?.errorReason ?? '');
check(
  'the hosted /settle answers the retry with an x402 response',
  refusal.status === 200 && typeof refusal.body?.success === 'boolean',
  `http ${refusal.status} ${JSON.stringify(refusal.body).slice(0, 140)}`,
);
check(
  'the retry is refused as payment-already-settled',
  refusal.body?.success === false && reason.startsWith('payment-already-settled'),
  reason.slice(0, 160),
);
check(
  'the refusal says when it settled',
  reason.includes(String(settledSeat.settledAt)),
  settledSeat.settledAt ?? '',
);
check(
  'nothing was broadcast — no signature, no payer',
  refusal.body?.transaction === '' && refusal.body?.payer === '',
  `transaction ${JSON.stringify(refusal.body?.transaction)} payer ${JSON.stringify(refusal.body?.payer)}`,
);
check(
  'the refusal echoes the rail network, not a bare string',
  refusal.body?.network === before.network,
  String(refusal.body?.network),
);

// ---------------------------------------------------------------------------
// 3. The refusal left no trace — the settlement log did not move
// ---------------------------------------------------------------------------

const after = await readLedger();
check(
  'the settlement log is unchanged after the refusal',
  after.settled.length === before.settled.length,
  `${before.settled.length} → ${after.settled.length} rows`,
);

// ---------------------------------------------------------------------------
// 4. Control — the same payload against a free seat is not refused this way
// ---------------------------------------------------------------------------

if (freeSeat) {
  const control = await post('/settle', settleBody(freeSeat.address, freeSeat.slot, before));
  const controlReason = String(control.body?.errorReason ?? '');
  check(
    'a free seat is not refused as already-settled',
    !controlReason.startsWith('payment-already-settled'),
    controlReason.slice(0, 160) || JSON.stringify(control.body).slice(0, 160),
  );
  const final = await readLedger();
  check(
    'the control settled nothing either',
    final.settled.length === after.settled.length,
    `${after.settled.length} → ${final.settled.length} rows`,
  );
} else {
  check('a free seat is not refused as already-settled', true, 'skipped — no free seat');
}

// ---------------------------------------------------------------------------
// 5. The same refusal on a hand-written v1 body — the union's first arm
// ---------------------------------------------------------------------------

const v1 = await post('/settle', v1SettleBody(settledSeat.address, before));
const v1Reason = String(v1.body?.errorReason ?? '');
check(
  'a hand-written x402 v1 body is refused the same way',
  v1.status === 200 &&
    v1.body?.success === false &&
    v1Reason.startsWith('payment-already-settled') &&
    v1Reason.includes(String(settledSeat.settledAt)) &&
    v1.body?.transaction === '' &&
    v1.body?.payer === '',
  `http ${v1.status} ${v1Reason.slice(0, 140)}`,
);
const afterV1 = await readLedger();
check(
  'the v1 refusal also settled nothing',
  afterV1.settled.length === after.settled.length,
  `${after.settled.length} → ${afterV1.settled.length} rows`,
);

// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok);
process.stdout.write(
  `\n${table([
    ['checks', String(checks.length)],
    ['passed', String(checks.length - failed.length)],
    ['failed', String(failed.length)],
  ])}\n\n`,
);
if (failed.length > 0) {
  process.stdout.write(`Failed:\n${failed.map((c) => `  ${c.name} — ${c.detail}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('The hosted /settle refuses a settled seat before anything is broadcast.\n');
