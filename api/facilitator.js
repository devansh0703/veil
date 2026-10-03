// scripts/facilitator-app.ts
import { readFile as readFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { toFacilitatorSvmSigner } from "@x402/svm";
import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema
} from "@x402/core/schemas";

// packages/server/src/scheme.ts
import { x402Facilitator } from "@x402/core/facilitator";
import {
  SettlementCache,
  decodeTransactionFromPayload,
  transactionMessageHash
} from "@x402/svm";
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder
} from "@solana/kit";

// packages/x402-core/src/index.ts
var VEIL_SCHEME = "exact-confidential";
var TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
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

// packages/server/src/scheme.ts
var CONFIDENTIAL_TRANSFER_IX = 27;
var CONFIDENTIAL_TRANSFER_OP = 7;
function addressOf(value) {
  if (value === void 0) return null;
  return typeof value === "string" ? value : value.address;
}
function invalid(reason, message, payer) {
  return { isValid: false, invalidReason: reason, invalidMessage: message, ...payer ? { payer } : {} };
}
var ConfidentialSvmScheme = class {
  scheme = VEIL_SCHEME;
  caipFamily = "solana:*";
  #signer;
  #owner;
  #simulate;
  #settlements;
  constructor(options) {
    this.#signer = options.signer;
    this.#owner = options.owner;
    this.#simulate = options.simulate ?? true;
    this.#settlements = options.settlements ?? new SettlementCache();
  }
  /**
   * What a client needs to build a payment: the fee payer, and the two facts that
   * make this scheme different from `exact` — the token program, and the privacy
   * model. Advertising `privacy` here is the same claim the 402 body makes, and it
   * is the field an SDK reads to decide whether to attempt a confidential
   * transfer at all.
   */
  getExtra(_network) {
    const [feePayer] = this.#signer.getAddresses();
    return {
      ...feePayer ? { feePayer } : {},
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      privacy: "confidential-balances"
    };
  }
  getSigners(_network) {
    return [...this.#signer.getAddresses()];
  }
  async verify(payload, requirements) {
    const raw = payload.payload?.transaction;
    if (typeof raw !== "string" || raw.length === 0) {
      return invalid(
        "invalid_payload",
        "payload.payload.transaction must be a base64 signed Solana transaction"
      );
    }
    const wire = raw;
    let decoded;
    let message;
    try {
      decoded = decodeTransactionFromPayload({ transaction: wire });
      const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
      message = decompileTransactionMessage(compiled);
    } catch (error) {
      return invalid(
        "invalid_transaction",
        `the transaction could not be decoded: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const feePayer = addressOf(message.feePayer);
    const signers = this.#signer.getAddresses().map(String);
    if (feePayer === null || !signers.includes(feePayer)) {
      return invalid(
        "fee_payer_not_facilitator",
        `the transaction's fee payer (${feePayer ?? "missing"}) is not one of this facilitator's signers (${signers.join(
          ", "
        )}). Build the payment with the feePayer from /supported.`
      );
    }
    const transfers = message.instructions.filter(
      (instruction) => instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS && instruction.data?.[0] === CONFIDENTIAL_TRANSFER_IX && instruction.data?.[1] === CONFIDENTIAL_TRANSFER_OP
    );
    if (transfers.length === 0) {
      return invalid(
        "no_confidential_transfer",
        "the transaction contains no Token-2022 confidential transfer instruction, so it cannot settle an exact-confidential payment"
      );
    }
    if (transfers.length > 1) {
      return invalid(
        "ambiguous_confidential_transfer",
        `the transaction contains ${transfers.length} confidential transfers; a payment must contain exactly one`
      );
    }
    const transfer = transfers[0];
    const accounts = (transfer.accounts ?? []).map((account) => account.address);
    const [source, mint, destination] = accounts;
    if (!source || !mint || !destination) {
      return invalid(
        "malformed_transfer",
        `a confidential transfer needs at least source, mint and destination accounts; got ${accounts.length}`
      );
    }
    if (destination !== requirements.payTo) {
      return invalid(
        "wrong_destination",
        `the transfer pays ${destination}, but the requirements name ${requirements.payTo}`
      );
    }
    if (mint !== requirements.asset) {
      return invalid(
        "wrong_mint",
        `the transfer moves ${mint}, but the requirements are denominated in ${requirements.asset}`
      );
    }
    if (!requirements.network.includes(":")) {
      return invalid(
        "wrong_network",
        `network must be CAIP-2 (e.g. solana:testnet), got ${String(requirements.network)}`
      );
    }
    const authority = accounts[accounts.length - 1] ?? null;
    if (this.#simulate) {
      try {
        await this.#signer.simulateTransaction(wire, requirements.network);
      } catch (error) {
        return invalid(
          "simulation_failed",
          `the transfer would not settle: ${error instanceof Error ? error.message : String(error)}`,
          authority ?? void 0
        );
      }
    }
    if (this.#owner) {
      const owner = this.#owner(requirements.payTo);
      if (owner === void 0) {
        return invalid(
          "unowned_destination",
          `${requirements.payTo} is not a payment account this facilitator can attribute to a merchant`,
          authority ?? void 0
        );
      }
    }
    return { isValid: true, ...authority ? { payer: authority } : {} };
  }
  async settle(payload, requirements) {
    const network = requirements.network;
    const wireValue = payload.payload?.transaction;
    const wire = typeof wireValue === "string" ? wireValue : "";
    let key = null;
    if (wire.length > 0) {
      try {
        key = transactionMessageHash(
          decodeTransactionFromPayload({ transaction: wire })
        );
        if (this.#settlements.isDuplicate(key)) {
          return {
            success: false,
            errorReason: "duplicate_settlement",
            errorMessage: "this payment is already being settled",
            transaction: "",
            network
          };
        }
      } catch {
        key = null;
      }
    }
    try {
      const verdict = await this.verify(payload, requirements);
      if (!verdict.isValid) {
        return {
          success: false,
          errorReason: verdict.invalidReason ?? "invalid_payment",
          errorMessage: verdict.invalidMessage ?? "payment verification failed",
          ...verdict.payer ? { payer: verdict.payer } : {},
          transaction: "",
          network
        };
      }
      const [feePayer] = this.#signer.getAddresses();
      if (!feePayer) {
        return {
          success: false,
          errorReason: "no_fee_payer",
          errorMessage: "this facilitator has no signer configured",
          transaction: "",
          network
        };
      }
      const signed = await this.#signer.signTransaction(wire, feePayer, network);
      const signature = await this.#signer.sendTransaction(signed, network);
      await this.#signer.confirmTransaction(signature, network);
      return {
        success: true,
        transaction: signature,
        network,
        ...verdict.payer ? { payer: verdict.payer } : {},
        extra: {
          // Enough for a merchant to reconcile without trusting our word.
          privacy: "confidential-balances",
          program: TOKEN_2022_PROGRAM_ADDRESS,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
        }
      };
    } catch (error) {
      if (key !== null) this.#settlements.delete(key);
      return {
        success: false,
        errorReason: "settlement_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        transaction: "",
        network
      };
    }
  }
};
function createVeilFacilitator(input) {
  const scheme = new ConfidentialSvmScheme({
    signer: input.signer,
    ...input.owner ? { owner: input.owner } : {},
    ...input.simulate !== void 0 ? { simulate: input.simulate } : {},
    ...input.settlements ? { settlements: input.settlements } : {}
  });
  const networks = (Array.isArray(input.networks) ? input.networks : [input.networks]).map((network) => normalizeNetwork(network));
  const facilitator = new x402Facilitator();
  facilitator.register(networks, scheme);
  return { facilitator, scheme };
}

// scripts/lib.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  static fromJSON(json) {
    if (!Array.isArray(json)) {
      throw new TypeError("pool ledger must be a JSON array");
    }
    const entries = json.map((raw, i) => {
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

// scripts/lib.ts
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
function relative(path) {
  return path.replace(`${PROJECT_ROOT}/`, "");
}
async function loadLedger(path = LEDGER_PATH) {
  try {
    const raw = await readFile(path, "utf8");
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
function decodeSecret(raw) {
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      const bytes2 = Uint8Array.from(parsed);
      return bytes2.length >= 32 ? bytes2 : null;
    } catch {
      return null;
    }
  }
  const bytes = base58Decode(text);
  return bytes && bytes.length >= 32 ? bytes : null;
}
function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (value.length === 0) return null;
  const bytes = [0];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
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
function parseMintConfidential(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "unknown";
}

// scripts/facilitator-app.ts
var cached = null;
function getFacilitatorApp(options) {
  cached ??= build(options);
  return cached;
}
async function build(options) {
  const PAYER_PATH = join2(KEYS_DIR, "payer.json");
  const fromEnv = process.env.VEIL_PAYER_SECRET;
  const seed = fromEnv ? decodeSecret(fromEnv) : await readFile2(PAYER_PATH, "utf8").then((raw) => decodeSecret(raw)).catch(() => null);
  if (!seed) {
    throw new Error(
      fromEnv ? "VEIL_PAYER_SECRET is set but is not a usable keypair (JSON byte array or base58)." : [
        `No usable keypair at ${relative(PAYER_PATH)}.`,
        "",
        "A facilitator needs one key: the fee payer that signs and broadcasts settlements.",
        "Run `npm run setup:devnet -- --apply` once to create and fund it."
      ].join("\n")
    );
  }
  const feePayer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const ledger = await loadLedger(options.ledgerPath);
  const { facilitator } = createVeilFacilitator({
    signer: toFacilitatorSvmSigner(feePayer, {
      ...options.rpcUrl ? { defaultRpcUrl: options.rpcUrl } : {}
    }),
    networks: [options.network],
    // Attribution: without it the facilitator would settle any destination. With
    // it, a payment to an account that is not one of this pool's is refused with a
    // reason instead of being broadcast and then disputed.
    owner: (address) => ledger.resolve(address)?.alias,
    simulate: process.env.VEIL_SKIP_SIMULATE !== "true"
  });
  function json(res, status, body) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      // Paying agents may call /verify and /settle from a browser on another
      // origin; nothing here accepts credentials, so `*` carries no risk.
      "access-control-allow-origin": "*"
    });
    res.end(payload);
  }
  async function readBody(req) {
    const preParsed = req.body;
    if (preParsed !== void 0 && preParsed !== null) return preParsed;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1e6) throw new Error("request body too large");
      chunks.push(chunk);
    }
    if (size === 0) return void 0;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function parseRequest(raw) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "body must be a JSON object" };
    const body = raw;
    if (typeof body.x402Version !== "number") {
      return { ok: false, error: "x402Version is required" };
    }
    const payload = PaymentPayloadSchema.safeParse(body.paymentPayload);
    if (!payload.success) {
      return {
        ok: false,
        error: `paymentPayload is not a valid x402 payload: ${payload.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      };
    }
    const requirements = PaymentRequirementsSchema.safeParse(body.paymentRequirements);
    if (!requirements.success) {
      return {
        ok: false,
        error: `paymentRequirements is not a valid x402 requirement: ${requirements.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      };
    }
    return {
      ok: true,
      payload: payload.data,
      requirements: requirements.data
    };
  }
  function out(lines) {
    process.stdout.write(`${lines.join("\n")}
`);
  }
  const handler2 = async (req, res) => {
    const query = req.query?.route;
    if (typeof query === "string" && query.length > 0) req.url = query;
    const pathOnly = new URL(req.url ?? "/", "http://localhost").pathname;
    const known = ["/verify", "/settle", "/supported", "/health"].find(
      (route) => pathOnly === route || pathOnly.endsWith(route)
    );
    if (known !== void 0) req.url = known;
    else if (pathOnly.endsWith("/facilitator") || pathOnly.endsWith("/api/facilitator")) {
      req.url = "/";
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      json(res, 200, {
        service: "veil-facilitator",
        scheme: VEIL_SCHEME,
        // Which chains? The ones the registered scheme was registered for.
        supported: ["GET /supported", "POST /verify", "POST /settle"],
        feePayers: facilitator.getSupported().signers,
        poolAccounts: ledger.allFor().length,
        ledger: relative(options.ledgerPath),
        network: options.network,
        rpc: options.rpcUrl ?? "default",
        honest: [
          "This service verifies destinations, mints and proofs, and simulates before settling.",
          "It cannot verify the transferred AMOUNT: a confidential transfer carries an encrypted value.",
          "The merchant verifies the amount by decrypting its own balance; see README.md."
        ]
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/supported") {
      json(res, 200, facilitator.getSupported());
      return;
    }
    if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : "unreadable body" });
        return;
      }
      const parsed = parseRequest(raw);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return;
      }
      const started = Date.now();
      if (url.pathname === "/verify") {
        const verdict = await facilitator.verify(parsed.payload, parsed.requirements);
        out([
          `verify  ${verdict.isValid ? "valid  " : "invalid"}  ${verdict.invalidReason ?? ""}  ${Date.now() - started}ms`.trimEnd()
        ]);
        json(res, 200, verdict);
        return;
      }
      const result = await facilitator.settle(parsed.payload, parsed.requirements);
      out([
        `settle  ${result.success ? `confirmed ${result.transaction}` : `failed ${result.errorReason ?? ""}`}  ${Date.now() - started}ms`.trimEnd()
      ]);
      json(res, 200, result);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400"
      });
      res.end();
      return;
    }
    json(res, 404, {
      error: "not found",
      // Echo of what arrived: when a hosted rewrite loses the original path,
      // this is the difference between a five-second fix and a blind one.
      seen: url.pathname,
      endpoints: ["GET /", "GET /health", "GET /supported", "POST /verify", "POST /settle"]
    });
  };
  const supported = facilitator.getSupported();
  return {
    handler: handler2,
    feePayerAddress: feePayer.address,
    poolAccounts: ledger.allFor().length,
    network: String(options.network),
    rpc: options.rpcUrl ?? "default",
    ledgerDisplay: relative(options.ledgerPath),
    kinds: supported.kinds.map((k) => `${k.scheme}@${k.network}`)
  };
}

// scripts/hosted.ts
import { rename, stat, writeFile as writeFile2 } from "node:fs/promises";

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
    await writeFile2(staging, `${JSON.stringify(pool_ledger_default, null, 2)}
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

// api-src/facilitator.ts
var ready = null;
async function ensureReady() {
  ready ??= (async () => {
    process.env.VEIL_LEDGER = await seedHostedLedger();
  })();
  return ready;
}
async function handler(req, res) {
  try {
    await ensureReady();
    const route = rewriteRoute(req.url);
    if (route !== null) req.url = route;
    const app = await getFacilitatorApp(optionsFromEnv([]));
    await app.handler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      const detail = error instanceof Error ? error.message : "unknown error";
      res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*"
      });
      res.end(JSON.stringify({ error: "facilitator-unavailable", detail }, null, 2));
    }
  }
}
export {
  handler as default
};
