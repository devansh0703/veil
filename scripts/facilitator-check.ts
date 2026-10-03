/**
 * Drive a running Veil facilitator the way an x402 client would.
 *
 *   npm run facilitator &                        # in one shell
 *   node scripts/facilitator-check.ts            # in another
 *   node scripts/facilitator-check.ts --port 4029
 *
 * This is the interoperability check, and it is deliberately not a mock. It
 * builds a real Solana transaction with a real Token-2022 confidential transfer
 * instruction, wraps it in a real x402 `PaymentPayload`, and posts it to the real
 * endpoints. What it does *not* have is the three zero-knowledge proofs, so the
 * chain simulation rejects it — and the assertion is exactly that: the service
 * reaches simulation, the chain says no, and the payer is told `simulation_failed`
 * instead of being handed a settlement that never happened.
 *
 * Fail-closed is the property under test. A verifier that cannot be made to say
 * "no" for the right reason is a verifier that will one day say "yes" for the
 * wrong one.
 */

import { readFile } from 'node:fs/promises';

import {
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
} from '@solana/kit';

import { buildConfidentialTransfer } from '../packages/onchain/src/index.ts';
import { buildPaymentPayload, buildPaymentRequired } from '../packages/x402-core/src/index.ts';
import { KEYS_DIR, decodeSecret, loadLedger, optionsFromEnv, table } from './lib.ts';
import { join } from 'node:path';

const options = optionsFromEnv(process.argv.slice(2));
const port = Number(process.env.VEIL_FACILITATOR_PORT ?? options.port + 1);
const base = `http://127.0.0.1:${port}`;

function out(lines: readonly string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  out([`  ${ok ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`]);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

out(['', `Checking ${base}`, '']);

// ---------------------------------------------------------------------------
// 1. /supported — does it describe itself the way x402 requires?
// ---------------------------------------------------------------------------

const supportedRes = await fetch(`${base}/supported`);
const supported = (await supportedRes.json()) as {
  kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
  signers: Record<string, string[]>;
};
const kind = supported.kinds.find((k) => k.scheme === 'exact-confidential');
check(
  'GET /supported advertises exact-confidential',
  supportedRes.status === 200 && Boolean(kind),
  JSON.stringify(supported.kinds),
);
check(
  'the advertised kind carries a fee payer a client can build against',
  typeof kind?.extra?.feePayer === 'string',
  String(kind?.extra?.feePayer),
);
check(
  'the privacy model is advertised, not implied',
  kind?.extra?.privacy === 'confidential-balances',
  String(kind?.extra?.privacy),
);

const feePayer = String(kind?.extra?.feePayer);

// ---------------------------------------------------------------------------
// 2. A real payment, built against the offer the facilitator can attribute
// ---------------------------------------------------------------------------

const ledger = await loadLedger(options.ledgerPath);
const seat = ledger.allFor()[0];
if (!seat) {
  out(['No pool accounts are registered. Run `npm run setup:devnet -- --apply` first.']);
  process.exit(1);
}

const seed = await readFile(join(KEYS_DIR, 'payer.json'), 'utf8').then((raw) => decodeSecret(raw));
if (!seed) {
  out([`No usable payer keypair in ${join(KEYS_DIR, 'payer.json')}.`]);
  process.exit(1);
}
const payer = await createKeyPairSignerFromPrivateKeyBytes(seed);

const offer = buildPaymentRequired({
  network: options.network,
  asset: options.mint,
  payTo: seat.address,
  amount: 49_000n,
  decimals: options.decimals,
  resource: '/v1/price/SOL',
  description: 'SOL spot price',
  poolIndex: seat.slot,
}).accepts[0]!;

/**
 * The payer's transaction: fee payer is the *facilitator*, authority is the
 * payer. That asymmetry is the whole point of a facilitator — the payer never
 * needs SOL.
 */
const instructions = buildConfidentialTransfer({
  sourceToken: seat.address as never,
  mint: options.mint as never,
  destinationToken: seat.address as never,
  authority: payer,
  newSourceDecryptableAvailableBalance: new Uint8Array(36),
});

const message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(feePayer as never, m),
  (m) =>
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: '11111111111111111111111111111111' as never,
        lastValidBlockHeight: 0n,
      },
      m,
    ),
  (m) => appendTransactionMessageInstructions(instructions, m),
);
// The wire transaction, with the facilitator's signature slot left *empty*.
//
// That null is the design, not an omission: the payer signs the transfer and the
// facilitator — which holds the fee payer — signs at settle. Encoding the slot as
// null is how a partially-signed transaction is expressed on the wire, and it is
// the shape `/verify` must be able to reason about.
const compiled = compileTransaction(message);
const wire = Buffer.from(
  getTransactionEncoder().encode({
    messageBytes: compiled.messageBytes,
    signatures: { [feePayer]: null },
  } as never),
).toString('base64');

const payload = buildPaymentPayload({
  accept: offer,
  transaction: wire,
  payTo: seat.address,
});

// ---------------------------------------------------------------------------
// 3. /verify — a well-formed request whose proofs are missing must be refused
// ---------------------------------------------------------------------------

const verify = await post('/verify', {
  x402Version: 2,
  paymentPayload: payload,
  paymentRequirements: {
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amount,
    payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    extra: offer.extra,
  },
});
check(
  '/verify answers 200 with a verdict, not a transport error',
  verify.status === 200 && typeof verify.body.isValid === 'boolean',
  `http ${verify.status} ${JSON.stringify(verify.body).slice(0, 140)}`,
);
check(
  'a transfer whose proofs are absent is refused at simulation, by the chain',
  verify.body.isValid === false && verify.body.invalidReason === 'simulation_failed',
  `${verify.body.invalidReason}: ${String(verify.body.invalidMessage ?? '').slice(0, 120)}`,
);
check(
  'the refusal names the payer so the merchant can act on it',
  typeof verify.body.payer === 'string' && verify.body.payer.length > 0,
  String(verify.body.payer),
);

// ---------------------------------------------------------------------------
// 4. /settle — must refuse the same payment, and must not broadcast
// ---------------------------------------------------------------------------

const settle = await post('/settle', {
  x402Version: 2,
  paymentPayload: payload,
  paymentRequirements: {
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amount,
    payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    extra: offer.extra,
  },
});
check(
  '/settle refuses a payment that failed verification and reports no signature',
  settle.status === 200 && settle.body.success === false && settle.body.transaction === '',
  `${settle.body.errorReason}: ${String(settle.body.errorMessage ?? '').slice(0, 120)}`,
);
check(
  'the refusal is the verification result, not a broadcast failure',
  settle.body.errorReason === 'simulation_failed',
  String(settle.body.errorReason),
);

// ---------------------------------------------------------------------------
// 5. A payload x402's own schema rejects is a 400, not a verdict
// ---------------------------------------------------------------------------

const malformed = await post('/verify', {
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: {}, payload: {} },
  paymentRequirements: { scheme: 'exact-confidential', network: options.network },
});
check(
  'a request that fails x402 schema validation is a 400 with the reason',
  malformed.status === 400 && typeof malformed.body.error === 'string',
  `http ${malformed.status} ${String(malformed.body.error ?? '').slice(0, 120)}`,
);

// ---------------------------------------------------------------------------
// 6. A payment to an account that is not ours is refused by name
// ---------------------------------------------------------------------------

const unowned = await post('/verify', {
  x402Version: 2,
  paymentPayload: {
    ...payload,
    accepted: { ...payload.accepted, payTo: 'VeilNotAnAccount1111111111111111111111111' },
    payload: { ...payload.payload, payTo: 'VeilNotAnAccount1111111111111111111111111' },
  },
  paymentRequirements: {
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amount,
    payTo: 'VeilNotAnAccount1111111111111111111111111',
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    extra: offer.extra,
  },
});
check(
  'a payment to an account this facilitator does not own is refused',
  unowned.status === 200 && unowned.body.isValid === false,
  String(unowned.body.invalidReason ?? unowned.body.error ?? ''),
);

const failed = checks.filter((c) => !c.ok);
out([
  '',
  table([
    ['checks', String(checks.length)],
    ['passed', String(checks.length - failed.length)],
    ['failed', String(failed.length)],
  ]),
  '',
]);

if (failed.length > 0) {
  out(['Failed:', ...failed.map((c) => `  ${c.name} — ${c.detail}`)]);
  process.exit(1);
}
out(['The facilitator speaks x402 and fails closed.']);
