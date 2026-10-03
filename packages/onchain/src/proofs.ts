/**
 * @veil/onchain/proofs — zero-knowledge proof *generation*, locally.
 *
 * ## Why this module exists
 *
 * The token program will not configure or move a confidential balance on trust.
 * It demands proofs, and it verifies them on chain by re-reading the proof
 * instruction from the Instructions sysvar at a signed offset. Two facts about
 * that were measured rather than assumed:
 *
 * 1. **The proofs are produced in this process.** `@solana/zk-sdk` ships the
 *    generators as WASM: `new PubkeyValidityProofData(elGamalKeypair)` assembles
 *    and self-verifies a proof on construction. No prover service, no RPC round
 *    trip, no cost. `npm run prove:check` asserts this on every run.
 *
 * 2. **The offset is signed, and negative.** `verify_and_extract_context` does
 *    `get_instruction_relative(offset, sysvar)`, which indexes
 *    `current_index + offset`. The proof is placed *before* the instruction that
 *    consumes it, so for a proof at index N and a consumer at N+1 the offset is
 *    `-1`. A positive offset walks past the end of the transaction and the token
 *    program returns `InvalidArgument` — which is exactly what a probe of
 *    offsets {+1, -2, -3} showed against live testnet, with only `-1` passing.
 *
 * ## Wire format
 *
 * `PubkeyValidityProofData` is `#[repr(C)] { context: 32 bytes, proof: 64
 * bytes }` = 96 bytes, and the ZK program's instruction data is a one-byte
 * `ProofType` discriminant (`PubkeyValidity = 4`) followed by that struct: 97
 * bytes total. The token program re-parses the same bytes with
 * `bytemuck::try_from_bytes`, so the layout must match exactly.
 *
 * Everything here is pure and offline: no network, no signer material beyond
 * the message the caller already controls.
 */

import { ristretto255 } from '@noble/curves/ed25519.js';
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from '@solana-program/zk-elgamal-proof';
import {
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  CiphertextCommitmentEqualityProofData,
  ConfidentialKeys,
  ElGamalCiphertext,
  ElGamalPubkey,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
  PubkeyValidityProofData,
  type ElGamalKeypair,
} from '@solana/zk-sdk';
import type { Address, Instruction } from '@solana/kit';

/** `ProofType::PubkeyValidity` — the discriminant byte the ZK program expects. */
export const PROOF_TYPE_PUBKEY_VALIDITY = 4;

/** `ProofType::ZeroCiphertext` — used when emptying an account. */
export const PROOF_TYPE_ZERO_CIPHERTEXT = 1;

/**
 * Derive the confidential-balance keys for a wallet from a 64-byte ed25519
 * signature over `ConfidentialKeys.signerMessage()` (`"solana-conf-bal/v1"`).
 *
 * One signature yields both halves Token-2022 needs: the ElGamal keypair, which
 * owns the encrypted balances, and the AES (`AeKey`) key behind the
 * `decryptable_available_balance` fast path. Because the message is a fixed
 * constant rather than a challenge, the same wallet derives the same keys on
 * every platform — that is what makes them recoverable rather than ephemeral.
 */
export function confidentialKeysFromSignature(signature: Uint8Array): ConfidentialKeys {
  if (signature.length !== 64) {
    throw new Error(`confidential keys need a 64-byte signature, got ${signature.length}`);
  }
  return ConfidentialKeys.fromSignature(signature);
}

/** The exact bytes a wallet signs once to derive its confidential keys. */
export function confidentialDerivationMessage(): Uint8Array {
  return ConfidentialKeys.signerMessage();
}

/**
 * Signs a fixed message and returns the raw 64-byte ed25519 signature.
 *
 * Deliberately abstracted over *how* the signature is produced. `@solana/kit`'s
 * `signBytes` takes a WebCrypto `CryptoKey`, which a seed-derived signer does
 * not have, while a browser wallet exposes a `signMessage` RPC. Taking the
 * function keeps this module free of key material and usable from both.
 */
export type SignDerivationMessage = () => Uint8Array | Promise<Uint8Array>;

/**
 * Derive a wallet's confidential keys from a caller-supplied signature.
 *
 * Prefer this over `confidentialKeysFromSignature` when the signature comes
 * from somewhere asynchronous — it keeps the message bytes in one place so the
 * caller cannot sign the wrong thing.
 */
export async function confidentialKeysFrom(
  sign: SignDerivationMessage,
): Promise<ConfidentialKeys> {
  return confidentialKeysFromSignature(new Uint8Array(await sign()));
}

/**
 * Build the `VerifyPubkeyValidity` instruction for an ElGamal public key.
 *
 * Pure: the proof is generated in this call and self-verifies on construction,
 * so a throw here means the key material was malformed rather than that
 * something remote failed. The instruction carries no accounts — all inputs
 * live in the 97 bytes of instruction data — which is why the ZK program can
 * verify it without a context-state account or any rent.
 */
export function buildPubkeyValidityProof(keys: ConfidentialKeys): Instruction {
  const proofData = new PubkeyValidityProofData(keys.elgamal());
  const body = proofData.toBytes(); // context(32) || proof(64)
  if (body.length !== 96) {
    throw new Error(`pubkey-validity body must be 96 bytes, got ${body.length}`);
  }
  const data = new Uint8Array(1 + body.length);
  data[0] = PROOF_TYPE_PUBKEY_VALIDITY;
  data.set(body, 1);
  return {
    programAddress: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS as Address,
    accounts: [],
    data,
  };
}

/**
 * The offset a consumer instruction must carry to find its proof, when the
 * proof is placed immediately before it.
 *
 * Encoded as a named constant rather than an inline `-1` because the sign is
 * load-bearing and silently inverted: a positive offset resolves to an
 * instruction index past the end of the transaction and the token program
 * fails with the unhelpful `InvalidArgument`.
 */
export const PROOF_OFFSET_IMMEDIATELY_PRECEDING = -1;

/** Encrypt a plaintext balance under the wallet's AES key (the fast path). */
export function encryptBalance(keys: ConfidentialKeys, amount: bigint): Uint8Array {
  return keys.ae().encrypt(amount).toBytes();
}

/**
 * Encrypt an amount under the wallet's ElGamal key (the ZK path).
 *
 * The ciphertext is 64 bytes and is what a transfer or deposit carries on
 * chain. `.toBytes()` is required: `encryptU64` returns an `ElGamalCiphertext`
 * object, and returning it raw would fail typecheck rather than serialize.
 */
export function encryptAmount(keys: ConfidentialKeys, amount: bigint): Uint8Array {
  return keys.elgamal().pubkey().encryptU64(amount).toBytes();
}

// ---------------------------------------------------------------------------
// A confidential transfer's three proofs — all generated in this process
// ---------------------------------------------------------------------------

/**
 * ProofType discriminants, read from the ZK program's own IDL rather than
 * remembered. A wrong byte here is a proof the token program cannot find.
 */
export const PROOF_TYPE_BATCHED_RANGE_PROOF_U128 = 7;
/** `ProofType::VerifyCiphertextCommitmentEquality`. */
export const PROOF_TYPE_CIPHERTEXT_COMMITMENT_EQUALITY = 3;
/** `ProofType::VerifyBatchedGroupedCiphertext3HandlesValidity`. */
export const PROOF_TYPE_BATCHED_GROUPED_CIPHERTEXT_3_HANDLES = 12;

/**
 * Bit widths Token-2022's `Transfer` splits the amount and balance into.
 *
 * Copied from the token program's own helper (`TRANSFER_AMOUNT_LO_BIT_LENGTH`
 * and friends). They are part of the wire format: a proof built at a different
 * split verifies against the wrong statement and the chain rejects it.
 */
export const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;
export const TRANSFER_AMOUNT_HI_BIT_LENGTH = 32n;
export const REMAINING_BALANCE_BIT_LENGTH = 64;
export const RANGE_PROOF_PADDING_BIT_LENGTH = 16;

/**
 * What a payer must know to prove a transfer: the amount, and the three
 * public keys the grouped ciphertext is encrypted under.
 *
 * No RPC, no context-state account, no prover service. Everything needed is
 * either already on the payer's device (its own keypair and AES key) or public
 * (the destination's and auditor's ElGamal keys).
 */
export interface TransferProofInput {
  /** The payer's confidential keys — never leave the client. */
  readonly keys: ConfidentialKeys;
  /** The payer's available balance, decrypted locally. */
  readonly sourceAvailableBalance: bigint;
  /**
   * The payer's on-chain available-balance ciphertext, read from its account.
   *
   * Needed because the equality proof states "the new balance equals the old
   * balance minus this transfer" — and the old balance only exists as this
   * ciphertext. It is public data (it is on the account), so reading it is not
   * a disclosure; the *plaintext* balance is what must stay local.
   */
  readonly sourceAvailableBalanceCiphertext: ElGamalCiphertext;
  /** The amount to pay, in atomic units. */
  readonly amount: bigint;
  /** The destination account's ElGamal public key, from its on-chain state. */
  readonly destinationPubkey: ElGamalPubkey;
  /**
   * The auditor's ElGamal public key, when the mint configures one.
   *
   * A grouped ciphertext is *three*-handled regardless: with no auditor the
   * zero key is used, which is what the token program expects to see rather
   * than a 2-handle variant.
   */
  readonly auditorPubkey?: ElGamalPubkey;
}

/** The three proof payloads, named rather than positional. */
export interface TransferProofBytes {
  readonly equality: Uint8Array;
  readonly ciphertextValidity: Uint8Array;
  readonly range: Uint8Array;
}

/** Everything the `Transfer` instruction needs, and nothing it does not. */
export interface TransferProofBundle {
  /** The three proof instructions, in the order Token-2022 expects them. */
  readonly proofs: readonly Instruction[];
  /**
   * The same three proofs as raw bytes.
   *
   * Both forms are reported because a transfer has two ways to reach its proofs,
   * and which one works is decided by arithmetic rather than preference. The
   * in-transaction form refers to the verification instructions by *offset*, so
   * the proofs must all be in the same transaction as the transfer. Measured
   * against a real cluster, these three come to 321 B + 545 B + 1001 B = 1867 B,
   * and a Solana transaction is capped at 1232 B — so on a live chain the
   * offset form cannot fit, and the proofs have to be verified into context-state
   * accounts first. That path needs the bytes, not pre-built instructions.
   */
  readonly proofBytes: TransferProofBytes;
  /** Re-encrypted source balance after paying, for the transfer's fast path. */
  readonly newSourceDecryptableAvailableBalance: Uint8Array;
  /** Auditor ciphertext halves — encryptions of zero when no auditor is set. */
  readonly auditorCiphertextLo: Uint8Array;
  readonly auditorCiphertextHi: Uint8Array;
  /** Offsets within the final transaction. All `-1`: each proof precedes. */
  readonly equalityProofOffset: number;
  readonly ciphertextValidityProofOffset: number;
  readonly rangeProofOffset: number;
  /** The source's balance after this payment. Reported for the dashboard. */
  readonly newAvailableBalance: bigint;
}

/** Split an amount into the low/high halves the wire format carries. */
function splitAmount(amount: bigint, loBits: bigint): [bigint, bigint] {
  const mask = (1n << loBits) - 1n;
  return [amount & mask, amount >> loBits];
}

/**
 * Pull one handle's 64-byte ciphertext out of a grouped ciphertext.
 *
 * A grouped ciphertext is `commitment(32) || handle_0(32) || handle_1(32) …`,
 * so handle `i`'s ciphertext is the commitment plus handle `i`. The token
 * program does the same slicing on chain; the auditor ciphertext that goes in
 * the instruction is the handle-2 slice, which is why this exists.
 */
function handleCiphertext(grouped: Uint8Array, handleIndex: number): Uint8Array {
  const out = new Uint8Array(64);
  out.set(grouped.slice(0, 32), 0);
  out.set(grouped.slice(32 + handleIndex * 32, 64 + handleIndex * 32), 32);
  return out;
}

/** Zero, encrypted for the auditor — what a mint with no auditor expects. */
function encryptedZero(): Uint8Array {
  return new Uint8Array(64);
}

/**
 * Build the three proofs a confidential transfer requires — locally.
 *
 * This is the answer to "where do the proofs come from?". They are generated by
 * WASM in this process, from key material the payer already holds, and the
 * ciphertexts they commit to are the same ones the `Transfer` instruction
 * carries. Nothing is sent to a prover, and no account has to exist on chain for
 * them to be built — which is what lets a browser wallet, a CLI, or a server do
 * this identically.
 *
 * The three statements, in the order the token program reads them:
 *
 * 1. **Ciphertext-commitment equality** — the new source balance I am writing
 *    into the account is the old balance minus the amount, and I know the
 *    opening. Without this a payer could write any balance it liked.
 * 2. **Batched grouped ciphertext validity** — the two grouped ciphertexts
 *    (amount low and high) really encrypt that amount under the source,
 *    destination and auditor keys.
 * 3. **Batched range proof (u128)** — every committed value is in range, so no
 *    amount can wrap into a negative or absurd balance.
 */
export function buildTransferProofs(input: TransferProofInput): TransferProofBundle {
  const amount = input.amount;
  if (amount <= 0n) {
    throw new RangeError('a confidential transfer must move a positive amount');
  }
  const [amountLo, amountHi] = splitAmount(amount, TRANSFER_AMOUNT_LO_BIT_LENGTH);

  const sourceKeypair: ElGamalKeypair = input.keys.elgamal();
  const sourcePubkey = sourceKeypair.pubkey();
  const auditorPubkey = input.auditorPubkey ?? zeroElGamalPubkey();

  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
    sourcePubkey,
    input.destinationPubkey,
    auditorPubkey,
    amountLo,
    openingLo,
  );
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
    sourcePubkey,
    input.destinationPubkey,
    auditorPubkey,
    amountHi,
    openingHi,
  );
  const groupedLoBytes = groupedLo.toBytes();
  const groupedHiBytes = groupedHi.toBytes();

  // The source ciphertexts are handle 0; the auditor's are handle 2. The
  // instruction carries the auditor slice, while the equality proof needs the
  // source slice, so both are extracted here rather than re-encrypted.
  const sourceCiphertextLo = ElGamalCiphertext.fromBytes(handleCiphertext(groupedLoBytes, 0));
  const sourceCiphertextHi = ElGamalCiphertext.fromBytes(handleCiphertext(groupedHiBytes, 0));
  if (!sourceCiphertextLo || !sourceCiphertextHi) {
    throw new Error('the grouped ciphertext did not yield a source handle');
  }

  const newAvailableBalance = input.sourceAvailableBalance - amount;
  if (newAvailableBalance < 0n) {
    throw new RangeError(
      `the source holds ${input.sourceAvailableBalance} but the transfer moves ${amount}`,
    );
  }
  const newBalanceOpening = new PedersenOpening();
  const newBalanceCommitment = PedersenCommitment.from(
    newAvailableBalance,
    newBalanceOpening,
  );

  // The ciphertext the equality proof commits to: the old balance ciphertext
  // minus the transfer, computed on the curve so the prover never has to
  // reveal the old balance. The two transfer halves are folded into one value
  // first, exactly as the token program does when it applies the transfer.
  const newBalanceCiphertext = subtractCiphertexts(
    input.sourceAvailableBalanceCiphertext,
    combineLoHi(sourceCiphertextLo, sourceCiphertextHi, TRANSFER_AMOUNT_LO_BIT_LENGTH),
  );

  const equalityProof = new CiphertextCommitmentEqualityProofData(
    sourceKeypair,
    newBalanceCiphertext,
    newBalanceCommitment,
    newBalanceOpening,
    newAvailableBalance,
  );

  const ciphertextValidityProof = new BatchedGroupedCiphertext3HandlesValidityProofData(
    sourcePubkey,
    input.destinationPubkey,
    auditorPubkey,
    groupedLo,
    groupedHi,
    amountLo,
    amountHi,
    openingLo,
    openingHi,
  );

  const commitmentLo = PedersenCommitment.fromBytes(groupedLoBytes.slice(0, 32));
  const commitmentHi = PedersenCommitment.fromBytes(groupedHiBytes.slice(0, 32));
  const paddingOpening = new PedersenOpening();
  const paddingCommitment = PedersenCommitment.from(0n, paddingOpening);
  const rangeProof = new BatchedRangeProofU128Data(
    [newBalanceCommitment, commitmentLo, commitmentHi, paddingCommitment],
    new BigUint64Array([newAvailableBalance, amountLo, amountHi, 0n]),
    Uint8Array.from([
      REMAINING_BALANCE_BIT_LENGTH,
      Number(TRANSFER_AMOUNT_LO_BIT_LENGTH),
      Number(TRANSFER_AMOUNT_HI_BIT_LENGTH),
      RANGE_PROOF_PADDING_BIT_LENGTH,
    ]),
    [newBalanceOpening, openingLo, openingHi, paddingOpening],
  );

  const proofBytes: TransferProofBytes = {
    equality: equalityProof.toBytes(),
    ciphertextValidity: ciphertextValidityProof.toBytes(),
    range: rangeProof.toBytes(),
  };

  return {
    proofs: [
      proofInstruction(PROOF_TYPE_CIPHERTEXT_COMMITMENT_EQUALITY, proofBytes.equality),
      proofInstruction(
        PROOF_TYPE_BATCHED_GROUPED_CIPHERTEXT_3_HANDLES,
        proofBytes.ciphertextValidity,
      ),
      proofInstruction(PROOF_TYPE_BATCHED_RANGE_PROOF_U128, proofBytes.range),
    ],
    proofBytes,
    newSourceDecryptableAvailableBalance: encryptBalance(input.keys, newAvailableBalance),
    auditorCiphertextLo: handleCiphertext(groupedLoBytes, 2),
    auditorCiphertextHi: handleCiphertext(groupedHiBytes, 2),
    // Every proof sits immediately before the transfer, so each offset is -1.
    equalityProofOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
    ciphertextValidityProofOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
    rangeProofOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
    newAvailableBalance,
  };
}

/**
 * ElGamal ciphertext arithmetic over Ristretto, the same group the token
 * program uses.
 *
 * A ciphertext is two curve points — a commitment and a decryption handle — so
 * "subtract" is point subtraction on both halves, not byte arithmetic. Getting
 * this wrong produces a ciphertext that looks well-formed and fails the
 * equality proof on chain, which is why it is done with the same primitives the
 * token-2022 helper uses rather than with hand-rolled bytes.
 */
const RistrettoPoint = ristretto255.Point;

function ciphertextToPoints(ciphertext: Uint8Array): {
  commitment: InstanceType<typeof RistrettoPoint>;
  handle: InstanceType<typeof RistrettoPoint>;
} {
  if (ciphertext.length !== 64) {
    throw new Error(`a ciphertext is 64 bytes, got ${ciphertext.length}`);
  }
  return {
    commitment: RistrettoPoint.fromBytes(ciphertext.slice(0, 32)),
    handle: RistrettoPoint.fromBytes(ciphertext.slice(32, 64)),
  };
}

function pointsToCiphertext(
  commitment: InstanceType<typeof RistrettoPoint>,
  handle: InstanceType<typeof RistrettoPoint>,
): Uint8Array {
  const out = new Uint8Array(64);
  out.set(commitment.toBytes(), 0);
  out.set(handle.toBytes(), 32);
  return out;
}

/** `lo + hi * 2^bitLength` — fold the two halves into one ciphertext. */
function combineLoHi(
  lo: ElGamalCiphertext,
  hi: ElGamalCiphertext,
  bitLength: bigint,
): ElGamalCiphertext {
  const scale = 1n << bitLength;
  const loPoints = ciphertextToPoints(lo.toBytes());
  const hiPoints = ciphertextToPoints(hi.toBytes());
  return required(
    ElGamalCiphertext.fromBytes(
      pointsToCiphertext(
        loPoints.commitment.add(hiPoints.commitment.multiply(scale)),
        loPoints.handle.add(hiPoints.handle.multiply(scale)),
      ),
    ),
    'combining the two transfer ciphertext halves',
  );
}

/** `left - right` on both halves. */
function subtractCiphertexts(
  left: ElGamalCiphertext,
  right: ElGamalCiphertext,
): ElGamalCiphertext {
  const a = ciphertextToPoints(left.toBytes());
  const b = ciphertextToPoints(right.toBytes());
  return required(
    ElGamalCiphertext.fromBytes(
      pointsToCiphertext(
        a.commitment.subtract(b.commitment),
        a.handle.subtract(b.handle),
      ),
    ),
    'subtracting the transfer from the balance ciphertext',
  );
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`could not build a ciphertext while ${what}`);
  return value;
}

/** The zero ElGamal public key, which is what a mint with no auditor uses. */
function zeroElGamalPubkey(): ElGamalPubkey {
  return ElGamalPubkey.fromBytes(new Uint8Array(32));
}

/** A ZK-program verify instruction: one discriminant byte, then the proof. */
function proofInstruction(discriminant: number, body: Uint8Array): Instruction {
  const data = new Uint8Array(1 + body.length);
  data[0] = discriminant;
  data.set(body, 1);
  return {
    programAddress: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS as Address,
    accounts: [],
    data,
  };
}
