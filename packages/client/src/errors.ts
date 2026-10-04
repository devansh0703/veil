/**
 * @veil/client — the error envelope.
 *
 * Every failure a developer can hit has one machine-readable shape, the one the
 * DX spec asks for: `type`, `code`, `message`, `param`, `cause`, `fix`, `doc_url`.
 * A raw Token-2022 program error tells a developer nothing; a code with a fix and
 * a link tells them exactly what to change. The distinction between a *refusal*
 * (Veil will not serve this) and a *client fault* (your request was wrong) is
 * carried in `type`, because they need different reactions: a refusal is final,
 * a client fault is a bug in the caller.
 */

export type VeilErrorType =
  | 'veil_refusal' // the rail declined to serve, by policy
  | 'veil_client_error' // the caller asked for something impossible
  | 'veil_rail_error' // the rail or the chain failed
  | 'veil_budget_error'; // the caller's own budget stopped the payment

export interface VeilErrorEnvelope {
  readonly type: VeilErrorType;
  readonly code: string;
  readonly message: string;
  /** The parameter at fault, when one is. */
  readonly param?: string;
  /** The underlying error, if there was one. */
  readonly cause?: string;
  /** The one thing to do about it. */
  readonly fix: string;
  readonly doc_url: string;
}

const DOCS = 'https://github.com/devansh0703/veil/blob/main/docs/troubleshooting.md';

interface CatalogEntry {
  readonly type: VeilErrorType;
  readonly message: string;
  readonly fix: string;
  readonly doc_url?: string;
}

/**
 * The catalogue.
 *
 * `VEIL-CONF-003` is load-bearing and deliberate: when confidentiality cannot be
 * guaranteed, the client refuses rather than silently paying in the clear. A
 * downgrade here would be the worst bug this product could have, so it is an
 * error the caller cannot swallow by accident.
 */
const CATALOG = {
  'VEIL-ACC-001': {
    type: 'veil_refusal',
    message: 'The destination account cannot receive confidential credits.',
    fix: 'Get sandbox dollars for this payer, or point at a rail whose destination is armed: `npm run sandbox -- --address <payer>`.',
  },
  'VEIL-BUDGET-002': {
    type: 'veil_budget_error',
    message: 'This payment would exceed the budget you set for the agent.',
    fix: 'Raise the budget, or spend less before this call. Veil never falls back to a public payment.',
  },
  'VEIL-CONF-003': {
    type: 'veil_refusal',
    message: 'Confidentiality cannot be guaranteed for this payment — refusing to pay.',
    fix: 'Fix the configuration named in the refusal (see the `veil` field of the 402 body) and retry, or use a rail that is configured for the mint.',
  },
  'VEIL-OFFER-004': {
    type: 'veil_rail_error',
    message: 'The rail returned a 402 that is not a usable Veil offer.',
    fix: 'Check that the URL is a Veil resource and the rail is up: `GET <rail>/v1/health`.',
  },
  'VEIL-POOL-005': {
    type: 'veil_refusal',
    message: 'The merchant has no unconsumed one-time account left.',
    fix: 'Wait for seats to be re-armed, or use a different merchant alias in the demo.',
  },
  'VEIL-PAY-006': {
    type: 'veil_rail_error',
    message: 'The payment was built but the rail did not settle it.',
    fix: 'Read `detail` on the response; a funding or simulation failure is reported there rather than swallowed.',
  },
  'VEIL-CONTEND-008': {
    type: 'veil_refusal',
    message: 'The rail could not claim an address for this payment before another instance claimed every one it could offer.',
    fix: 'Retry. The rail refuses rather than name an address it does not hold, because paying into one would leave money on chain and nothing credited. If it keeps happening the pool is being walked faster than reservations can be recorded — grow it (`npm run setup:devnet -- --apply`).',
  },
  'VEIL-RAIL-007': {
    type: 'veil_rail_error',
    message: 'The rail could not be reached.',
    fix: 'Check the origin (it must be the deployed rail, not a path) and your network.',
  },
} as const;

export type VeilCode = keyof typeof CATALOG;

/** A structured Veil failure. Every field a developer needs is on the object. */
export class VeilError extends Error {
  readonly type: VeilErrorType;
  readonly code: string;
  readonly param?: string;
  // `cause` is inherited from `Error` (used via the standard options bag), so it
  // is deliberately not redeclared here; `toEnvelope` renders it as a string.
  readonly fix: string;
  readonly doc_url: string;

  constructor(
    code: VeilCode,
    overrides: Partial<Pick<VeilErrorEnvelope, 'message' | 'param' | 'cause' | 'fix'>> = {},
  ) {
    const entry: CatalogEntry = CATALOG[code];
    const message = overrides.message ?? entry.message;
    super(message, overrides.cause !== undefined ? { cause: overrides.cause } : undefined);
    this.name = 'VeilError';
    this.type = entry.type;
    this.code = code;
    this.message = message;
    this.fix = overrides.fix ?? entry.fix;
    this.doc_url = entry.doc_url ?? DOCS;
    if (overrides.param !== undefined) this.param = overrides.param;
  }

  /** The wire shape, for logging or for a JSON error response. */
  toEnvelope(): VeilErrorEnvelope {
    return {
      type: this.type,
      code: this.code,
      message: this.message,
      ...(this.param !== undefined ? { param: this.param } : {}),
      ...(this.cause !== undefined ? { cause: String(this.cause) } : {}),
      fix: this.fix,
      doc_url: this.doc_url,
    };
  }
}

export function isVeilError(value: unknown): value is VeilError {
  return value instanceof VeilError;
}
