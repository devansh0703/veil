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

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DEVNET,
  PLACEHOLDER_MINT,
  fromAtomic,
  buildPaymentRequired,
  buildRefusal402,
  checkBudget,
  formatAtomic,
  isValidAddress,
  normalizeNetwork,
  parsePaymentRequired,
  priceFor,
  refusal,
  resolveResourceUrl,
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
  mergeLedgers,
  type StoredSettlement,
  type PaymentIdentity,
} from '../../derive/src/index.ts';
import { inspectPaymentTransaction } from './inspect.ts';
import {
  BatchSessionManager,
  capDecimal,
  type BatchSession,
  type ChargeFailure,
  type SignedVoucher,
} from './batch.ts';

/**
 * How many times to try to win a seat reservation before refusing the offer.
 *
 * Each attempt is a read, a compare-and-set write and a read-back, so this is a
 * spend of store round trips under contention. Four is enough that it takes four
 * consecutive losses to reach it, and a rail losing that consistently has a
 * capacity problem (`VEIL-CONF-006` says so) rather than a race to retry away.
 */
const RESERVATION_ATTEMPTS = 4;

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
  /**
   * Fills in the fee-payer signature on a payment transaction before broadcast.
   *
   * x402 splits a payment's signature in two: the payer signs its own half and
   * the facilitator's fee payer signs the rest, which is what lets a payer hold
   * no SOL. The facilitator service does this itself, but a resource server that
   * settles *inline* has to be handed the same capability — otherwise it
   * broadcasts a transaction whose fee-payer slot is still empty and the RPC
   * rejects it as "did not pass signature verification". The callback receives
   * the base64 wire the payer produced and returns the same transaction with the
   * fee-payer signature added; it must not alter the signed bytes.
   *
   * Omitting it keeps the original behaviour: whatever the payer signed is what
   * is sent (a fully signed transaction still settles fine).
   */
  readonly feePayerCosigner?: (transaction: string) => Promise<string>;
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
  /**
   * Anywhere the ledger can live that is not the local filesystem.
   *
   * A serverless function's disk is read-only except `/tmp`, and `/tmp` belongs
   * to one instance: a seat consumed here is forgotten by the next cold start,
   * which re-seeds from the bundle. That is per-instance *memory*, not money —
   * chain balances are unaffected — but "already settled" and "which seats are
   * spent" then depend on which instance answers, and a caller can walk a pool
   * to exhaustion within one instance's lifetime.
   *
   * Supplying a store replaces that memory with one durable copy. `flush()`
   * prefers it over `ledgerPath`, so the file path stays the local behaviour and
   * a deployment opts in by configuring a store rather than by swapping code.
   */
  readonly ledgerStore?: LedgerStore;
  /**
   * The `batch-confidential` session manager.
   *
   * Omit it and Veil serves one-time seats only, exactly as before: sessions are
   * an additive scheme, negotiated by the caller choosing to open one. Supplying
   * it mounts three routes — `POST /v1/sessions`, `GET /v1/sessions/{id}`, and
   * `POST /v1/sessions/{id}/settle` — and lets any protected resource be paid
   * with a cumulative voucher (`X-VOUCHER`) instead of a payment transaction.
   */
  readonly batchSessions?: BatchSessionManager;
}

/**
 * A durable home for the pool ledger.
 *
 * Deliberately two methods and no schema: the ledger is a small document that is
 * read on every quote and rewritten when a seat is consumed, so the operations
 * a store must provide are "give me the whole thing" and "here is the new whole
 * thing". Everything about how that is achieved — Redis, SQL, object storage —
 * is the implementation's business.
 */
export interface LedgerStore {
  /** The persisted ledger, or null when nothing has been stored yet. */
  load(): Promise<PoolLedger | null>;
  /** Persist the ledger. Must survive a concurrent writer without losing seats. */
  save(ledger: PoolLedger): Promise<void>;
  /**
   * Settlement records written by any instance, if the store keeps them.
   *
   * The seat map answers "is this address spent", which is the pool's promise.
   * It does not carry the transaction that settled it, so a dashboard listing
   * settlements from the seat map alone would show a row without a signature for
   * every payment a different instance took. Optional: a store that keeps only
   * the promise still works, and the dashboard says so by showing what it has.
   */
  loadSettlements?(): Promise<readonly StoredSettlement[]>;
  /** Record a settlement. Must not lose a concurrent one. */
  appendSettlement?(settlement: StoredSettlement): Promise<void>;
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

/**
 * Load the ledger from wherever this config keeps it.
 *
 * A store wins over the file when one is configured, and a store that has
 * nothing yet falls through to the seeded file — which is how a deployment's
 * first request populates an empty database from the bundle instead of starting
 * with no seats at all.
 */
export async function loadLedgerFor(config: {
  readonly ledgerPath: string;
  readonly ledgerStore?: LedgerStore;
}): Promise<PoolLedger> {
  const seeded = await loadLedger(config.ledgerPath);
  if (!config.ledgerStore) return seeded;
  // The store is the authority on what has been spent; the bundle is the
  // authority on which seats exist. Merging rather than picking one means a
  // redeploy that armed new seats does not silently shrink the pool back to
  // whatever existed the first time the store was written.
  return mergeLedgers(await config.ledgerStore.load(), seeded);
}

// ---------------------------------------------------------------------------
// The facilitator
// ---------------------------------------------------------------------------

/**
 * What this rail did, counted.
 *
 * `confidential_assertion_failures` is the one that matters: the number of times
 * Veil refused because it could not assert that a payment was confidential. Veil's
 * entire claim is that this is the thing it will not trade away, and a claim
 * nobody can read is not a check — so the counter is published on `/api/ledger`
 * and `/v1/health` rather than left to be inferred from a log.
 *
 * It is a per-process counter, not a lifetime one: on a serverless deployment
 * each cold start begins at zero, which is why the structured settlement log is
 * the durable record and this is the live one. Both are reported, and the mode is
 * named next to them, so neither can be mistaken for the other.
 */
export interface RailMetrics {
  /** Refusals where confidentiality could not be asserted, or was disproved. */
  readonly confidential_assertion_failures: number;
  /** Settlements this process recorded. */
  readonly settlements: number;
  /** Settlements this process actually broadcast to a chain. */
  readonly broadcasts: number;
}

export interface Facilitator {
  readonly config: ServerConfig;
  readonly state: ServerState;
  /** Live counters for the preconditions this rail enforces. */
  readonly metrics: RailMetrics;
  /**
   * Price this resource for this caller, or explain why we will not serve.
   *
   * Asynchronous because an offer is a claim on a one-time address, and on a
   * hosted rail a claim only counts once the shared ledger says so. Reserving and
   * persisting before answering is what stops two instances from selling the same
   * address to two payers, so this cannot be a value returned from memory.
   */
  quote(
    resource: ResourceDefinition,
    id: PaymentIdentity,
    /** Origin the resource was requested from, so the offer can be absolute. */
    baseUrl?: string,
  ): Promise<
    | { readonly ok: true; readonly body: VeilPaymentRequired; readonly amount: Atomic }
    | { readonly ok: false; readonly status: number; readonly body: VeilPaymentRequired }
  >;
  /** Check a payer's payment before doing any work. */
  verify(
    raw: unknown,
    resource: ResourceDefinition,
  ):
    | { readonly ok: true; readonly payload: VeilPaymentPayload; readonly address: string }
    | {
        readonly ok: false;
        readonly status: number;
        readonly reason: string;
        /**
         * A refusal-catalog code, when the refusal is one the catalog names.
         *
         * Optional because most verify failures are the payer's mistake (a bad
         * mint, a foreign account) rather than a policy refusal, and dressing a
         * typo up as a policy code would make the catalog useless for deciding
         * what to do next.
         */
        readonly code?: RefusalCode;
      };
  /** Record a settlement. Refuses to invent one. */
  settle(input: {
    readonly payload: VeilPaymentPayload;
    readonly resource: ResourceDefinition;
    readonly address: string;
    readonly paymentId: string;
    /** Buyer identity, so the spend cap is counted per buyer. */
    readonly payer: string;
    readonly amount: Atomic;
  }): Promise<
    | { readonly ok: true; readonly settlement: Settlement }
    | { readonly ok: false; readonly status: number; readonly reason: string }
  >;
  flush(): Promise<void>;
  /**
   * Every settlement the rail knows of, wherever it was broadcast.
   *
   * The seat map supplies a row for every settled address, which is what makes
   * this the same on every instance; the store supplies the signature and the
   * details for the ones this process did not take; and this process's own
   * records override both, because they are the only copy that holds a signature
   * it produced itself.
   */
  settlementLog(): Promise<readonly StoredSettlement[]>;
  /**
   * Re-read the durable ledger, if one is configured.
   *
   * A store makes the ledger permanent, but a function that only reads it at
   * cold start is still reasoning from a snapshot: a seat reserved by the
   * instance that answered the quote is invisible to the instance that answers
   * the payment, and the second one would offer a spent seat to the next caller.
   * Reading through before each decision is what turns a durable ledger into a
   * shared one. It is a no-op without a store.
   */
  refresh(): Promise<void>;
}

export function createFacilitator(
  rawConfig: ServerConfig,
  initialLedger: PoolLedger,
): Facilitator {
  let ledger = initialLedger;
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
  /**
   * Counters, kept next to the state they count.
   *
   * Deliberately not written to the ledger: a counter is per-process and the
   * ledger is shared, so mixing them would make a redeploy look like a fall in
   * refusals — the one number that must never be quietly reset by a deploy.
   */
  const counts = { confidential_assertion_failures: 0, settlements: 0, broadcasts: 0 };

  /**
   * One JSON line per settlement or refusal, on stdout.
   *
   * Structured rather than prose because the preconditions this rail refuses on
   * are only auditable if the refusals can be counted: a line a human reads is a
   * log, a line a pipeline can group by is evidence, and D-4's counter is only
   * trustworthy if the events behind it are visible.
   *
   * `alias_hash`, not the alias: a merchant alias is a public identifier and the
   * public graph is exactly what the one-time-address pool exists to break —
   * republishing it per payment would undo the pool in a log file.
   */
  const logEvent = (event: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  };

  /** A stable, non-reversible label for a merchant alias. */
  const aliasHash = (alias: string): string =>
    createHash('sha256').update(alias, 'utf8').digest('hex').slice(0, 16);
  // Per buyer, not global. A cap is the buyer's own budget guard, so one buyer
  // reaching its ceiling must never refuse a different buyer — that would turn
  // an open rail into a first-come-first-served one, and it did: a single
  // counter meant the fifth dollar settled anywhere exhausted everyone's cap.
  const spentByPayer = new Map<string, Atomic>();

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
    // Every path out of this function is a refusal to *assert* confidentiality,
    // so the counter is bumped in one place instead of at five return
    // statements. A counter that can be forgotten at a branch is a counter that
    // reports zero on a rail that is refusing everything.
    const blocked = (code: RefusalCode): { code: RefusalCode } => {
      counts.confidential_assertion_failures += 1;
      logEvent({
        event: 'refusal',
        decision: 'refused',
        stage: 'gate',
        reason: code,
        alias_hash: aliasHash(alias),
        confidential_asserted: false,
      });
      return { code };
    };
    if (!config.privacy) return blocked('VEIL-CONF-003');
    const mint = config.privacy.mintConfidential();
    if (mint === false) return blocked('VEIL-CONF-001');
    if (mint === 'unknown') return blocked('VEIL-CONF-003');
    const accounts = config.privacy.accountsArmed(alias);
    if (accounts === false) return blocked('VEIL-CONF-002');
    if (accounts === 'unknown') return blocked('VEIL-CONF-003');
    return null;
  };

  /**
   * Take a seat for a payment, and do not answer until the claim is recorded.
   *
   * One process is trivially safe: `reserve` mutates the only ledger and nothing
   * else can pick the same seat. A deployment is not. Two instances can read the
   * same free seat, each reserve it for a *different* payment, and each write its
   * own state. The store's write is a merge that keeps the earliest claim, so the
   * loser's reservation is silently discarded — while the loser has already told
   * its payer to pay that address. The payer pays, the seat belongs to someone
   * else, and the settle is refused: money moved, nothing credited.
   *
   * The fix is not a cleverer write, it is refusing to answer before checking.
   * After writing, this reads back and asks the only question that matters: does
   * the shared ledger say *this* payment owns the seat I am about to offer? If it
   * says another payment does, the claim was lost, so the ledger is replaced with
   * the winner's state and the seat is picked again — a different one, because
   * the one just lost is no longer free. Retries are bounded and a claim that
   * cannot be won is refused (`VEIL-CONF-006`) rather than offered, because an
   * offer nobody can honour is worse than no offer.
   */
  const reserveSeat = async (
    alias: string,
    id: PaymentIdentity,
    poolSize: number,
  ): Promise<
    | { readonly ok: true; readonly address: string; readonly slot: number }
    | { readonly ok: false; readonly code: RefusalCode }
  > => {
    if (!config.ledgerStore) {
      try {
        const seat = ledger.reserve(alias, id, poolSize);
        return { ok: true, address: seat.address, slot: seat.slot };
      } catch {
        return { ok: false, code: 'VEIL-CONF-005' };
      }
    }

    const paymentId = derivePaymentId(id);
    for (let attempt = 0; attempt < RESERVATION_ATTEMPTS; attempt++) {
      // Start from the newest shared state so a seat another instance just took
      // is already gone before this attempt picks one.
      const latest = await config.ledgerStore.load();
      if (latest) ledger = mergeLedgers(latest, ledger);

      let seat;
      try {
        seat = ledger.reserve(alias, id, poolSize);
      } catch {
        return { ok: false, code: 'VEIL-CONF-005' };
      }

      await config.ledgerStore.save(ledger);

      const persisted = await config.ledgerStore.load();
      if (persisted) ledger = mergeLedgers(persisted, ledger);
      if (ledger.resolve(seat.address)?.consumedBy === paymentId) {
        return { ok: true, address: seat.address, slot: seat.slot };
      }
    }
    return { ok: false, code: 'VEIL-CONF-006' };
  };

  const facilitator: Facilitator = {
    config,
    // A getter, not a copy: a snapshot taken once would report whatever the
    // counters happened to be when the server started.
    get metrics(): RailMetrics {
      return { ...counts };
    },
    // A getter, not a copy: `refresh` swaps the ledger object, and every read of
    // `state.ledger` — the spent-identity check included — must see the swap.
    state: {
      get ledger(): PoolLedger {
        return ledger;
      },
      settled,
    },

    async quote(resource, id, baseUrl) {
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
            ...(baseUrl ? { baseUrl } : {}),
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
          alreadySpent: spentByPayer.get(id.payer) ?? 0n,
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
              ...(baseUrl ? { baseUrl } : {}),
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
            ...(baseUrl ? { baseUrl } : {}),
            poolIndex: 0,
          }),
        };
      }

      const seat = await reserveSeat(resource.alias, id, poolSize);
      if (!seat.ok) {
        return {
          ok: false,
          status: 503,
          body: buildRefusal402(seat.code, {
            network: config.network,
            asset: config.mint,
            payTo: '',
            decimals: config.decimals,
            resource: resource.path,
            ...(baseUrl ? { baseUrl } : {}),
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
          payTo: seat.address,
          amount,
          decimals: config.decimals,
          resource: resource.path,
          ...(baseUrl ? { baseUrl } : {}),
          description: `${resource.description} (${amountDecimal} units)`,
          poolIndex: seat.slot,
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

      // --- the payment is bound to the resource it was signed for -------------
      //
      // F7, and the answer to the arXiv replay attack's live result (one captured
      // payment reused for 248 grants). The seat ledger already stops one payment
      // being *credited* twice — that is the strongest defence in the paper's own
      // taxonomy — but it says nothing about *where* a payment is redeemed. A
      // captured payment replayed against a different endpoint would be a
      // different payment identity and therefore a different seat, so the ledger
      // would happily credit it. Binding the payment to the offer it answered is
      // what closes that, and `accepted.resource` is already the payer's own
      // signed statement of which offer that was — F7 is the check, not a new
      // field. Compared by path, because Veil publishes an absolute URL wherever
      // the request arrived with a Host header and the path is the part the payer
      // and the merchant must agree on.
      const bound = pathOf(accepted.resource);
      if (bound !== resource.path) {
        return {
          ok: false,
          status: 402,
          code: 'VEIL-CONF-007',
          reason: `this payment is bound to ${bound ?? 'a resource Veil cannot read'}, but it was presented against ${resource.path}`,
        };
      }

      // --- the transaction must actually BE a confidential transfer -----------
      //
      // The gate above proves a confidential transfer was *possible*: the mint
      // carries the extension and the destination accepts confidential credits.
      // It says nothing about the bytes the payer signed, and a payer can hold a
      // perfectly armed seat and still hand over a plain SPL transfer whose
      // amount is public. Reading the transaction is what turns "we intend to be
      // private" into "this payment is private", and it is the check the hostile
      // QA test forces: a public transfer is refused here, and the refusal is
      // counted, because it is the one event this product claims cannot happen.
      const reading = inspectPaymentTransaction(inner.transaction, {
        payTo: inner.payTo,
        mint: config.mint,
      });
      if (!reading.ok) {
        if (reading.kind === 'not-confidential') {
          counts.confidential_assertion_failures += 1;
          logEvent({
            event: 'refusal',
            decision: 'refused',
            stage: 'transaction',
            reason: 'VEIL-CONF-008',
            alias_hash: aliasHash(entry.alias),
            detail: reading.reason,
            confidential_asserted: false,
          });
          return { ok: false, status: 402, code: 'VEIL-CONF-008', reason: reading.reason };
        }
        // No reading at all. `'unknown'` is never a pass, but the consequence
        // depends on whether a chain settlement was going to happen: a rail with
        // an RPC is about to broadcast, so it refuses; a chain-free local run is
        // not claiming a chain fact about placeholder bytes, and reports itself
        // as `local-ledger-only` everywhere it is asked.
        if (config.rpcUrl !== undefined) {
          counts.confidential_assertion_failures += 1;
          logEvent({
            event: 'refusal',
            decision: 'refused',
            stage: 'transaction',
            reason: 'VEIL-CONF-008',
            alias_hash: aliasHash(entry.alias),
            detail: reading.reason,
            confidential_asserted: 'unknown',
          });
          return {
            ok: false,
            status: 402,
            code: 'VEIL-CONF-008',
            reason: `cannot assert this payment is confidential: ${reading.reason}`,
          };
        }
      }

      return {
        ok: true,
        payload: payload as VeilPaymentPayload,
        address: entry.address,
      };
    },

    async settle(input) {
      const { payload, resource, address, paymentId } = input;
      // Measured from entry, not from the broadcast: what a settlement costs a
      // merchant is the whole leg, and the broadcast is only part of it.
      const startedAt = Date.now();

      // Order matters here, and it is not arbitrary. Accounting is validated
      // *before* the broadcast, because a broadcast is irreversible: if we sent
      // first and the ledger then rejected the entry, real money would have
      // moved while the merchant's own books recorded nothing. Checking first
      // costs one pass over a small array and removes that entire failure mode.
      //
      // The claim before the check is what makes that promise hold on a hosted
      // rail. There, the instance that answered the unpaid request and the
      // instance that answers the paid one need not be the same, and the second
      // one has never heard of the reservation — so refusing here would mean
      // taking a payment into our own account and recording nothing. Claiming a
      // seat that is still free is idempotent for its current owner; a seat
      // already owned by a *different* payment still refuses, because two
      // payments into one one-time address is the relinking the pool exists to
      // prevent.
      try {
        ledger.claim(address, paymentId);
        ledger.settleable(address, paymentId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'settlement rejected';
        logEvent({
          event: 'settlement',
          payment_id: paymentId,
          alias_hash: aliasHash(resource.alias),
          slot: ledger.resolve(address)?.slot ?? null,
          signature: null,
          confidential_asserted: null,
          decision: 'refused',
          reason,
          duration_ms: Date.now() - startedAt,
        });
        return { ok: false, status: 402, reason };
      }

      // Broadcasting is only honest when it can actually happen. Reporting a
      // settlement we did not make would be the single worst bug this code could
      // have, so absent chain access is a hard stop, not a silent success.
      let signature: string | null = null;
      if (config.rpcUrl !== undefined) {
        // The payer signed only its half. Fill in the fee-payer signature the
        // RPC's preflight demands, signing the exact bytes the payer produced.
        // Without a cosigner configured this is a pass-through, so a fully
        // signed payment still broadcasts unchanged.
        const wire =
          config.feePayerCosigner !== undefined
            ? await config.feePayerCosigner(payload.payload.transaction)
            : payload.payload.transaction;
        signature = await broadcast(config.rpcUrl, wire);
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
      spentByPayer.set(input.payer, (spentByPayer.get(input.payer) ?? 0n) + input.amount);
      await facilitator.flush();
      // The seat map already recorded that this address is spent; this records
      // *what settled it*, which the seat map has no room for. It is a separate
      // write because the two have different lifetimes: the seat map must stay
      // small and is never aged out, while this is a log the dashboard reads and
      // the store trims. A store that does not keep records is not an error —
      // the credits are on chain either way, and the dashboard shows the rows the
      // seat map can supply without the signature.
      await config.ledgerStore?.appendSettlement?.({
        paymentId: settlement.paymentId,
        alias: settlement.alias,
        address: settlement.address,
        amount: settlement.amount.toString(),
        resource: settlement.resource,
        at: settlement.at,
        signature: settlement.signature,
      });
      counts.settlements += 1;
      if (signature !== null) counts.broadcasts += 1;
      logEvent({
        event: 'settlement',
        payment_id: settlement.paymentId,
        alias_hash: aliasHash(settlement.alias),
        slot: ledger.resolve(settlement.address)?.slot ?? null,
        signature: settlement.signature,
        confidential_asserted: true,
        decision: 'served',
        settlement_mode: signature !== null ? 'rpc' : 'local-ledger-only',
        duration_ms: Date.now() - startedAt,
      });
      return { ok: true, settlement };
    },

    async settlementLog() {
      // Keyed by address, because an address is what the pool promises and the
      // only thing all three sources agree on: the store's log, this process's
      // records and the seat map itself.
      const rows = new Map<string, StoredSettlement>();

      // The seat map first: it is shared, so it supplies a row for every settled
      // address even when this instance took none of them.
      for (const entry of ledger.allFor()) {
        if (entry.settledAt === undefined) continue;
        rows.set(entry.address, {
          paymentId: entry.consumedBy ?? '',
          alias: entry.alias,
          address: entry.address,
          // Not invented. The seat map records that it settled, not for how
          // much, and a wrong number on a money dashboard is worse than a blank.
          amount: '',
          resource: '',
          at: entry.settledAt,
          signature: null,
        });
      }

      // The store's log fills in the details a different instance broadcast.
      for (const record of (await config.ledgerStore?.loadSettlements?.()) ?? []) {
        rows.set(record.address, record);
      }

      // This process's own records win last: they are the only copy carrying a
      // signature this instance produced, and the only one it can vouch for.
      for (const record of settled) {
        rows.set(record.address, {
          paymentId: record.paymentId,
          alias: record.alias,
          address: record.address,
          amount: record.amount.toString(),
          resource: record.resource,
          at: record.at,
          signature: record.signature,
        });
      }

      return [...rows.values()].sort((a, b) => a.at.localeCompare(b.at));
    },

    async refresh() {
      // No store means one process owns the ledger outright, so there is nothing
      // to read through and reloading the file would only discard live state.
      if (!config.ledgerStore) return;
      // Merge the store's *consumption* onto the ledger this process is
      // holding, rather than rebuilding from the file. The pool's seats come
      // from whoever constructed it — the seeded bundle in a deployment, the
      // caller's own ledger in a test or an embedder — and re-reading a file
      // that may not exist would empty a pool that was handed over in memory.
      // Consumption is the only thing that changes behind our back, and it is
      // the only thing taken from the store.
      const stored = await config.ledgerStore.load();
      if (stored) ledger = mergeLedgers(stored, ledger);
    },

    async flush() {
      // A configured store is the authority when there is one: writing the file
      // as well would create two copies that can disagree, and on a hosted
      // runtime the file copy is the one that gets thrown away.
      if (config.ledgerStore) {
        await config.ledgerStore.save(ledger);
        return;
      }
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

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
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
    // F8 — paid content is never cacheable. This lives in the one function every
    // response is written through, so a new route cannot forget it; the arXiv
    // paper leaked paid content through misconfigured caches on 100% of the
    // nginx configurations it tested, and the published mitigation is exactly
    // this header. The regression test asserts it on a granted paid GET.
    'cache-control': 'no-store',
    // F8 — and a response that varies with the caller's identity must say so, or
    // a shared cache that ignores `no-store` could still hand one payer's answer
    // to the next one keyed only by URL.
    vary: 'x-payer, x-payment, payment-signature, x-voucher',
    // Payers are browsers and agents on other origins — a hosted rail must
    // answer them. No credentials are accepted here, so `*` is safe.
    'access-control-allow-origin': '*',
    // The payment headers are the response half of the protocol. Without this
    // list a browser payer can read the body but not the challenge or the
    // settlement receipt, which is the difference between an x402 client that
    // works in a page and one that only works in a script.
    'access-control-expose-headers':
      'payment-required, payment-response, x-idempotency-key, x-payment-signature',
    ...headers,
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
 * The origin a request actually arrived on.
 *
 * x402 v2's `resource.url` is a URL, so the offer has to name the origin the
 * payer can fetch back. Only the request knows it: the local server sees a
 * `Host` header, and a proxy (Vercel) adds `x-forwarded-proto` in front of it.
 * Returns `undefined` when there is no host, which leaves the offer relative
 * rather than inventing an origin.
 */
/**
 * The path part of whatever `accepted.resource` carries.
 *
 * x402 v2's `resource` is a URL and v1's is a path, and Veil emits both forms —
 * absolute whenever the request arrived with a `Host` header. Comparing the path
 * rather than the whole string is what makes a payment signed against
 * `https://rail.example/t/data` verifiable at a server reached on a different
 * port or behind a proxy, which is the normal case for every deployment.
 */
function pathOf(resource: unknown): string | null {
  if (typeof resource !== 'string' || resource.length === 0) return null;
  if (resource.startsWith('/')) return resource;
  try {
    return new URL(resource).pathname;
  } catch {
    return null;
  }
}

/**
 * Decode the raw ed25519 public key a session is opened with.
 *
 * Base64 or hex, because the two are indistinguishable in a config file and a
 * key the server refuses to parse is a session nobody can open. Length is the
 * only thing checked: a 32-byte key is what ed25519 verification needs, and
 * anything else would fail later with a message about signatures rather than
 * about the key that produced them.
 */
function decodePublicKey(value: string): Uint8Array | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 ? bytes : null;
}

/**
 * Read the claims a voucher states, or `null` when it is not shaped like one.
 *
 * Shape first, signature second, and never a throw: a malformed voucher is a
 * refusal with a reason, not an exception on the charge path.
 */
function readVoucherClaims(
  signed: SignedVoucher,
): { readonly sessionId: string; readonly seq: number; readonly total: bigint } | null {
  const voucher = signed?.voucher;
  if (
    typeof voucher?.sessionId !== 'string' ||
    voucher.sessionId.length === 0 ||
    !Number.isSafeInteger(voucher.seq) ||
    voucher.seq < 1 ||
    typeof voucher.total !== 'string' ||
    !/^\d+$/.test(voucher.total)
  ) {
    return null;
  }
  return { sessionId: voucher.sessionId, seq: voucher.seq, total: BigInt(voucher.total) };
}

/**
 * Why a voucher was refused, in terms the payer can act on.
 *
 * The `code` in the body is the machine-readable half; this is the half a human
 * (or an agent's planner) reads to decide what to do differently, which is a
 * different sentence for each refusal.
 */
function voucherRefusalDetail(
  code: ChargeFailure,
  claims: { readonly seq: number; readonly total: bigint },
  price: Atomic,
  decimals: number,
): string {
  const unit = (value: Atomic): string => formatAtomic(value, decimals, '');
  switch (code) {
    case 'underpaid':
      return `this call costs ${unit(price)}; a cumulative total of ${unit(
        claims.total,
      )} does not cover the session's served value plus this call. Sign a higher cumulative total.`;
    case 'stale-seq':
      return `sequence ${claims.seq} has already been charged in this session; a cumulative chain only moves forward, so sign sequence ${
        claims.seq + 1
      } with the new total.`;
    case 'gap-seq':
      return `sequence ${claims.seq} is not the next one owed; a gap would let one signature silently cover charges nobody vouched for.`;
    case 'over-cap':
      return 'the voucher total exceeds the cap this session was opened with. Open a new session with a larger cap to spend more.';
    case 'bad-signature':
      return 'the voucher signature does not verify against the public key this session was opened with.';
    case 'session-expired':
      return 'this session passed its expiry; open a new one.';
    case 'session-closed':
      return 'this session has already redeemed as one settlement, so a later voucher is a double-spend attempt rather than a late arrival.';
    case 'unknown-session':
      return 'no session with this id is open on the instance answering. Retry against the instance that opened it, or open a new session.';
  }
}

/** How a session is published, so a client never has to guess the contract. */
function sessionView(
  session: BatchSession,
  config: ServerConfig,
  baseUrl?: string,
): Record<string, unknown> {
  return {
    scheme: 'batch-confidential',
    sessionId: session.id,
    alias: session.alias,
    payer: session.payer,
    state: session.state,
    cap: capDecimal(session, config.decimals),
    headSeq: session.headSeq,
    served: session.charged.toString(),
    servedDecimal: fromAtomic(session.charged, config.decimals),
    openedAt: session.openedAt,
    expiresAt: session.expiresAt,
    voucher: {
      // The exact bytes a payer signs, published so a client does not have to
      // guess the domain separation or the field order and then discover the
      // mismatch as a signature failure.
      format:
        'veil-batch-voucher-v1 : u32be-len(sessionId) sessionId : u32be-len(seq) seq : u32be-len(total) total',
      signedWith: 'ed25519 over the bytes above; signature is base64',
      cumulative: true,
      transport: {
        header: 'X-VOUCHER',
        encoding: 'base64 of JSON { voucher: { sessionId, seq, total }, signature }',
      },
      binding: 'docs/notes/svm-batch-binding.md',
    },
    settle: resolveResourceUrl(`/v1/sessions/${session.id}/settle`, baseUrl),
    ...(session.receipt ? { receipt: session.receipt } : {}),
  };
}

function requestBaseUrl(req: IncomingMessage): string | undefined {
  const host = req.headers['host'];
  if (typeof host !== 'string' || host.length === 0) return undefined;
  const forwarded = req.headers['x-forwarded-proto'];
  const protoHeader = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const proto = protoHeader?.split(',')[0]?.trim().toLowerCase();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
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
      // The origin this request landed on, so offers name a fetchable URL.
      const baseUrl = requestBaseUrl(req);

      // Cross-origin preflight: a payer in a browser never sends credentials
      // to Veil, so the only thing CORS must unlock is reading the 402 body.
      // `x-payer` is listed because it is half the payment identity — without
      // it a browser cannot set the header, so every browser payer collapses
      // onto the `anonymous` identity and shares one payment id.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers':
            'content-type, x-payer, x-payment, payment-signature, x-voucher',
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
            // The URL a client should call, so discovery is actionable without
            // guessing the host it is talking to.
            url: resolveResourceUrl(r.path, baseUrl),
            base: r.base,
            ...(r.perUnit ? { perUnit: r.perUnit, units: r.units ?? 0 } : {}),
          })),
          privacySource: config.privacySource ?? 'none',
          /**
           * Who a caller must believe for the privacy claim to hold.
           *
           * Published because it is the honest half of the pitch: Veil's privacy
           * is chain-verified — Token-2022 Confidential Balances means the
           * transfer's zk proofs are checked by the zk-elgamal-proof program on
           * chain and the amount is an ElGamal ciphertext under the recipient's
           * key — so there is no operator set, no threshold, and no gateway in
           * the trust path. A competing design that secret-shares balances across
           * an MPC cluster, or decrypts inside an FHE coprocessor, is private for
           * as long as that cluster behaves; this one is private for as long as
           * the chain's own verifier holds, and anyone can re-derive the claim
           * with `npm run replay` rather than take this server's word for it.
           */
          trust: {
            model: 'chain-verified',
            verifiedBy: 'the Token-2022 zk-elgamal-proof program, on chain',
            keyHeldBy: 'the recipient only',
            intermediates: [],
            verifier: {
              command: 'npm run replay <paymentId|signature>',
              reads: 'chain state, with no Veil service in the loop',
            },
          },
          paymentHeaders: {
            v1: { request: 'X-PAYMENT' },
            v2: {
              request: 'PAYMENT-SIGNATURE',
              challenge: 'PAYMENT-REQUIRED',
              response: 'PAYMENT-RESPONSE',
            },
            idempotency: 'X-IDEMPOTENCY-KEY',
          },
          ...(config.batchSessions !== undefined
            ? {
                batch: {
                  scheme: 'batch-confidential',
                  sessions: resolveResourceUrl('/v1/sessions', baseUrl),
                  binding: 'docs/notes/svm-batch-binding.md',
                },
              }
            : {}),
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
              'VEIL-CONF-006',
              'VEIL-CONF-007',
              'VEIL-CONF-008',
            ] as const
          ).map((code: RefusalCode) => {
            const r = refusal(code);
            return { code: r.code, title: r.title, recoverable: r.recoverable };
          }),
        });
      }

      if (path === '/v1/health') {
        // Read through first, exactly as /api/ledger does. Counting from the
        // shared seat map is only instance-independent if this instance has
        // actually read the shared copy — a seat stamped by another instance's
        // settle is invisible until one refresh happens here.
        await facilitator.refresh();
        return json(res, 200, {
          ok: true,
          network: config.network,
          mint: config.mint,
          poolSize: facilitator.state.ledger.size,
          // Counted from the ledger, not from this process's own list. A seat
          // that settled is settled for every instance, and with a durable
          // ledger they all read the same seats — so this is the one number that
          // does not depend on which instance answered. The per-instance list is
          // still what /api/ledger shows rows from, because only the instance
          // that broadcast a payment holds its signature.
          settled: facilitator.state.ledger
            .allFor()
            .filter((entry) => entry.settledAt !== undefined).length,
          // Where seat consumption is remembered. "local-file" on a hosted runtime
          // means a per-instance copy that a cold start forgets; a configured
          // store is one shared record, and a caller should be able to tell which
          // one it is talking to without reading the config.
          ledger: config.ledgerStore !== undefined ? 'durable-store' : 'local-file',
          settlement: config.rpcUrl
            ? 'rpc'
            : config.allowLocalSettlement === true
              ? 'local-ledger-only'
              : 'unavailable',
          // D-4's counter, live. `/api/ledger` carries it too, so the dashboard
          // and the CLI read the same number from the same place.
          metrics: facilitator.metrics,
          batchSessions:
            config.batchSessions !== undefined
              ? { open: config.batchSessions.list().length }
              : null,
        });
      }

      // --- dashboard data --------------------------------------------------
      if (path === '/api/ledger') {
        // Read through first, so the seat map this returns is the shared one and
        // not this instance's snapshot of it.
        await facilitator.refresh();
        return json(res, 200, {
          network: config.network,
          mint: config.mint,
          decimals: config.decimals,
          // A refusal count that only exists in a log file is a claim; one next
          // to the settlement rows is a check a reader can perform. Per-process,
          // and labelled as such by `scope`.
          metrics: {
            scope: 'process',
            counter: 'confidential_assertion_failures',
            ...facilitator.metrics,
          },
          pool: facilitator.state.ledger.toJSON(),
          // One row per settled seat, not one per settlement this instance
          // happened to broadcast, and with the signature and amount the shared
          // log recorded rather than a blank where another instance took the
          // payment. Nothing here is per-instance except the last write.
          settled: await facilitator.settlementLog(),
        });
      }

      // --- batch sessions (the `batch-confidential` scheme) -----------------
      //
      // Mounted ahead of the resource table because a session id is not a priced
      // resource: there is no offer to look up, and a 404 from the resource map
      // would be the wrong answer for a live session. Every rule enforced here
      // lives in `BatchSessionManager`; this is the transport.
      if (config.batchSessions !== undefined && path.startsWith('/v1/sessions')) {
        const sessions = config.batchSessions;
        if (req.method === 'POST' && path === '/v1/sessions') {
          const body = (await readBody(req)) as Record<string, unknown> | undefined;
          const rawKey = body?.payerPubkey;
          const pubkey = typeof rawKey === 'string' ? decodePublicKey(rawKey) : null;
          if (pubkey === null) {
            return json(res, 400, {
              error: 'invalid-payer-pubkey',
              detail:
                'payerPubkey must be base64 or 64-char hex of a raw 32-byte ed25519 public key — the key every voucher in this session is verified against',
            });
          }
          try {
            const opened = sessions.open({
              // The session's payer defaults to the caller's own identity. Read
              // here rather than from the resource branch below, because a
              // session is opened before any resource is named and the header is
              // the only thing that says who is asking.
              payer:
                typeof body?.payer === 'string'
                  ? body.payer
                  : typeof req.headers['x-payer'] === 'string'
                    ? (req.headers['x-payer'] as string)
                    : 'anonymous',
              alias: typeof body?.alias === 'string' ? body.alias : config.resources[0]!.alias,
              payerPubkey: pubkey,
              cap: typeof body?.cap === 'string' ? body.cap : '0.50',
              decimals: config.decimals,
            });
            return json(res, 201, sessionView(opened, config, baseUrl));
          } catch (error) {
            return json(res, 400, {
              error: 'session-not-opened',
              detail: error instanceof Error ? error.message : 'unknown',
            });
          }
        }

        const sessionId = path.slice('/v1/sessions/'.length).split('/')[0] ?? '';
        const session = sessions.get(sessionId);
        if (!session) {
          return json(res, 404, { error: 'unknown-session', sessionId });
        }

        if (req.method === 'GET' && path === `/v1/sessions/${sessionId}`) {
          return json(res, 200, sessionView(session, config, baseUrl));
        }

        if (req.method === 'POST' && path === `/v1/sessions/${sessionId}/settle`) {
          if (session.state === 'settled') {
            return json(res, 409, {
              error: 'session-already-settled',
              detail:
                'this session already redeemed: the value moved exactly once, and the receipt below is that record',
              receipt: session.receipt,
            });
          }
          const head = session.headVoucher;
          if (head === null || session.charged === 0n) {
            return json(res, 402, {
              error: 'nothing-to-settle',
              detail:
                'no voucher has been charged to this session, so there is no value to redeem',
            });
          }

          // The redemption is ONE ordinary `exact-confidential` payment for the
          // session total, into a fresh one-time seat, through the same
          // verify/settle path as any other payment. That is the whole point of
          // composing the two schemes rather than inventing a third: the
          // redemption inherits the confidentiality gate, the seat pool, the
          // resource binding and the transaction reading without a line of new
          // settlement code.
          const total = BigInt(head.voucher.total);
          const settleResource: ResourceDefinition = {
            path: `/v1/sessions/${sessionId}/settle`,
            alias: session.alias,
            description: `Redeem session ${sessionId} — one confidential transfer for the whole session`,
            base: fromAtomic(total, config.decimals),
            produce: () => ({ redeemed: sessionId }),
          };
          const settleIdentity: PaymentIdentity = {
            resource: settleResource.path,
            payer: session.payer,
            nonce: 0,
          };
          const settleHeader = req.headers['payment-signature'] ?? req.headers['x-payment'];
          if (typeof settleHeader !== 'string') {
            const quote = await facilitator.quote(settleResource, settleIdentity, baseUrl);
            const challenge = {
              'payment-required': Buffer.from(JSON.stringify(quote.body)).toString('base64'),
            };
            return json(res, quote.ok ? 402 : quote.status, quote.body, challenge);
          }
          let settleDecoded: unknown;
          try {
            settleDecoded = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'));
          } catch {
            return json(res, 402, {
              error: 'malformed-payment-header',
              detail: 'the redemption payment must be base64-encoded JSON',
            });
          }
          const settleVerified = facilitator.verify(settleDecoded, settleResource);
          if (!settleVerified.ok) {
            return json(res, settleVerified.status, {
              error: 'invalid-payment',
              detail: settleVerified.reason,
              ...(settleVerified.code !== undefined
                ? { refusal: refusal(settleVerified.code) }
                : {}),
            });
          }
          const settleOutcome = await facilitator.settle({
            payload: settleVerified.payload,
            resource: settleResource,
            address: settleVerified.address,
            paymentId: derivePaymentId(settleIdentity),
            payer: session.payer,
            amount: total,
          });
          if (!settleOutcome.ok) {
            return json(res, settleOutcome.status, {
              error: 'settlement-failed',
              detail: settleOutcome.reason,
            });
          }
          const receipt = sessions.settle(sessionId, {
            voucherHead: head,
            seat: settleVerified.address,
            signature: settleOutcome.settlement.signature,
            settlementMode:
              settleOutcome.settlement.signature !== null ? 'rpc' : 'local-ledger-only',
          });
          return json(
            res,
            200,
            {
              redeemed: true,
              receipt,
              ...(receipt === null
                ? {
                    detail:
                      'the settlement landed and the session closed concurrently, so this response could not record the receipt — the settlement rows on /api/ledger are the record',
                  }
                : {}),
            },
            {
              'x-idempotency-key': `${sessionId}:settle`,
              ...(settleOutcome.settlement.signature !== null
                ? { 'x-payment-signature': settleOutcome.settlement.signature }
                : {}),
              'payment-response': Buffer.from(
                JSON.stringify({
                  success: true,
                  transaction: settleOutcome.settlement.signature,
                  network: config.network,
                  payer: session.payer,
                }),
              ).toString('base64'),
            },
          );
        }

        return json(res, 405, {
          error: 'method-not-allowed',
          detail: 'the session surface is POST /v1/sessions, GET /v1/sessions/{id}, POST /v1/sessions/{id}/settle',
          path,
        });
      }

      // --- protected resources --------------------------------------------
      const resource = byPath.get(path);
      if (!resource) {
        return json(res, 404, { error: 'not-found', path });
      }

      const payerHeader = req.headers['x-payer'];
      const payer = typeof payerHeader === 'string' ? payerHeader : 'anonymous';
      const rawNonce = url.searchParams.get('nonce');
      const nonce = rawNonce === null ? 0 : Number(rawNonce);
      // The nonce is half the payment identity: two different payments to the
      // same resource from the same payer differ only by nonce. `Number('nonsense')`
      // is NaN, and String(NaN) would collapse every garbage nonce onto one
      // identity — two unrelated callers then sharing a payment id, and one of
      // them's settle refused as a duplicate of the other's. Refuse instead.
      if (!Number.isSafeInteger(nonce) || nonce < 0) {
        return json(res, 400, {
          error: 'invalid-nonce',
          detail:
            'nonce must be a non-negative safe integer; it identifies the payment and garbage would collide two payments onto one id',
          ...(rawNonce === null ? {} : { got: String(rawNonce).slice(0, 64) }),
        });
      }
      const id: PaymentIdentity = { resource: path, payer, nonce };

      // F3 — x402 v2 spells the payment `PAYMENT-SIGNATURE` where v1 spelled it
      // `X-PAYMENT`. Both are read: a payer's client does not get to choose which
      // one a merchant understands, and refusing a v2 client over a header name
      // would make Veil unusable beside every other 2026 x402 server. The v1
      // spelling still works, byte for byte, because the hosted demo uses it.
      const paymentHeader = req.headers['payment-signature'] ?? req.headers['x-payment'];

      // Read through the durable ledger before deciding anything. Quote and
      // payment can land on different instances, and the one answering now must
      // see the seats the other one spent — otherwise it offers a spent address
      // to the next caller, which is the relinking the pool exists to prevent.
      // A no-op when no store is configured.
      await facilitator.refresh();

      // --- batch sessions: a cumulative voucher in place of a payment --------
      //
      // F1's hot path. The voucher is verified offline — no chain lookup, no seat
      // reservation, no 402 — which is the "speed of HTTP" property the x402
      // batch-settlement post claims, kept here with amounts hidden. The resource
      // is served on the strength of a signature; value moves once, later, when
      // the session redeems.
      const voucherHeader = req.headers['x-voucher'];
      if (typeof voucherHeader === 'string') {
        const sessions = config.batchSessions;
        if (sessions === undefined) {
          return json(res, 501, {
            error: 'sessions-not-enabled',
            detail:
              'this rail was started without a session manager, so it serves one-time seats only. Configure batchSessions to accept vouchers, or pay per call with a confidential transfer.',
          });
        }
        let signed: SignedVoucher;
        try {
          signed = JSON.parse(
            Buffer.from(voucherHeader, 'base64').toString('utf8'),
          ) as SignedVoucher;
        } catch {
          return json(res, 402, {
            error: 'malformed-voucher-header',
            detail: 'X-VOUCHER must be base64-encoded JSON of { voucher, signature }',
          });
        }
        const claims = readVoucherClaims(signed);
        if (claims === null) {
          return json(res, 402, {
            error: 'malformed-voucher',
            detail:
              'a voucher must carry { voucher: { sessionId, seq, total }, signature }; anything else is refused rather than interpreted',
          });
        }
        const price = priceFor(
          {
            base: resource.base,
            ...(resource.perUnit !== undefined ? { perUnit: resource.perUnit } : {}),
            ...(resource.units !== undefined ? { units: resource.units } : {}),
          },
          config.decimals,
        );
        const charged = sessions.charge(claims.sessionId, signed, price);
        if (!charged.ok) {
          return json(res, 402, {
            error: 'voucher-rejected',
            code: charged.code,
            detail: voucherRefusalDetail(charged.code, claims, price, config.decimals),
          });
        }
        return json(
          res,
          200,
          {
            paid: true,
            session: {
              sessionId: claims.sessionId,
              headSeq: charged.headSeq,
              served: charged.charged.toString(),
              servedDecimal: fromAtomic(charged.charged, config.decimals),
              settlesWith: resolveResourceUrl(`/v1/sessions/${claims.sessionId}/settle`, baseUrl),
              deferred:
                'charged to the session: the per-call usage is a voucher signature and never reaches the chain, and the session redeems as one confidential transfer',
            },
            data: resource.produce({ paid: true }),
          },
          { 'x-idempotency-key': `${claims.sessionId}:${charged.headSeq}` },
        );
      }

      // No payment yet: quote the price. This is the normal x402 first leg.
      if (typeof paymentHeader !== 'string') {
        // A payment that already settled is spent. Handing its address back as a
        // fresh offer takes the payer's funds into an account whose settle is
        // then refused — money moved, nothing credited — so a client that
        // retries its own completed request must be told the identity is used up
        // rather than sold to it twice. A second payment needs a second nonce.
        const spent = facilitator.state.ledger.entryFor(resource.alias, id);
        if (spent !== null && spent.settledAt !== undefined) {
          return json(res, 409, {
            error: 'payment-already-settled',
            detail:
              'this payment identity already settled; paying it again would not be credited — use a new nonce for a new payment',
            settledAt: spent.settledAt,
          });
        }
        const quote = await facilitator.quote(resource, id, baseUrl);
        // F3 — the same challenge body, base64'd into the v2 header, so an x402
        // v2 client that reads headers instead of bodies sees the identical
        // terms rather than an empty challenge.
        const challenge = {
          'payment-required': Buffer.from(JSON.stringify(quote.body)).toString('base64'),
        };
        if (!quote.ok) return json(res, quote.status, quote.body, challenge);
        // No flush here. `quote` does not return an address until the shared
        // ledger says this payment owns it, so the promise not to sell the same
        // seat twice has already been recorded — and the local file is left
        // alone, where writing a seat map on every unpaid GET would dirty the
        // committed pool.
        return json(res, 402, quote.body, challenge);
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
        return json(res, verified.status, {
          error: 'invalid-payment',
          detail: verified.reason,
          // The policy refusals carry their catalog entry, so a client can tell
          // "your payment is bound to another resource" (VEIL-CONF-007) from "your
          // transaction would settle in public" (VEIL-CONF-008) without parsing
          // prose — and so the counter and the body name the same event.
          ...(verified.code !== undefined ? { refusal: refusal(verified.code) } : {}),
        });
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

      // verify() already resolved the destination, bound the payment to this
      // resource, and confirmed on the signed bytes that the transfer is a
      // confidential one. Nothing below this line can put an amount on the public
      // ledger.
      const outcome = await facilitator.settle({
        payload: verified.payload,
        resource,
        address: verified.address,
        paymentId,
        payer: id.payer,
        amount,
      });

      if (!outcome.ok) {
        return json(res, outcome.status, {
          error: 'settlement-failed',
          detail: outcome.reason,
        });
      }

      return json(
        res,
        200,
        {
          paid: true,
          settled: {
            signature: outcome.settlement.signature,
            amount: outcome.settlement.amount.toString(),
            at: outcome.settlement.at,
            paymentId,
            seat: outcome.settlement.address,
            confid: 'amount hidden on chain by Token-2022 confidential balances',
          },
          data: resource.produce({ paid: true }),
        },
        {
          // F7 — the idempotency key is derived from the payment identity, so
          // the payer and the merchant compute the same key for the same payment
          // without either telling the other. A retried HTTP request answers on
          // the same key, which is what makes "deterministic instead of a second
          // grant" checkable rather than merely intended.
          'x-idempotency-key': paymentId,
          ...(outcome.settlement.signature !== null
            ? { 'x-payment-signature': outcome.settlement.signature }
            : {}),
          // F3 — v2's settlement receipt, in a header, mirroring the body.
          'payment-response': Buffer.from(
            JSON.stringify({
              success: true,
              transaction: outcome.settlement.signature,
              network: config.network,
              payer: id.payer,
            }),
          ).toString('base64'),
        },
      );
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
  {
    // The cheapest resource, and the one this deployment uses for its own
    // end-to-end check: a real wallet pays a seat owned by a wallet we hold, so
    // "the money moved" is verifiable by decrypting the payee's own balance
    // rather than by trusting a log line. Its pool holds a single seat, which is
    // what makes a payment here deterministic — the offer cannot name another
    // merchant's account.
    path: '/v1/payee/test',
    alias: 'payee.test',
    description: 'Reference payee — the seat the end-to-end check pays',
    base: '0.001',
    produce: () => ({
      received: true,
      note: 'Paid to an account owned by the payee wallet; the amount is encrypted on chain.',
      source: 'payee.test',
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

// ---------------------------------------------------------------------------
// Minimal merchant setup
// ---------------------------------------------------------------------------

/**
 * Three things, like x402: your server, a wallet to be paid at, and a price.
 *
 * x402's seller quickstart is roughly "your API + a receive address + the
 * middleware pointed at the facilitator". Veil keeps the same sentence and
 * drops one clause: the facilitator runs in the same process (`createFacilitator`
 * over your pool), so you never configure a URL for it. What is left is a
 * wallet and a price; network, mint, decimals, the one-time account pool and
 * the confidentiality gate all default from the hosted rail's public config.
 *
 * Veil never trades its confidentiality rule for a shorter setup: if it cannot
 * verify the preconditions it refuses to serve, and the refusal is reported
 * through `/.well-known/veil` exactly as a full deployment's would be.
 */
export interface VeilOptions {
  /** The wallet where you want to receive payments. The one required field. */
  readonly payTo: string;
  /** Flat price per call in decimal units. Default `'0.05'`. */
  readonly price?: string;
  /** The path your server serves. Default `'/'`. */
  readonly path?: string;
  /** Human label for the resource, shown in the 402 offer. */
  readonly description?: string;
  /** What a paid caller receives. Default acknowledges the payment. */
  readonly produce?: (ctx: { readonly paid: boolean }) => unknown;
  /** Defaults to the hosted rail's public config when omitted. */
  readonly network?: Network;
  /** Payment mint. Defaults to the hosted rail's mint. */
  readonly asset?: string;
  readonly decimals?: number;
  /** Pool ledger path. Default `data/pool-ledger.<payTo-suffix>.json`. */
  readonly ledgerPath?: string;
  /** Buyer spend cap per session in decimal units. `null` disables it. Default `'5.00'`. */
  readonly spendCap?: string | null;
  /** Precondition probe. Defaults to the pool ledger this call just wrote. */
  readonly privacy?: PrivacyProbe;
  /** One-time accounts to provision on first run. Default `8`. */
  readonly poolSize?: number;
}

export interface VeilMerchant {
  readonly server: ReturnType<typeof createServer>;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly config: ServerConfig;
  readonly facilitator: Facilitator;
  readonly ledger: PoolLedger;
  /** Accounts created because the ledger had none for this merchant. */
  readonly provisioned: number;
}

/** The network, mint and precision the hosted rail quotes in. */
export const HOSTED_DEFAULTS = {
  // devnet is the production rail: the link every surface hands to a new user,
  // and the cluster the shipped reference payment settled on. A merchant that
  // passes nothing lands here rather than on testnet.
  network: 'solana:devnet' as Network,
  asset: 'H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p',
  decimals: 6,
} as const;

/** The facilitator clients reach when a merchant does not run one of its own. */
export const HOSTED_FACILITATOR = 'https://veil-devnet.vercel.app/facilitator';

/** A filesystem-safe suffix for a wallet address, so two merchants never share a pool. */
function poolSlug(address: string): string {
  return address.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'merchant';
}

/**
 * Start a Veil merchant from a wallet and (optionally) a price.
 *
 *     const { server } = await veil({ payTo: 'YourWallet', price: '0.05' });
 *     server.listen(4021);
 *
 * On first run it provisions `poolSize` one-time accounts for the merchant and
 * records the pool on disk; later runs reload it. The confidentiality gate is
 * answered from that same ledger (reported as `pool-ledger`, never `chain`, so
 * the declared-vs-read distinction stays visible).
 */
export async function veil(options: VeilOptions): Promise<VeilMerchant> {
  if (typeof options.payTo !== 'string' || options.payTo.length === 0) {
    throw new TypeError('veil(): payTo is required — the wallet you want to be paid at.');
  }
  const network = options.network ?? HOSTED_DEFAULTS.network;
  const asset = options.asset ?? HOSTED_DEFAULTS.asset;
  const decimals = options.decimals ?? HOSTED_DEFAULTS.decimals;
  const path = options.path ?? '/';
  const alias = options.payTo;
  const ledgerPath = options.ledgerPath ?? `data/pool-ledger.${poolSlug(alias)}.json`;

  const ledger = await loadLedger(ledgerPath);
  let provisioned = 0;
  if (ledger.armedFor(alias).length === 0) {
    // Imported here rather than at module top level: the hosted function never
    // provisions a pool (it loads a seeded one), and an eager import would put
    // `@solana/kit` on that bundle's load graph for no reason. Only the merchant
    // path — a real Node process with the package installed — reaches this line.
    const { generateKeyPairSigner } = await import('@solana/kit');
    const poolSize = options.poolSize ?? 8;
    for (let slot = 0; slot < poolSize; slot++) {
      const signer = await generateKeyPairSigner();
      ledger.register({ slot, address: signer.address, alias, armed: true });
    }
    provisioned = poolSize;
    await saveLedger(ledgerPath, ledger);
  }

  // Declared, not chain-read: the hosted mint is a confidential mint by
  // construction, and anything else is honestly reported as `unknown` so the
  // gate refuses rather than pretending.
  const declared = asset === HOSTED_DEFAULTS.asset ? true : 'unknown';
  const privacy = options.privacy ?? poolLedgerProbe(ledger, declared);

  const resource: ResourceDefinition = {
    path,
    alias,
    description: options.description ?? `Paid resource at ${path}`,
    base: options.price ?? '0.05',
    produce: options.produce ?? (() => ({ paid: true, resource: path })),
  };

  const config: ServerConfig = {
    network,
    mint: asset,
    decimals,
    ledgerPath,
    resources: [resource],
    ...(options.spendCap === null ? {} : { spendCap: options.spendCap ?? '5.00' }),
    privacy,
    privacySource: options.privacy ? 'chain' : 'pool-ledger',
  };

  const facilitator = createFacilitator(config, ledger);
  const handler = createVeilHandler(config, facilitator);
  return { server: createServer(handler), handler, config, facilitator, ledger, provisioned };
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

/**
 * The second scheme, published from the same entry point as the first.
 *
 * `batch-confidential` is additive: a merchant that never opens a session never
 * touches this code, and a client that only speaks `exact-confidential` is
 * unaffected — which is how an x402 extension is supposed to land.
 */
export {
  BatchSessionManager,
  canonicalVoucher,
  verifyVoucher,
  voucherSignerFromSeed,
  type BatchSession,
  type ChargeFailure,
  type SessionReceipt,
  type SignedVoucher,
  type Voucher,
} from './batch.ts';

/**
 * The transaction reading, exported so a verifier can run the rail's own check.
 *
 * `scripts/replay.ts` uses this against chain state: the replay tool deliberately
 * reads a settled transaction with the *same* reader the rail uses, and prints the
 * raw primitives (program ids, discriminators, byte lengths, balance deltas)
 * beside the verdict — so the report can be checked by hand rather than trusted
 * because it came from the same code.
 */
export { inspectConfidentialTransfer, inspectPaymentTransaction } from './inspect.ts';
