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
 * x402's and `@x402/svm`'s code. The only additions are the route table and the
 * pool-ownership lookup.
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

import { createVeilFacilitator } from '../packages/server/src/scheme.ts';
import { VEIL_SCHEME } from '../packages/x402-core/src/index.ts';
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
  const ledger = await loadLedger(options.ledgerPath);

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
    if (typeof query === 'string' && query.length > 0) req.url = query;

    const pathOnly = new URL(req.url ?? '/', 'http://localhost').pathname;
    const known = ['/verify', '/settle', '/supported', '/health'].find(
      (route) => pathOnly === route || pathOnly.endsWith(route),
    );
    if (known !== undefined) req.url = known;
    else if (pathOnly.endsWith('/facilitator') || pathOnly.endsWith('/api/facilitator')) {
      req.url = '/';
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

      const result = await facilitator.settle(parsed.payload, parsed.requirements);
      out([
        `settle  ${result.success ? `confirmed ${result.transaction}` : `failed ${result.errorReason ?? ''}`}  ${
          Date.now() - started
        }ms`.trimEnd(),
      ]);
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
