// packages/server/src/index.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// packages/x402-core/src/index.ts
var X402_VERSION = 2;
var VEIL_SCHEME = "exact-confidential";
var TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
var PRIVACY_MODEL = "confidential-balances";
var SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
var SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
var SOLANA_TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
var NETWORK_ALIASES = {
  devnet: SOLANA_DEVNET,
  testnet: SOLANA_TESTNET,
  "mainnet-beta": SOLANA_MAINNET,
  mainnet: SOLANA_MAINNET,
  "solana:devnet": SOLANA_DEVNET,
  "solana:testnet": SOLANA_TESTNET,
  "solana:mainnet": SOLANA_MAINNET,
  "solana-devnet": SOLANA_DEVNET,
  "solana-testnet": SOLANA_TESTNET
};
var CANONICAL_NETWORKS = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET];
function normalizeNetwork(network) {
  if (CANONICAL_NETWORKS.includes(network)) {
    return network;
  }
  const alias = NETWORK_ALIASES[network];
  if (alias) return alias;
  throw new RangeError(
    `unsupported network ${JSON.stringify(network)}; use one of ${CANONICAL_NETWORKS.join(
      ", "
    )}, or a friendly name such as testnet`
  );
}
var DEVNET = SOLANA_DEVNET;
var PLACEHOLDER_MINT = "6pFkZndusKGifrKLXgaQJFjUT3Gi9n1uXcwkG7Jef3ur";
var BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const bytes = [0];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
function isValidAddress(value) {
  const bytes = decodeBase58(value);
  return bytes !== null && bytes.length === 32;
}
var REFUSALS = {
  "VEIL-CONF-001": {
    title: "Mint is not confidential",
    detail: "The configured mint does not have the Token-2022 confidential-transfer extension initialised, so no transfer in it can be confidential.",
    remedy: "Initialise the confidential-transfer extension on the mint (getInitializeConfidentialTransferMintInstruction), or point Veil at a mint that already carries it.",
    recoverable: false
  },
  "VEIL-CONF-002": {
    title: "Destination cannot receive confidential credits",
    detail: "The destination account is configured to reject confidential credits (allow_confidential_credits is false), which would force this transfer to be public.",
    remedy: "Re-configure the destination account with enableConfidentialCredits before offering it as a payment account.",
    recoverable: false
  },
  "VEIL-CONF-003": {
    title: "Confidentiality cannot be guaranteed \u2014 refusing to serve",
    detail: "The payment could only be settled with a public transfer. Serving it would give the caller a false privacy guarantee.",
    remedy: "Fix the configuration fault (see the accompanying VEIL-CONF-00x reason) and retry. Veil never downgrades a payment to public.",
    recoverable: false
  },
  "VEIL-CONF-004": {
    title: "Buyer spend cap exceeded",
    detail: "Settling this payment would take the buyer past the cap it declared for this session.",
    remedy: "Raise the buyer spend cap for the session, or settle a smaller amount.",
    recoverable: true
  },
  "VEIL-CONF-005": {
    title: "One-time address pool exhausted",
    detail: "Every pre-configured payment account for this merchant alias has already been consumed. Reusing one would relink two payments on the public account graph.",
    remedy: "Grow the pool (scripts/setup-devnet.ts --pool-size N) or wait for consumed accounts to be re-armed.",
    recoverable: true
  }
};
function refusal(code) {
  return { code, ...REFUSALS[code] };
}
function refusalFor402(code) {
  const r = refusal(code);
  return { code: r.code, message: r.title, remedy: r.remedy };
}
function toAtomic(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be an integer in 0..18, got ${decimals}`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(amount)) {
    throw new TypeError(`not a decimal number: ${JSON.stringify(amount)}`);
  }
  const negative = amount.startsWith("-");
  const [whole, frac = ""] = (negative ? amount.slice(1) : amount).split(".");
  if (frac.length > decimals) {
    throw new RangeError(
      `${amount} has more precision than ${decimals} decimals can represent exactly`
    );
  }
  const padded = frac.padEnd(decimals, "0");
  const value = BigInt(`${whole}${padded}`);
  return negative ? -value : value;
}
function formatAtomic(amount, decimals, symbol = "$") {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const digits = abs.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? "" : digits.slice(digits.length - decimals);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = frac ? `${grouped}.${frac}` : grouped;
  return `${negative ? "-" : ""}${symbol}${body}`;
}
function priceFor(input, decimals) {
  let total = 0n;
  if (input.base !== void 0) total += toAtomic(input.base, decimals);
  if (input.perUnit !== void 0) {
    const units = input.units ?? 0;
    if (!Number.isInteger(units) || units < 0) {
      throw new RangeError(`units must be a non-negative integer, got ${units}`);
    }
    const unitSteps = toAtomic(input.perUnit, decimals) * BigInt(units);
    total += unitSteps;
  }
  return total;
}
function checkBudget(amount, state) {
  if (amount < 0n) throw new RangeError("amount must not be negative");
  const projected = state.alreadySpent + amount;
  if (projected > state.spendCap) {
    return { ok: false, refusal: refusal("VEIL-CONF-004") };
  }
  return { ok: true, remainingAfter: state.spendCap - projected };
}
function buildPaymentRequired(input) {
  const network = normalizeNetwork(input.network);
  if (input.amount <= 0n) {
    throw new RangeError("maxAmountRequired must be positive");
  }
  if (input.decimals < 0 || input.decimals > 18) {
    throw new RangeError("decimals out of range");
  }
  const amount = input.amount.toString();
  return {
    x402Version: X402_VERSION,
    ...input.error ? { error: input.error } : {},
    resource: {
      url: input.resource,
      ...input.description ? { description: input.description } : {},
      mimeType: input.mimeType ?? "application/json"
    },
    accepts: [
      {
        scheme: VEIL_SCHEME,
        network,
        asset: input.asset,
        payTo: input.payTo,
        maxAmountRequired: amount,
        amount,
        resource: input.resource,
        ...input.description ? { description: input.description } : {},
        ...input.mimeType ? { mimeType: input.mimeType } : {},
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60,
        extra: {
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          decimals: input.decimals,
          privacy: PRIVACY_MODEL,
          poolIndex: input.poolIndex,
          auditor: input.auditor ?? null,
          hides: ["on-chain-amount", "on-chain-balance"]
        }
      }
    ]
  };
}
function buildRefusal402(code, input) {
  const amount = input.amount ?? 0n;
  const r = refusalFor402(code);
  const quote = amount > 0n ? buildPaymentRequired({ ...input, amount }) : null;
  return {
    x402Version: X402_VERSION,
    error: r.message,
    ...quote ? { resource: quote.resource } : {},
    accepts: quote ? quote.accepts : [],
    veil: { refused: code, message: r.message, remedy: r.remedy }
  };
}

// packages/derive/src/index.ts
import { createHash } from "node:crypto";
function derivePaymentId(id) {
  const h = createHash("sha256");
  const parts = [id.resource, id.payer, String(id.nonce)];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    h.update(len);
    h.update(bytes);
  }
  return h.digest("hex");
}
function deriveSlot(id, poolSize) {
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new RangeError(`poolSize must be a positive integer, got ${poolSize}`);
  }
  if ((poolSize & poolSize - 1) !== 0) {
    throw new RangeError(
      `poolSize must be a power of two so slot assignment is unbiased, got ${poolSize}`
    );
  }
  const digest = Buffer.from(derivePaymentId(id), "hex");
  return digest.readUInt32BE(0) % poolSize;
}
var PoolExhaustedError = class extends Error {
  code = "VEIL-CONF-005";
  constructor(alias, size) {
    super(
      `no armed one-time account left for alias ${alias} (pool size ${size})`
    );
    this.name = "PoolExhaustedError";
  }
};
var SlotConflictError = class extends Error {
  constructor(slot, alias) {
    super(`slot ${slot} is already occupied by alias ${alias}`);
    this.name = "SlotConflictError";
  }
};
var PoolLedger = class _PoolLedger {
  #entries = [];
  constructor(entries) {
    this.#entries = entries;
  }
  static empty() {
    return new _PoolLedger([]);
  }
  static fromJSON(json2) {
    if (!Array.isArray(json2)) {
      throw new TypeError("pool ledger must be a JSON array");
    }
    const entries = json2.map((raw, i) => {
      if (typeof raw !== "object" || raw === null) {
        throw new TypeError(`entry ${i} must be an object`);
      }
      const e = raw;
      if (typeof e.slot !== "number" || !Number.isInteger(e.slot) || e.slot < 0) {
        throw new TypeError(`entry ${i}.slot must be a non-negative integer`);
      }
      if (typeof e.address !== "string" || e.address.length === 0) {
        throw new TypeError(`entry ${i}.address must be a non-empty string`);
      }
      if (typeof e.alias !== "string" || e.alias.length === 0) {
        throw new TypeError(`entry ${i}.alias must be a non-empty string`);
      }
      if (typeof e.armed !== "boolean") {
        throw new TypeError(`entry ${i}.armed must be a boolean`);
      }
      const consumedBy = e.consumedBy ?? null;
      if (consumedBy !== null && typeof consumedBy !== "string") {
        throw new TypeError(`entry ${i}.consumedBy must be a string or null`);
      }
      return {
        slot: e.slot,
        address: e.address,
        alias: e.alias,
        armed: e.armed,
        consumedBy,
        ...typeof e.settledAt === "string" ? { settledAt: e.settledAt } : {}
      };
    });
    const ledger = new _PoolLedger(entries);
    ledger.assertInvariants();
    return ledger;
  }
  toJSON() {
    return this.#entries.map((e) => ({ ...e }));
  }
  get size() {
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
  register(entry) {
    if (this.#entries.some(
      (e) => e.slot === entry.slot && e.alias === entry.alias
    )) {
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
  reserve(alias, id, poolSize = this.#capacityFor(alias)) {
    const preferred = deriveSlot(id, poolSize);
    const paymentId = derivePaymentId(id);
    const free = this.#entries.filter(
      (e) => e.alias === alias && e.armed && !e.consumedBy
    );
    if (free.length === 0) throw new PoolExhaustedError(alias, poolSize);
    const chosen = free.find((e) => e.slot === preferred) ?? free[0];
    if (!chosen) throw new PoolExhaustedError(alias, poolSize);
    chosen.consumedBy = paymentId;
    return { ...chosen };
  }
  /** Resolve an incoming payment's destination address back to its alias. */
  resolve(address) {
    const entry = this.#entries.find((e) => e.address === address);
    return entry ? { ...entry } : void 0;
  }
  /** An alias's alias — i.e. which merchant owns this destination. */
  aliasFor(address) {
    return this.#entries.find((e) => e.address === address)?.alias;
  }
  /**
   * Slots that are ready to take a payment.
   *
   * Returns copies. An earlier version returned the internal objects straight out
   * of `filter`, which let a caller silently re-arm or consume a slot by mutating
   * what it was handed.
   */
  armedFor(alias) {
    return this.#entries.filter((e) => e.alias === alias && e.armed && !e.consumedBy).map((e) => ({ ...e }));
  }
  allFor(alias) {
    return this.#entries.filter((e) => alias === void 0 || e.alias === alias).map((e) => ({ ...e }));
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
  settleable(address, consumedBy) {
    this.#findSettleable(address, consumedBy);
  }
  #findSettleable(address, consumedBy) {
    const entry = this.#entries.find((e) => e.address === address);
    if (!entry) throw new Error(`unknown payment account ${address}`);
    if (entry.consumedBy === null) {
      throw new Error(
        `account ${address} was never reserved, so nothing could have settled into it`
      );
    }
    if (entry.consumedBy !== consumedBy) {
      throw new Error(
        `account ${address} was consumed by ${entry.consumedBy}, not ${consumedBy}`
      );
    }
    if (entry.settledAt !== void 0) {
      throw new Error(
        `account ${address} already settled at ${entry.settledAt} \u2014 settling twice would double-count one payment`
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
  settle(address, consumedBy, settledAt) {
    const entry = this.#findSettleable(address, consumedBy);
    entry.settledAt = settledAt;
  }
  #capacityFor(alias) {
    const total = this.#entries.filter((e) => e.alias === alias).length;
    if (total === 0) {
      throw new Error(`no pool accounts registered for alias ${alias}`);
    }
    return 2 ** Math.floor(Math.log2(total));
  }
  /**
   * Invariants that must hold for the privacy claim to be true.
   *
   * These are checked on load, not just on write, because the ledger is a file
   * on disk and a hand-edit is a realistic way for a duplicate address to appear.
   */
  assertInvariants() {
    const seenSlots = /* @__PURE__ */ new Set();
    const seenAddresses = /* @__PURE__ */ new Set();
    for (const e of this.#entries) {
      const slotKey = `${e.alias}#${e.slot}`;
      if (seenSlots.has(slotKey)) {
        throw new Error(`duplicate slot ${e.slot} for alias ${e.alias}`);
      }
      seenSlots.add(slotKey);
      if (seenAddresses.has(e.address)) {
        throw new Error(
          `duplicate address ${e.address} in pool ledger \u2014 two aliases would be linkable`
        );
      }
      seenAddresses.add(e.address);
      if (e.consumedBy !== null && !e.armed) {
        throw new Error(
          `slot ${e.slot} is consumed by a payment but not armed \u2014 it could not have settled`
        );
      }
    }
  }
};

// packages/server/src/index.ts
async function saveLedger(path, ledger) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger.toJSON(), null, 2)}
`, "utf8");
}
function createFacilitator(rawConfig, ledger) {
  const config = {
    ...rawConfig,
    network: normalizeNetwork(rawConfig.network)
  };
  if (!isValidAddress(config.mint)) {
    throw new TypeError(
      `config.mint is not a valid 32-byte base58 address: ${JSON.stringify(config.mint)}. Set VEIL_MINT to the real mint, or use PLACEHOLDER_MINT for a chain-free run.`
    );
  }
  const settled = [];
  let spent = 0n;
  const poolSizeFor = (alias) => {
    const total = ledger.allFor(alias).length;
    if (total === 0) return 0;
    return 2 ** Math.floor(Math.log2(total));
  };
  const gate = (alias) => {
    if (!config.privacy) return { code: "VEIL-CONF-003" };
    const mint = config.privacy.mintConfidential();
    if (mint === false) return { code: "VEIL-CONF-001" };
    if (mint === "unknown") return { code: "VEIL-CONF-003" };
    const accounts = config.privacy.accountsArmed(alias);
    if (accounts === false) return { code: "VEIL-CONF-002" };
    if (accounts === "unknown") return { code: "VEIL-CONF-003" };
    return null;
  };
  const facilitator = {
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
            payTo: "",
            decimals: config.decimals,
            resource: resource.path,
            poolIndex: 0
          })
        };
      }
      const amount = priceFor(
        {
          base: resource.base,
          ...resource.perUnit !== void 0 ? { perUnit: resource.perUnit } : {},
          ...resource.units !== void 0 ? { units: resource.units } : {}
        },
        config.decimals
      );
      const amountDecimal = formatAtomic(amount, config.decimals, "");
      if (config.spendCap !== void 0) {
        const verdict = checkBudget(amount, {
          spendCap: toAtomic(config.spendCap, config.decimals),
          alreadySpent: spent
        });
        if (!verdict.ok) {
          return {
            ok: false,
            status: 402,
            body: buildRefusal402("VEIL-CONF-004", {
              network: config.network,
              asset: config.mint,
              payTo: "",
              decimals: config.decimals,
              resource: resource.path,
              poolIndex: 0
            })
          };
        }
      }
      const poolSize = poolSizeFor(resource.alias);
      if (poolSize === 0) {
        return {
          ok: false,
          status: 503,
          body: buildRefusal402("VEIL-CONF-005", {
            network: config.network,
            asset: config.mint,
            payTo: "",
            decimals: config.decimals,
            resource: resource.path,
            poolIndex: 0
          })
        };
      }
      let reserved;
      try {
        reserved = ledger.reserve(resource.alias, id, poolSize);
      } catch {
        return {
          ok: false,
          status: 503,
          body: buildRefusal402("VEIL-CONF-005", {
            network: config.network,
            asset: config.mint,
            payTo: "",
            decimals: config.decimals,
            resource: resource.path,
            poolIndex: 0
          })
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
          poolIndex: reserved.slot
        })
      };
    },
    verify(raw, resource) {
      if (typeof raw !== "object" || raw === null) {
        return { ok: false, status: 402, reason: "payment payload must be an object" };
      }
      const payload = raw;
      if (payload.x402Version !== 2) {
        return { ok: false, status: 402, reason: "x402Version must be 2" };
      }
      if (payload.scheme !== "exact-confidential") {
        return {
          ok: false,
          status: 402,
          reason: `scheme must be exact-confidential, got ${String(payload.scheme)}`
        };
      }
      if (payload.network !== config.network) {
        return {
          ok: false,
          status: 402,
          reason: `wrong network: expected ${config.network}, got ${String(payload.network)}`
        };
      }
      const inner = payload.payload;
      if (!inner) {
        return { ok: false, status: 402, reason: "payload.payload is required" };
      }
      if (typeof inner.transaction !== "string" || inner.transaction.length === 0) {
        return {
          ok: false,
          status: 402,
          reason: "payload.transaction must be a base64 signed transaction"
        };
      }
      if (typeof inner.payTo !== "string" || inner.payTo.length === 0) {
        return { ok: false, status: 402, reason: "payload.payTo is required" };
      }
      if (inner.asset !== config.mint) {
        return {
          ok: false,
          status: 402,
          reason: `wrong mint: expected ${config.mint}, got ${String(inner.asset)}`
        };
      }
      const accepted = payload.accepted;
      if (!accepted || typeof accepted !== "object") {
        return { ok: false, status: 402, reason: "payload.accepted is required (x402 v2)" };
      }
      if (accepted.scheme !== "exact-confidential") {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.scheme must be exact-confidential, got ${String(
            accepted.scheme
          )}`
        };
      }
      if (accepted.network !== config.network) {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.network must be ${config.network}, got ${String(
            accepted.network
          )}`
        };
      }
      if (accepted.asset !== config.mint) {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.asset must be ${config.mint}, got ${String(accepted.asset)}`
        };
      }
      if (accepted.payTo !== inner.payTo) {
        return {
          ok: false,
          status: 402,
          reason: `payload.accepted.payTo (${String(
            accepted.payTo
          )}) does not match the account paid (${inner.payTo})`
        };
      }
      const entry = ledger.resolve(inner.payTo);
      if (!entry) {
        return {
          ok: false,
          status: 402,
          reason: "payload.payTo is not a payment account Veil issued; it cannot be attributed to a merchant"
        };
      }
      if (entry.alias !== resource.alias) {
        return {
          ok: false,
          status: 402,
          reason: `payload.payTo belongs to ${entry.alias}, not the merchant for ${resource.path}`
        };
      }
      return {
        ok: true,
        payload,
        address: entry.address
      };
    },
    async settle(input) {
      const { payload, resource, address, paymentId } = input;
      try {
        ledger.settleable(address, paymentId);
      } catch (error) {
        return {
          ok: false,
          status: 402,
          reason: error instanceof Error ? error.message : "settlement rejected"
        };
      }
      let signature = null;
      if (config.rpcUrl !== void 0) {
        signature = await broadcast(config.rpcUrl, payload.payload.transaction);
      } else if (config.allowLocalSettlement !== true) {
        return {
          ok: false,
          status: 503,
          reason: "settlement-unavailable: no RPC configured. Set VEIL_RPC_URL and fund the payer to broadcast, or run the local protocol demo (npm run demo:local), which exercises this path and reports itself as chain-free."
        };
      }
      const settlement = {
        paymentId,
        alias: resource.alias,
        address,
        amount: input.amount,
        resource: resource.path,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        signature
      };
      ledger.settle(address, paymentId, settlement.at);
      settled.push(settlement);
      spent += input.amount;
      await facilitator.flush();
      return { ok: true, settlement };
    },
    async flush() {
      await saveLedger(config.ledgerPath, ledger);
    }
  };
  return facilitator;
}
async function broadcast(rpcUrl, base64Transaction) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [base64Transaction, { encoding: "base64", preflightCommitment: "confirmed" }]
    })
  });
  const body = await response.json();
  if (body.error) {
    throw new Error(`broadcast rejected: ${body.error.message ?? "unknown"}`);
  }
  if (typeof body.result !== "string") {
    throw new Error("broadcast returned no signature");
  }
  return body.result;
}
function json(res, status, body) {
  const text = JSON.stringify(
    body,
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
    2
  );
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    // Payers are browsers and agents on other origins — a hosted rail must
    // answer them. No credentials are accepted here, so `*` is safe.
    "access-control-allow-origin": "*"
  });
  res.end(text);
}
function createVeilHandler(rawConfig, facilitator) {
  const config = {
    ...rawConfig,
    network: normalizeNetwork(rawConfig.network)
  };
  const byPath = new Map(config.resources.map((r) => [r.path, r]));
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-payment",
          "access-control-max-age": "86400"
        });
        res.end();
        return;
      }
      if (path === "/.well-known/veil") {
        return json(res, 200, {
          scheme: "exact-confidential",
          network: config.network,
          mint: config.mint,
          decimals: config.decimals,
          privacy: "confidential-balances",
          hides: ["on-chain-amount", "on-chain-balance"],
          exposes: ["destination-account", "mint", "transaction-existence"],
          resources: config.resources.map((r) => ({
            path: r.path,
            base: r.base,
            ...r.perUnit ? { perUnit: r.perUnit, units: r.units ?? 0 } : {}
          })),
          privacySource: config.privacySource ?? "none",
          privacyGate: config.privacy === void 0 ? {
            mode: "refusing",
            note: "no precondition probe configured, so every paid resource answers VEIL-CONF-003"
          } : {
            mode: "enforcing",
            source: config.privacySource ?? "none",
            checks: ["mint-confidential-extension", "destination-confidential-credits"]
          },
          settlement: config.rpcUrl !== void 0 ? { mode: "rpc", chain: String(config.network) } : config.allowLocalSettlement === true ? {
            mode: "local-ledger-only",
            chain: "none",
            note: "settlements are accounting records here, not chain facts"
          } : { mode: "unavailable", chain: "none" },
          refusals: [
            "VEIL-CONF-001",
            "VEIL-CONF-002",
            "VEIL-CONF-003",
            "VEIL-CONF-004",
            "VEIL-CONF-005"
          ].map((code) => {
            const r = refusal(code);
            return { code: r.code, title: r.title, recoverable: r.recoverable };
          })
        });
      }
      if (path === "/v1/health") {
        return json(res, 200, {
          ok: true,
          network: config.network,
          mint: config.mint,
          poolSize: facilitator.state.ledger.size,
          settled: facilitator.state.settled.length,
          settlement: config.rpcUrl ? "rpc" : config.allowLocalSettlement === true ? "local-ledger-only" : "unavailable"
        });
      }
      if (path === "/api/ledger") {
        return json(res, 200, {
          network: config.network,
          mint: config.mint,
          decimals: config.decimals,
          pool: facilitator.state.ledger.toJSON(),
          settled: facilitator.state.settled.map((s) => ({
            ...s,
            amount: s.amount.toString()
          }))
        });
      }
      const resource = byPath.get(path);
      if (!resource) {
        return json(res, 404, { error: "not-found", path });
      }
      const payerHeader = req.headers["x-payer"];
      const payer = typeof payerHeader === "string" ? payerHeader : "anonymous";
      const nonce = Number(url.searchParams.get("nonce") ?? "0");
      const id = { resource: path, payer, nonce };
      const paymentHeader = req.headers["x-payment"];
      if (typeof paymentHeader !== "string") {
        const quote = facilitator.quote(resource, id);
        if (!quote.ok) return json(res, quote.status, quote.body);
        return json(res, 402, quote.body);
      }
      let decoded;
      try {
        decoded = JSON.parse(
          Buffer.from(paymentHeader, "base64").toString("utf8")
        );
      } catch {
        return json(res, 402, {
          error: "malformed-payment-header",
          detail: "X-PAYMENT must be base64-encoded JSON"
        });
      }
      const verified = facilitator.verify(decoded, resource);
      if (!verified.ok) {
        return json(res, verified.status, { error: "invalid-payment", detail: verified.reason });
      }
      const paymentId = derivePaymentId(id);
      const amount = priceFor(
        {
          base: resource.base,
          ...resource.perUnit !== void 0 ? { perUnit: resource.perUnit } : {},
          ...resource.units !== void 0 ? { units: resource.units } : {}
        },
        config.decimals
      );
      const outcome = await facilitator.settle({
        payload: verified.payload,
        resource,
        address: verified.address,
        paymentId,
        amount
      });
      if (!outcome.ok) {
        return json(res, outcome.status, {
          error: "settlement-failed",
          detail: outcome.reason
        });
      }
      return json(res, 200, {
        paid: true,
        settled: {
          signature: outcome.settlement.signature,
          amount: outcome.settlement.amount.toString(),
          at: outcome.settlement.at,
          confid: "amount hidden on chain by Token-2022 confidential balances"
        },
        data: resource.produce({ paid: true })
      });
    } catch (error) {
      json(res, 500, {
        error: "internal-error",
        detail: error instanceof Error ? error.message : "unknown"
      });
    }
  };
}
var DEFAULT_RESOURCES = [
  {
    path: "/v1/oracle/tide",
    alias: "oracle.tide",
    description: "Sea-state and tidal window, per call",
    base: "0.049",
    produce: () => ({
      station: "Tidewater Atlas \xB7 Galveston Pier 21",
      window: "2026-10-02T04:12Z \u2192 2026-10-02T10:38Z",
      waveHeightM: 1.2,
      // A real implementation would read a live feed; this server is the payment
      // rail, and the payload shape is what matters to an integrator.
      source: "oracle.tide"
    })
  },
  {
    path: "/v1/quote/feedmarket",
    alias: "feedmarket",
    description: "Feed commodity quote, per 1k bushels",
    base: "0.000",
    perUnit: "0.0011",
    units: 900,
    produce: () => ({
      commodity: "Feed corn",
      unit: "per bushel",
      price: "4.18",
      asOf: "2026-10-02T09:00:00Z",
      source: "feedmarket"
    })
  },
  {
    path: "/v1/attest/sensor",
    alias: "sensor.attest",
    description: "Sensor provenance attestation, per call",
    base: "0.012",
    produce: () => ({
      device: "coldchain-4417",
      attestation: "range-intact",
      issuedAt: "2026-10-02T09:41:07Z",
      source: "sensor.attest"
    })
  }
];
function poolLedgerProbe(ledger, mintConfidential) {
  return {
    mintConfidential: () => mintConfidential,
    accountsArmed: (alias) => {
      const entries = ledger.allFor(alias);
      if (entries.length === 0) return false;
      return entries.some((e) => e.armed);
    }
  };
}

// scripts/lib.ts
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join } from "node:path";
import { fileURLToPath } from "node:url";
var PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
var DATA_DIR = join(PROJECT_ROOT, "data");
var LEDGER_PATH = join(DATA_DIR, "pool-ledger.json");
var SETTLEMENTS_PATH = join(DATA_DIR, "settlements.json");
var KEYS_DIR = join(PROJECT_ROOT, ".keys");
var MINT_PATH = join(DATA_DIR, "mint.json");
var DEMO_DIR = join(DATA_DIR, "demo");
var DEMO_LEDGER_PATH = join(DEMO_DIR, "pool-ledger.json");
var DEMO_RUN_PATH = join(DEMO_DIR, "run.json");
var FIXTURES_DIR = join(DATA_DIR, "fixtures");
async function loadLedger(path = LEDGER_PATH) {
  try {
    const raw = await readFile2(path, "utf8");
    return PoolLedger.fromJSON(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") return PoolLedger.empty();
    throw error;
  }
}
function optionsFromEnv(argv = []) {
  const flag = (name) => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0) return argv[index + 1];
    return void 0;
  };
  return {
    mint: flag("mint") ?? process.env.VEIL_MINT ?? PLACEHOLDER_MINT,
    decimals: Number(flag("decimals") ?? process.env.VEIL_DECIMALS ?? "6"),
    network: flag("network") ?? process.env.VEIL_NETWORK ?? DEVNET,
    spendCap: flag("spend-cap") ?? process.env.VEIL_SPEND_CAP ?? "5.00",
    rpcUrl: flag("rpc") ?? process.env.VEIL_RPC_URL,
    allowLocalSettlement: flag("local-settlement") === "true" || process.env.VEIL_LOCAL_SETTLEMENT === "true",
    poolSize: Number(flag("pool-size") ?? process.env.VEIL_POOL_SIZE ?? "8"),
    port: Number(flag("port") ?? process.env.VEIL_PORT ?? "4021"),
    ledgerPath: flag("ledger") ?? process.env.VEIL_LEDGER ?? LEDGER_PATH,
    mintConfidential: parseMintConfidential(
      flag("mint-confidential") ?? process.env.VEIL_MINT_CONFIDENTIAL
    )
  };
}
function parseMintConfidential(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "unknown";
}
function configFrom(options, ledger) {
  return {
    network: options.network,
    mint: options.mint,
    decimals: options.decimals,
    ledgerPath: options.ledgerPath,
    resources: DEFAULT_RESOURCES,
    spendCap: options.spendCap,
    ...options.rpcUrl !== void 0 ? { rpcUrl: options.rpcUrl } : {},
    ...options.allowLocalSettlement ? { allowLocalSettlement: true } : {},
    ...ledger ? {
      privacy: poolLedgerProbe(ledger, options.mintConfidential),
      privacySource: "pool-ledger"
    } : { privacySource: "none" }
  };
}

// scripts/hosted.ts
import { rename, stat, writeFile as writeFile3 } from "node:fs/promises";

// data/pool-ledger.json
var pool_ledger_default = [
  {
    slot: 0,
    address: "HYLLJkNr7LpEGa8Eck8EP9vqNxHv1y8z71A7FLKUiHgc",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "5QU2gN1M3cQTSQr5xRcSJWyo669s71Wco3ZFjFHMkgKX",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "Hrso3sCDYjWoPgyLxn3wmabGX1SWMUE9XPSkKZoao9Tv",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "DKxzFxrLgCQnaAhrUWyCieDqpnydkTi7Mg3ugkvH1Mvf",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "7BVQaurz8VSxw8MVHmwruCEq8sSHhww3XKZTmxQSaQJi",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "J1pqGAewEEKAP5umysRcTpNEitprcHMGZoGjzRBHeyrM",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "5qCxeApYmJzF1bK46TBqXgwixzVY52EdPrsLGPEDQsF5",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 0,
    address: "EU5kSbk1Gdz2KXoRQ294A9yTSoxuWBr4pCu3kt4AmMbo",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "HxDViXQTdsU2M9p9NyoHqsXeeUYswSh8zyTiagFACi83",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "EwL7AqhRTBFXs4V4PcDYAe678e7Aj89hU9ALdM9etZrK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "H9RmhDhdWMzFG9a8YXfWe76dK4B95N7DqpbMLUvCUMsb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "BpJ87GXAevi87cRqB2spDtUTEgP1SDRStN7uzafXNwYA",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "GmDpZNBh73AQ9DaevFDtxhYasKfAmvC9HjiSKowrixhU",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "5vtrXpeAkJWnr4XDbJ26STbvLYhwGmVRLVxNxvvR3ycK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "9UQPMVXFEmNvcTbkUKeakBiH5K7Ca3i1StUJ7yt1pgN",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 0,
    address: "5L5AS47hbYmfTdpt6M4R7mG9LzV8Lnf9jpwNJqxnungo",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "36pT9X5vNLx3kvU87s32nkhrbCWoTeioTsxdzRw7BDCP",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "82GQCuBG2kaZg6irZsFSSxkrcBMT4d3YXiCt5SyDLWfp",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "CxcrAztrHnFGg96yJ4j8VGfVdDUXutZyw8zuvyqXm7KN",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "3Yfz8YLhR4ehwSmwo4awtXbRFzCVMnQ3LYJUdoph5zmq",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "abFQZESM3MaX7SnydD66pNibgHFXj2V5HgnGJV226BE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "8N7ynV8FVWBxv7DajbDo8QVtDKCR9Du8BcCxSYtQsUHq",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "BLrTv22TCL5Jj8VrmmwU3kNQBbdyRh2UPkSjzA2GvMVA",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  }
];

// scripts/hosted.ts
var HOSTED_LEDGER = "/tmp/veil-pool-ledger.json";
async function seedHostedLedger() {
  try {
    await stat(HOSTED_LEDGER);
  } catch {
    const staging = `${HOSTED_LEDGER}.seed-${process.pid}`;
    await writeFile3(staging, `${JSON.stringify(pool_ledger_default, null, 2)}
`, "utf8");
    await rename(staging, HOSTED_LEDGER);
  }
  return HOSTED_LEDGER;
}
function rewriteRoute(reqUrl) {
  try {
    const route = new URL(reqUrl ?? "/", "http://localhost").searchParams.get("route");
    return route !== null && route.length > 0 ? route : null;
  } catch {
    return null;
  }
}

// api-src/veil.ts
var cached = null;
async function build() {
  process.env.VEIL_LEDGER = await seedHostedLedger();
  const options = optionsFromEnv([]);
  const ledger = await loadLedger(options.ledgerPath);
  const config = configFrom(options, ledger);
  const facilitator = createFacilitator(config, ledger);
  return createVeilHandler(config, facilitator);
}
async function handler(req, res) {
  const veil = await (cached ??= build());
  const route = rewriteRoute(req.url);
  if (route !== null) req.url = route;
  await veil(req, res);
}
export {
  handler as default
};
