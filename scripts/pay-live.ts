/**
 * scripts/pay-live.ts — an independent payer pays a merchant, live.
 *
 *   npm run pay:live                      # inspect only; nothing is broadcast
 *   npm run pay:live -- --apply           # broadcast the full payment
 *   VEIL_RPC_URL=https://api.testnet.solana.com npm run pay:live -- --apply
 *
 * ## What this proves that `go:live` does not
 *
 * `go:live` moves value between two accounts the *operator* controls: one key
 * creates, funds, signs and settles everything. That proves the cryptography and
 * the token program, but it does not prove the product, because the product's
 * claim is that *somebody else* can pay.
 *
 * This script is that somebody else. A payer with its own keypair — generated
 * here, unrelated to the operator's, holding no relationship to the pool —
 * builds a confidential transfer, generates its three zero-knowledge proofs
 * locally, signs only its half of the transaction, and hands it to the
 * facilitator over the real x402 endpoints: `POST /verify`, then
 * `POST /settle`. The facilitator verifies the payment the way x402 specifies,
 * co-signs it as fee payer with its own SOL, and broadcasts. The chain settles
 * it. The merchant then decrypts its own balance with its own key to see what
 * actually arrived.
 *
 * The asymmetry is the point, and every party holds exactly one of the three
 * rights the payment needs:
 *
 *   - the payer signs the *transfer* (its authority over its own funds),
 *   - the facilitator signs the *fee* (its SOL — the payer never pays gas on
 *     the payment itself),
 *   - the merchant alone can read the *amount* (only its keys decrypt the
 *     destination),
 *   - and the operator's key is needed exactly once per payer, to mint its
 *     starting funds — the faucet, not the rail.
 *
 * ## Who pays for what, honestly
 *
 * The payment transaction is gasless for the payer: the facilitator is its fee
 * payer. What the payer does pay for is the *proof scaffolding* — the three
 * context-state accounts and the record account that hold its proofs between
 * transactions, because 1867 bytes of proof cannot fit in a 1232-byte
 * transaction (measured; see `go-live.ts`). That is a rent *float*, not a fee:
 * closing the accounts returns every lamport to the payer. The true recurring
 * cost of a payment, for the payer, is a handful of transaction fees; for the
 * facilitator, one signature.
 *
 * ## Flow
 *
 *   0. Preconditions, all read from the chain: the mint carries the confidential
 *      extension, a fresh armed merchant seat exists and decrypts to zero, the
 *      facilitator answers `/supported` (started here if it is not already).
 *   1. The faucet: fund the payer's rent float, create and configure its token
 *      account, and top its confidential balance up to exactly the ticket size.
 *   2. The payer proves: three proofs generated in this process, verified into
 *      context-state accounts on chain — the payer pays this rent and gets it
 *      back in step 5.
 *   3. The payment: build the transfer against those accounts, partially sign
 *      (payer authority only), `POST /verify`, `POST /settle`. The facilitator
 *      co-signs and broadcasts; the signature comes back on the response.
 *   4. The merchant reads its own balance: decrypt, apply the pending credit,
 *      decrypt again — the amount never left the clear only inside this process
 *      and the merchant's.
 *   5. Reclaim: the payer closes the context accounts; the float comes home.
 *
 * Without `--apply` the script stops after step 0 and prints what would happen.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSome,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  partiallySignTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getApproveConfidentialTransferAccountInstruction,
  getConfidentialDepositInstruction,
  getEnableConfidentialCreditsInstruction,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { decryptConfidentialTransferBalance } from '@solana-program/token-2022/confidential';
import {
  RECORD_CHUNK_SIZE_POST_INITIALIZE,
  RECORD_META_DATA_SIZE,
  RECORD_PROGRAM_ADDRESS,
  getCloseAccountInstruction as getCloseRecordAccountInstruction,
  getInitializeInstruction as getInitializeRecordInstruction,
  getRecordSize,
  getWriteInstruction,
} from '@solana-program/record';
import {
  closeContextStateProof,
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
} from '@solana-program/zk-elgamal-proof';
import { ElGamalCiphertext, ElGamalPubkey } from '@solana/zk-sdk';

import {
  buildApplyPendingBalance,
  buildConfidentialTransfer,
  buildConfigureAccount,
  buildCreatePaymentAccount,
  confidentialAccountSpace,
} from '../packages/onchain/src/index.ts';
import {
  buildPubkeyValidityProof,
  buildTransferProofs,
  confidentialDerivationMessage,
  confidentialKeysFrom,
  encryptBalance,
  PROOF_OFFSET_IMMEDIATELY_PRECEDING,
} from '../packages/onchain/src/proofs.ts';
import { PoolLedger } from '../packages/derive/src/index.ts';
import {
  PLACEHOLDER_MINT,
  buildPaymentPayload,
  buildPaymentRequired,
  networkFromRpc,
} from '../packages/x402-core/src/index.ts';
import {
  DATA_DIR,
  KEYS_DIR,
  MINT_PATH,
  PROJECT_ROOT,
  clusterTag,
  decodeSecret,
  optionsFromEnv,
  readJSON,
  relative,
  saveJSON,
  table,
} from './lib.ts';

/** The keys type, taken from the function that produces it rather than guessed. */
type ConfidentialKeys = Awaited<ReturnType<typeof confidentialKeysFrom>>;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const options = optionsFromEnv(process.argv.slice(2));
const apply = process.argv.includes('--apply');

const rpcUrl = options.rpcUrl;
if (!rpcUrl) {
  process.stderr.write(
    'pay:live needs an RPC endpoint, because the point of it is to reach a chain.\n\n' +
      '  VEIL_RPC_URL=https://api.testnet.solana.com npm run pay:live -- --apply\n\n' +
      'Without --apply it reads and reports only. Nothing is broadcast either way\n' +
      'until you pass --apply.\n',
  );
  process.exit(1);
}

const rpc = createSolanaRpc(rpcUrl);

/**
 * Which network the payment is denominated in.
 *
 * Derived from the endpoint rather than trusted from `VEIL_NETWORK`: the two
 * disagree easily, and a payment whose network label does not match the cluster
 * the bytes are signed for fails at settle with a reason that blames neither.
 * When the host is not a known cluster name, the configured value stands.
 */
const network = networkFromRpc(rpcUrl) ?? options.network;

/** 0.049 tokens at 6 decimals — the demo's ticket size, same as `go:live`. */
const AMOUNT = 49_000n;
/** The confidential-extension cap this project configures everywhere. */
const MAX_PENDING_CREDIT_COUNTER = 65_535n;

/**
 * The payer's rent float, in SOL.
 *
 * Sized against measured rents: three context-state accounts (roughly 380,
 * 600 and 1050 bytes) plus the range proof's ~1 KB record account comes to
 * about 0.04 SOL at the network's per-byte rent, plus fees. The headroom is
 * there because an under-funded payer fails halfway through scaffolding, and a
 * failure there strands rent in accounts whose keys only exist in this
 * process's memory. Every lamport above the fees comes back in step 5.
 */
const FLOAT_SOL = 0.07;
/** Below this the float is topped up again; above it, nothing is transferred. */
const FLOAT_FLOOR_SOL = 0.06;

/**
 * A gap between transactions.
 *
 * The free public RPC answers `429` under a burst, and this script sends a
 * dozen transactions. Waiting is cheaper than retrying.
 */
const PAUSE_BETWEEN_TXS_MS = 1_200;

let failed = 0;

function step(n: string, title: string): void {
  process.stdout.write(`\n${n} · ${title}\n`);
}

function ok(label: string, detail = ''): void {
  process.stdout.write(`  ok    ${label}${detail ? `  ${detail}` : ''}\n`);
}

function note(label: string, detail = ''): void {
  process.stdout.write(`  note  ${label}${detail ? `  ${detail}` : ''}\n`);
}

function stop(label: string, detail = ''): void {
  failed += 1;
  process.stdout.write(`  STOP  ${label}${detail ? `  ${detail}` : ''}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an operation that only *reads* from the chain.
 *
 * Reads retry; sends never do. A retried read is free and idempotent; a retried
 * send after an ambiguous failure is how a payment gets made twice.
 */
async function retryRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 5;
  let lastError: unknown = new Error(`${label} failed`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === MAX_ATTEMPTS) {
        // Labeled before it leaves: a raw JSON-RPC error with no idea which
        // read produced it has cost this project an hour before.
        throw new Error(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      process.stdout.write(`  retry ${label} — attempt ${attempt + 1}/${MAX_ATTEMPTS}\n`);
      await sleep(1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
    }
  }
  throw lastError;
}

/** A rate-limited public RPC's failures are worth retrying; a rejected instruction is not. */
function isTransient(error: unknown): boolean {
  const text = String((error as { message?: string })?.message ?? error);
  return (
    text.includes('429') ||
    text.includes('Too Many Requests') ||
    text.includes('fetch failed') ||
    text.includes('ECONNRESET') ||
    text.includes('ETIMEDOUT') ||
    text.includes('socket hang up') ||
    text.includes('Blockhash not found')
  );
}

/**
 * Sign and send one transaction with an explicit fee payer, then wait for it.
 *
 * Confirmation is not optional: every next step reads what the previous step
 * wrote, so an unconfirmed send would make this script decrypt a balance that
 * does not exist and report the wrong thing.
 */
async function send(
  label: string,
  instructions: readonly Instruction[],
  feePayer: KeyPairSigner,
): Promise<string> {
  if (instructions.length === 0) throw new Error(`${label}: no instructions to send`);

  const MAX_SEND_ATTEMPTS = 8;
  let signature: string | undefined;
  let lastError: unknown = new Error('send failed');

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    /** Which part of the attempt threw — an unlabeled JSON-RPC error is
     * undiagnosable, and this run's first failure was exactly that. */
    let phase: 'blockhash' | 'sign and send' = 'blockhash';
    try {
      const { value: lifetime } = await retryRead('read a recent blockhash', () =>
        rpc.getLatestBlockhash().send(),
      );
      phase = 'sign and send';
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
        (tx) => appendTransactionMessageInstructions(instructions, tx),
      );
      const signed = await signTransactionMessageWithSigners(message);
      // Base58, not base64: Solana signatures are base58 strings everywhere the
      // RPC names them — `getSignatureStatuses` rejects a base64 one with a bare
      // `Invalid param: Invalid`, which cost this script two runs to trace.
      signature = getSignatureFromTransaction(signed);
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
        })
        .send();
      break;
    } catch (error) {
      lastError = new Error(
        `${label} — failed at ${phase}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
      if (!isTransient(error) || attempt === MAX_SEND_ATTEMPTS) throw lastError;
      const wait = Math.min(20_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      process.stdout.write(
        `  retry ${label} — attempt ${attempt + 1}/${MAX_SEND_ATTEMPTS} in ${Math.round(wait / 100) / 10}s\n`,
      );
      await sleep(wait);
    }
  }
  if (!signature) throw lastError;

  const CONFIRM_TIMEOUT_MS = 60_000;
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let status: { err: unknown; confirmationStatus?: string | null } | null | undefined;
    try {
      const result = await rpc.getSignatureStatuses([signature as never]).send();
      status = result.value[0];
    } catch (error) {
      lastError = new Error(
        `${label} — failed at confirm poll: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
      if (!isTransient(error)) throw lastError;
      await sleep(2_000);
      continue;
    }
    if (status?.err) {
      throw new Error(`${label}: the transaction failed on chain — ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      ok(label, `${instructions.length} ix · ${signature}`);
      await sleep(PAUSE_BETWEEN_TXS_MS);
      return signature;
    }
    // Polled slowly on purpose: each poll spends the same per-second request
    // budget as the transactions themselves.
    await sleep(2_000);
  }
  throw new Error(`${label}: ${signature} was not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s`);
}/**
 * Recover the payer's token account from a run that crashed before recording it.
 *
 * A run can create the account and die before `data/pay-live.json` is written —
 * which is exactly what happened on this deployment's first attempt. Without
 * this, the next run would create a *second* account and strand the first one's
 * rent forever, so any token-2022 account of the payer's for this mint is
 * adopted before a new one is created.
 */
async function findPayerTokenAccount(owner: Address): Promise<Address | null> {
  const owned = await retryRead('find a payer token account from an earlier run', () =>
    rpc
      .getTokenAccountsByOwner(
        owner,
        { programId: TOKEN_2022_PROGRAM_ADDRESS },
        { encoding: 'base64' },
      )
      .send(),
  );
  for (const entry of owned.value) {
    const decoded = tokenDecoder.decode(Buffer.from(entry.account.data[0], 'base64'));
    if (decoded.mint === mint) return entry.pubkey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bookkeeping: prior runs, and this script's own state
// ---------------------------------------------------------------------------

/**
 * Destinations `go:live` has already paid into.
 *
 * Kept separate from the pool ledger for the same reason `go:live` keeps its
 * own: the ledger records payments the server *quoted*, and a script that
 * reaches around the quote flow would be stamping reservations it never made.
 */
const GO_LIVE_RUNS_PATH = join(DATA_DIR, `go-live${clusterTag(rpcUrl, options.network)}.json`);
const PAY_LIVE_PATH = join(DATA_DIR, `pay-live${clusterTag(rpcUrl, options.network)}.json`);

interface PayLiveState {
  readonly agent?: {
    readonly address: string;
    /** The payer's token account, created once and reused. */
    readonly tokenAccount?: string;
  };
  readonly runs: {
    readonly destination: string;
    readonly amount: string;
    readonly signature: string;
    readonly payer: string;
    readonly at: string;
  }[];
}

const priorGoLive = await readJSON<{ runs: { destination: string }[] }>(GO_LIVE_RUNS_PATH, {
  runs: [],
});
const state = await readJSON<PayLiveState>(PAY_LIVE_PATH, { runs: [] });
const paid = new Set([
  ...priorGoLive.runs.map((run) => run.destination),
  ...state.runs.map((run) => run.destination),
]);

const AGENT_PATH = join(KEYS_DIR, 'agent.json');

/** Sign the fixed confidential-key derivation message with a raw seed. */
async function signDerivation(seed: Uint8Array): Promise<Uint8Array> {
  const { createPrivateKey, sign } = await import('node:crypto');
  const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(sign(null, Buffer.from(confidentialDerivationMessage()), key));
}

const tokenDecoder = getTokenDecoder();

async function solOf(address: Address): Promise<number> {
  const balance = await retryRead(`read the balance of ${address}`, () =>
    rpc.getBalance(address).send(),
  );
  return Number(balance.value) / 1e9;
}

/** Read a token account and decrypt it locally with the given keys. */
async function readAccount(address: Address, keys: ConfidentialKeys, label: string) {
  const info = await retryRead(`read ${label}`, () =>
    rpc.getAccountInfo(address, { encoding: 'base64' }).send(),
  );
  if (!info.value) throw new Error(`${label} (${address}) does not exist on chain`);
  const decoded = tokenDecoder.decode(Buffer.from(info.value.data[0], 'base64'));
  const decrypted = decryptConfidentialTransferBalance({
    tokenAccount: decoded,
    elgamalSecretKey: keys.elgamal().secret(),
    aesKey: keys.ae(),
  });
  return {
    decoded,
    available: decrypted.availableBalance,
    pending: decrypted.pendingBalance,
    expectedPending: decrypted.expectedPendingBalanceCreditCounter,
    publicBalance: (decoded as { amount: bigint }).amount,
  };
}

// ---------------------------------------------------------------------------
// The facilitator: reach it, or start it
// ---------------------------------------------------------------------------

const facilitatorPort = Number(process.env.VEIL_FACILITATOR_PORT ?? options.port + 1);
// A hosted facilitator replaces the local one: set VEIL_FACILITATOR_URL
// (e.g. https://<app>.vercel.app/facilitator) and this run verifies and settles
// against the public endpoint instead of spawning a child process.
const hostedBase = process.env.VEIL_FACILITATOR_URL?.replace(/\/$/, '');
const facilitatorBase = hostedBase ?? `http://127.0.0.1:${facilitatorPort}`;
let spawned: ChildProcess | null = null;

process.on('exit', () => {
  // The child dies with us: an orphaned facilitator holding the fee-payer key
  // is not something this script should leave behind.
  spawned?.kill('SIGTERM');
});

async function facilitatorReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${facilitatorBase}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function readFeePayer(): Promise<string | null> {
  try {
    const res = await fetch(`${facilitatorBase}/supported`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      kinds?: { scheme?: string; extra?: { feePayer?: unknown } }[];
    };
    const kind = body.kinds?.find((k) => k.scheme === 'exact-confidential');
    return typeof kind?.extra?.feePayer === 'string' ? kind.extra.feePayer : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a facilitator is answering, and return the fee payer it will sign as.
 *
 * A running one is used as-is. Otherwise one is started from this repository's
 * own `scripts/facilitator.ts`, inheriting this process's environment so it
 * points at the same cluster, ledger and key. Its stdout is inherited too: the
 * `verify …` / `settle …` lines it prints are part of this run's evidence.
 */
async function ensureFacilitator(): Promise<string> {
  if (await facilitatorReachable()) {
    const feePayer = await readFeePayer();
    if (feePayer) {
      ok('using the facilitator already running at', facilitatorBase);
      return feePayer;
    }
    throw new Error(
      `something answers ${facilitatorBase}/health but /supported does not name a fee payer`,
    );
  }

  if (hostedBase) {
    // Never silently fall back to a local child when a hosted endpoint was
    // requested: a run that settles against a different facilitator than the
    // operator named would be lying about what it proved.
    throw new Error(`the hosted facilitator at ${facilitatorBase} is not answering /health`);
  }

  const forwarded = process.argv.slice(2).filter((arg) => arg !== '--apply');
  // The child defaults `VEIL_NETWORK` to devnet; when the operator did not set
  // it, the derived network is passed explicitly so the facilitator registers
  // the same network this script's offer will carry.
  if (!forwarded.some((arg) => arg.startsWith('--network')) && !process.env.VEIL_NETWORK) {
    forwarded.push(`--network=${network}`);
  }
  spawned = spawn(process.execPath, ['scripts/facilitator.ts', ...forwarded], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await facilitatorReachable()) break;
    if (spawned.exitCode !== null) {
      throw new Error(`the facilitator exited with code ${spawned.exitCode} before becoming ready`);
    }
    await sleep(500);
  }
  const feePayer = await readFeePayer();
  if (!feePayer) throw new Error(`the facilitator at ${facilitatorBase} never became ready`);
  ok('started the facilitator', `${facilitatorBase} · fee payer ${feePayer}`);
  return feePayer;
}

// ---------------------------------------------------------------------------
// 0 · Preconditions, read from the chain
// ---------------------------------------------------------------------------

step('0', 'Preconditions, read from the chain');

let mintRecord: { mint?: string } = {};
try {
  mintRecord = await readJSON<{ mint?: string }>(MINT_PATH, {});
} catch {
  mintRecord = {};
}

const mint = (
  options.mint !== PLACEHOLDER_MINT ? options.mint : (mintRecord.mint ?? options.mint)
) as Address;

if (options.mint === PLACEHOLDER_MINT) {
  if (!mintRecord.mint) {
    stop(
      'no mint was passed and no mint is recorded',
      `pass --mint=<address>, or run \`npm run setup:devnet\` first (${relative(MINT_PATH)} is absent)`,
    );
    process.exit(1);
  }
  ok('no --mint given; using the recorded one', `${mint} from ${relative(MINT_PATH)}`);
}

const mintInfo = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send();
if (!mintInfo.value) {
  stop('the mint does not exist on this cluster', mint);
  process.exit(1);
}
ok('the mint exists', mint);

/**
 * Walk the mint's TLV extension table for the confidential-transfer extension.
 *
 * The base mint is 82 bytes and the account-type tag occupies byte 165, so the
 * extension header starts at 166. `ConfidentialTransferMint` is extension type
 * 4 — type 10 is `InterestBearingConfig`, and checking for 10 makes a
 * correctly-configured mint look unconfigured.
 */
const mintData = Buffer.from(mintInfo.value.data[0], 'base64');
const extensionTypes: number[] = [];
{
  let cursor = 166;
  while (cursor + 4 <= mintData.length) {
    const type = mintData.readUInt16LE(cursor);
    const length = mintData.readUInt16LE(cursor + 2);
    if (type === 0) break;
    extensionTypes.push(type);
    cursor += 4 + length;
  }
}
const EXT_CONFIDENTIAL_TRANSFER_MINT = 4;
if (!extensionTypes.includes(EXT_CONFIDENTIAL_TRANSFER_MINT)) {
  stop(
    'the mint does not carry the ConfidentialTransferMint extension',
    `extensions seen: ${extensionTypes.join(', ') || 'none'}`,
  );
  process.exit(1);
}
ok('the mint carries the confidential extension', `type 4 among [${extensionTypes.join(', ')}]`);

const rawLedger = await readJSON<unknown[]>(options.ledgerPath, []);
const ledger = PoolLedger.fromJSON(rawLedger);
const poolAccounts = ledger.allFor();
ok(
  'the pool ledger is loaded',
  `${poolAccounts.length} accounts from ${relative(options.ledgerPath)}`,
);

// The seat this run will pay into: armed, not consumed by a settlement, and not
// already paid by either go-live or a previous pay-live run — a reused seat
// would hold a balance, and paying into a non-empty seat is how a "fresh" run
// silently overwrites real money.
const seat = poolAccounts.find((entry) => entry.armed && !entry.consumedBy && !paid.has(entry.address));
if (!seat) {
  stop(
    'no armed merchant seat is left that has not already been paid',
    `add seats with \`npm run setup:devnet -- --apply\`, or clear ${relative(GO_LIVE_RUNS_PATH)} and ${relative(PAY_LIVE_PATH)}`,
  );
  process.exit(1);
}
const destination = seat.address as Address;
const destinationInfo = await rpc.getAccountInfo(destination, { encoding: 'base64' }).send();
if (!destinationInfo.value) {
  stop('the merchant seat is not on chain', destination);
  process.exit(1);
}
ok('an armed merchant seat exists on chain', `${destination} (slot ${seat.slot})`);

const decodedDestination = tokenDecoder.decode(
  Buffer.from(destinationInfo.value.data[0], 'base64'),
);
const destinationExtensions = isSome(decodedDestination.extensions)
  ? decodedDestination.extensions.value
  : [];
const destinationExtension = destinationExtensions.find(
  (entry) => entry.__kind === 'ConfidentialTransferAccount',
);
if (!destinationExtension || destinationExtension.__kind !== 'ConfidentialTransferAccount') {
  stop('the seat has no ConfidentialTransferAccount extension', destination);
  process.exit(1);
}
if (!destinationExtension.allowConfidentialCredits) {
  stop('the seat does not accept confidential credits', destination);
  process.exit(1);
}
ok(
  'the seat accepts confidential credits and refuses plain ones',
  `allowNonConfidentialCredits=${destinationExtension.allowNonConfidentialCredits}`,
);
const destinationApproved = destinationExtension.approved;

// ---------------------------------------------------------------------------
// The two keys that are not the operator's, and the operator itself
// ---------------------------------------------------------------------------

const operatorSeed = decodeSecret(await readFile(join(KEYS_DIR, 'payer.json'), 'utf8'));
if (!operatorSeed) {
  stop(`${relative(join(KEYS_DIR, 'payer.json'))} is not a valid keypair`);
  process.exit(1);
}
const operator = await createKeyPairSignerFromPrivateKeyBytes(operatorSeed);
const operatorSol = await solOf(operator.address);
ok('the operator key loaded', `${operator.address} · ${operatorSol.toFixed(4)} SOL`);

/**
 * The merchant's own keys — the pool's derivation.
 *
 * Every pool account shares the operator's derivation (see `go-live.ts`), which
 * is what lets this script play both roles honestly: the *merchant* side reads
 * the destination with these keys, and the *payer* side below has entirely
 * different ones. The amount is legible only to the first.
 */
const merchantKeys: ConfidentialKeys = await confidentialKeysFrom(() =>
  signDerivation(operatorSeed),
);

/**
 * The payer: its own keypair, generated here on first run.
 *
 * Not the operator's key, not derived from it, not funded from its balance
 * beyond the faucet transfer below. If this file is deleted the payer is a
 * stranger again — which is the point.
 */
let payerSeed: Uint8Array | null = null;
try {
  payerSeed = decodeSecret(await readFile(AGENT_PATH, 'utf8'));
} catch {
  payerSeed = null;
}
if (!payerSeed && !apply) {
  note('no payer key yet', `${relative(AGENT_PATH)} will be created by --apply`);
} else if (!payerSeed) {
  payerSeed = new Uint8Array(randomBytes(32));
  await writeFile(AGENT_PATH, `${JSON.stringify([...payerSeed])}\n`, { mode: 0o600 });
  ok('created a fresh payer keypair', relative(AGENT_PATH));
}

/**
 * Declared `const` deliberately: the guard below narrows these two to their
 * non-null types, and a narrowing on a `const` survives into the closures
 * defined after it — where a `let` would revert to `KeyPairSigner | null` and
 * every helper would need its own assertion.
 */
const payer: KeyPairSigner | null = payerSeed
  ? await createKeyPairSignerFromPrivateKeyBytes(payerSeed)
  : null;
const payerKeys: ConfidentialKeys | null = payerSeed
  ? await confidentialKeysFrom(() => signDerivation(payerSeed!))
  : null;
if (payer) {
  const payerSol = await solOf(payer.address);
  ok('the payer key loaded', `${payer.address} · ${payerSol.toFixed(4)} SOL`);
}

// The payer's token account, from a previous run if it exists.
const tokenAccount = state.agent?.tokenAccount
  ? (state.agent.tokenAccount as Address)
  : null;

// ---------------------------------------------------------------------------
// The facilitator, and what this run would cost
// ---------------------------------------------------------------------------

step('0b', 'The facilitator');

let feePayerAddress: Address | null = null;
if (apply) {
  feePayerAddress = (await ensureFacilitator()) as Address;
} else if (await facilitatorReachable()) {
  feePayerAddress = (await readFeePayer()) as Address | null;
  if (feePayerAddress) {
    ok('the facilitator is running', `${facilitatorBase} · fee payer ${feePayerAddress}`);
  } else {
    note('something answers the port but /supported names no fee payer', facilitatorBase);
  }
} else {
  note(
    'the facilitator is not running now',
    `--apply starts it automatically, or run \`npm run facilitator\` first`,
  );
}

// Decrypt the destination here, before anything is spent: if the operator's
// keys cannot read the merchant's balance to zero, the seat is not fresh and
// this run would be paying into a stranger's money.
let destinationFresh = false;
try {
  const destState = await readAccount(destination, merchantKeys, 'the merchant seat');
  destinationFresh = destState.available === 0n && destState.pending === 0n;
  ok(
    'the seat decrypts locally',
    `available ${destState.available}, pending ${destState.pending}`,
  );
  if (!destinationFresh) {
    stop('the seat is not empty', 'this run assumes a fresh destination');
  }
} catch (error) {
  stop('the seat does not decrypt with the merchant key', (error as Error).message);
}

const deployerSpendStart = operatorSol;
let payerSpendStart = 0;
if (payer) payerSpendStart = await solOf(payer.address);

if (!apply) {
  const plan = [
    !payerSeed ? `1. create the payer keypair ${relative(AGENT_PATH)}` : null,
    payerSeed && payerSpendStart >= FLOAT_FLOOR_SOL
      ? '2. the payer already holds its rent float'
      : `2. send the payer its rent float — ${FLOAT_SOL} SOL from the operator (returned after every payment)`,
    !tokenAccount
      ? '3. create + configure the payer token account (operator pays the rent, once)'
      : '3. the payer token account already exists',
    '4. top the payer confidential balance up to the ticket size (mint → deposit → apply)',
    destinationApproved ? null : '5. approve the merchant seat for confidential transfers',
    '6. the payer generates its three proofs locally and verifies them into',
    '   context-state accounts on chain (the payer pays this rent — reclaimed in 9)',
    '7. build the transfer, partially sign it (payer authority only), then POST',
    `   /verify and /settle at ${facilitatorBase} — the facilitator co-signs the fee`,
    '8. the merchant decrypts its own balance, applies the pending credit, and',
    '   reports what actually arrived',
    '9. the payer closes the context accounts; the rent float comes home',
  ].filter((line): line is string => line !== null);

  process.stdout.write(
    [
      '',
      '  Read-only pass. Nothing was broadcast.',
      '',
      `  Would pay ${AMOUNT} atomic units of ${mint} from an independent payer`,
      `  into merchant seat ${destination} (slot ${seat.slot}).`,
      '',
      '  What --apply would do:',
      ...plan.map((line) => `    ${line}`),
      '',
      '  Every precondition above was read from the chain, not assumed.',
      '  Re-run with --apply to broadcast.',
      '',
    ].join('\n'),
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (failed > 0 || !destinationFresh || !payer || !payerKeys || !feePayerAddress) {
  process.exit(1);
}

const feePayer = feePayerAddress;

/**
 * Aliases with the *narrowed* types.
 *
 * The guard above proved the payer is non-null, and at this scope TypeScript
 * knows it — but a function declaration re-reads the declared union type, not
 * the flow state at its birth. Binding once here gives the helpers below types
 * that need no assertions at every use site.
 */
const payerSigner: KeyPairSigner = payer;

// ---------------------------------------------------------------------------
// Scaffolding state, so a failed run can give the rent back
// ---------------------------------------------------------------------------

/** Context accounts staged this run — pushed *before* their verification, so a
 * verification that fails after creating the account is still reclaimed below
 * rather than stranding its rent in an address only this process ever knew. */
let openContexts: Address[] = [];
let recordAccount: Awaited<ReturnType<typeof generateKeyPairSigner>> | null = null;
/** The payer's token account once resolved — what the run record persists. */
let resolvedTokenAccount: Address | null = null;

/**
 * Return every rent-exempt lamport this run staged, on any exit path.
 *
 * The addresses exist only in this process — if they are not closed here, the
 * rent is gone. This runs on failure and on success; on failure it is the
 * difference between a cheap mistake and a stranded float.
 */
async function reclaimScaffolding(): Promise<void> {
  const closable = [...openContexts];
  openContexts = [];
  // One close per account, not one combined transaction: an address whose
  // creation never landed would make a combined close fail as a whole and
  // strand every other account's rent with it.
  for (const contextState of closable) {
    try {
      await send(
        `reclaimed the context account ${contextState}`,
        [
          closeContextStateProof({
            contextState,
            authority: payer!,
            destination: payer!.address,
          }),
        ],
        payer!,
      );
    } catch (error) {
      note(`could not close ${contextState}`, (error as Error).message);
    }
  }
  if (recordAccount) {
    try {
      await send(
        'reclaimed the record account',
        [
          getCloseRecordAccountInstruction({
            recordAccount: recordAccount.address,
            authority: payer!,
            receiver: payer!.address,
          }),
        ],
        payer!,
      );
    } catch (error) {
      note('could not close the record account', (error as Error).message);
    }
    recordAccount = null;
  }
}

let paymentSignature: string | null = null;
let sourceBeforeAvailable: bigint | null = null;

try {
  // -------------------------------------------------------------------------
  // 1 · The faucet: float, token account, balance
  // -------------------------------------------------------------------------

  step('1', 'The faucet — fund the payer once, then it can pay forever');

  const payerSol = await solOf(payer.address);
  if (payerSol < FLOAT_FLOOR_SOL) {
    const lamports = BigInt(Math.round((FLOAT_SOL - payerSol) * 1e9));
    await send(
      `sent the payer its rent float (${(Number(lamports) / 1e9).toFixed(4)} SOL)`,
      [
        getTransferSolInstruction({
          source: operator,
          destination: payer.address,
          amount: lamports,
        }),
      ],
      operator,
    );
  } else {
    ok('the payer already holds its rent float', `${payerSol.toFixed(4)} SOL`);
  }

  // The payer's token account. The keypair matters only at creation; from then
  // on every operation is authorised by the payer's own address, which is why
  // only the address is persisted.
  let tokenAddress: Address | null = tokenAccount;
  if (tokenAddress) {
    const held = tokenAddress;
    const info = await retryRead('read the payer token account', () =>
      rpc.getAccountInfo(held, { encoding: 'base64' }).send(),
    );
    if (info.value === null) tokenAddress = null;
  }
  if (!tokenAddress) {
    tokenAddress = await findPayerTokenAccount(payer.address);
    if (tokenAddress) {
      ok('adopted the token account an earlier run left behind', tokenAddress);
    }
  }
  if (!tokenAddress) {
    const tokenSigner = await generateKeyPairSigner();
    tokenAddress = tokenSigner.address;
    const rent = await retryRead('read the payer account rent', () =>
      rpc.getMinimumBalanceForRentExemption(BigInt(confidentialAccountSpace())).send(),
    );
    await send(
      'created + configured the payer token account, with a local pubkey proof',
      [
        ...buildCreatePaymentAccount({
          payer: operator,
          account: tokenSigner,
          mint,
          owner: payer.address,
          lamports: rent,
        }),
        buildPubkeyValidityProof(payerKeys),
        buildConfigureAccount({
          token: tokenAddress,
          mint,
          authority: payer,
          proofInstructionOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
          maximumPendingBalanceCreditCounter: MAX_PENDING_CREDIT_COUNTER,
          decryptableZeroBalance: encryptBalance(payerKeys, 0n),
        }),
        getEnableConfidentialCreditsInstruction({ token: tokenAddress, authority: payer }),
        // `autoApproveNewAccounts` is off on this mint: the authority that minted
        // it vouches for the account, or Deposit fails with a bare `0x18`.
        getApproveConfidentialTransferAccountInstruction({
          token: tokenAddress,
          mint,
          authority: operator,
        }),
      ],
      operator,
    );
    ok('the payer token account is ready', tokenAddress);
  } else {
    ok('the payer token account already exists', tokenAddress);
  }
  const token: Address = tokenAddress;
  resolvedTokenAccount = token;

  // Top the confidential balance up to the ticket size — only as far as needed.
  let state0 = await readAccount(token, payerKeys, 'the payer token account');
  if (state0.pending > 0n) {
    // A deposit credits *pending*, and pending is not spendable until the owner
    // applies it. A crashed earlier run can leave exactly this state.
    await send(
      'applied the pending balance from an earlier run',
      [
        buildApplyPendingBalance({
          token,
          authority: payer,
          expectedPendingBalanceCreditCounter: state0.expectedPending,
          newDecryptableAvailableBalance: encryptBalance(
            payerKeys,
            state0.available + state0.pending,
          ),
        }),
      ],
      payer,
    );
    state0 = await readAccount(token, payerKeys, 'the payer token account');
  }
  if (state0.available < AMOUNT) {
    const need = AMOUNT - state0.available;
    const toMint = need > state0.publicBalance ? need - state0.publicBalance : 0n;
    if (toMint > 0n) {
      await send(
        `minted ${toMint} tokens to the payer (operator as faucet)`,
        [
          getMintToInstruction({
            mint,
            token,
            mintAuthority: operator,
            amount: toMint,
          }),
        ],
        operator,
      );
    }
    const toDeposit = state0.publicBalance + toMint;
    if (toDeposit > 0n) {
      await send(
        'deposited them into the confidential balance',
        [
          getConfidentialDepositInstruction({
            token,
            mint,
            authority: payer,
            amount: toDeposit,
            decimals: options.decimals,
          }),
        ],
        payer,
      );
    }
    const afterDeposit = await readAccount(token, payerKeys, 'the payer token account');
    await send(
      'applied the deposit to the available balance',
      [
        buildApplyPendingBalance({
          token,
          authority: payer,
          expectedPendingBalanceCreditCounter: afterDeposit.expectedPending,
          newDecryptableAvailableBalance: encryptBalance(
            payerKeys,
            afterDeposit.available + afterDeposit.pending,
          ),
        }),
      ],
      payer,
    );
    state0 = await readAccount(token, payerKeys, 'the payer token account');
  }
  if (state0.available < AMOUNT) {
    throw new Error(
      `the payer holds ${state0.available} available, less than the ${AMOUNT} to pay`,
    );
  }
  ok(
    'the payer can pay',
    `available ${state0.available}, pending ${state0.pending}, public ${state0.publicBalance}`,
  );

  if (!destinationApproved) {
    await send(
      'approved the merchant seat for confidential transfers',
      [
        getApproveConfidentialTransferAccountInstruction({
          token: destination,
          mint,
          authority: operator,
        }),
      ],
      operator,
    );
  }

  // -------------------------------------------------------------------------
  // 2 · The payer proves — locally, then on chain
  // -------------------------------------------------------------------------

  step('2', "The payer's proofs: generated in this process, verified on chain");

  const source = await readAccount(token, payerKeys, 'the payer token account');
  sourceBeforeAvailable = source.available;
  ok('the source balance was decrypted locally', `available ${source.available}`);
  if (source.available < AMOUNT) {
    throw new Error(`the source holds ${source.available}, less than ${AMOUNT}`);
  }

  const destinationPubkey = ElGamalPubkey.fromBytes(
    new Uint8Array(getBase58Encoder().encode(destinationExtension.elgamalPubkey)),
  );
  ok('the destination ElGamal key decoded from live state', destinationExtension.elgamalPubkey);

  const sourceExtensionRaw = (() => {
    const extensions = isSome(source.decoded.extensions) ? source.decoded.extensions.value : [];
    return extensions.find((entry) => entry.__kind === 'ConfidentialTransferAccount');
  })();
  if (!sourceExtensionRaw || sourceExtensionRaw.__kind !== 'ConfidentialTransferAccount') {
    throw new Error('the payer account lost its confidential extension');
  }
  const balanceCiphertext = new Uint8Array(sourceExtensionRaw.availableBalance);
  const parsedBalance = ElGamalCiphertext.fromBytes(balanceCiphertext);
  if (!parsedBalance) {
    throw new Error(`the available balance is not a valid ciphertext (${balanceCiphertext.length}B)`);
  }

  const proofs = buildTransferProofs({
    keys: payerKeys,
    sourceAvailableBalance: source.available,
    sourceAvailableBalanceCiphertext: parsedBalance,
    amount: AMOUNT,
    destinationPubkey,
  });
  const bytes = proofs.proofBytes;
  ok(
    'three proofs generated locally',
    `${bytes.equality.length} + ${bytes.ciphertextValidity.length} + ${bytes.range.length} = ` +
      `${bytes.equality.length + bytes.ciphertextValidity.length + bytes.range.length} B`,
  );

  /**
   * Verify one proof into a context-state account.
   *
   * The SDK's verify action reads the account's rent before it can build the
   * instructions — a read the public RPC's rate limiter hits first, so only the
   * build is retried. The send is not: re-running it after an ambiguous failure
   * would try to create the same account twice.
   */
  async function verifyIntoContext(
    label: string,
    verify: typeof verifyBatchedRangeProofU128,
    contextAccount: Awaited<ReturnType<typeof generateKeyPairSigner>>,
    proofData: Parameters<typeof verifyBatchedRangeProofU128>[0]['proofData'],
  ): Promise<void> {
    const instructions = await retryRead(`build the verification for ${label}`, () =>
      verify({
        rpc,
        payer: payerSigner,
        proofData,
        contextState: { contextAccount, authority: payerSigner.address },
      }),
    );
    await send(label, instructions, payerSigner);
  }

  const contexts = {
    equality: await generateKeyPairSigner(),
    ciphertextValidity: await generateKeyPairSigner(),
    range: await generateKeyPairSigner(),
  };

  openContexts.push(contexts.equality.address);
  await verifyIntoContext(
    'verified the equality proof into a context account',
    verifyCiphertextCommitmentEquality,
    contexts.equality,
    bytes.equality,
  );

  openContexts.push(contexts.ciphertextValidity.address);
  await verifyIntoContext(
    'verified the ciphertext-validity proof into a context account',
    verifyBatchedGroupedCiphertext3HandlesValidity,
    contexts.ciphertextValidity,
    bytes.ciphertextValidity,
  );

  /**
   * The range proof travels through a record account.
   *
   * It is ~1001 bytes: even alone it cannot be embedded in a transaction of its
   * own (1816 bytes against the 1232-byte ceiling), so the bytes are written
   * into an account of their own — a chunk per transaction — and the
   * verification instruction names that account instead. Account data does not
   * count against a transaction's size; only the 32-byte address does.
   */
  recordAccount = await generateKeyPairSigner();
  const recordSize = getRecordSize(bytes.range.length);
  const recordRent = await retryRead('read the record account rent', () =>
    rpc.getMinimumBalanceForRentExemption(recordSize).send(),
  );
  await send(
    `created a ${recordSize}B record account for the range proof`,
    [
      getCreateAccountInstruction({
        payer,
        newAccount: recordAccount,
        lamports: recordRent,
        space: recordSize,
        programAddress: RECORD_PROGRAM_ADDRESS,
      }),
      getInitializeRecordInstruction({ recordAccount: recordAccount.address, authority: payer }),
    ],
    payer,
  );
  for (
    let offset = 0;
    offset < bytes.range.length;
    offset += RECORD_CHUNK_SIZE_POST_INITIALIZE
  ) {
    const chunk = bytes.range.slice(offset, offset + RECORD_CHUNK_SIZE_POST_INITIALIZE);
    await send(
      `wrote range-proof bytes ${offset}..${offset + chunk.length}`,
      [
        getWriteInstruction({
          recordAccount: recordAccount.address,
          authority: payer,
          offset,
          data: chunk,
        }),
      ],
      payer,
    );
  }

  openContexts.push(contexts.range.address);
  await verifyIntoContext(
    'verified the range proof, reading it from the record',
    verifyBatchedRangeProofU128,
    contexts.range,
    // The offset is the record's 33-byte header (`RECORD_META_DATA_SIZE`), not
    // 0: `Write` offsets are payload-relative, this read is account-relative,
    // and reading at 0 fails with `proof verification failed: ProofContext` —
    // which names neither the offset nor the record.
    { account: recordAccount.address, offset: Number(RECORD_META_DATA_SIZE) },
  );

  // The record is scaffolding the transfer never refers to; close it now, as
  // `go:live` does, so only the three context accounts remain open.
  await send(
    'closed the record account',
    [
      getCloseRecordAccountInstruction({
        recordAccount: recordAccount.address,
        authority: payer,
        receiver: payer.address,
      }),
    ],
    payer,
  );
  recordAccount = null;

  // -------------------------------------------------------------------------
  // 3 · The payment: /verify, then /settle, through the facilitator
  // -------------------------------------------------------------------------

  step('3', 'Pay through the facilitator — x402 /verify then /settle');

  const { value: lifetime } = await retryRead('read a recent blockhash', () =>
    rpc.getLatestBlockhash().send(),
  );
  const instructions = buildConfidentialTransfer({
    sourceToken: token,
    mint,
    destinationToken: destination,
    authority: payer,
    newSourceDecryptableAvailableBalance: proofs.newSourceDecryptableAvailableBalance,
    transferAmountAuditorCiphertextLo: proofs.auditorCiphertextLo,
    transferAmountAuditorCiphertextHi: proofs.auditorCiphertextHi,
    proofRecords: {
      equality: contexts.equality.address,
      ciphertextValidity: contexts.ciphertextValidity.address,
      range: contexts.range.address,
    },
  });

  /**
   * The payment transaction: the payer's authority, the facilitator's fee.
   *
   * The fee payer is a plain address the facilitator will fill in at settle —
   * so this transaction is signed *partially*, which is the whole asymmetry of
   * a facilitator expressed in one function call. `signTransaction…` would
   * refuse to leave a transaction unsigned; `partiallySign…` is the API that
   * means "sign my half and leave the rest for whoever holds that key".
   */
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  const signatureSlots = signed.signatures as Record<string, Uint8Array | null>;
  if (!signatureSlots[payer.address]) {
    throw new Error('the payer half of the signature is missing');
  }
  if (signatureSlots[feePayer]) {
    throw new Error('the fee payer slot is filled — it must be left for the facilitator');
  }
  if (Object.keys(signatureSlots).length !== 2) {
    throw new Error(
      `expected exactly two signature slots (fee payer + authority), got ${Object.keys(signatureSlots).length}`,
    );
  }
  const wire = getBase64EncodedWireTransaction(signed);
  ok(
    'the payment transaction is signed by the payer only',
    `wire ${Buffer.from(wire, 'base64').length} B · fee payer ${feePayer} signs later`,
  );

  const offer = buildPaymentRequired({
    network,
    asset: mint,
    payTo: destination,
    amount: AMOUNT,
    decimals: options.decimals,
    resource: '/v1/price/SOL',
    description: 'SOL spot price',
    poolIndex: seat.slot,
  }).accepts[0]!;

  const payload = buildPaymentPayload({ accept: offer, transaction: wire, payTo: destination });
  const body = {
    x402Version: payload.x402Version,
    paymentPayload: payload,
    paymentRequirements: {
      scheme: offer.scheme,
      network: offer.network,
      asset: offer.asset,
      amount: offer.amount,
      payTo: offer.payTo,
      maxTimeoutSeconds: offer.maxTimeoutSeconds,
      extra: offer.extra,
    },
  };

  async function post(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${facilitatorBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const verify = await post('/verify');
  if (verify.status !== 200 || verify.body.isValid !== true) {
    throw new Error(
      `the facilitator refused the payment: http ${verify.status} ` +
        `${verify.body.invalidReason ?? verify.body.error ?? 'unknown'} — ` +
        `${String(verify.body.invalidMessage ?? '').slice(0, 300)}`,
    );
  }
  ok('the facilitator verified the payment', `payer ${verify.body.payer ?? '(unreported)'}`);

  const settle = await post('/settle');
  if (settle.status !== 200 || settle.body.success !== true) {
    throw new Error(
      `the facilitator could not settle: ${settle.body.errorReason ?? settle.status} — ` +
        `${String(settle.body.errorMessage ?? '').slice(0, 300)}`,
    );
  }
  paymentSignature = String(settle.body.transaction);
  ok('the facilitator settled the payment', paymentSignature);

  // -------------------------------------------------------------------------
  // 4 · The merchant reads its own balance
  // -------------------------------------------------------------------------

  step('4', 'The merchant decrypts what arrived — with the merchant key only');

  const credited = await readAccount(destination, merchantKeys, 'the merchant seat');
  ok(
    'the destination received a pending credit',
    `pending ${credited.pending}, available ${credited.available}`,
  );
  if (credited.pending !== AMOUNT) {
    throw new Error(`the merchant sees ${credited.pending} pending, expected ${AMOUNT}`);
  }
  const newAvailable = credited.available + credited.pending;
  await send(
    'applied the pending balance (the merchant acknowledging the payment)',
    [
      buildApplyPendingBalance({
        token: destination,
        authority: operator,
        expectedPendingBalanceCreditCounter: credited.expectedPending,
        newDecryptableAvailableBalance: encryptBalance(merchantKeys, newAvailable),
      }),
    ],
    operator,
  );
  const settledDest = await readAccount(destination, merchantKeys, 'the merchant seat');
  if (settledDest.available !== newAvailable || settledDest.pending !== 0n) {
    throw new Error(
      `the merchant seat did not settle: available ${settledDest.available}, pending ${settledDest.pending}`,
    );
  }
  ok('the merchant seat settled', `available ${settledDest.available}, pending ${settledDest.pending}`);

  const payerAfter = await readAccount(token, payerKeys, 'the payer token account');
  if (payerAfter.available !== sourceBeforeAvailable - AMOUNT) {
    throw new Error(
      `the payer balance is ${payerAfter.available}, expected ${sourceBeforeAvailable - AMOUNT}`,
    );
  }
  ok(
    'the payer balance went down by exactly the amount',
    `${sourceBeforeAvailable} − ${AMOUNT} = ${payerAfter.available}`,
  );

  // -------------------------------------------------------------------------
  // 5 · Reclaim the scaffolding — the float comes home
  // -------------------------------------------------------------------------

  step('5', 'Close the context accounts; the rent returns to the payer');
  await reclaimScaffolding();
} catch (error) {
  stop('the run failed', (error as Error).message);
  await reclaimScaffolding();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const operatorEnd = await solOf(operator.address);
const payerEnd = payer ? await solOf(payer.address) : 0;

// The explorer wants a cluster *name*; the offer carries a CAIP-2 id (which
// for this project is the genesis hash). The endpoint the run actually used
// is the least ambiguous way to recover it.
const explorerCluster = /devnet|testnet|mainnet/.test(rpcUrl)
  ? rpcUrl.includes('devnet')
    ? 'devnet'
    : rpcUrl.includes('testnet')
      ? 'testnet'
      : 'mainnet-beta'
  : options.network.includes('devnet')
    ? 'devnet'
    : options.network.includes('testnet')
      ? 'testnet'
      : 'mainnet-beta';

if (paymentSignature && failed === 0 && payer) {
  await saveJSON(PAY_LIVE_PATH, {
    agent: {
      address: String(payer.address),
      tokenAccount: String(resolvedTokenAccount ?? state.agent?.tokenAccount ?? ''),
    },
    runs: [
        ...state.runs,
        {
          destination: String(destination),
          amount: String(AMOUNT),
          signature: paymentSignature,
        payer: String(payer.address),
        at: new Date().toISOString(),
      },
    ],
  } satisfies PayLiveState);
  ok('the run was recorded', relative(PAY_LIVE_PATH));
}

process.stdout.write(
  [
    '',
    'Veil — an independent payer, through the x402 facilitator',
    '',
    table([
      ['network', network],
      ['rpc', rpcUrl],
      ['facilitator', `${facilitatorBase} · fee payer ${feePayerAddress ?? 'n/a'}`],
      ['operator', `${operator.address} · ${deployerSpendStart.toFixed(4)} → ${operatorEnd.toFixed(4)} SOL`],
      ['payer', `${payer?.address ?? 'n/a'} · ${payerSpendStart.toFixed(4)} → ${payerEnd.toFixed(4)} SOL`],
      ['merchant seat', `${destination} (slot ${seat.slot})`],
      ['amount', paymentSignature ? `${AMOUNT} atomic units, never in the clear` : '—'],
      ['payment', paymentSignature ?? 'not settled'],
      ['landed', failed === 0 ? `${AMOUNT} available, decrypted with the merchant key` : '—'],
    ]),
    '',
    failed === 0
      ? [
          'The payer signed the transfer. The facilitator paid the fee.',
          'The merchant alone could read the amount. The operator minted the',
          'funds once — the faucet, not the rail.',
          '',
          `Look it up: https://explorer.solana.com/tx/${paymentSignature}?cluster=${explorerCluster}`,
          '',
        ].join('\n')
      : `${failed} check(s) failed; staged rent was reclaimed where possible.`,
    '',
  ].join('\n'),
);

process.exit(failed === 0 ? 0 : 1);
