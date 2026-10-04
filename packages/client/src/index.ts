/**
 * The Veil payer — the client half of the protocol.
 *
 * Veil's server side is a normal x402 resource server: ask, get a `402` with a
 * price and a one-time account, pay that account with a confidential transfer,
 * retry with `X-PAYMENT`. This package is the other end of that exchange, and it
 * exists so a client is not a shell script somebody has to reverse-engineer:
 *
 *   1. ask the resource, keep the offer (`GET` with `X-Payer`)
 *   2. generate the three proofs Token-2022 needs for a confidential transfer
 *      and verify them into context accounts, on chain, paid by the payer
 *   3. build the transfer and sign **only** the payer's half — the fee payer is
 *      the facilitator's, and leaving that slot empty is what lets the payer
 *      hold no SOL
 *   4. retry the same URL with the payload in `X-PAYMENT`
 *
 * Nothing here is Node-specific: the same module runs in a browser (see
 * `web/prove/veil-client.ts`, which bundles it with `@solana/zk-sdk` aliased to
 * its web build). The platform split is *where the signature comes from* — a
 * local keypair here, a wallet adapter there.
 */

import {
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getUtf8Encoder,
  isSome,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';

type SolanaRpc = ReturnType<typeof createSolanaRpc>;
import {
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
import { getCreateAccountInstruction as getCreateRecordAccountInstruction } from '@solana-program/system';
import {
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
} from '@solana-program/zk-elgamal-proof';
import { ConfidentialKeys, ElGamalCiphertext, ElGamalPubkey } from '@solana/zk-sdk';

import {
  buildApplyPendingBalance,
  buildConfidentialTransfer,
} from '../../onchain/src/index.ts';
import { buildTransferProofs, encryptBalance } from '../../onchain/src/proofs.ts';
import {
  buildPaymentPayload,
  toAtomic,
  VEIL_SCHEME,
  type VeilPaymentRequired,
} from '../../x402-core/src/index.ts';
import { VeilError, type VeilCode } from './errors.ts';

export { VeilError, isVeilError } from './errors.ts';
export type { VeilErrorEnvelope, VeilErrorType, VeilCode } from './errors.ts';

// In `@solana/kit` an `Encoder` takes the printable form and returns bytes;
// a `Decoder` takes bytes and returns the printable form.
const base64ToBytes = getBase64Encoder();
const bytesToBase64 = getBase64Decoder();
const utf8ToBytes = getUtf8Encoder();
const base58ToBytes = getBase58Encoder();
const tokenDecoder = getTokenDecoder();

export interface Step {
  readonly label: string;
  readonly detail: string;
}

export interface VeilBalance {
  readonly available: bigint;
  readonly pending: bigint;
  readonly expectedPending: bigint;
  readonly publicBalance: bigint;
}

/** A decoded token account plus the confidential extras this client needs. */
export interface VeilTokenAccount extends VeilBalance {
  readonly decoded: unknown;
  /** The `available_balance` ciphertext, still encrypted. */
  readonly balanceCiphertext: Uint8Array;
}

function rpcFor(url: string): SolanaRpc {
  return createSolanaRpc(url) as SolanaRpc;
}

interface ConfidentialExtension {
  readonly __kind: string;
  readonly availableBalance?: Uint8Array;
  readonly elgamalPubkey?: string;
  readonly allowConfidentialCredits?: boolean;
}

function confidentialExtension(decoded: unknown): ConfidentialExtension | undefined {
  const extensions = (decoded as { extensions?: { value?: readonly ConfidentialExtension[] } })
    .extensions;
  const list = extensions?.value ?? [];
  return list.find((entry) => entry.__kind === 'ConfidentialTransferAccount');
}

/** Read an account and decrypt its balances with the caller's own keys. */
export async function readTokenAccount(
  rpc: SolanaRpc,
  token: Address,
  keys: ConfidentialKeys,
): Promise<VeilTokenAccount> {
  const info = await rpc.getAccountInfo(token, { encoding: 'base64' }).send();
  if (!info.value) throw new Error(`${token} is not on chain`);
  const decoded = tokenDecoder.decode(base64ToBytes.encode(info.value.data[0]));
  const decrypted = decryptConfidentialTransferBalance({
    tokenAccount: decoded as never,
    elgamalSecretKey: keys.elgamal().secret(),
    aesKey: keys.ae(),
  });
  const extension = confidentialExtension(decoded);
  return {
    decoded,
    available: decrypted.availableBalance,
    pending: decrypted.pendingBalance,
    expectedPending: decrypted.expectedPendingBalanceCreditCounter,
    publicBalance: (decoded as { amount: bigint }).amount,
    balanceCiphertext: new Uint8Array(extension?.availableBalance ?? new Uint8Array(0)),
  };
}

/** The payer's own Token-2022 account for a mint, or null. */
export async function findTokenAccount(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
): Promise<Address | null> {
  const owned = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_2022_PROGRAM_ADDRESS },
      { encoding: 'base64' },
    )
    .send();
  for (const entry of owned.value) {
    const decoded = tokenDecoder.decode(base64ToBytes.encode(entry.account.data[0]));
    if (decoded.mint === mint) return entry.pubkey;
  }
  return null;
}

/** Move a pending credit into the spendable balance. */
export async function applyPending(
  rpc: SolanaRpc,
  token: Address,
  owner: KeyPairSigner,
  keys: ConfidentialKeys,
): Promise<string> {
  const state = await readTokenAccount(rpc, token, keys);
  if (state.pending === 0n) throw new Error('there is no pending balance to apply');
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(owner.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    (tx) =>
      appendTransactionMessageInstruction(
        buildApplyPendingBalance({
          token,
          authority: owner,
          expectedPendingBalanceCreditCounter: state.expectedPending,
          newDecryptableAvailableBalance: encryptBalance(keys, state.available + state.pending),
        }),
        tx,
      ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' })
    .send();
  return signature;
}

/**
 * Send a transaction the payer signs fully — used only for the proof setup,
 * which is the payer's own work on the payer's own fee budget. The payment
 * itself is partially signed; see `payVeilResource`.
 */
async function sendOwn(
  rpc: SolanaRpc,
  instructions: readonly Instruction[],
  payer: KeyPairSigner,
): Promise<string> {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(payer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' })
    .send();
  return signature;
}

/** The facilitator's fee payer, read from `/supported` — the x402 way. */
export async function feePayerOf(
  rail: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${rail.replace(/\/$/, '')}/supported`);
  if (!res.ok) throw new Error(`GET /supported → ${res.status}`);
  const body = (await res.json()) as { kinds?: readonly { extra?: { feePayer?: string } }[] };
  const feePayer = body.kinds?.[0]?.extra?.feePayer;
  if (!feePayer) throw new Error('/supported named no fee payer');
  return feePayer;
}

export interface PayVeilInput {
  /** The rail's origin, e.g. `https://veil-devnet.vercel.app`. */
  readonly rail: string;
  readonly resource: string;
  /** One payment identity. Reusing it after settlement is a `409`, by design. */
  readonly nonce: number;
  /** `X-Payer`: the buyer's name, so a retry gets its own seat back. */
  readonly payer: string;
  readonly rpcUrl: string;
  /** Signs the proofs' transactions and the payment; pays the setup's fees. */
  readonly payerSigner: KeyPairSigner;
  readonly keys: ConfidentialKeys;
  /** The fee payer to leave unsigned — from `feePayerOf`. */
  readonly feePayer: string;
  readonly decimals: number;
  readonly url?: string;
  readonly onStep?: (step: Step) => void;
  readonly fetchImpl?: typeof fetch;
  /** Extra wait between the payer's transactions, for public RPC limits. */
  readonly pauseMs?: number;
}

export interface PayVeilResult {
  readonly status: number;
  readonly body: unknown;
  /** Present once the rail settled and broadcast. */
  readonly signature: string | null;
  readonly amount: string;
  readonly payTo: string;
  /** Every transaction this call caused, in order, including the payer's own. */
  readonly transactions: readonly string[];
}

/**
 * Pay for one Veil resource and return what the rail said.
 *
 * Deliberately not retried and not idempotent-looking: a payment's identity is
 * `(resource, payer, nonce)`, and re-running the same nonce after a settle is
 * how the `409` is produced. A caller wanting a second payment passes a second
 * nonce.
 */
export async function payVeilResource(input: PayVeilInput): Promise<PayVeilResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const rpc = rpcFor(input.rpcUrl);
  const pauseMs = input.pauseMs ?? 1200;
  const base = input.rail.replace(/\/$/, '');
  const url = input.url ?? `${base}${input.resource}?nonce=${input.nonce}`;
  const step = input.onStep ?? (() => {});
  const transactions: string[] = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, pauseMs));

  const offerRes = await fetchImpl(url, { headers: { 'X-Payer': input.payer } });
  const offer = (await offerRes.json()) as VeilPaymentRequired;
  if (offerRes.status !== 402) {
    throw new Error(
      `expected a 402 offer, got ${offerRes.status}: ${JSON.stringify(offer).slice(0, 300)}`,
    );
  }
  const accept = offer.accepts[0];
  if (!accept) throw new Error('the 402 body carried no accepts[] entry');
  if (accept.scheme !== VEIL_SCHEME) {
    throw new Error(`the offer's scheme is ${accept.scheme}, not ${VEIL_SCHEME}`);
  }
  step({ label: 'asked the rail, got a price', detail: `${accept.amount} atomic → ${accept.payTo}` });

  const amount = BigInt(accept.amount);
  const mint = accept.asset as Address;
  const destination = accept.payTo as Address;

  const sourceToken = await findTokenAccount(rpc, input.payerSigner.address, mint);
  if (!sourceToken) throw new Error(`no ${mint} token account for ${input.payerSigner.address}`);
  const source = await readTokenAccount(rpc, sourceToken, input.keys);
  step({ label: 'read the payer balance locally', detail: `${source.available} available` });
  if (source.available < amount) {
    throw new Error(`the payer holds ${source.available}, less than the ${amount} to pay`);
  }

  const destinationInfo = await rpc.getAccountInfo(destination, { encoding: 'base64' }).send();
  if (!destinationInfo.value) throw new Error(`the offer's account ${destination} is not on chain`);
  const decodedDestination = tokenDecoder.decode(
    base64ToBytes.encode(destinationInfo.value.data[0]),
  );
  const destinationExtension = confidentialExtension(decodedDestination);
  if (!destinationExtension?.elgamalPubkey) {
    throw new Error('the account the offer names is not configured for confidential transfers');
  }
  const destinationPubkey = ElGamalPubkey.fromBytes(
    new Uint8Array(base58ToBytes.encode(destinationExtension.elgamalPubkey)),
  );
  step({ label: 'the destination is armed and confidential', detail: destination });

  const parsedBalance = ElGamalCiphertext.fromBytes(source.balanceCiphertext);
  if (!parsedBalance) throw new Error('the available balance is not a valid ciphertext');

  const proofs = buildTransferProofs({
    keys: input.keys,
    sourceAvailableBalance: source.available,
    sourceAvailableBalanceCiphertext: parsedBalance,
    amount,
    destinationPubkey,
  });
  step({
    label: 'three proofs generated locally',
    detail:
      `${proofs.proofBytes.equality.length} + ${proofs.proofBytes.ciphertextValidity.length} + ` +
      `${proofs.proofBytes.range.length} bytes`,
  });

  /** Verify one proof into its own context account. */
  async function verifyInto(
    label: string,
    build: (contextAccount: KeyPairSigner) => Promise<readonly Instruction[]>,
  ): Promise<Address> {
    const contextAccount = await generateKeyPairSigner();
    const instructions = await build(contextAccount);
    const signature = await sendOwn(rpc, instructions, input.payerSigner);
    transactions.push(signature);
    step({ label, detail: signature });
    await wait();
    return contextAccount.address;
  }

  const equality = await verifyInto('verified the equality proof on chain', (contextAccount) =>
    verifyCiphertextCommitmentEquality({
      rpc,
      payer: input.payerSigner,
      proofData: proofs.proofBytes.equality,
      contextState: { contextAccount, authority: input.payerSigner.address },
    }),
  );
  const ciphertextValidity = await verifyInto(
    'verified the ciphertext-validity proof on chain',
    (contextAccount) =>
      verifyBatchedGroupedCiphertext3HandlesValidity({
        rpc,
        payer: input.payerSigner,
        proofData: proofs.proofBytes.ciphertextValidity,
        contextState: { contextAccount, authority: input.payerSigner.address },
      }),
  );

  // The range proof is ~1 kB: too large to embed in any transaction, so its
  // bytes are written into a record account a chunk at a time and the
  // verification names the account instead.
  const recordAccount = await generateKeyPairSigner();
  const rangeBytes = proofs.proofBytes.range;
  const recordSize = getRecordSize(rangeBytes.length);
  const recordRent = await rpc.getMinimumBalanceForRentExemption(recordSize).send();
  const openRecord = await sendOwn(
    rpc,
    [
      getCreateRecordAccountInstruction({
        payer: input.payerSigner,
        newAccount: recordAccount,
        lamports: recordRent,
        space: recordSize,
        programAddress: RECORD_PROGRAM_ADDRESS,
      }),
      getInitializeRecordInstruction({
        recordAccount: recordAccount.address,
        authority: input.payerSigner,
      }),
    ],
    input.payerSigner,
  );
  transactions.push(openRecord);
  step({ label: 'opened a record account for the range proof', detail: openRecord });
  await wait();

  for (let offset = 0; offset < rangeBytes.length; offset += RECORD_CHUNK_SIZE_POST_INITIALIZE) {
    const chunk = rangeBytes.slice(offset, offset + RECORD_CHUNK_SIZE_POST_INITIALIZE);
    const signature = await sendOwn(
      rpc,
      [
        getWriteInstruction({
          recordAccount: recordAccount.address,
          authority: input.payerSigner,
          offset,
          data: chunk,
        }),
      ],
      input.payerSigner,
    );
    transactions.push(signature);
    await wait();
  }

  const range = await verifyInto('verified the range proof on chain', (contextAccount) =>
    verifyBatchedRangeProofU128({
      rpc,
      payer: input.payerSigner,
      proofData: {
        account: recordAccount.address,
        offset: Number(RECORD_META_DATA_SIZE),
      },
      contextState: { contextAccount, authority: input.payerSigner.address },
    }),
  );

  const closedRecord = await sendOwn(
    rpc,
    [
      getCloseRecordAccountInstruction({
        recordAccount: recordAccount.address,
        authority: input.payerSigner,
        receiver: input.payerSigner.address,
      }),
    ],
    input.payerSigner,
  );
  transactions.push(closedRecord);
  step({ label: 'closed the record account', detail: closedRecord });
  await wait();

  const transfer = buildConfidentialTransfer({
    sourceToken,
    mint,
    destinationToken: destination,
    authority: input.payerSigner,
    newSourceDecryptableAvailableBalance: proofs.newSourceDecryptableAvailableBalance,
    transferAmountAuditorCiphertextLo: proofs.auditorCiphertextLo,
    transferAmountAuditorCiphertextHi: proofs.auditorCiphertextHi,
    proofRecords: { equality, ciphertextValidity, range },
  });

  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(input.feePayer as Address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    (tx) => appendTransactionMessageInstructions(transfer, tx),
  );
  const partial = await partiallySignTransactionMessageWithSigners(message);
  const slots = partial.signatures as Record<string, Uint8Array | null>;
  if (!slots[input.payerSigner.address]) throw new Error('the payer half of the signature is missing');
  if (slots[input.feePayer]) throw new Error('the fee payer slot is filled — it must be left open');
  const wire = getBase64EncodedWireTransaction(partial);
  step({
    label: 'the payment transaction is signed by the payer alone',
    detail: `${Math.round(wire.length * 0.75)} B · fee payer ${input.feePayer} signs later`,
  });

  // The wire form is Veil's own payload, not the hoisted x402 v2 adaptation.
  // `toX402PaymentPayload` moves `scheme`/`network` under `accepted`, and the
  // server's `verify()` checks them at the top level — sending the hoisted shape
  // fails with `scheme must be exact-confidential, got undefined`. `buildPaymentPayload`
  // emits both the v1 top-level fields and the v2 `accepted` entry, so one body
  // satisfies either reader.
  const payload = buildPaymentPayload({
    accept,
    transaction: wire,
    payTo: destination,
  });
  const header = bytesToBase64.decode(utf8ToBytes.encode(JSON.stringify(payload)));

  const paidRes = await fetchImpl(url, {
    headers: { 'X-Payer': input.payer, 'X-PAYMENT': header },
  });
  const paidBody = (await paidRes.json()) as {
    settled?: { signature?: string };
  };
  const signature = paidBody?.settled?.signature ?? null;
  if (signature) transactions.push(signature);

  return {
    status: paidRes.status,
    body: paidBody,
    signature,
    amount: accept.amount,
    payTo: destination,
    transactions,
  };
}

// ---------------------------------------------------------------------------
// veilFetch — the agent half, in one call
// ---------------------------------------------------------------------------

/** What a settled call cost, for logging or a receipt. */
export interface VeilPayment {
  readonly signature: string | null;
  readonly amount: string;
  readonly payTo: string;
}

export interface VeilFetchResult {
  readonly status: number;
  /** The resource body the rail served after settlement. */
  readonly data: unknown;
  readonly paid: boolean;
  /** Atomic units spent so far, counting this call. */
  readonly spent: bigint;
  readonly payment: VeilPayment | null;
}

export interface VeilFetchInput {
  /** Signs the proofs' transactions and the payment; pays the setup's fees. */
  readonly payerSigner: KeyPairSigner;
  readonly keys: ConfidentialKeys;
  readonly rpcUrl: string;
  readonly nonce?: number;
  /** `X-Payer`: the buyer's name. Defaults to the signer's address. */
  readonly payer?: string;
  readonly decimals?: number;
  /** Decimal-unit ceiling for the agent, e.g. `'0.10'`. Omit for no cap. */
  readonly budget?: string;
  /** Atomic units already spent, threaded by the caller between calls. */
  readonly spent?: bigint;
  /** Retries on a 402 that is not a final refusal. Default 1. */
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly pauseMs?: number;
  readonly onStep?: (step: Step) => void;
  readonly onPayment?: (payment: VeilPayment) => void;
}

/** The refusal codes the rail emits, mapped to this client's catalogue. */
const REFUSAL_TO_CODE: Record<string, VeilCode> = {
  'VEIL-CONF-001': 'VEIL-ACC-001',
  'VEIL-CONF-002': 'VEIL-ACC-001',
  'VEIL-CONF-003': 'VEIL-CONF-003',
  'VEIL-CONF-004': 'VEIL-BUDGET-002',
  'VEIL-CONF-005': 'VEIL-POOL-005',
  'VEIL-CONF-006': 'VEIL-CONTEND-008',
};

function withNonce(url: string, nonce: number): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('nonce')) parsed.searchParams.set('nonce', String(nonce));
  return parsed.toString();
}

/**
 * Fetch a Veil resource the way x402's `fetch` wrapper fetches any other: one
 * call, the payment handled, the resource returned.
 *
 * The budget is checked **before** anything is signed. A price that does not fit
 * is a `VEIL-BUDGET-002` and no payment is attempted — the client half of x402's
 * economic-reasoning property, so an agent cannot be talked into unbounded spend
 * by a server that keeps raising its price.
 *
 * A refusal from the rail is not retried and never downgraded to a public
 * payment; it is raised as a structured `VeilError` carrying a fix.
 */
export async function veilFetch(url: string, input: VeilFetchInput): Promise<VeilFetchResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const payerName = input.payer ?? input.payerSigner.address;
  const decimals = input.decimals ?? 6;
  const spent = input.spent ?? 0n;
  const maxRetries = input.maxRetries ?? 1;
  const step = input.onStep ?? (() => {});
  const requestUrl = withNonce(url, input.nonce ?? 1);
  const parsed = new URL(requestUrl);
  const rail = parsed.origin;

  // 1. Ask. This is the only place the price is read before money moves.
  let offerRes: Response;
  try {
    offerRes = await fetchImpl(requestUrl, { headers: { 'X-Payer': payerName } });
  } catch (cause) {
    throw new VeilError('VEIL-RAIL-007', { cause: String(cause), param: 'url' });
  }

  if (offerRes.status === 200) {
    // Already free or already served — nothing to pay.
    return { status: 200, data: await offerRes.json(), paid: false, spent, payment: null };
  }
  if (offerRes.status === 409) {
    const body = (await offerRes.json()) as { error?: string };
    throw new VeilError('VEIL-OFFER-004', {
      message: `This payment identity is already settled (${body.error ?? '409'}); use a new nonce.`,
    });
  }
  // A refusal is not always a 402. A pool that has run out answers 503, and the
  // structured reason is in the body's `veil` field — the same field a 402
  // refusal uses. Reading the status first and throwing a generic rail error
  // would swallow the one piece of information the caller needs, which is what
  // an earlier version did: a "no seat left" came back as "check your network".
  const offer = (await offerRes.json().catch(() => ({}))) as VeilPaymentRequired & {
    veil?: { refused: string; message: string; remedy: string };
  };

  if (offerRes.status !== 402) {
    const refused = offer.veil?.refused;
    if (refused) {
      throw new VeilError(REFUSAL_TO_CODE[refused] ?? 'VEIL-CONF-003', {
        message: offer.veil?.message,
        fix: offer.veil?.remedy,
      });
    }
    throw new VeilError('VEIL-RAIL-007', {
      message: `expected a 200 or a 402 from the rail, got ${offerRes.status}`,
      param: 'url',
    });
  }

  const accept = offer.accepts?.[0];
  if (!accept) {
    // A refusal carries no `accepts[]` on purpose; surface its code and remedy.
    const refused = offer.veil?.refused;
    if (refused) {
      throw new VeilError(REFUSAL_TO_CODE[refused] ?? 'VEIL-CONF-003', {
        message: offer.veil?.message,
        fix: offer.veil?.remedy,
      });
    }
    throw new VeilError('VEIL-OFFER-004');
  }

  if (accept.scheme !== VEIL_SCHEME) {
    throw new VeilError('VEIL-OFFER-004', {
      message: `the offer's scheme is ${accept.scheme}, not ${VEIL_SCHEME}`,
      param: 'scheme',
    });
  }

  const price = BigInt(accept.amount);

  // 2. Budget, before any signature.
  if (input.budget !== undefined) {
    const cap = toAtomic(input.budget, decimals);
    if (spent + price > cap) {
      throw new VeilError('VEIL-BUDGET-002', {
        cause: `spent ${spent} + price ${price} would exceed the budget of ${cap} atomic units`,
        param: 'budget',
      });
    }
  }
  step({ label: 'price accepted against budget', detail: `${accept.amount} atomic → ${accept.payTo}` });

  // 3. Pay, retrying only a non-final 402.
  const feePayer = await feePayerOf(rail, fetchImpl);
  let result: PayVeilResult | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    result = await payVeilResource({
      rail,
      resource: parsed.pathname,
      nonce: input.nonce ?? 1,
      payer: payerName,
      rpcUrl: input.rpcUrl,
      payerSigner: input.payerSigner,
      keys: input.keys,
      feePayer,
      decimals,
      url: requestUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.pauseMs !== undefined ? { pauseMs: input.pauseMs } : {}),
      onStep: step,
    });
    if (result.status === 200) break;
  }

  if (!result || result.status !== 200) {
    throw new VeilError('VEIL-PAY-006', {
      cause: JSON.stringify(result?.body ?? {}).slice(0, 300),
    });
  }

  const payment: VeilPayment = {
    signature: result.signature,
    amount: result.amount,
    payTo: result.payTo,
  };
  input.onPayment?.(payment);
  const data = (result.body as { data?: unknown })?.data;
  return { status: 200, data, paid: true, spent: spent + price, payment };
}

/**
 * A stateful agent: one budget, one running spend, a fresh nonce per call.
 *
 * The nonce is the payment identity, so an agent that makes many calls must
 * never reuse one — this is the wrapper that makes that impossible to get wrong.
 */
export interface VeilAgent {
  fetch(url: string, options?: { readonly budget?: string; readonly nonce?: number }): Promise<VeilFetchResult>;
  /** Atomic units spent through this agent so far. */
  readonly spent: bigint;
}

export function createVeilAgent(
  options: Omit<VeilFetchInput, 'nonce' | 'spent'> & { readonly budget?: string },
): VeilAgent {
  let spent = 0n;
  let nonce = Math.floor(Date.now() / 1000) % 1_000_000_000;
  return {
    get spent() {
      return spent;
    },
    async fetch(url, call = {}) {
      const result = await veilFetch(url, {
        ...options,
        nonce,
        spent,
        budget: call.budget ?? options.budget,
      });
      nonce += 1;
      spent = result.spent;
      return result;
    },
  };
}
