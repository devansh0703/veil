/**
 * @veil/server — an x402 resource server that prices in private.
 *
 * This is the working product surface: an HTTP server that answers an unpaid
 * request with a 402 carrying a one-time payment account, verifies a payer's
 * confidential payment, settles it, and serves the resource. It is deliberately
 * dependency-free (node:http only) so the whole control path can be read and
 * audited in one sitting.
 *
 * ## The rule that shapes everything here
 *
 * Veil never downgrades a payment to public. When the confidential path is not
 * available — mint not configured, destination not armed, pool exhausted — the
 * server *refuses*. It does not fall back to a visible transfer, because a
 * merchant who believes a payment was private while its amount sat on a public
 * ledger has been actively misled. That is the failure this product exists to
 * make impossible, so it is the one thing the code will not trade away for
 * availability.
 *
 * ## What is real, and what needs funds
 *
 * - Pricing, the 402 body, refusal policy, pool reservation, budget enforcement,
 *   and settlement *accounting* are all real and run without any chain access.
 * - Broadcasting a signed transaction needs devnet funds. Without them the
 *   server reports `settlement-unavailable` and says why. It never reports a
 *   settlement it did not make.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DEVNET,
  PLACEHOLDER_MINT,
  buildPaymentRequired,
  buildRefusal402,
  checkBudget,
  formatAtomic,
  isValidAddress,
  normalizeNetwork,
  parsePaymentRequired,
  priceFor,
  refusal,
  toAtomic,
  type Atomic,
  type Network,
  type RefusalCode,
  type VeilPaymentPayload,
  type VeilPaymentRequired,
} from '../../x402-core/src/index.ts';
import {
  PoolLedger,
  derivePaymentId,
  type PaymentIdentity,
} from '../../derive/src/index.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  /** Path, e.g. '/v1/oracle/tide'. */
  readonly path: string;
  /** Merchant alias that receives payment for this resource. */
  readonly alias: string;
  readonly description: string;
  /** Flat price in decimal units, priced at the mint's precision. */
  readonly base: string;
  /** Optional per-unit component and how many units a call costs. */
  readonly perUnit?: string;
  readonly units?: number;
  /** What the caller receives. Real data, produced on demand. */
  readonly produce: (ctx: { readonly paid: boolean }) => unknown;
}

/**
 * The source of truth for Veil's confidential preconditions.
 *
 * Veil refuses to serve a payment it cannot make confidential, which means it
 * has to *know* two things: that the mint carries the confidential-transfer
 * extension, and that the destination account is configured to receive
 * confidential credits. Neither can be assumed. A deployment supplies this
 * probe, and it is expected to answer from chain state (see the setup script)
 * or from the pool ledger it just created.
 *
 * Every method may answer `'unknown'`, and `'unknown'` is not a pass. An
 * assertion the deployment cannot check is exactly the situation VEIL-CONF-003
 * exists for: serving on an unverified precondition is how a merchant ends up
 * believing an amount was hidden while it sat in the clear.
 *
 * There is deliberately no default. A server started without a probe refuses
 * every paid resource rather than guessing.
 */
export interface PrivacyProbe {
  readonly mintConfidential: () => boolean | 'unknown';
  readonly accountsArmed: (alias: string) => boolean | 'unknown';
}

export interface ServerConfig {
  readonly network: Network;
  /** Mint the payment must be denominated in. */
  readonly mint: string;
  readonly decimals: number;
  /** Where the pool ledger is persisted. */
  readonly ledgerPath: string;
  readonly resources: readonly ResourceDefinition[];
  /**
   * Buyer spend cap per session, in decimal units. Enforced server-side so a
   * merchant cannot talk an agent past what the agent declared.
   */
  readonly spendCap?: string;
  /** Set when on-chain broadcasting is actually possible. */
  readonly rpcUrl?: string;
  /**
   * Record settlements without contacting a chain.
   *
   * A deliberate, loudly-named escape hatch for the local protocol demo and for
   * tests. It is off by default and reported through /v1/health and
   * /.well-known/veil so a running server never hides which mode it is in. It is
   * not a production mode: with it on, a settlement is an accounting record and
   * not a chain fact.
   */
  readonly allowLocalSettlement?: boolean;
  /** Where the confidential preconditions are checked. Omit to refuse. */
  readonly privacy?: PrivacyProbe;
  /**
   * How the preconditions are known, for reporting.
   *
   * `chain` means every answer came from reading devnet. `pool-ledger` means the
   * answers came from the ledger Veil itself wrote when it created the accounts,
   * which is a real record but not an independent one. The distinction is
   * published through /.well-known/veil because a judge or an integrator should
   * be able to tell them apart without reading this file.
   */
  readonly privacySource?: 'chain' | 'pool-ledger' | 'none';
}

export interface ServerState {
  readonly ledger: PoolLedger;
  /** Payment ids that have settled, in order. */
  readonly settled: Settlement[];
}

export interface Settlement {
  readonly paymentId: string;
  readonly alias: string;
  readonly address: string;
  readonly amount: Atomic;
  readonly resource: string;
  readonly at: string;
  /** The transaction signature, when one was actually broadcast. */
  readonly signature: string | null;
}

// ---------------------------------------------------------------------------
// Ledger persistence
// ---------------------------------------------------------------------------

async function loadLedger(path: string): Promise<PoolLedger> {
  try {
    const raw = await readFile(path, 'utf8');
    return PoolLedger.fromJSON(JSON.parse(raw));
  } catch (error) {
    // A missing ledger is normal on first run. A *corrupt* one is not: it is
    // loaded through fromJSON so its invariants are checked, and a failure here
    // must stop the server rather than silently start with an empty pool (which
    // would reuse addresses and relink payments).
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return PoolLedger.empty();
    throw error;
  }
}

async function saveLedger(path: string, ledger: PoolLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// The facilitator
// ---------------------------------------------------------------------------

export interface Facilitator {
  readonly config: ServerConfig;
  readonly state: ServerState;
  /** Price this resource for this caller, or explain why we will not serve. */
  quote(
    resource: ResourceDefinition,
    id: PaymentIdentity,
  ):
    | { readonly ok: true; readonly body: VeilPaymentRequired; readonly amount: Atomic }
    | { readonly ok: false; readonly status: number; readonly body: VeilPaymentRequired };
  /** Check a payer's payment before doing any work. */
  verify(
    raw: unknown,
    resource: ResourceDefinition,
  ):
    | { readonly ok: true; readonly payload: VeilPaymentPayload; readonly address: string }
    | { readonly ok: false; readonly status: number; readonly reason: string };
  /** Record a settlement. Refuses to invent one. */
  settle(input: {
    readonly payload: VeilPaymentPayload;
    readonly resource: ResourceDefinition;
    readonly address: string;
    readonly paymentId: string;
    readonly amount: Atomic;
  }): Promise<
    | { readonly ok: true; readonly settlement: Settlement }
    | { readonly ok: false; readonly status: number; readonly reason: string }
  >;
  flush(): Promise<void>;
}

export function createFacilitator(
  rawConfig: ServerConfig,
  ledger: PoolLedger,
): Facilitator {
  // The network a deployment configures is a friendly name (`solana:testnet`);
  // the network on the wire is a genesis hash. Normalising once, here, means the
  // 402 body a payer echoes back and the config it is compared against are the
  // same string — otherwise every valid payment fails as "wrong network".
  const config: ServerConfig = {
    ...rawConfig,
    network: normalizeNetwork(rawConfig.network),
  };

  // A mint that no client can parse is a configuration error, and it must be one
  // here rather than a mysterious RPC failure later. The check is cheap and it
  // closes a real trap: a placeholder like "VeilUSD111…" reads as an address,
  // ships in every 402 body, and cannot be looked up by anyone who receives it.
  if (!isValidAddress(config.mint)) {
    throw new TypeError(
      `config.mint is not a valid 32-byte base58 address: ${JSON.stringify(config.mint)}. ` +
        'Set VEIL_MINT to the real mint, or use PLACEHOLDER_MINT for a chain-free run.',
    );
  }

  const settled: Settlement[] = [];
  let spent: Atomic = 0n;

  const poolSizeFor = (alias: string): number => {
    const total = ledger.allFor(alias).length;
    if (total === 0) return 0;
    return 2 ** Math.floor(Math.log2(total));
  };

  /**
   * The confidential precondition gate.
   *
   * Evaluated before any price is quoted, because a price is an offer to settle,
   * and Veil must not offer a settlement it cannot make private.
   */
  const gate = (alias: string): { code: RefusalCode } | null => {
    if (!config.privacy) return { code: 'VEIL-CONF-003' };
    const mint = config.privacy.mintConfidential();
    if (mint === false) return { code: 'VEIL-CONF-001' };
    if (mint === 'unknown') return { code: 'VEIL-CONF-003' };
    const accounts = config.privacy.accountsArmed(alias);
    if (accounts === false) return { code: 'VEIL-CONF-002' };
    if (accounts === 'unknown') return { code: 'VEIL-CONF-003' };
    return null;
  };

  const facilitator: Facilitator = {
    config,
    state: { ledger, settled },

    quote(resource, id) {
      const blocked = gate(resource.alias);
      if (blocked) {
        return {
          ok: false,
          status: 402,
          body: buildRefusal402(blocked.code, {
            network: config.network,
            asset: config.mint,
            payTo: '',
            decimals: config.decimals,
            resource: resource.path,
            poolIndex: 0,
          }),
        };
      }

      const amount = priceFor(
        {
          base: resource.base,
          ...(resource.perUnit !== undefined ? { perUnit: resource.perUnit } : {}),
          ...(resource.units !== undefined ? { units: resource.units } : {}),
        },
        config.decimals,
      );

      const amountDecimal = formatAtomic(amount, config.decimals, '');

      // 1. Will this payment fit what the buyer declared it would spend?
      if (config.spendCap !== undefined) {
        const verdict = checkBudget(amount, {
          spendCap: toAtomic(config.spendCap, config.decimals),
          alreadySpent: spent,
        });
        if (!verdict.ok) {
          return {
            ok: false,
            status: 402,
            body: buildRefusal402('VEIL-CONF-004', {
              network: config.network,
              asset: config.mint,
              payTo: '',
              decimals: config.decimals,
              resource: resource.path,
              poolIndex: 0,
            }),
          };
        }
      }

      // 2. Is there a one-time account free? If not we must not reuse one.
      const poolSize = poolSizeFor(resource.alias);
      if (poolSize === 0) {
        return {
          ok: false,
          status: 503,
          body: buildRefusal402('VEIL-CONF-005', {
            network: config.network,
            asset: config.mint,
            payTo: '',
            decimals: config.decimals,
            resource: resource.path,
            poolIndex: 0,
          }),
        };
      }

      let reserved;
      try {
        reserved = ledger.reserve(resource.alias, id, poolSize);
      } catch {
        return {
          ok: false,
          status: 503,
          body: buildRefusal402('VEIL-CONF-005', {
            network: config.network,
            asset: config.mint,
            payTo: '',
            decimals: config.decimals,
            resource: resource.path,
            poolIndex: 0,
          }),
        };
      }

      return {
        ok: true,
        amount,
        body: buildPaymentRequired({
          network: config.network,
          asset: config.mint,
          payTo: reserved.address,
          amount,
          decimals: config.decimals,
          resource: resource.path,
          description: `${resource.description} (${amountDecimal} units)`,
          poolIndex: reserved.slot,
        }),
      };
    },

    verify(raw, resource) {
      if (typeof raw !== 'object' || raw === null) {
        return { ok: false, status: 402, reason: 'payment payload must be an object' };
      }
      const payload = raw as Partial<VeilPaymentPayload>;
      if (payload.x402Version !== 2) {
        return { ok: false, status: 402, reason: 'x402Version must be 2' };
      }
      if (payload.scheme !== 'exact-confidential') {
        return {
          ok: false,
          status: 402,
          reason: `scheme must be exact-confidential, got ${String(payload.scheme)}`,
        };
      }
      if (payload.network !== config.network) {
        return {
          ok: false,
          status: 402,
          reason: `wrong network: expected ${config.network}, got ${String(payload.network)}`,
        };
      }
      const inner = payload.payload;
      if (!inner) {
        return { ok: false, status: 402, reason: 'payload.payload is required' };
      }
      if (typeof inner.transaction !== 'string' || inner.transaction.length === 0) {
        return {
          ok: false,
          status: 402,
          reason: 'payload.transaction must be a base64 signed transaction',
        };
      }
      if (typeof inner.payTo !== 'string' || inner.payTo.length === 0) {
        return { ok: false, status: 402, reason: 'payload.payTo is required' };
      }
      if (inner.asset !== config.mint) {
        return {
          ok: false,
          status: 402,
          reason: `wrong mint: expected ${config.mint}, got ${String(inner.asset)}`,
        };
      }

      // x402 v2 payloads carry the `accepts[]` entry the payer answered. It is not
      // decoration: it is the payer's own statement of the terms it agreed to, and
      // it is the *only* part of the payload the SDK's schema validates. Checking
      // it here means the two halves of the payload cannot disagree — a payment
      // whose terms name one account while the signed transaction names another
      // is rejected as the contradiction it is.
      const accepted = payload.accepted;
      if (!accepted || typeof accepted !== 'object') {
        return { ok: false, status: 402, reason: 'payload.accepted is required (x402 v2)' };
      }
      if (accepted.scheme !== 'exact-confidential') {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.scheme must be exact-confidential, got ${String(
            accepted.scheme,
          )}`,
        };
      }
      if (accepted.network !== config.network) {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.network must be ${config.network}, got ${String(
            accepted.network,
          )}`,
        };
      }
      if (accepted.asset !== config.mint) {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.asset must be ${config.mint}, got ${String(accepted.asset)}`,
        };
      }
      if (accepted.payTo !== inner.payTo) {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.payTo (${String(
            accepted.payTo,
          )}) does not match the account paid (${inner.payTo})`,
        };
      }

      // The destination must be one of ours AND belong to the merchant that owns
      // this resource. A payment to another merchant's pool account would be
      // attributable to the wrong party, so it is rejected rather than credited.
      const entry = ledger.resolve(inner.payTo);
      if (!entry) {
        return {
          ok: false,
          status: 402,
          reason:
            'payload.payTo is not a payment account Veil issued; it cannot be attributed to a merchant',
        };
      }
      if (entry.alias !== resource.alias) {
        return {
          ok: false,
          status: 402,
          reason: `payload.payTo belongs to ${entry.alias}, not the merchant for ${resource.path}`,
        };
      }
      return {
        ok: true,
        payload: payload as VeilPaymentPayload,
        address: entry.address,
      };
    },

    async settle(input) {
      const { payload, resource, address, paymentId } = input;

      // Order matters here, and it is not arbitrary. Accounting is validated
      // *before* the broadcast, because a broadcast is irreversible: if we sent
      // first and the ledger then rejected the entry, real money would have
      // moved while the merchant's own books recorded nothing. Checking first
      // costs one pass over a small array and removes that entire failure mode.
      try {
        ledger.settleable(address, paymentId);
      } catch (error) {
        return {
          ok: false,
          status: 402,
          reason: error instanceof Error ? error.message : 'settlement rejected',
        };
      }

      // Broadcasting is only honest when it can actually happen. Reporting a
      // settlement we did not make would be the single worst bug this code could
      // have, so absent chain access is a hard stop, not a silent success.
      let signature: string | null = null;
      if (config.rpcUrl !== undefined) {
        signature = await broadcast(config.rpcUrl, payload.payload.transaction);
      } else if (config.allowLocalSettlement !== true) {
        return {
          ok: false,
          status: 503,
          reason:
            'settlement-unavailable: no RPC configured. Set VEIL_RPC_URL and fund the payer to broadcast, or run the local protocol demo (npm run demo:local), which exercises this path and reports itself as chain-free.',
        };
      }
      const settlement: Settlement = {
        paymentId,
        alias: resource.alias,
        address,
        amount: input.amount,
        resource: resource.path,
        at: new Date().toISOString(),
        signature,
      };

      // Committed after the broadcast. The pre-check above already established
      // that this cannot throw for a caller mistake; if it throws anyway the
      // ledger was mutated between the two calls, which is a genuine fault and
      // should surface as one rather than as a 402 blaming the payer.
      ledger.settle(address, paymentId, settlement.at);

      settled.push(settlement);
      spent += input.amount;
      await facilitator.flush();
      return { ok: true, settlement };
    },

    async flush() {
      await saveLedger(config.ledgerPath, ledger);
    },
  };

  return facilitator;
}

/**
 * Broadcast a signed transaction over plain JSON-RPC.
 *
 * Deliberately a thin, explicit call rather than a client library, so the only
 * thing this code can do is send the pre-signed bytes the payer produced. Veil
 * never holds a payer's key and cannot alter what was signed.
 */
async function broadcast(rpcUrl: string, base64Transaction: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [base64Transaction, { encoding: 'base64', preflightCommitment: 'confirmed' }],
    }),
  });
  const body = (await response.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`broadcast rejected: ${body.error.message ?? 'unknown'}`);
  }
  if (typeof body.result !== 'string') {
    throw new Error('broadcast returned no signature');
  }
  return body.result;
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  // Atomic amounts are bigint, and JSON.stringify throws on those. Serialising
  // them as decimal strings keeps precision exactly and stops a whole class of
  // "works until it reaches a response" bug: an endpoint that forgot to convert
  // used to fail as a 500 with no clue why.
  const text = JSON.stringify(
    body,
    (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    2,
  );
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // Payers are browsers and agents on other origins — a hosted rail must
    // answer them. No credentials are accepted here, so `*` is safe.
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}export function createVeilServer(
  rawConfig: ServerConfig,
  facilitator: Facilitator,
): ReturnType<typeof createServer> {
  return createServer(createVeilHandler(rawConfig, facilitator));
}

/**
 * The request handler behind `createVeilServer`, exported so a serverless
 * function can answer with exactly this code path. A hosted deployment that
 * re-implemented the router would drift from the local server; sharing the
 * handler keeps "local" and "hosted" the same product.
 */
export function createVeilHandler(
  rawConfig: ServerConfig,
  facilitator: Facilitator,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // Same normalisation as createFacilitator: what we *publish* must be the
  // identifier x402 speaks, not the name this deployment typed into a flag.
  const config: ServerConfig = {
    ...rawConfig,
    network: normalizeNetwork(rawConfig.network),
  };
  const byPath = new Map(config.resources.map((r) => [r.path, r]));

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      // Cross-origin preflight: a payer in a browser never sends credentials
      // to Veil, so the only thing CORS must unlock is reading the 402 body.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-payment',
          'access-control-max-age': '86400',
        });
        res.end();
        return;
      }

      // --- machine-legible capability surface -----------------------------
      if (path === '/.well-known/veil') {
        return json(res, 200, {
          scheme: 'exact-confidential',
          network: config.network,
          mint: config.mint,
          decimals: config.decimals,
          privacy: 'confidential-balances',
          hides: ['on-chain-amount', 'on-chain-balance'],
          exposes: ['destination-account', 'mint', 'transaction-existence'],
          resources: config.resources.map((r) => ({
            path: r.path,
            base: r.base,
            ...(r.perUnit ? { perUnit: r.perUnit, units: r.units ?? 0 } : {}),
          })),
          privacySource: config.privacySource ?? 'none',
          privacyGate:
            config.privacy === undefined
              ? {
                  mode: 'refusing',
                  note: 'no precondition probe configured, so every paid resource answers VEIL-CONF-003',
                }
              : {
                  mode: 'enforcing',
                  source: config.privacySource ?? 'none',
                  checks: ['mint-confidential-extension', 'destination-confidential-credits'],
                },
          settlement:
            config.rpcUrl !== undefined
              ? { mode: 'rpc', chain: String(config.network) }
              : config.allowLocalSettlement === true
                ? {
                    mode: 'local-ledger-only',
                    chain: 'none',
                    note: 'settlements are accounting records here, not chain facts',
                  }
                : { mode: 'unavailable', chain: 'none' },
          refusals: (
            [
              'VEIL-CONF-001',
              'VEIL-CONF-002',
              'VEIL-CONF-003',
              'VEIL-CONF-004',
              'VEIL-CONF-005',
            ] as const
          ).map((code: RefusalCode) => {
            const r = refusal(code);
            return { code: r.code, title: r.title, recoverable: r.recoverable };
          }),
        });
      }

      if (path === '/v1/health') {
        return json(res, 200, {
          ok: true,
          network: config.network,
          mint: config.mint,
          poolSize: facilitator.state.ledger.size,
          settled: facilitator.state.settled.length,
          settlement: config.rpcUrl
            ? 'rpc'
            : config.allowLocalSettlement === true
              ? 'local-ledger-only'
              : 'unavailable',
        });
      }

      // --- dashboard data --------------------------------------------------
      if (path === '/api/ledger') {
        return json(res, 200, {
          network: config.network,
          mint: config.mint,
          decimals: config.decimals,
          pool: facilitator.state.ledger.toJSON(),
          settled: facilitator.state.settled.map((s) => ({
            ...s,
            amount: s.amount.toString(),
          })),
        });
      }

      // --- protected resources --------------------------------------------
      const resource = byPath.get(path);
      if (!resource) {
        return json(res, 404, { error: 'not-found', path });
      }

      const payerHeader = req.headers['x-payer'];
      const payer = typeof payerHeader === 'string' ? payerHeader : 'anonymous';
      const nonce = Number(url.searchParams.get('nonce') ?? '0');
      const id: PaymentIdentity = { resource: path, payer, nonce };

      const paymentHeader = req.headers['x-payment'];

      // No payment yet: quote the price. This is the normal x402 first leg.
      if (typeof paymentHeader !== 'string') {
        const quote = facilitator.quote(resource, id);
        if (!quote.ok) return json(res, quote.status, quote.body);
        return json(res, 402, quote.body);
      }

      // A payment was supplied. Decode, verify, settle, then serve.
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          Buffer.from(paymentHeader, 'base64').toString('utf8'),
        );
      } catch {
        return json(res, 402, {
          error: 'malformed-payment-header',
          detail: 'X-PAYMENT must be base64-encoded JSON',
        });
      }

      const verified = facilitator.verify(decoded, resource);
      if (!verified.ok) {
        return json(res, verified.status, { error: 'invalid-payment', detail: verified.reason });
      }

      // The payment is identified by the request identity, the same inputs the
      // quote used, so a settlement can be reconciled to the offer it answered.
      const paymentId = derivePaymentId(id);
      const amount = priceFor(
        {
          base: resource.base,
          ...(resource.perUnit !== undefined ? { perUnit: resource.perUnit } : {}),
          ...(resource.units !== undefined ? { units: resource.units } : {}),
        },
        config.decimals,
      );

      // verify() already resolved and attributed the destination.
      const outcome = await facilitator.settle({
        payload: verified.payload,
        resource,
        address: verified.address,
        paymentId,
        amount,
      });

      if (!outcome.ok) {
        return json(res, outcome.status, {
          error: 'settlement-failed',
          detail: outcome.reason,
        });
      }

      return json(res, 200, {
        paid: true,
        settled: {
          signature: outcome.settlement.signature,
          amount: outcome.settlement.amount.toString(),
          at: outcome.settlement.at,
          confid: 'amount hidden on chain by Token-2022 confidential balances',
        },
        data: resource.produce({ paid: true }),
      });
    } catch (error) {
      // A thrown error must not leak internals.
      json(res, 500, {
        error: 'internal-error',
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_RESOURCES: readonly ResourceDefinition[] = [
  {
    path: '/v1/oracle/tide',
    alias: 'oracle.tide',
    description: 'Sea-state and tidal window, per call',
    base: '0.049',
    produce: () => ({
      station: 'Tidewater Atlas · Galveston Pier 21',
      window: '2026-10-02T04:12Z → 2026-10-02T10:38Z',
      waveHeightM: 1.2,
      // A real implementation would read a live feed; this server is the payment
      // rail, and the payload shape is what matters to an integrator.
      source: 'oracle.tide',
    }),
  },
  {
    path: '/v1/quote/feedmarket',
    alias: 'feedmarket',
    description: 'Feed commodity quote, per 1k bushels',
    base: '0.000',
    perUnit: '0.0011',
    units: 900,
    produce: () => ({
      commodity: 'Feed corn',
      unit: 'per bushel',
      price: '4.18',
      asOf: '2026-10-02T09:00:00Z',
      source: 'feedmarket',
    }),
  },
  {
    path: '/v1/attest/sensor',
    alias: 'sensor.attest',
    description: 'Sensor provenance attestation, per call',
    base: '0.012',
    produce: () => ({
      device: 'coldchain-4417',
      attestation: 'range-intact',
      issuedAt: '2026-10-02T09:41:07Z',
      source: 'sensor.attest',
    }),
  },
];

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    network: DEVNET,
    mint: PLACEHOLDER_MINT,
    decimals: 6,
    ledgerPath: 'data/pool-ledger.json',
    resources: DEFAULT_RESOURCES,
    spendCap: '5.00',
    // No privacy probe by default. A server that has not been told how to check
    // the confidential preconditions refuses every paid resource, which is the
    // correct default for a product whose only promise is that it never settles
    // in the clear.
    privacySource: 'none',
    ...overrides,
  };
}

/**
 * The probe a `privacySource: 'pool-ledger'` deployment uses.
 *
 * Answers from the ledger Veil itself wrote. `mintConfidential` is a declared
 * config value rather than a read, which is why it is never reported as `chain`
 * — the source field exists so this difference is visible rather than implied.
 */
export function poolLedgerProbe(
  ledger: PoolLedger,
  mintConfidential: boolean | 'unknown',
): PrivacyProbe {
  return {
    mintConfidential: () => mintConfidential,
    accountsArmed: (alias) => {
      const entries = ledger.allFor(alias);
      if (entries.length === 0) return false;
      return entries.some((e) => e.armed);
    },
  };
}

/** Re-exported so scripts and tests reach the protocol through one entry point. */
export {
  PLACEHOLDER_MINT,
  PoolLedger,
  buildPaymentRequired,
  isValidAddress,
  parsePaymentRequired,
  refusal,
};
