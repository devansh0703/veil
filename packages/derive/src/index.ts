/**
 * @veil/derive — one-time-address assignment and resolution.
 *
 * ## What this module is for
 *
 * Confidential balances hide *amounts*. They do not hide *which accounts exist*.
 * If a merchant received every payment into a single token account, an observer
 * could still count transactions and correlate them with the merchant's public
 * identity — amount privacy with a fully public graph around it.
 *
 * Veil's second privacy layer is that each payment lands in a different
 * pre-created account, so two payments to the same merchant never sit next to
 * each other on the account graph.
 *
 * ## A correction worth stating plainly
 *
 * The engineering review (AR8) asked for a *derivation function* that the agent
 * and the merchant both call to arrive at the same one-time address. That is not
 * implementable as written, and pretending otherwise would produce two code
 * paths that silently disagree — the exact leak AR8 was trying to prevent.
 *
 * A token account's address is not a function of (owner, mint): the only address
 * form that is, is the associated token account, and there is exactly *one* ATA
 * per (owner, mint) pair. A pool of N accounts for one mint therefore cannot be
 * derived; the accounts are created once and their addresses recorded.
 *
 * So the "single implementation consumed by both sides" here is:
 *
 *   - `deriveSlot` — pure and deterministic. Given the same payment identity and
 *     pool size, the agent and the merchant independently agree on *which slot*
 *     a payment belongs to, with no coordination.
 *   - `PoolLedger` — the single source of truth for slot -> address -> alias.
 *     Both sides read addresses from this, never from a second implementation.
 *
 * The agent learns its destination address from the 402 offer. What it checks is
 * that the offered address is one this ledger actually owns for that alias —
 * which is a real verification, and it is the thing that keeps the two sides in
 * agreement.
 */

import { createHash } from 'node:crypto';

/** How a payment identity is formed. Stable across sides; never user-visible. */
export interface PaymentIdentity {
  /** The resource being paid for, as advertised in the 402 body. */
  readonly resource: string;
  /** The payer's wallet address. */
  readonly payer: string;
  /** Monotonic per-session counter, so repeats of the same call differ. */
  readonly nonce: number | bigint;
}

/**
 * A stable 32-byte digest of a payment identity.
 *
 * Field lengths are prefixed so that `("ab","c")` and `("a","bc")` cannot hash
 * to the same value. Without that, a payer could craft a resource string to
 * collide with another resource's identity.
 */
export function derivePaymentId(id: PaymentIdentity): string {
  const h = createHash('sha256');
  const parts = [id.resource, id.payer, String(id.nonce)];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    h.update(len);
    h.update(bytes);
  }
  return h.digest('hex');
}

/**
 * Choose a slot in the pool for a payment.
 *
 * Deterministic and pure: both sides compute this from the same identity and get
 * the same answer, which is what lets the merchant reconcile an incoming payment
 * without the payer telling it anything extra.
 *
 * The digest is reduced modulo `poolSize`, so this is a *partition*, not a
 * permutation — for a pool of 32 and a handful of payments, collisions are
 * possible and are handled by the ledger (a taken slot falls through to the next
 * free one). `poolSize` must be a power of two for the modulo to be unbiased;
 * this function rejects other sizes rather than quietly skewing the distribution.
 */
export function deriveSlot(id: PaymentIdentity, poolSize: number): number {
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new RangeError(`poolSize must be a positive integer, got ${poolSize}`);
  }
  if ((poolSize & (poolSize - 1)) !== 0) {
    throw new RangeError(
      `poolSize must be a power of two so slot assignment is unbiased, got ${poolSize}`,
    );
  }
  const digest = Buffer.from(derivePaymentId(id), 'hex');
  // Take 4 bytes of the digest. 2^32 is an exact multiple of any power-of-two
  // poolSize, so the modulo below introduces no bias.
  return digest.readUInt32BE(0) % poolSize;
}

// ---------------------------------------------------------------------------
// Pool ledger
// ---------------------------------------------------------------------------

export interface PoolEntry {
  readonly slot: number;
  readonly address: string;
  readonly alias: string;
  /** True when the account exists on chain and can receive a confidential credit. */
  readonly armed: boolean;
  /** Payment id that consumed this slot, if any. */
  readonly consumedBy: string | null;
  /** Set when the slot was re-armed after a settlement reconciled. */
  readonly settledAt?: string;
}

/**
 * The ledger's own accounting record.
 *
 * Public reads hand out `PoolEntry` copies; mutations happen against this type.
 * Keeping the two separate is what lets `PoolEntry` be honestly readonly — a
 * caller cannot reach in and re-arm a slot, because they never hold the entry the
 * ledger mutates.
 */
interface MutableEntry {
  slot: number;
  address: string;
  alias: string;
  armed: boolean;
  consumedBy: string | null;
  settledAt?: string;
}

export class PoolExhaustedError extends Error {
  readonly code = 'VEIL-CONF-005' as const;
  constructor(alias: string, size: number) {
    super(
      `no armed one-time account left for alias ${alias} (pool size ${size})`,
    );
    this.name = 'PoolExhaustedError';
  }
}

export class SlotConflictError extends Error {
  constructor(slot: number, alias: string) {
    super(`slot ${slot} is already occupied by alias ${alias}`);
    this.name = 'SlotConflictError';
  }
}

/**
 * The merchant's index of one-time payment accounts.
 *
 * Deliberately holds no key material. A pool account's authority is the
 * merchant's wallet, so the merchant never needs the account's own private key —
 * it needs the address, the alias it belongs to, and whether it is armed. That
 * makes this file safe to persist and to show in the dashboard, which is why the
 * dashboard can render the mapping at all.
 */
export class PoolLedger {
  #entries: MutableEntry[] = [];

  private constructor(entries: MutableEntry[]) {
    this.#entries = entries;
  }

  static empty(): PoolLedger {
    return new PoolLedger([]);
  }

  static fromJSON(json: unknown): PoolLedger {
    if (!Array.isArray(json)) {
      throw new TypeError('pool ledger must be a JSON array');
    }
    const entries = json.map((raw, i) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new TypeError(`entry ${i} must be an object`);
      }
      const e = raw as Record<string, unknown>;
      if (typeof e.slot !== 'number' || !Number.isInteger(e.slot) || e.slot < 0) {
        throw new TypeError(`entry ${i}.slot must be a non-negative integer`);
      }
      if (typeof e.address !== 'string' || e.address.length === 0) {
        throw new TypeError(`entry ${i}.address must be a non-empty string`);
      }
      if (typeof e.alias !== 'string' || e.alias.length === 0) {
        throw new TypeError(`entry ${i}.alias must be a non-empty string`);
      }
      if (typeof e.armed !== 'boolean') {
        throw new TypeError(`entry ${i}.armed must be a boolean`);
      }
      const consumedBy = e.consumedBy ?? null;
      if (consumedBy !== null && typeof consumedBy !== 'string') {
        throw new TypeError(`entry ${i}.consumedBy must be a string or null`);
      }
      return {
        slot: e.slot,
        address: e.address,
        alias: e.alias,
        armed: e.armed,
        consumedBy,
        ...(typeof e.settledAt === 'string' ? { settledAt: e.settledAt } : {}),
      } satisfies MutableEntry;
    });
    const ledger = new PoolLedger(entries);
    ledger.assertInvariants();
    return ledger;
  }

  toJSON(): PoolEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * Register a pool account. Slots are addressed explicitly, never inferred.
   *
   * Slot numbers are scoped to an alias: every merchant's pool starts at slot 0,
   * because `deriveSlot` partitions against that merchant's own pool size. Only
   * addresses must be globally unique — a shared address is what would make two
   * merchants linkable.
   */
  register(entry: Omit<PoolEntry, 'consumedBy'> & { consumedBy?: string | null }): void {
    if (
      this.#entries.some(
        (e) => e.slot === entry.slot && e.alias === entry.alias,
      )
    ) {
      throw new SlotConflictError(entry.slot, entry.alias);
    }
    if (this.#entries.some((e) => e.address === entry.address)) {
      throw new Error(`address ${entry.address} is already registered`);
    }
    this.#entries.push({ consumedBy: null, ...entry });
  }

  /**
   * Reserve the next free armed slot for an alias.
   *
   * Tries the deterministic slot first, then falls through to the next free one
   * that is free. Every failure mode the caller cares about is a named error
   * rather than a null, because a null here becomes a public transfer later.
   */
  reserve(
    alias: string,
    id: PaymentIdentity,
    poolSize = this.#capacityFor(alias),
  ): PoolEntry {
    const preferred = deriveSlot(id, poolSize);
    const paymentId = derivePaymentId(id);

    // Re-quoting the same payment identity hands back the seat it already holds.
    // A quote is keyed by the payment, not by the HTTP request: a client that
    // retries a 402 (browser refresh, a read that 429'd) must not burn a second
    // seat, and two offers for one payment id must never name two addresses —
    // that is the shape that lets one payment look like two on the public graph.
    // Distinct payments are distinct nonces, and only those take a new seat.
    const held = this.#entries.find(
      (e) => e.alias === alias && e.consumedBy === paymentId,
    );
    if (held) return { ...held };

    // Operate on the ledger's own entries, not on copies, so the reservation
    // actually sticks.
    const free = this.#entries.filter(
      (e) => e.alias === alias && e.armed && !e.consumedBy,
    );
    if (free.length === 0) throw new PoolExhaustedError(alias, poolSize);

    const chosen = free.find((e) => e.slot === preferred) ?? free[0];
    if (!chosen) throw new PoolExhaustedError(alias, poolSize);

    chosen.consumedBy = paymentId;
    return { ...chosen };
  }

  /**
   * The seat a payment identity holds, if it holds one — spent or not.
   *
   * Read-only, and deliberately not a reservation: the caller uses it to notice
   * that an identity is already *settled*, which is a different answer from the
   * pool being empty. `reserve()` stays the only thing that consumes a seat.
   */
  entryFor(alias: string, id: PaymentIdentity): PoolEntry | null {
    const paymentId = derivePaymentId(id);
    const entry = this.#entries.find(
      (e) => e.alias === alias && e.consumedBy === paymentId,
    );
    return entry ? { ...entry } : null;
  }

  /** Resolve an incoming payment's destination address back to its alias. */
  resolve(address: string): PoolEntry | undefined {
    const entry = this.#entries.find((e) => e.address === address);
    return entry ? { ...entry } : undefined;
  }

  /** An alias's alias — i.e. which merchant owns this destination. */
  aliasFor(address: string): string | undefined {
    return this.#entries.find((e) => e.address === address)?.alias;
  }

  /**
   * Slots that are ready to take a payment.
   *
   * Returns copies. An earlier version returned the internal objects straight out
   * of `filter`, which let a caller silently re-arm or consume a slot by mutating
   * what it was handed.
   */
  armedFor(alias: string): PoolEntry[] {
    return this.#entries
      .filter((e) => e.alias === alias && e.armed && !e.consumedBy)
      .map((e) => ({ ...e }));
  }

  allFor(alias?: string): PoolEntry[] {
    return this.#entries
      .filter((e) => alias === undefined || e.alias === alias)
      .map((e) => ({ ...e }));
  }

  /**
   * Would `settle` accept this? Checked *before* anything irreversible happens.
   *
   * This exists because settlement is two steps with a broadcast in the middle,
   * and the broadcast cannot be undone. If the accounting check ran only after
   * the broadcast, a rejected settlement would leave money on chain that the
   * ledger had no record of — the payer paid, the merchant was paid, and the
   * merchant's own books said nothing had happened. Splitting the check from the
   * mutation lets the caller validate first, broadcast second, commit third.
   */
  settleable(address: string, consumedBy: string): void {
    this.#findSettleable(address, consumedBy);
  }

  /**
   * Take a seat for a payment that is being settled now rather than quoted.
   *
   * On a single process, `reserve` at quote time and `settle` at payment time
   * are the same pool, so a seat is always already claimed by the time it is
   * paid. A hosted rail breaks that assumption: the instance that answers the
   * unpaid request and the instance that answers the paid one are not
   * guaranteed to be the same, and the second one has never heard of the
   * reservation.
   *
   * Refusing in that case is the worst possible answer, because the money has
   * already moved into the merchant's own account — the rail would be taking
   * the payment and recording nothing. So a payment may claim a seat that is
   * still free, and this is idempotent for the seat's current owner.
   *
   * What it deliberately does *not* do is take a seat claimed by a different
   * payment. That is the one case where refusing is right: two payments into one
   * one-time address is exactly the relinking the pool exists to prevent, and
   * the second payer must be told to use a new offer rather than be counted into
   * an address someone else is already using.
   */
  claim(address: string, consumedBy: string): void {
    const entry = this.#entries.find((e) => e.address === address);
    if (!entry) throw new Error(`unknown payment account ${address}`);
    // Already this payment's seat: the normal case on a single process.
    if (entry.consumedBy === consumedBy) return;
    if (entry.consumedBy !== null) {
      throw new Error(
        `account ${address} was consumed by ${entry.consumedBy}, not ${consumedBy}`,
      );
    }
    // Re-arming is a separate, deliberate operation; a settlement path must not
    // quietly hand out an account the merchant chose to withhold.
    if (!entry.armed) {
      throw new Error(`account ${address} is not armed, so it cannot take a payment`);
    }
    entry.consumedBy = consumedBy;
  }

  #findSettleable(address: string, consumedBy: string): MutableEntry {
    const entry = this.#entries.find((e) => e.address === address);
    if (!entry) throw new Error(`unknown payment account ${address}`);
    if (entry.consumedBy === null) {
      throw new Error(
        `account ${address} was never reserved, so nothing could have settled into it`,
      );
    }
    if (entry.consumedBy !== consumedBy) {
      throw new Error(
        `account ${address} was consumed by ${entry.consumedBy}, not ${consumedBy}`,
      );
    }
    if (entry.settledAt !== undefined) {
      throw new Error(
        `account ${address} already settled at ${entry.settledAt} — settling twice would double-count one payment`, 
      );
    }
    return entry;
  }

  /**
   * Record that a payment settled into this account.
   *
   * Deliberately does NOT free the account for reuse.
   *
   * An earlier version re-armed the slot here, which quietly turned the one-time
   * address back into a reusable one: the next payment would have landed in an
   * account that already held a settled payment, and the public graph would link
   * the two. That is precisely the leak the pool exists to close, so a consumed
   * account stays consumed and the pool is grown instead (see PoolExhaustedError
   * and VEIL-CONF-005).
   *
   * Settling the same account twice is rejected rather than re-stamped: a payer
   * that retries a settle it already got a 200 for must not be counted twice.
   */
  settle(address: string, consumedBy: string, settledAt: string): void {
    const entry = this.#findSettleable(address, consumedBy);
    entry.settledAt = settledAt;
  }

  #capacityFor(alias: string): number {
    const total = this.#entries.filter((e) => e.alias === alias).length;
    if (total === 0) {
      throw new Error(`no pool accounts registered for alias ${alias}`);
    }
    // Largest power of two that is not larger than the alias's pool, so
    // deriveSlot's unbiased-modulo precondition holds.
    return 2 ** Math.floor(Math.log2(total));
  }

  /**
   * Invariants that must hold for the privacy claim to be true.
   *
   * These are checked on load, not just on write, because the ledger is a file
   * on disk and a hand-edit is a realistic way for a duplicate address to appear.
   */
  assertInvariants(): void {
    const seenSlots = new Set<string>();
    const seenAddresses = new Set<string>();
    for (const e of this.#entries) {
      const slotKey = `${e.alias}#${e.slot}`;
      if (seenSlots.has(slotKey)) {
        throw new Error(`duplicate slot ${e.slot} for alias ${e.alias}`);
      }
      seenSlots.add(slotKey);
      if (seenAddresses.has(e.address)) {
        throw new Error(
          `duplicate address ${e.address} in pool ledger — two aliases would be linkable`,
        );
      }
      seenAddresses.add(e.address);
      if (e.consumedBy !== null && !e.armed) {
        throw new Error(
          `slot ${e.slot} is consumed by a payment but not armed — it could not have settled`,
        );
      }
    }
  }
}

/**
 * A settlement in the form it can be stored and served.
 *
 * The ledger records *that* a seat settled (`settledAt`), which is the part the
 * pool's promise depends on. It does not record the transaction that settled it:
 * the signature, amount and resource live in the process that broadcast the
 * payment, which is exactly the copy a serverless instance loses. Keeping the
 * record here, in a shape both the store and the HTTP surface can carry, is what
 * lets a dashboard show a settlement that a *different* instance took.
 *
 * `amount` is a string and not the branded `Atomic` because this is a wire and
 * storage shape: a bigint survives neither `JSON.stringify` nor a Redis value,
 * and silently turning one into a float on the way out would misstate money.
 */
export interface StoredSettlement {
  readonly paymentId: string;
  readonly alias: string;
  readonly address: string;
  readonly amount: string;
  readonly resource: string;
  readonly at: string;
  readonly signature: string | null;
}

/**
 * Combine a stored ledger with a freshly-seeded one, keeping every consumed seat.
 *
 * A durable store and the bundle that seeded it drift apart in both directions,
 * and each direction has one safe answer:
 *
 * - The store learned that seats were consumed; the seed has never heard of
 *   those payments. The store's `consumedBy`/`settledAt` win, always, because
 *   forgetting a paid address is how a pool hands the same one-time address to a
 *   second payer.
 * - The seed gained seats since the store was written, because the operator armed
 *   more. Those must appear, or a redeploy would silently shrink the pool to
 *   whatever existed the first time it ran.
 *
 * So structure (which seats exist, their alias and armed flag) comes from the
 * seed, and only the two monotonic consumption fields come from the store. Both
 * sides go through the same constructor checks as any other ledger, so a merge
 * that would produce an impossible pool fails loudly instead of persisting.
 */
export function mergeLedgers(stored: PoolLedger | null, seed: PoolLedger): PoolLedger {
  if (!stored) return seed;

  const storedByAddress = new Map<string, PoolEntry>();
  for (const entry of stored.allFor()) storedByAddress.set(entry.address, entry);

  const merged = PoolLedger.empty();
  // The seed's structure where it has a say, and the seed's own entries are
  // never dropped. A seat the store knows about but the seed does not is kept
  // too: an empty or unreadable seed must not be able to empty a live pool, and
  // a pool whose seats were armed by an earlier writing of the file is still
  // that pool. There is no way to add a seat without writing it down, so every
  // seat in the store was legitimate when it was written.
  const seen = new Set<string>();
  for (const entry of seed.allFor()) {
    const storedEntry = storedByAddress.get(entry.address);
    const settledAt = storedEntry?.settledAt ?? entry.settledAt;
    merged.register({
      slot: entry.slot,
      address: entry.address,
      alias: entry.alias,
      armed: entry.armed,
      consumedBy: storedEntry?.consumedBy ?? entry.consumedBy,
      ...(settledAt === undefined ? {} : { settledAt }),
    });
    seen.add(entry.address);
  }
  for (const entry of stored.allFor()) {
    if (seen.has(entry.address)) continue;
    merged.register({
      slot: entry.slot,
      address: entry.address,
      alias: entry.alias,
      armed: entry.armed,
      consumedBy: entry.consumedBy,
      ...(entry.settledAt === undefined ? {} : { settledAt: entry.settledAt }),
    });
  }
  return merged;
}
