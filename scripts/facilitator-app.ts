/**
 * The Veil facilitator as a reusable request handler.
 *
 * `scripts/facilitator.ts` wraps this in an HTTP server for local use; the
 * Vercel function `api/facilitator.ts` invokes the exact same handler, so the
 * hosted rail answers with the code the local one runs — no second
 * implementation to drift.
 *
 * This is the service half of what a Veil merchant needs and the part that is
 * *not* Veil-specific. It answers the three endpoints every x402 facilitator
 * answers — `GET /supported`, `POST /verify`, `POST /settle` — with the request
 * and response bodies x402 defines, by delegating to the stock
 * `x402Facilitator` from `@x402/core` with Veil's `exact-confidential` scheme
 * registered on it. HTTP framing, dedup, fee-payer signing and broadcast are
 * x402's and `@x402/svm`'s code. The additions are the route table, the
 * pool-ownership lookup, and the settlement record the dashboard reads — a
 * broadcast this path makes is a settlement, and a settlement no instance can
 * see is an invisible one.
 *
 * Why a facilitator exists at all, and why Veil runs its own: a payer should not
 * need SOL to pay, and a merchant should not need an RPC endpoint or a hot key in
 * its web process. The facilitator is the gas station and the broadcaster; the
 * merchant's job stays "decide whether this payment is real", which it does with
 * its own key against its own accounts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';
import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
} from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

import type { PoolLedger } from '../packages/derive/src/index.ts';
import { createVeilFacilitator } from '../packages/server/src/scheme.ts';
import { VEIL_SCHEME } from '../packages/x402-core/src/index.ts';
import { HOSTED_LEDGER_KEY, HOSTED_SETTLEMENTS_KEY } from './hosted.ts';
import {
  mergeLedgers,
  redisLedgerStore,
  type RedisLedgerStore,
} from './ledger-store.ts';
import {
  KEYS_DIR,
  decodeSecret,
  loadLedger,
  relative,
  type ScriptOptions,
} from './lib.ts';

export interface FacilitatorApp {
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly feePayerAddress: string;
  readonly poolAccounts: number;
  readonly network: string;
  readonly rpc: string;
  readonly ledgerDisplay: string;
  /** `scheme@network` strings for the startup banner. */
  readonly kinds: readonly string[];
}

let cached: Promise<FacilitatorApp> | null = null;

/**
 * The pool as the shared store last saw it.
 *
 * A seat's settlement state can change on another instance between this one's
 * cold start and the request in front of it: the quote that reserved a seat and
 * the settle that spends it are routinely answered by different functions.
 */
async function sharedLedger(
  ledger: PoolLedger,
  store?: RedisLedgerStore,
): Promise<PoolLedger> {
  if (!store) return ledger;
  const stored = await store.load();
  return stored ? mergeLedgers(stored, ledger) : ledger;
}

/**
 * Why `/settle` must stop before the broadcast, or null when it may proceed.
 *
 * The resource path refuses this with a 409 (`payment-already-settled`); the
 * x402 path must refuse it too, and can: here the money has not moved yet — the
 * payer's transaction is signed but never cosigned or sent. Settling into an
 * address that has already taken a payment is the relinking the pool exists to
 * prevent: two payments, one public account, linkable forever.
 */
export function settleRefusal(
  ledger: PoolLedger,
  payTo: string,
): string | null {
  const entry = ledger.resolve(payTo);
  if (entry?.settledAt === undefined) return null;
  return (
    `payment-already-settled: this one-time address settled at ${entry.settledAt}; ` +
    'paying it again would link two payments to one public account — request a fresh offer'
  );
}

/**
 * Write down what the broadcast just did.
 *
 * x402's scheme verifies, cosigns and broadcasts, and returns the signature —
 * but nothing on this path previously told the seat map or the settlement log,
 * so the dashboard and `/v1/health` never learned the payment happened. This is
 * the same recording the resource path's settle does, done here for the x402
 * surface: stamp the seat (`settledAt`, which is what the shared pool and the
 * health count read), then append the row carrying the signature, amount and
 * resource (which the seat map has no room for).
 *
 * Returns a line for the settle log, and never throws: the credit is already on
 * chain, so a bookkeeping fault must not turn a settled payment into a failed
 * response — it is reported instead, and the signature is what repairs it.
 */
export async function recordSettlement(input: {
  readonly ledger: PoolLedger;
  readonly store?: RedisLedgerStore;
  readonly requirements: PaymentRequirements;
  readonly signature: string;
  readonly at?: string;
}): Promise<string> {
  const { ledger, store, requirements, signature } = input;
  const at = input.at ?? new Date().toISOString();
  const address = requirements.payTo;
  const entry = ledger.resolve(address);
  // The payment id the quote reserved this seat under, when there was a quote.
  // A direct payment to a still-free seat has none, and the settlement's own
  // identity is the only honest one to give it.
  const paymentId = entry?.consumedBy ?? `settle:${signature}`;
  // x402's requirements parse as either of its two shapes, and the parsed body
  // keeps only one of them: V1 names the price `maxAmountRequired` and carries
  // the resource; V2 names it `amount` and has no resource at all. The
  // normalized `PaymentRequirements` type claims `amount` always exists — not
  // when V1 matched and stripped it — so read each field by name rather than
  // trusting the type.
  const source = requirements as unknown as Record<string, unknown>;
  const field = (...names: string[]): string => {
    for (const name of names) {
      const value = source[name];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return '';
  };
  const amount = field('maxAmountRequired', 'amount');
  const resource = field('resource');
  let stamped = false;
  let stampNote = '';
  try {
    ledger.claim(address, paymentId);
    ledger.settle(address, paymentId, at);
    stamped = true;
  } catch (error) {
    // Already stamped (a retried settle) or held by a payment this one cannot
    // name. The seat map is not ours to change — but the settlement still
    // happened and is still recorded below.
    stampNote = `; seat not stamped: ${(error as Error).message}`;
  }
  try {
    if (!store) {
      return `no durable store configured; the record stays in this process${stampNote}`;
    }
    if (stamped) await store.save(ledger);
    await store.appendSettlement({
      paymentId,
      alias: entry?.alias ?? '',
      address,
      amount,
      // The offer publishes the resource absolute when it knew its origin;
      // every other row on the dashboard is a path.
      resource: resource.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''),
      at,
      signature,
    });
    return `recorded ${signature} → ${address}${stampNote}`;
  } catch (error) {
    return `RECORD FAILED for ${signature}: ${(error as Error).message}${stampNote}`;
  }
}

/**
 * Build (once per process) and return the facilitator application.
 *
 * Memoised: a serverless instance calls this per invocation and must not
 * re-read the fee key or re-register the scheme each time.
 */
export function getFacilitatorApp(options: ScriptOptions): Promise<FacilitatorApp> {
  cached ??= build(options);
  return cached;
}

async function build(options: ScriptOptions): Promise<FacilitatorApp> {
  const PAYER_PATH = join(KEYS_DIR, 'payer.json');
  const fromEnv = process.env.VEIL_PAYER_SECRET;

  // Hosted deployments supply the fee key as an encrypted environment variable
  // (the repo's `.keys/` never ships); locally it is the file setup created.
  const seed = fromEnv
    ? decodeSecret(fromEnv)
    : await readFile(PAYER_PATH, 'utf8')
        .then((raw) => decodeSecret(raw))
        .catch(() => null);
  if (!seed) {
    throw new Error(
      fromEnv
        ? 'VEIL_PAYER_SECRET is set but is not a usable keypair (JSON byte array or base58).'
        : [
            `No usable keypair at ${relative(PAYER_PATH)}.`,
            '',
            'A facilitator needs one key: the fee payer that signs and broadcasts settlements.',
            'Run `npm run setup:devnet -- --apply` once to create and fund it.',
          ].join('\n'),
    );
  }

  const feePayer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  // The same durable pool the resource path reads (api-src/veil.ts builds its
  // store from these keys), so a settle recorded here is a settle every
  // instance, the health count and the dashboard can see. Null without the
  // credentials, which leaves this app behaving exactly as it did before.
  const ledgerStore =
    redisLedgerStore({
      key: HOSTED_LEDGER_KEY,
      settlementKey: HOSTED_SETTLEMENTS_KEY,
    }) ?? undefined;
  const ledger = await sharedLedger(
    await loadLedger(options.ledgerPath),
    ledgerStore,
  );

  const { facilitator } = createVeilFacilitator({
    signer: toFacilitatorSvmSigner(feePayer, {
      ...(options.rpcUrl ? { defaultRpcUrl: options.rpcUrl } : {}),
    }),
    networks: [options.network],
    // Attribution: without it the facilitator would settle any destination. With
    // it, a payment to an account that is not one of this pool's is refused with a
    // reason instead of being broadcast and then disputed.
    owner: (address) => ledger.resolve(address)?.alias,
    simulate: process.env.VEIL_SKIP_SIMULATE !== 'true',
  });

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      // Paying agents may call /verify and /settle from a browser on another
      // origin; nothing here accepts credentials, so `*` carries no risk.
      'access-control-allow-origin': '*',
    });
    res.end(payload);
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    // A hosted runtime (Vercel) parses JSON bodies into `req.body` before the
    // handler sees the stream; prefer it or the stream may already be drained.
    const preParsed = (req as IncomingMessage & { body?: unknown }).body;
    if (preParsed !== undefined && preParsed !== null) return preParsed;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // A settlement is a base64 transaction plus a small JSON body; anything
      // larger than this is not a payment and is not read into memory.
      if (size > 1_000_000) throw new Error('request body too large');
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * Split an x402 request into its two validated halves.
   *
   * Validated with x402's own schemas rather than ad-hoc checks: a facilitator that
   * accepts a shape x402 does not is a facilitator whose rejections mean nothing.
   */
  function parseRequest(
    raw: unknown,
  ):
    | { ok: true; payload: PaymentPayload; requirements: PaymentRequirements }
    | { ok: false; error: string } {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body must be a JSON object' };
    const body = raw as Record<string, unknown>;
    if (typeof body.x402Version !== 'number') {
      return { ok: false, error: 'x402Version is required' };
    }
    const payload = PaymentPayloadSchema.safeParse(body.paymentPayload);
    if (!payload.success) {
      return {
        ok: false,
        error: `paymentPayload is not a valid x402 payload: ${payload.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      };
    }
    const requirements = PaymentRequirementsSchema.safeParse(body.paymentRequirements);
    if (!requirements.success) {
      return {
        ok: false,
        error: `paymentRequirements is not a valid x402 requirement: ${requirements.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      };
    }
    return {
      ok: true,
      payload: payload.data as PaymentPayload,
      requirements: requirements.data as PaymentRequirements,
    };
  }

  function out(lines: readonly string[]): void {
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Recover the logical route, then ALWAYS normalise it. A hosted rewrite
    // delivers the destination path plus the original in `?route=` (vercel.json);
    // a browser may also address `/facilitator/verify` directly. The order matters:
    // on a hosted runtime `req.query.route` can carry the prefixed form
    // (`/facilitator/health`), which only the suffix pass below reduces to the
    // exact table's `/health`. Locally the URL is already exact.
    const query = (req as IncomingMessage & { query?: Record<string, unknown> }).query?.route;
    if (typeof query === 'string' && query.length > 0) {
      // Stamping the route in must never cost the caller a param: re-attach the
      // rest of the query alongside it (idempotent when rewriteRoute in
      // scripts/hosted.ts already restored the same path plus params).
      const rest = new URL(req.url ?? '/', 'http://localhost').searchParams;
      rest.delete('route');
      const tail = rest.toString();
      req.url = tail.length === 0 ? query : `${query}${query.includes('?') ? '&' : '?'}${tail}`;
    }

    // Carry the query through the normalisation: the route table matches on the
    // path, but it must not eat params the caller sent. (The merchant half has
    // the same rule and a sharper reason — see rewriteRoute in scripts/hosted.ts.)
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathOnly = parsedUrl.pathname;
    const { search } = parsedUrl;
    const known = ['/verify', '/settle', '/supported', '/health'].find(
      (route) => pathOnly === route || pathOnly.endsWith(route),
    );
    if (known !== undefined) req.url = `${known}${search}`;
    else if (pathOnly.endsWith('/facilitator') || pathOnly.endsWith('/api/facilitator')) {
      req.url = `/${search}`;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      json(res, 200, {
        service: 'veil-facilitator',
        scheme: VEIL_SCHEME,
        // Which chains? The ones the registered scheme was registered for.
        supported: ['GET /supported', 'POST /verify', 'POST /settle'],
        feePayers: facilitator.getSupported().signers,
        poolAccounts: ledger.allFor().length,
        ledger: relative(options.ledgerPath),
        network: options.network,
        rpc: options.rpcUrl ?? 'default',
        honest: [
          'This service verifies destinations, mints and proofs, and simulates before settling.',
          'It cannot verify the transferred AMOUNT: a confidential transfer carries an encrypted value.',
          'The merchant verifies the amount by decrypting its own balance; see README.md.',
        ],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/supported') {
      // Exactly x402's SupportedResponse, produced by x402's own facilitator.
      json(res, 200, facilitator.getSupported());
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/verify' || url.pathname === '/settle')) {
      let raw: unknown;
      try {
        raw = await readBody(req);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : 'unreadable body' });
        return;
      }

      const parsed = parseRequest(raw);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return;
      }

      const started = Date.now();
      if (url.pathname === '/verify') {
        const verdict = await facilitator.verify(parsed.payload, parsed.requirements);
        out([
          `verify  ${verdict.isValid ? 'valid  ' : 'invalid'}  ${
            verdict.invalidReason ?? ''
          }  ${Date.now() - started}ms`.trimEnd(),
        ]);
        // x402's convention: an invalid payment is a 200 with isValid:false, because
        // the request itself was well-formed and the client needs the reason.
        json(res, 200, verdict);
        return;
      }

      // The seat's settlement state lives in the shared pool, so read it fresh
      // rather than from this instance's cold-start copy: a refusal must be
      // based on what every instance knows, and it costs one GET.
      const current = await sharedLedger(ledger, ledgerStore);
      const refusal = settleRefusal(current, parsed.requirements.payTo);
      if (refusal !== null) {
        out([
          `settle  refused ${parsed.requirements.payTo}  ${
            Date.now() - started
          }ms`.trimEnd(),
        ]);
        // The same shape x402's scheme returns for a failed settle, so a client
        // reads one failure format whether the refusal came from the scheme or
        // from the pool. Nothing was broadcast; the payer's funds are untouched.
        json(res, 200, {
          success: false,
          // From the requirements, which name the network on both of x402's
          // shapes; the payload nests it differently per version.
          network: parsed.requirements.network,
          transaction: '',
          errorReason: refusal,
          payer: '',
        });
        return;
      }

      const result = await facilitator.settle(parsed.payload, parsed.requirements);
      out([
        `settle  ${result.success ? `confirmed ${result.transaction}` : `failed ${result.errorReason ?? ''}`}  ${
          Date.now() - started
        }ms`.trimEnd(),
      ]);
      if (result.success) {
        out([
          `record  ${await recordSettlement({
            ledger: current,
            ...(ledgerStore ? { store: ledgerStore } : {}),
            requirements: parsed.requirements,
            signature: result.transaction,
          })}`,
        ]);
      }
      json(res, 200, result);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

    json(res, 404, {
      error: 'not found',
      // Echo of what arrived: when a hosted rewrite loses the original path,
      // this is the difference between a five-second fix and a blind one.
      seen: url.pathname,
      endpoints: ['GET /', 'GET /health', 'GET /supported', 'POST /verify', 'POST /settle'],
    });
  };

  const supported = facilitator.getSupported();
  return {
    handler,
    feePayerAddress: feePayer.address,
    poolAccounts: ledger.allFor().length,
    network: String(options.network),
    rpc: options.rpcUrl ?? 'default',
    ledgerDisplay: relative(options.ledgerPath),
    kinds: supported.kinds.map((k) => `${k.scheme}@${k.network}`),
  };
}
