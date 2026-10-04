/**
 * @veil/x402-core — the protocol surface of Veil.
 *
 * Veil is an x402 *scheme* (`exact-confidential`) rather than a fork of x402. A
 * resource server answers an unpaid request with a PaymentRequired body whose
 * `accepts[]` entry names a one-time payment account and the Token-2022 mint to
 * pay in. The payer settles with a confidential transfer, so the amount moved is
 * never public even though the settlement itself is a normal Solana transaction.
 *
 * Everything in this module is pure: no network, no clock, no filesystem. That
 * is deliberate — the 402 body and the refusal policy are the parts a judge,
 * an integrator, or an auditor needs to reason about, and they must be
 * reproducible from inputs alone.
 *
 * Conformance note: `@x402/core` 2.28 exports its own `PaymentRequired` /
 * `PaymentRequirements` types, and the two versions disagree about field names:
 * v1 calls the price `maxAmountRequired` and keeps `resource` inside each
 * `accepts[]` entry, while v2 calls it `amount` and hoists `resource` to the top
 * level. Veil emits **both** names for the same value, so one body parses under
 * either schema. That is not indecision — it is the cheapest way to be a real
 * x402 citizen: a stock `x402ResourceServer`, `HTTPFacilitatorClient` or
 * `PaymentRequiredSchema.safeParse()` from `@x402/core` accepts what we send,
 * today, with no adapter in the middle. `conformance.test.ts` asserts this
 * against the stock zod schemas rather than against our own parser.
 *
 * `toX402Requirements` / `toX402PaymentRequired` / `toX402PaymentPayload` at the
 * bottom of this file are the single adaptation points, kept as pure functions
 * so this protocol core stays zero-dependency.
 */

export const X402_VERSION = 2 as const;

/** The scheme name Veil advertises. Mirrors x402's `exact` but adds privacy. */
export const VEIL_SCHEME = 'exact-confidential' as const;

/** Token-2022 program. Confidential balances only exist on this program. */
export const TOKEN_2022_PROGRAM_ADDRESS =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as const;

/** The privacy model we actually provide. Not a marketing string. */
export const PRIVACY_MODEL = 'confidential-balances' as const;

export type VeilScheme = typeof VEIL_SCHEME;
export type Network = `solana:${string}`;

/**
 * The CAIP-2 network identifiers x402 actually accepts.
 *
 * These are the Solana *genesis-hash* form, and they are not decorative. x402's
 * own `normalizeNetwork` validates against exactly this list and throws
 * `Unsupported SVM network` for anything else, so a body advertising
 * `solana:testnet` parses under x402's schema and is then rejected by x402's
 * signer. Veil learned this the hard way: the facilitator advertised
 * `solana:testnet`, the stock signer refused it, and the resulting failure looked
 * like a simulation error rather than a wrong network string.
 *
 * So the friendly names are inputs, not wire values. `normalizeNetwork` below is
 * the one place a name becomes an identifier, and `conformance.test.ts` asserts
 * the result against x402's own validator rather than against our opinion of it.
 */
export const SOLANA_MAINNET: Network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET: Network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SOLANA_TESTNET: Network = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';

/** Canonical identifiers, keyed by the names people actually type. */
const NETWORK_ALIASES: Record<string, Network> = {
  devnet: SOLANA_DEVNET,
  testnet: SOLANA_TESTNET,
  'mainnet-beta': SOLANA_MAINNET,
  mainnet: SOLANA_MAINNET,
  'solana:devnet': SOLANA_DEVNET,
  'solana:testnet': SOLANA_TESTNET,
  'solana:mainnet': SOLANA_MAINNET,
  'solana-devnet': SOLANA_DEVNET,
  'solana-testnet': SOLANA_TESTNET,
};

const CANONICAL_NETWORKS = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET];

/**
 * Turn whatever a caller configured into the identifier x402 accepts.
 *
 * Throws rather than guessing: an unrecognised network produces a payment that
 * cannot settle, and a facilitator that starts anyway turns that into a mystery
 * at the RPC layer.
 */
export function normalizeNetwork(network: string): Network {
  if ((CANONICAL_NETWORKS as readonly string[]).includes(network)) {
    return network as Network;
  }
  const alias = NETWORK_ALIASES[network];
  if (alias) return alias;
  throw new RangeError(
    `unsupported network ${JSON.stringify(network)}; use one of ${CANONICAL_NETWORKS.join(
      ', ',
    )}, or a friendly name such as testnet`,
  );
}

/** The network the local demo and the chain-free fixture path use. */
export const DEVNET: Network = SOLANA_DEVNET;

/**
 * Infer a cluster from the RPC endpoint a run actually talked to.
 *
 * The configured network and the endpoint are two independent pieces of state
 * that are easy to set inconsistently, and the resulting record is worse than no
 * record: this project's `data/mint.json` claimed `solana:devnet` while its
 * `rpcUrl` pointed at testnet, because the network came from an environment
 * default rather than from the chain that was read. The endpoint is the ground
 * truth — it is where the reads and writes went — so the label is derived from
 * it wherever the host is recognisable, and `undefined` where it is not (a local
 * validator, a private endpoint), which the caller should report rather than
 * guess at.
 */
export function networkFromRpc(rpcUrl: string): Network | undefined {
  const host = (() => {
    try {
      return new URL(rpcUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (!host) return undefined;
  if (host.includes('devnet')) return SOLANA_DEVNET;
  if (host.includes('testnet')) return SOLANA_TESTNET;
  if (host.includes('mainnet')) return SOLANA_MAINNET;
  return undefined;
}

/**
 * A syntactically valid mint address with no account behind it.
 *
 * The default configuration needs *a* mint string, and a placeholder that is not
 * a valid address is a trap: it parses fine into a 402 body, ships to a client,
 * and only fails at the first RPC call with an error that says nothing about the
 * real problem. An earlier version of this file shipped exactly that. So the
 * placeholder is a real 32-byte base58 address — it simply has no account — and
 * every 402 body is therefore parseable by every client that receives it.
 *
 * It decodes to the ASCII bytes `VeilUSD local placeholder mint!!`.
 */
export const PLACEHOLDER_MINT =
  '6pFkZndusKGifrKLXgaQJFjUT3Gi9n1uXcwkG7Jef3ur' as const;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode base58 to bytes, or return null.
 *
 * Hand-written so this module keeps its zero-dependency property. A protocol
 * core that a judge can read in one sitting is worth twenty lines of alphabet
 * arithmetic.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const bytes: number[] = [0];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * True when this string is a 32-byte base58 account address.
 *
 * Used to reject a misconfigured mint at startup rather than at the first RPC
 * call, and to reject an offer whose `payTo` no client could ever parse.
 */
export function isValidAddress(value: string): boolean {
  const bytes = decodeBase58(value);
  return bytes !== null && bytes.length === 32;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Codes the facilitator returns when it will not serve a request.
 *
 * These are a policy surface, not decoration. `VEIL-CONF-003` in particular is
 * load-bearing: when Veil cannot make a payment confidential it must refuse
 * outright. Downgrading to a public transfer silently would mean a merchant
 * believing they were private while their amounts sat on a public ledger, which
 * is worse than an error.
 */
export type RefusalCode =
  | 'VEIL-CONF-001' // mint does not carry the confidential-transfer extension
  | 'VEIL-CONF-002' // destination account cannot receive confidential credits
  | 'VEIL-CONF-003' // this payment cannot be made confidential — refuse to serve
  | 'VEIL-CONF-004' // buyer would exceed its declared spend cap
  | 'VEIL-CONF-005' // pool exhausted: no unconsumed one-time account available
  | 'VEIL-CONF-006'; // could not claim an address before another instance took it

export interface Refusal {
  readonly code: RefusalCode;
  readonly title: string;
  readonly detail: string;
  /** What the caller can actually do about it. */
  readonly remedy: string;
  /** Whether the server may proceed anyway. Only ever true for non-privacy faults. */
  readonly recoverable: boolean;
}

const REFUSALS: Record<RefusalCode, Omit<Refusal, 'code'>> = {
  'VEIL-CONF-001': {
    title: 'Mint is not confidential',
    detail:
      'The configured mint does not have the Token-2022 confidential-transfer extension initialised, so no transfer in it can be confidential.',
    remedy:
      'Initialise the confidential-transfer extension on the mint (getInitializeConfidentialTransferMintInstruction), or point Veil at a mint that already carries it.',
    recoverable: false,
  },
  'VEIL-CONF-002': {
    title: 'Destination cannot receive confidential credits',
    detail:
      'The destination account is configured to reject confidential credits (allow_confidential_credits is false), which would force this transfer to be public.',
    remedy:
      'Re-configure the destination account with enableConfidentialCredits before offering it as a payment account.',
    recoverable: false,
  },
  'VEIL-CONF-003': {
    title: 'Confidentiality cannot be guaranteed — refusing to serve',
    detail:
      'The payment could only be settled with a public transfer. Serving it would give the caller a false privacy guarantee.',
    remedy:
      'Fix the configuration fault (see the accompanying VEIL-CONF-00x reason) and retry. Veil never downgrades a payment to public.',
    recoverable: false,
  },
  'VEIL-CONF-004': {
    title: 'Buyer spend cap exceeded',
    detail:
      'Settling this payment would take the buyer past the cap it declared for this session.',
    remedy:
      'Raise the buyer spend cap for the session, or settle a smaller amount.',
    recoverable: true,
  },
  'VEIL-CONF-005': {
    title: 'One-time address pool exhausted',
    detail:
      'Every pre-configured payment account for this merchant alias has already been consumed. Reusing one would relink two payments on the public account graph.',
    remedy:
      'Grow the pool (scripts/setup-devnet.ts --pool-size N) or wait for consumed accounts to be re-armed.',
    recoverable: true,
  },
  'VEIL-CONF-006': {
    title: 'Could not reserve a one-time address',
    detail:
      'Another instance consumed every address this payment could be offered before this one could record its claim on one. Answering with an address this instance does not hold would offer the same one-time account to two payments, which is the relinking the pool exists to prevent — so the offer is refused instead.',
    remedy:
      'Retry the request. If it keeps happening, the rail is answering quotes faster than one instance can record reservations: grow the pool, or run fewer instances against the same store.',
    recoverable: true,
  },
};

export function refusal(code: RefusalCode): Refusal {
  return { code, ...REFUSALS[code] } as Refusal;
}

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === 'string' && value in REFUSALS;
}

/** A refusal suitable for embedding in a 402 body. Never leaks internals. */
export function refusalFor402(code: RefusalCode): {
  code: RefusalCode;
  message: string;
  remedy: string;
} {
  const r = refusal(code);
  return { code: r.code, message: r.title, remedy: r.remedy };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** An amount in atomic units. Held as bigint, never a float. */
export type Atomic = bigint;

/**
 * Decimal string -> atomic units. Rejects anything that cannot be represented
 * exactly at `decimals`, rather than rounding money silently.
 */
export function toAtomic(amount: string, decimals: number): Atomic {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be an integer in 0..18, got ${decimals}`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(amount)) {
    throw new TypeError(`not a decimal number: ${JSON.stringify(amount)}`);
  }
  const negative = amount.startsWith('-');
  const [whole, frac = ''] = (negative ? amount.slice(1) : amount).split('.');
  if (frac.length > decimals) {
    throw new RangeError(
      `${amount} has more precision than ${decimals} decimals can represent exactly`,
    );
  }
  const padded = frac.padEnd(decimals, '0');
  const value = BigInt(`${whole}${padded}`);
  return negative ? -value : value;
}

/** Atomic units -> decimal string, trimming trailing zeros but never the point. */
export function fromAtomic(amount: Atomic, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? '' : digits.slice(digits.length - decimals);
  const trimmed = frac.replace(/0+$/, '');
  const body = trimmed ? `${whole}.${trimmed}` : whole;
  return negative ? `-${body}` : body;
}

/** Human display of an atomic amount, e.g. "$247.80" for 247800000 at 6dp. */
export function formatAtomic(
  amount: Atomic,
  decimals: number,
  symbol = '$',
): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const digits = abs.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? '' : digits.slice(digits.length - decimals);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac ? `${grouped}.${frac}` : grouped;
  return `${negative ? '-' : ''}${symbol}${body}`;
}

export interface PriceInput {
  /** Flat charge for the call. */
  readonly base?: string;
  /** Charge per unit of measured usage. */
  readonly perUnit?: string;
  /** Measured usage for this call. */
  readonly units?: number;
}

/**
 * Price a call. Both components are decimal strings so the arithmetic happens
 * in bigint at the mint's precision and cannot drift.
 */
export function priceFor(input: PriceInput, decimals: number): Atomic {
  let total = 0n;
  if (input.base !== undefined) total += toAtomic(input.base, decimals);
  if (input.perUnit !== undefined) {
    const units = input.units ?? 0;
    if (!Number.isInteger(units) || units < 0) {
      throw new RangeError(`units must be a non-negative integer, got ${units}`);
    }
    const unitSteps = toAtomic(input.perUnit, decimals) * BigInt(units);
    total += unitSteps;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Budget guard
// ---------------------------------------------------------------------------

export interface BudgetState {
  /** The most the buyer has authorised for this session. */
  readonly spendCap: Atomic;
  /** What has already been settled against that cap. */
  readonly alreadySpent: Atomic;
}

export type BudgetVerdict =
  | { readonly ok: true; readonly remainingAfter: Atomic }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Decide whether a payment fits the buyer's declared cap.
 *
 * This exists so a client-side agent cannot be talked into unbounded spend by a
 * server that keeps raising its price, and so the facilitator can enforce the
 * cap the agent declared rather than the one the merchant would prefer.
 */
export function checkBudget(
  amount: Atomic,
  state: BudgetState,
): BudgetVerdict {
  if (amount < 0n) throw new RangeError('amount must not be negative');
  const projected = state.alreadySpent + amount;
  if (projected > state.spendCap) {
    return { ok: false, refusal: refusal('VEIL-CONF-004') };
  }
  return { ok: true, remainingAfter: state.spendCap - projected };
}

// ---------------------------------------------------------------------------
// The 402 body
// ---------------------------------------------------------------------------

export interface VeilAccept {
  readonly scheme: VeilScheme;
  readonly network: Network;
  /** Mint address the payment must be denominated in. */
  readonly asset: string;
  /** The one-time payment account this specific call must pay into. */
  readonly payTo: string;
  /**
   * Price in atomic units, as a string so no precision is lost in JSON.
   *
   * `maxAmountRequired` is x402 v1's name for this field and `amount` is v2's.
   * Both are always emitted with the same value — see the conformance note at the
   * top of this file — and `parseAccept` accepts either, verifying that a body
   * carrying both does not contradict itself.
   */
  readonly maxAmountRequired: string;
  /** x402 v2 name for {@link maxAmountRequired}. Always equal to it. */
  readonly amount: string;
  readonly resource: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: {
    readonly tokenProgram: string;
    readonly decimals: number;
    readonly privacy: typeof PRIVACY_MODEL;
    /** Which pool slot this address came from — lets the merchant reconcile. */
    readonly poolIndex: number;
    /** Optional third-party decryption key. Global per mint, so off by default. */
    readonly auditor?: string | null;
    /**
     * How the payer should treat the amount. The HTTP exchange is not private
     * (the payer must be told the price); what Veil hides is the on-chain amount.
     * Stating that here stops integrators assuming the wrong boundary.
     */
    readonly hides: readonly ['on-chain-amount', 'on-chain-balance'];
  };
}

/**
 * x402 v2 hoists the resource out of each `accepts[]` entry into this object.
 * Veil emits it alongside the per-accept `resource` string for the same reason it
 * emits both price names: one body, two parsers.
 */
export interface VeilResourceInfo {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface VeilPaymentRequired {
  readonly x402Version: typeof X402_VERSION;
  readonly error?: string;
  /**
   * v2 requires this field to be present, so it always is on a Veil body.
   * `parsePaymentRequired` tolerates its absence on the way in, because a v1
   * body produced by some other x402 server is still a body we must understand.
   */
  readonly resource?: VeilResourceInfo;
  readonly accepts: readonly VeilAccept[];
  /** Present only when Veil declined to serve. */
  readonly veil?: {
    readonly refused: RefusalCode;
    readonly message: string;
    readonly remedy: string;
  };
}

/**
 * Make a resource path absolute against the origin that actually served it.
 *
 * x402 v2's `resource.url` is a URL, and `accepts[].resource` is meant to name
 * where the payer goes back to. The hosted rail published `/v1/oracle/tide` — a
 * path with no scheme or host, which a stock x402 client cannot fetch and which
 * reads as a different resource from the one at the public origin. The origin is
 * only known where the request lands (`Host` / `x-forwarded-proto`), so the
 * caller passes it in. With no base, the path is returned unchanged, which keeps
 * the pure protocol core usable and testable without a request.
 */
export function resolveResourceUrl(resource: string, baseUrl?: string): string {
  if (!baseUrl) return resource;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resource)) return resource;
  try {
    return new URL(resource, baseUrl).toString();
  } catch {
    return resource;
  }
}

export interface BuildPaymentRequiredInput {
  readonly network: Network;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: Atomic;
  readonly decimals: number;
  readonly resource: string;
  /**
   * Origin the resource was served from, e.g. `https://veil.example`. When set,
   * `resource.url` and `accepts[].resource` are published absolute; without it
   * they stay as the caller passed them (a bare path in tests and local runs).
   */
  readonly baseUrl?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly poolIndex: number;
  readonly maxTimeoutSeconds?: number;
  readonly auditor?: string | null;
  readonly error?: string;
}

export function buildPaymentRequired(
  input: BuildPaymentRequiredInput,
): VeilPaymentRequired {
  // Normalised on the way out as well as in: whatever a deployment configured,
  // the body it publishes is the identifier x402's signer and client accept.
  const network = normalizeNetwork(input.network);
  if (input.amount <= 0n) {
    throw new RangeError('maxAmountRequired must be positive');
  }
  if (input.decimals < 0 || input.decimals > 18) {
    throw new RangeError('decimals out of range');
  }
  const amount = input.amount.toString();
  // Absolute when the caller knows the origin, so the resource a client is told
  // to pay for is the exact URL it can fetch back.
  const resource = resolveResourceUrl(input.resource, input.baseUrl);
  return {
    x402Version: X402_VERSION,
    ...(input.error ? { error: input.error } : {}),
    resource: {
      url: resource,
      ...(input.description ? { description: input.description } : {}),
      mimeType: input.mimeType ?? 'application/json',
    },
    accepts: [
      {
        scheme: VEIL_SCHEME,
        network,
        asset: input.asset,
        payTo: input.payTo,
        maxAmountRequired: amount,
        amount,
        resource,
        ...(input.description ? { description: input.description } : {}),
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60,
        extra: {
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          decimals: input.decimals,
          privacy: PRIVACY_MODEL,
          poolIndex: input.poolIndex,
          auditor: input.auditor ?? null,
          hides: ['on-chain-amount', 'on-chain-balance'],
        },
      },
    ],
  };
}

/** A 402 body that refuses, carrying the code so tooling can act on it. */
export function buildRefusal402(
  code: RefusalCode,
  input: Omit<BuildPaymentRequiredInput, 'amount'> & { amount?: Atomic },
): VeilPaymentRequired {
  const amount = input.amount ?? 0n;
  const r = refusalFor402(code);
  // A refusal still carries the price when there is one, so a caller that the
  // budget gate turned away can see what it was asked for. With no price there is
  // no offer, and `accepts` is empty on purpose: an empty `accepts[]` is how Veil
  // says "this is not a payment challenge, it is a refusal".
  const quote = amount > 0n ? buildPaymentRequired({ ...input, amount }) : null;
  return {
    x402Version: X402_VERSION,
    error: r.message,
    ...(quote ? { resource: quote.resource } : {}),
    accepts: quote ? quote.accepts : [],
    veil: { refused: code, message: r.message, remedy: r.remedy },
  };
}

export class PaymentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRequiredError';
  }
}

function requireString(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PaymentRequiredError(`${path} must be a non-empty string`);
  }
}

function parseAccept(raw: unknown, path: string): VeilAccept {
  if (typeof raw !== 'object' || raw === null) {
    throw new PaymentRequiredError(`${path} must be an object`);
  }
  const a = raw as Record<string, unknown>;
  if (a.scheme !== VEIL_SCHEME) {
    throw new PaymentRequiredError(
      `${path}.scheme must be ${VEIL_SCHEME}, got ${String(a.scheme)}`,
    );
  }
  requireString(a.network, `${path}.network`);
  requireString(a.asset, `${path}.asset`);
  requireString(a.payTo, `${path}.payTo`);
  requireString(a.resource, `${path}.resource`);

  // x402 v1 names the price `maxAmountRequired`, v2 names it `amount`. Accept
  // either, because a payer agent consumes bodies written by servers it does not
  // control: refusing a v2 body over a field name would make Veil unusable
  // against every current x402 merchant. When both are present they must agree —
  // a body that quotes two different prices is not a body to act on.
  const v1Name = a.maxAmountRequired;
  const v2Name = a.amount;
  if (typeof v1Name !== 'string' && typeof v2Name !== 'string') {
    throw new PaymentRequiredError(
      `${path}.maxAmountRequired (or its x402 v2 name, amount) is required`,
    );
  }
  if (v1Name !== undefined && v2Name !== undefined && v1Name !== v2Name) {
    throw new PaymentRequiredError(
      `${path} quotes two different prices: maxAmountRequired=${JSON.stringify(
        v1Name,
      )} but amount=${JSON.stringify(v2Name)}`,
    );
  }
  const price = typeof v1Name === 'string' ? v1Name : (v2Name as string);
  if (!/^\d+$/.test(price)) {
    throw new PaymentRequiredError(
      `${path}.maxAmountRequired must be an integer string in atomic units`,
    );
  }
  if (typeof a.maxTimeoutSeconds !== 'number' || a.maxTimeoutSeconds <= 0) {
    throw new PaymentRequiredError(`${path}.maxTimeoutSeconds must be positive`);
  }
  const extra = a.extra as Record<string, unknown> | undefined;
  if (!extra || typeof extra !== 'object') {
    throw new PaymentRequiredError(`${path}.extra must be an object`);
  }
  if (extra.privacy !== PRIVACY_MODEL) {
    throw new PaymentRequiredError(
      `${path}.extra.privacy must be ${PRIVACY_MODEL} — Veil will not parse an offer whose privacy claim it cannot check`,
    );
  }
  if (typeof extra.decimals !== 'number') {
    throw new PaymentRequiredError(`${path}.extra.decimals must be a number`);
  }
  if (typeof extra.poolIndex !== 'number' || extra.poolIndex < 0) {
    throw new PaymentRequiredError(`${path}.extra.poolIndex must be >= 0`);
  }
  // Normalised, not merely validated: a caller reading `.amount` off a body that
  // only carried the v1 name must never get `undefined`.
  const accept = raw as VeilAccept;
  return { ...accept, maxAmountRequired: price, amount: price };
}

/**
 * Parse a 402 body defensively. A payer agent consumes bodies produced by
 * servers it does not control, so a malformed or over-claiming offer must fail
 * loudly here rather than become a bad transaction.
 */
export function parsePaymentRequired(json: unknown): VeilPaymentRequired {
  if (typeof json !== 'object' || json === null) {
    throw new PaymentRequiredError('body must be a JSON object');
  }
  const b = json as Record<string, unknown>;
  if (b.x402Version !== X402_VERSION) {
    throw new PaymentRequiredError(
      `x402Version must be ${X402_VERSION}, got ${String(b.x402Version)}`,
    );
  }
  if (!Array.isArray(b.accepts)) {
    throw new PaymentRequiredError('accepts must be an array');
  }
  const accepts = b.accepts.map((entry, i) => parseAccept(entry, `accepts[${i}]`));
  let veil: VeilPaymentRequired['veil'];
  if (b.veil !== undefined) {
    if (typeof b.veil !== 'object' || b.veil === null) {
      throw new PaymentRequiredError('veil must be an object when present');
    }
    const v = b.veil as Record<string, unknown>;
    if (!isRefusalCode(v.refused)) {
      throw new PaymentRequiredError(
        `veil.refused is not a known refusal code: ${String(v.refused)}`,
      );
    }
    veil = {
      refused: v.refused,
      message: String(v.message ?? ''),
      remedy: String(v.remedy ?? ''),
    };
  }
  return {
    x402Version: X402_VERSION,
    ...(typeof b.error === 'string' ? { error: b.error } : {}),
    ...(isResourceInfo(b.resource)
      ? { resource: b.resource }
      : accepts[0]
        ? { resource: { url: accepts[0].resource, mimeType: accepts[0].mimeType ?? 'application/json', ...(accepts[0].description ? { description: accepts[0].description } : {}) } }
        : {}),
    accepts,
    ...(veil ? { veil } : {}),
  };
}

function isResourceInfo(raw: unknown): raw is VeilResourceInfo {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).url === 'string'
  );
}

// ---------------------------------------------------------------------------
// Payment payload
// ---------------------------------------------------------------------------

export interface VeilPaymentPayload {
  readonly x402Version: typeof X402_VERSION;
  /** v1 field: the scheme the payer selected. Redundant with `accepted`. */
  readonly scheme: VeilScheme;
  /** v1 field: the network the payer selected. Redundant with `accepted`. */
  readonly network: Network;
  /**
   * v2 field: the exact `accepts[]` entry this payment answers.
   *
   * Emitted so the payload round-trips through a stock x402 client/server, and
   * load-bearing for a second reason: a payer that quotes the terms it agreed to
   * gives the merchant something to check the payment against without holding
   * per-request state.
   */
  readonly accepted: VeilAccept;
  readonly resource?: VeilResourceInfo;
  readonly payload: {
    /** Base64 of the signed, serialised Solana transaction. */
    readonly transaction: string;
    /**
     * The destination account the payer actually paid.
     *
     * Echoed back rather than inferred, so a server can attribute a payment
     * without holding per-request state. The server still checks this against
     * its own pool, so echoing it is a claim to be verified and not a trusted
     * input — a payer naming somebody else's account simply fails the check.
     */
    readonly payTo: string;
    /** The mint paid in, echoed for the same reason. */
    readonly asset: string;
    /** Facilitator fills this in after broadcast. */
    readonly signature?: string;
  };
}

export interface BuildPaymentPayloadInput {
  /** The `accepts[]` entry being paid. Everything else is derived from it. */
  readonly accept: VeilAccept;
  /** Base64 of the signed, serialised Solana transaction. */
  readonly transaction: string;
  /** The account actually paid — echoed and then checked by the merchant. */
  readonly payTo: string;
  /** Filled in by the facilitator after broadcast. */
  readonly signature?: string;
}

/**
 * Build the payer's payload.
 *
 * This exists so the wire shape is produced in exactly one place. Both the local
 * demo and the page fixtures used to hand-assemble a payload object, which is
 * how a field gets dropped from one of them and nobody notices — `accepted` in
 * particular is only checked by x402's own schema, not by ours.
 */
export function buildPaymentPayload(input: BuildPaymentPayloadInput): VeilPaymentPayload {
  if (input.accept.scheme !== VEIL_SCHEME) {
    throw new PaymentRequiredError(
      `cannot pay an offer for scheme ${JSON.stringify(input.accept.scheme)} with Veil`,
    );
  }
  if (input.transaction.length === 0) {
    throw new PaymentRequiredError('transaction must be a base64 signed transaction');
  }
  if (input.payTo !== input.accept.payTo) {
    throw new PaymentRequiredError(
      `payTo ${JSON.stringify(input.payTo)} is not the account this offer names (${JSON.stringify(
        input.accept.payTo,
      )})`,
    );
  }
  return {
    x402Version: X402_VERSION,
    scheme: VEIL_SCHEME,
    network: input.accept.network,
    accepted: input.accept,
    resource: {
      url: input.accept.resource,
      ...(input.accept.description ? { description: input.accept.description } : {}),
      mimeType: input.accept.mimeType ?? 'application/json',
    },
    payload: {
      transaction: input.transaction,
      payTo: input.payTo,
      asset: input.accept.asset,
      ...(input.signature ? { signature: input.signature } : {}),
    },
  };
}

/**
 * The single adaptation point to x402's own requirement shape — **v2**.
 *
 * Kept as a standalone function rather than a dependency so Veil's protocol core
 * has zero runtime dependencies and can be read in one sitting. `amount` is the
 * v2 name; the v1 name travels in the same object so that a v1-only consumer
 * still finds it.
 */
export function toX402Requirements(accept: VeilAccept): {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
} {
  return {
    scheme: accept.scheme,
    network: accept.network,
    asset: accept.asset,
    amount: accept.amount,
    maxAmountRequired: accept.maxAmountRequired,
    payTo: accept.payTo,
    resource: accept.resource,
    description: accept.description ?? '',
    mimeType: accept.mimeType ?? 'application/json',
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    extra: accept.extra as unknown as Record<string, unknown>,
  };
}

/** The body as a stock x402 v2 `PaymentRequired`, resource hoisted. */
export function toX402PaymentRequired(body: VeilPaymentRequired): {
  x402Version: number;
  error?: string;
  resource: VeilResourceInfo;
  accepts: ReturnType<typeof toX402Requirements>[];
  extensions?: Record<string, unknown>;
} {
  return {
    x402Version: X402_VERSION,
    ...(body.error ? { error: body.error } : {}),
    resource: body.resource ?? {
      url: body.accepts[0]?.resource ?? '',
      mimeType: body.accepts[0]?.mimeType ?? 'application/json',
    },
    accepts: body.accepts.map(toX402Requirements),
    ...(body.veil
      ? { extensions: { veil: body.veil as unknown as Record<string, unknown> } }
      : {}),
  };
}

/** The payload as a stock x402 v2 `PaymentPayload`. */
export function toX402PaymentPayload(payload: VeilPaymentPayload): {
  x402Version: number;
  resource?: VeilResourceInfo;
  accepted: ReturnType<typeof toX402Requirements>;
  payload: Record<string, unknown>;
} {
  return {
    x402Version: X402_VERSION,
    ...(payload.resource ? { resource: payload.resource } : {}),
    accepted: toX402Requirements(payload.accepted),
    payload: { ...payload.payload },
  };
}
