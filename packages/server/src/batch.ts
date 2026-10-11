/**
 * `batch-confidential` — sessions, cumulative vouchers, and one settlement.
 *
 * Veil's implementation of the x402 Batch Settlement scheme's **SVM binding**,
 * specified in `docs/notes/svm-batch-binding.md`. The scheme is chain-abstract
 * (commit → accumulate → redeem); this file is the binding: what a commitment
 * looks like on SVM, how vouchers are verified offline, how double-spends are
 * prevented, and how a whole session redeems as ONE confidential transfer into
 * a pooled one-time seat.
 *
 * The privacy upgrade over stock batch settlement: per-call usage is a voucher
 * signature — invisible on-chain. Only the session total ever lands on chain,
 * encrypted by Token-2022 Confidential Balances, readable by the merchant
 * alone. No MPC operator set, no FHE gateway: the chain verifies the transfer's
 * proofs and nothing else about the amounts.
 *
 * Trust model: **capital-backed**, per the x402 batch spec. The seats the pool
 * has already armed are the committed escrow — they exist on chain and only the
 * merchant can move their contents — and the payer's signed cap bounds the
 * session. There is no intermediary underwriting anything, which is the whole
 * difference between capital-backed and credit-backed trust.
 *
 * Two numbers are deliberately kept apart, because collapsing them is how a
 * session receipt lies:
 *
 *   - `served` — what the merchant actually handed over, summed from its own
 *     price list. This is the merchant's accounts-receivable.
 *   - the voucher head's `total` — what the payer signed off on owing. This is
 *     what redeems, because redeeming anything else would move money the payer
 *     did not authorize.
 *
 * A voucher must cover the call it pays for (`underpaid` otherwise), a sequence
 * must strictly advance, and the cumulative total must stay under the cap. Every
 * rule is checked offline, which is the "speed of HTTP" property the x402 batch
 * post claims — Veil keeps it and adds amount privacy on top.
 *
 * Everything here is pure except the clock, which is injected, so the session
 * state machine is testable without a chain and without sleeping.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { fromAtomic, toAtomic, type Atomic } from '../../x402-core/src/index.ts';

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/**
 * A cumulative voucher: the payer's signed "I owe you `total` for session S
 * through sequence N".
 *
 * Cumulative on purpose — the x402 batch spec's own model. A cumulative chain
 * head means the merchant only ever needs the *latest* voucher to redeem, a
 * dropped voucher costs nothing, and replaying an old voucher is detectable
 * (its seq is behind the head). It is also what makes the hot path stateless:
 * the voucher carries the whole session total, so the merchant never has to
 * reconstruct it from a log of individual charges to decide whether a call is
 * covered.
 */
export interface Voucher {
  readonly sessionId: string;
  /** 1-based sequence of this charge within the session. Strictly monotonic. */
  readonly seq: number;
  /** Cumulative amount for the whole session, in atomic units, as a string. */
  readonly total: string;
}

/** A voucher plus the payer's signature over it. */
export interface SignedVoucher {
  readonly voucher: Voucher;
  /** base64 ed25519 signature over `canonicalVoucher(voucher)`. */
  readonly signature: string;
}

/**
 * The exact bytes a voucher signs.
 *
 * Length-prefixed fields, same discipline as `derivePaymentId`, so no two
 * distinct vouchers can serialize to one string. A domain tag keeps this
 * signature from ever being confused with a transaction signature or anything
 * else the same key signs — a signature that can be reinterpreted is a
 * signature that can be forged from a different context.
 */
export function canonicalVoucher(voucher: Voucher): Buffer {
  const parts = [
    'veil-batch-voucher-v1',
    voucher.sessionId,
    String(voucher.seq),
    voucher.total,
  ];
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/** DER prefixes for raw ed25519 keys, the same ones the CLI key file uses. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A voucher signer over a 32-byte ed25519 seed (the agent key file's layout). */
export type VoucherSigner = (voucher: Voucher) => SignedVoucher;

export function voucherSignerFromSeed(seed: Uint8Array): VoucherSigner {
  if (seed.length !== 32) {
    throw new TypeError(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return (voucher) => ({
    voucher,
    signature: sign(null, canonicalVoucher(voucher), privateKey).toString('base64'),
  });
}

/**
 * Verify a voucher against a payer's raw public key.
 *
 * Offline by design — this is the "speed of HTTP" property the x402 batch
 * post claims, and Veil keeps it: no chain lookup happens on the charge path.
 * The shape checks come first so a malformed voucher cannot reach the verifier,
 * and a signature that cannot be parsed is a `false` rather than a throw: the
 * caller is deciding whether to serve, and a decision point must not be able to
 * fail as an exception.
 */
export function verifyVoucher(signed: SignedVoucher, payerPubkey: Uint8Array): boolean {
  if (payerPubkey.length !== 32) return false;
  const voucher = signed?.voucher;
  const signature = signed?.signature;
  if (
    typeof voucher?.sessionId !== 'string' ||
    voucher.sessionId.length === 0 ||
    !Number.isSafeInteger(voucher.seq) ||
    voucher.seq < 1 ||
    typeof voucher.total !== 'string' ||
    !/^\d+$/.test(voucher.total) ||
    typeof signature !== 'string' ||
    signature.length === 0
  ) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(payerPubkey)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, canonicalVoucher(voucher), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionState = 'open' | 'settled' | 'expired';

export interface BatchSession {
  readonly id: string;
  /** The payer's wallet address (X-Payer identity). */
  readonly payer: string;
  /** Merchant alias this session pays. Vouchers only charge resources of it. */
  readonly alias: string;
  /** Raw ed25519 public key (32 bytes) the voucher chain is verified against. */
  readonly payerPubkey: Uint8Array;
  /** Hard ceiling in atomic units — the session's spend cap. */
  readonly cap: Atomic;
  /** Highest sequence charged so far (0 = nothing charged yet). */
  readonly headSeq: number;
  /** Cumulative value the merchant has *served*, atomic. Its own tally. */
  readonly charged: Atomic;
  /**
   * The latest voucher the payer signed.
   *
   * Kept because redemption needs it and nothing else can reconstruct it: the
   * merchant holds a signature it cannot produce, and the receipt's whole point
   * is that the redeemed value is checkable against the payer's own signature
   * rather than against the merchant's word.
   */
  readonly headVoucher: SignedVoucher | null;
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly state: SessionState;
  /** Set once the session redeems. The reconciliation artifact (F6). */
  readonly receipt?: SessionReceipt;
}

/**
 * The per-session reconciliation artifact.
 *
 * The missing piece between per-payment rows (shipped) and session economics:
 * one row a merchant's books can close a session on, carrying what only the
 * merchant is entitled to know (the decrypted total) next to what anyone can
 * check (the voucher head and the settlement signature).
 *
 * `servedDecimal` and `totalDecimal` are both here because they are genuinely
 * different numbers and a receipt that showed only one would be wrong in one of
 * two directions: showing only the voucher total would overstate revenue when a
 * payer over-signed, and showing only the served value would hide how much of
 * the payer's authorization was drawn down.
 */
export interface SessionReceipt {
  readonly sessionId: string;
  readonly alias: string;
  readonly payer: string;
  /** The final voucher the merchant redeemed. Anyone can re-verify it. */
  readonly voucherHead: SignedVoucher;
  /** What the voucher authorized, in decimal units at the mint's precision. */
  readonly totalDecimal: string;
  /** What the merchant actually served, in decimal units. */
  readonly servedDecimal: string;
  /** How many calls the session carried. */
  readonly calls: number;
  /** The one-time seat the settlement landed in. */
  readonly seat: string;
  /** The settlement transaction, or null in local-ledger-only mode. */
  readonly signature: string | null;
  readonly settledAt: string;
  /** How the settlement happened — stated so a receipt is never mistaken for a chain fact. */
  readonly settlementMode: 'rpc' | 'local-ledger-only';
}

export type ChargeFailure =
  | 'unknown-session'
  | 'session-closed'
  | 'session-expired'
  | 'bad-signature'
  | 'stale-seq'
  | 'gap-seq'
  | 'over-cap'
  | 'underpaid';

export type ChargeOutcome =
  | { readonly ok: true; readonly headSeq: number; readonly charged: Atomic }
  | { readonly ok: false; readonly code: ChargeFailure };

export interface OpenSessionInput {
  readonly payer: string;
  readonly alias: string;
  readonly payerPubkey: Uint8Array;
  /** Decimal-unit cap, e.g. '0.50'. Converted with the mint's precision. */
  readonly cap: string;
  readonly decimals: number;
  readonly now?: Date;
  readonly ttlMs?: number;
}

/**
 * The session state machine.
 *
 * In-memory because sessions are hot-path state: a hosted deployment that needs
 * cross-instance sessions puts this behind the same store interface the pool
 * ledger uses, but the *rules* — monotonic seqs, cumulative caps, offline
 * signature checks — live here and nowhere else, exactly like the pool's rules
 * live in PoolLedger.
 *
 * In-memory is a real boundary and is stated rather than implied: a session
 * opened on one instance is not visible to another. A voucher presented to an
 * instance that did not open the session is refused as `unknown-session`, which
 * is a refusal rather than a wrong answer — the payer is told to retry against
 * the instance that holds its session, instead of being served on an unverified
 * voucher. A single-instance deployment (the local rail, the demo) is unaffected.
 */
export class BatchSessionManager {
  readonly #sessions = new Map<string, BatchSession>();
  readonly #decimals: number;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  #calls = 0;

  constructor(options: {
    readonly decimals: number;
    readonly ttlMs?: number;
    readonly now?: () => Date;
    /** Deterministic ids for tests. Default: a random 32-hex capability. */
    readonly idFactory?: () => string;
  }) {
    this.#decimals = options.decimals;
    // The x402 batch spec requires expiry; an hour is short enough that an
    // abandoned session's cap stops being a live liability, long enough that an
    // agent doing real work never sees it.
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomSessionId(this.#now()));
  }

  readonly #idFactory: () => string;

  open(input: OpenSessionInput): BatchSession {
    const now = input.now ?? this.#now();
    const cap = toAtomic(input.cap, input.decimals ?? this.#decimals);
    if (cap <= 0n) {
      throw new RangeError('a session cap must be greater than zero');
    }
    if (input.payerPubkey.length !== 32) {
      throw new TypeError(
        `payerPubkey must be a raw 32-byte ed25519 public key, got ${input.payerPubkey.length} bytes`,
      );
    }
    const session: BatchSession = {
      id: this.#idFactory(),
      payer: input.payer,
      alias: input.alias,
      payerPubkey: Uint8Array.from(input.payerPubkey),
      cap,
      headSeq: 0,
      charged: 0n,
      headVoucher: null,
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      state: 'open',
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): BatchSession | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (session.state === 'open' && Date.parse(session.expiresAt) <= this.#now().getTime()) {
      const expired: BatchSession = { ...session, state: 'expired' };
      this.#sessions.set(id, expired);
      return expired;
    }
    return session;
  }

  /**
   * Charge one call against a session, for `price` atomic units.
   *
   * The whole hot path, in one place: signature check (offline), strict sequence
   * monotonicity, no gaps, coverage of this call, cumulative cap. A session that
   * has settled refuses everything — the redemption already moved the total, so a
   * late voucher is a double-spend attempt, not a late arrival.
   *
   * `price` is the merchant's own number from its own price list. Requiring the
   * voucher to cover it is what stops a payer from signing a one-unit voucher and
   * drawing down an expensive resource: the signature proves *who* committed,
   * and this check establishes *how much* was committed for the call being
   * served.
   */
  charge(sessionId: string, signed: SignedVoucher, price: Atomic): ChargeOutcome {
    const session = this.get(sessionId);
    if (!session) return { ok: false, code: 'unknown-session' };
    if (session.state === 'settled') return { ok: false, code: 'session-closed' };
    if (session.state === 'expired') return { ok: false, code: 'session-expired' };
    if (price < 0n) throw new RangeError('price must not be negative');
    if (!verifyVoucher(signed, session.payerPubkey)) {
      return { ok: false, code: 'bad-signature' };
    }
    const { voucher } = signed;
    if (voucher.sessionId !== session.id) {
      return { ok: false, code: 'unknown-session' };
    }
    // Strictly next, no gaps and no replays. A cumulative chain where N can be
    // skipped would let one signature cover charges nobody vouched for, and a
    // repeat of N is a replay of a call already served.
    if (voucher.seq <= session.headSeq) return { ok: false, code: 'stale-seq' };
    if (voucher.seq !== session.headSeq + 1) return { ok: false, code: 'gap-seq' };
    const total = BigInt(voucher.total);
    if (total > session.cap) return { ok: false, code: 'over-cap' };
    if (total < session.charged + price) return { ok: false, code: 'underpaid' };

    const next: BatchSession = {
      ...session,
      headSeq: voucher.seq,
      charged: session.charged + price,
      headVoucher: signed,
    };
    this.#calls += 1;
    this.#sessions.set(sessionId, next);
    return { ok: true, headSeq: next.headSeq, charged: next.charged };
  }

  /**
   * Close a session with its redemption outcome.
   *
   * The caller (the HTTP layer) does the on-chain half — one confidential
   * transfer into a pooled seat via the normal verify/settle path — and hands
   * the result back here so the receipt lives with the session it describes.
   * Returns `null` for a session that is not open, so a double redemption cannot
   * overwrite the first receipt with a second one.
   */
  settle(
    sessionId: string,
    input: {
      readonly voucherHead: SignedVoucher;
      readonly seat: string;
      readonly signature: string | null;
      readonly settlementMode: 'rpc' | 'local-ledger-only';
    },
  ): SessionReceipt | null {
    const session = this.get(sessionId);
    if (!session || session.state !== 'open') return null;
    const receipt: SessionReceipt = {
      sessionId: session.id,
      alias: session.alias,
      payer: session.payer,
      voucherHead: input.voucherHead,
      totalDecimal: fromAtomic(BigInt(input.voucherHead.voucher.total), this.#decimals),
      servedDecimal: fromAtomic(session.charged, this.#decimals),
      calls: session.headSeq,
      seat: input.seat,
      signature: input.signature,
      settledAt: this.#now().toISOString(),
      settlementMode: input.settlementMode,
    };
    this.#sessions.set(sessionId, { ...session, state: 'settled', receipt });
    return receipt;
  }

  /** Every session, for the dashboard's session-economics view. */
  list(): BatchSession[] {
    return [...this.#sessions.values()];
  }

  /** Calls charged across every session this process holds. */
  get calls(): number {
    return this.#calls;
  }
}

/**
 * A session id nobody can guess and everybody can recompute a payment id from.
 *
 * Random rather than derived: unlike a payment identity (whose determinism lets
 * both sides reconcile), a session id is a bearer-ish capability — two parties
 * opening sessions at the same millisecond must not collide, and nothing needs
 * to derive it.
 */
function randomSessionId(now: Date): string {
  const entropy = Buffer.concat([
    Buffer.from(now.getTime().toString(16), 'utf8'),
    Buffer.from(String(Math.floor(Math.random() * 0xffffffffffffffff)), 'utf8'),
  ]);
  return createHash('sha256').update(entropy).digest('hex').slice(0, 32);
}

/** The cheapest way for a caller to see the cap in decimal units. */
export function capDecimal(session: BatchSession, decimals: number): string {
  return fromAtomic(session.cap, decimals);
}
