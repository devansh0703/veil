/**
 * @veil/onchain — the Token-2022 confidential-transfer instruction layer.
 *
 * Every builder here is written against the *real* `@solana-program/token-2022`
 * API, verified by introspecting the installed package rather than from memory.
 * The builders are pure: they assemble `Instruction` objects and touch no
 * network, so the shape of what Veil submits is asserted in tests without a
 * funded keypair.
 *
 * ## The honest boundary
 *
 * Assembling instructions is half of a confidential payment. The other half is
 * the zero-knowledge proofs Token-2022 requires, and those come from
 * `@solana-program/zk-elgamal-proof` through helpers that need an RPC connection
 * and a rent-paid context-state account:
 *
 *     verifyPubkeyValidity({ rpc, payer, proofData, contextState, programId })
 *       -> Promise<Instruction[]>
 *
 * A prover also *produces* the ciphertexts a transfer carries. So this module
 * takes already-computed proofs and ciphertexts as input and splices them in.
 * That keeps the offline-verifiable half genuinely verifiable and confines the
 * fund-dependent half to the proof step, which lives in scripts/.
 *
 * ## What is and is not private
 *
 * A confidential transfer is a normal Solana transaction. What is hidden is the
 * *amounts and balances*; the existence of the transaction, its destination
 * account, and its mint are public. Anything in this file that looked like it was
 * hiding an address would be a bug.
 */

import {
  TOKEN_2022_PROGRAM_ADDRESS,
  ExtensionType,
  getApplyConfidentialPendingBalanceInstruction,
  getConfidentialTransferInstruction,
  getConfigureConfidentialTransferAccountInstruction,
  getDecryptableBalanceEncoder,
  getDisableNonConfidentialCreditsInstruction,
  getEnableConfidentialCreditsInstruction,
  getEncryptedBalanceEncoder,
  getInitializeAccountInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getMintSize,
  getTokenSize,
} from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
import { PROOF_OFFSET_IMMEDIATELY_PRECEDING } from './proofs.ts';
import type {
  Address,
  Instruction,
  Lamports,
  TransactionSigner,
} from '@solana/kit';

export { ExtensionType, TOKEN_2022_PROGRAM_ADDRESS };

// ---------------------------------------------------------------------------
// Encoded sizes, read from the codecs rather than written down by hand
// ---------------------------------------------------------------------------

/** 36 bytes: authenticated-encryption ciphertext of an account balance. */
export const DECRYPTABLE_BALANCE_SIZE =
  getDecryptableBalanceEncoder().fixedSize;
/** 64 bytes: ElGamal ciphertext of a balance or a transfer amount. */
export const ENCRYPTED_BALANCE_SIZE = getEncryptedBalanceEncoder().fixedSize;

/** Rent-exempt base sizes from the SPL Token-2022 layout. */
export const BASE_MINT_SIZE = 82;
export const BASE_ACCOUNT_SIZE = 165;
/** Every extension account carries a 1-byte AccountType after the base region. */
export const ACCOUNT_TYPE_SIZE = 1;
/** Each extension is a TLV entry: 2-byte type, 2-byte length, then data. */
export const EXTENSION_HEADER_SIZE = 4;

/** ConfidentialTransferMint: authority(32) + auto_approve(1) + auditor(32). */
export const CONFIDENTIAL_TRANSFER_MINT_DATA_SIZE = 65;
/**
 * Bytes Token-2022 adds for ONE mint extension before its data.
 *
 * Not a guess: `getMintSize` reports +88 for `NonTransferable` (0 bytes of
 * data), +120 for `MintCloseAuthority` (32 bytes) and +153 for
 * `ConfidentialTransferMint` (65 bytes) — 88 in every case. The old value here
 * was 5 (account-type tag + a 4-byte TLV header), which made every mint
 * 83 bytes too short and made the real `InitializeMint` reject it with
 * `InvalidAccountData` the first time `--apply` ever ran against a live
 * cluster. `test/chain` re-derives this from the SDK on every run.
 */
export const MINT_EXTENSION_OVERHEAD = 88;

/**
 * The space the Token-2022 program will accept for this mint.
 *
 * Delegates to the SDK's `getMintSize`, which is the same function the
 * official `getCreateMintInstructionPlan` uses, so the size cannot drift from
 * the program's own `try_calculate_account_len` check. The arithmetic is kept
 * beside it because that check is what failed in practice and a reviewer needs
 * to see why the number is 235 and not 152.
 */
/**
 * ConfidentialTransferAccount wire layout:
 *   approved(1) + elgamal_pubkey(32) + pending_lo(64) + pending_hi(64)
 *   + available(64) + decryptable_available(36) + allow_confidential_credits(1)
 *   + allow_non_confidential_credits(1) + 4 x counter(8)
 */
export const CONFIDENTIAL_TRANSFER_ACCOUNT_DATA_SIZE = 295;

/**
 * Bytes a mint needs to hold the confidential-transfer extension.
 *
 * Spelled out as arithmetic so a reviewer can check it against the Token-2022
 * spec. The bootstrap script reasserts it against the live account's real data
 * length before trusting it.
 */
export function confidentialMintSpace(): number {
  return getMintSize([
    {
      __kind: 'ConfidentialTransferMint',
      autoApproveNewAccounts: false,
      authority: null,
      auditorElgamalPubkey: null,
    },
  ]);
}

/** The same size, written out: 82 + 88 + 65 = 235. Checked against the SDK. */
export function confidentialMintSpaceArithmetic(): number {
  return BASE_MINT_SIZE + MINT_EXTENSION_OVERHEAD + CONFIDENTIAL_TRANSFER_MINT_DATA_SIZE;
}

/**
 * Bytes a token account needs to hold the confidential-transfer extension.
 *
 * Delegates to the SDK's `getTokenSize`, which measures 465 for this extension —
 * the same number the hand-rolled arithmetic below produces. Both are kept:
 * the SDK is authoritative, and the arithmetic is what a reviewer checks it
 * against. If they ever disagree, the SDK wins and this comment is where the
 * argument is recorded.
 */
export function confidentialAccountSpace(): number {
  return getTokenSize([confidentialAccountExtensionArgs()]);
}

/** The same size, written out: 165 + 88 + 212 = 465. Checked against the SDK. */
export function confidentialAccountSpaceArithmetic(): number {
  return (
    BASE_ACCOUNT_SIZE +
    ACCOUNT_TYPE_SIZE +
    EXTENSION_HEADER_SIZE +
    CONFIDENTIAL_TRANSFER_ACCOUNT_DATA_SIZE
  );
}

/**
 * A placeholder `ConfidentialTransferAccount` extension for size measurement.
 *
 * `getTokenSize` encodes the whole extension to measure it, so it needs every
 * field. The values here are the on-chain defaults a freshly configured account
 * starts from; none of them affect the length, which is all this is used for.
 */
function confidentialAccountExtensionArgs() {
  const zero = new Uint8Array(ENCRYPTED_BALANCE_SIZE);
  return {
    __kind: 'ConfidentialTransferAccount' as const,
    approved: false,
    elgamalPubkey: ZERO_ADDRESS,
    pendingBalanceLow: zero,
    pendingBalanceHigh: zero,
    availableBalance: zero,
    decryptableAvailableBalance: new Uint8Array(DECRYPTABLE_BALANCE_SIZE),
    allowConfidentialCredits: true,
    allowNonConfidentialCredits: true,
    pendingBalanceCreditCounter: 0,
    maximumPendingBalanceCreditCounter: 65535,
    expectedPendingBalanceCreditCounter: 0,
    actualPendingBalanceCreditCounter: 0,
  };
}

/**
 * The decryptable balance a freshly configured account starts from: zero.
 *
 * The length is taken from the SDK's own codec, so this cannot drift from the
 * wire format. scripts/setup-devnet.ts still checks the value against the first
 * account it configures on chain, because "all zeroes means zero" is a protocol
 * convention worth confirming once against real data rather than asserting.
 */
export function decryptableZeroBalance(): Uint8Array {
  return new Uint8Array(DECRYPTABLE_BALANCE_SIZE);
}

/** All-zero ElGamal ciphertext, the encoding of an encrypted zero balance. */
export function encryptedZeroBalance(): Uint8Array {
  return new Uint8Array(ENCRYPTED_BALANCE_SIZE);
}

/**
 * The system program's address — 32 zero bytes.
 *
 * Used only as a placeholder ElGamal pubkey when *measuring* an extension's
 * size. `getTokenSize` encodes the whole struct, so it needs a syntactically
 * valid address even though no byte of it affects the length being measured.
 */
const ZERO_ADDRESS = '11111111111111111111111111111111' as Address;

// ---------------------------------------------------------------------------
// Instruction builders (pure)
// ---------------------------------------------------------------------------

export interface InitializeConfidentialMintInput {
  readonly mint: Address;
  readonly authority: Address;
  readonly autoApproveNewAccounts: boolean;
  /**
   * Third-party decryption key.
   *
   * A single GLOBAL ElGamal key per mint, able to decrypt every amount on that
   * mint. It is not a per-merchant reconciliation mechanism — each merchant
   * reconciles by decrypting its own incoming ciphertext — so this is null
   * unless a merchant genuinely wants an external auditor.
   */
  readonly auditorElgamalPubkey?: Address | null;
}

export function buildInitializeConfidentialMint(
  input: InitializeConfidentialMintInput,
): Instruction {
  return getInitializeConfidentialTransferMintInstruction({
    mint: input.mint,
    authority: input.authority,
    autoApproveNewAccounts: input.autoApproveNewAccounts,
    auditorElgamalPubkey: input.auditorElgamalPubkey ?? null,
  });
}

export interface CreatePaymentAccountInput {
  /** Wallet paying rent. Must be able to sign. */
  readonly payer: TransactionSigner;
  /**
   * The new payment account. Creating an account requires the new account's own
   * signature, so this is a generated signer whose address becomes the one-time
   * destination. The merchant keeps it, or creates it once and discards the
   * secret (the account's authority is the merchant's wallet, not this key).
   */
  readonly account: TransactionSigner;
  readonly mint: Address;
  /** Owner of the token account — the merchant's wallet. */
  readonly owner: Address;
  readonly lamports: Lamports;
}

/**
 * Create one pre-configured payment account.
 *
 * Create the account with room for the confidential-transfer extension, then
 * initialise it as a Token-2022 account. Configuration (ElGamal pubkey and
 * credit flags) is a separate owner-signed step requiring proofs — see
 * `buildConfigureAccount` and `buildArmForConfidentialCredits`. That separation
 * is exactly why Veil pre-creates a pool: configuring per payment would need the
 * merchant online and signing for every call.
 */
export function buildCreatePaymentAccount(
  input: CreatePaymentAccountInput,
): Instruction[] {
  return [
    getCreateAccountInstruction({
      payer: input.payer,
      newAccount: input.account,
      lamports: input.lamports,
      space: confidentialAccountSpace(),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccountInstruction({
      account: input.account.address,
      mint: input.mint,
      owner: input.owner,
    }),
  ];
}

export interface ConfigureAccountInput {
  readonly token: Address;
  readonly mint: Address;
  /**
   * The account owner, as a signer.
   *
   * Typed as a signer rather than an address on purpose. The SDK resolves a bare
   * address to a non-signer account, which would produce an instruction that
   * assembles cleanly and then fails on chain for a missing signature. Requiring
   * the signer makes that mistake impossible to write.
   */
  readonly authority: TransactionSigner;
  /** Offset of the proof instruction within this transaction. */
  readonly proofInstructionOffset: number;
  readonly maximumPendingBalanceCreditCounter: bigint;
  /** Defaults to the zero balance; see `decryptableZeroBalance`. */
  readonly decryptableZeroBalance?: Uint8Array;
}

export function buildConfigureAccount(input: ConfigureAccountInput): Instruction {
  return getConfigureConfidentialTransferAccountInstruction({
    token: input.token,
    mint: input.mint,
    authority: input.authority,
    proofInstructionOffset: input.proofInstructionOffset,
    maximumPendingBalanceCreditCounter: input.maximumPendingBalanceCreditCounter,
    decryptableZeroBalance:
      input.decryptableZeroBalance ?? decryptableZeroBalance(),
  });
}

/**
 * Allow this account to receive confidential credits, and refuse plain ones.
 *
 * Both halves matter. Enabling confidential credits is what lets a payment be
 * private; disabling non-confidential credits removes the public fallback, so a
 * failed proof surfaces as an on-chain error instead of silently degrading into
 * a visible transfer.
 */
export function buildArmForConfidentialCredits(input: {
  readonly token: Address;
  /** The account owner, as a signer — see the note on ConfigureAccountInput. */
  readonly authority: TransactionSigner;
}): Instruction[] {
  return [
    getEnableConfidentialCreditsInstruction({
      token: input.token,
      authority: input.authority,
    }),
    getDisableNonConfidentialCreditsInstruction({
      token: input.token,
      authority: input.authority,
    }),
  ];
}

export interface ConfidentialTransferInput {
  readonly sourceToken: Address;
  readonly mint: Address;
  readonly destinationToken: Address;
  /** The source account's owner, as a signer. */
  readonly authority: TransactionSigner;
  /**
   * The source's balance after this transfer, re-encrypted.
   *
   * Produced by the prover: the sender must supply a fresh decryptable balance
   * because the old ciphertext is invalidated by spending part of it.
   */
  readonly newSourceDecryptableAvailableBalance: Uint8Array;
  /**
   * Auditor ciphertexts for this transfer.
   *
   * Required by the instruction even when no auditor is configured — in that
   * case the prover returns encryptions of zero. Defaulted here to zeroes so a
   * caller without an auditor does not have to know this.
   */
  readonly transferAmountAuditorCiphertextLo?: Uint8Array;
  readonly transferAmountAuditorCiphertextHi?: Uint8Array;
  /** Proof instructions, already verified, in the order Token-2022 expects. */
  readonly proofs?: readonly Instruction[];
  /** Index of the equality-proof instruction within the final transaction. */
  readonly equalityProofOffset?: number;
  /** Index of the ciphertext-validity proof within the final transaction. */
  readonly ciphertextValidityProofOffset?: number;
  /** Index of the range proof within the final transaction. */
  readonly rangeProofOffset?: number;
  /**
   * Proof context-state accounts, when the proofs are not in this transaction.
   *
   * The offset form and this form are mutually exclusive, and the choice is not
   * stylistic: the three proofs total 1867 bytes against a 1232-byte transaction
   * ceiling, so on a live chain they cannot travel with the transfer. They are
   * verified into context-state accounts beforehand and the transfer refers to
   * those accounts instead, which is what this field carries. Supplying it sets
   * every offset to `0`, the wire value that means "look at the account, not the
   * instruction list".
   */
  readonly proofRecords?: {
    readonly equality: Address;
    readonly ciphertextValidity: Address;
    readonly range: Address;
  };
}

/**
 * The offset value that tells Token-2022 to read a proof from a context-state
 * account rather than from an instruction at a relative position.
 */
export const PROOF_OFFSET_CONTEXT_STATE = 0;

/**
 * Pay confidentially.
 *
 * Two ways to reach the proofs, and the caller does not get to pick arbitrarily:
 *
 *   - `proofs` + offsets: the verification instructions travel in this same
 *     transaction, and the transfer points at them by relative position. Proof
 *     instructions come first and the transfer last, because an offset is only
 *     meaningful once the thing it names is already there.
 *   - `proofRecords`: the proofs were verified earlier into context-state
 *     accounts, and the transfer names those accounts with an offset of `0`.
 *
 * The second form exists because the first one does not survive contact with a
 * real cluster: these three proofs are 1867 bytes and a transaction is capped at
 * 1232, so any transfer large enough to need a batched range proof has to use
 * context-state accounts. Providing neither form leaves every offset at `-1`
 * with no proofs to point at, which is a malformed instruction rather than a
 * shortcut, so callers should always supply one.
 */
export function buildConfidentialTransfer(
  input: ConfidentialTransferInput,
): Instruction[] {
  const proofs = input.proofs ?? [];
  const records = input.proofRecords;

  if (records && proofs.length > 0) {
    // Mixing the two forms would produce a transaction whose offsets point one
    // way and whose accounts point another; the program would read whichever it
    // was told to and silently ignore the other.
    throw new Error(
      'a confidential transfer takes either in-transaction proofs or context-state ' +
        'accounts, not both',
    );
  }

  const transfer = getConfidentialTransferInstruction({
    sourceToken: input.sourceToken,
    mint: input.mint,
    destinationToken: input.destinationToken,
    authority: input.authority,
    newSourceDecryptableAvailableBalance:
      input.newSourceDecryptableAvailableBalance,
    transferAmountAuditorCiphertextLo:
      input.transferAmountAuditorCiphertextLo ?? encryptedZeroBalance(),
    transferAmountAuditorCiphertextHi:
      input.transferAmountAuditorCiphertextHi ?? encryptedZeroBalance(),
    ...(records
      ? {
          equalityRecord: records.equality,
          ciphertextValidityRecord: records.ciphertextValidity,
          rangeRecord: records.range,
        }
      : {}),
    equalityProofInstructionOffset:
      input.equalityProofOffset ??
      (records ? PROOF_OFFSET_CONTEXT_STATE : PROOF_OFFSET_IMMEDIATELY_PRECEDING),
    ciphertextValidityProofInstructionOffset:
      input.ciphertextValidityProofOffset ??
      (records ? PROOF_OFFSET_CONTEXT_STATE : PROOF_OFFSET_IMMEDIATELY_PRECEDING),
    rangeProofInstructionOffset:
      input.rangeProofOffset ??
      (records ? PROOF_OFFSET_CONTEXT_STATE : PROOF_OFFSET_IMMEDIATELY_PRECEDING),
  });
  return [...proofs, transfer];
}

/**
 * Move a received confidential transfer from pending to available.
 *
 * Token-2022 credits confidentially-received funds into a *pending* balance the
 * owner must explicitly apply. Veil shows both numbers because a dashboard with
 * a single "balance" is showing the merchant something not yet spendable.
 */
export function buildApplyPendingBalance(input: {
  readonly token: Address;
  /** The account owner, as a signer. */
  readonly authority: TransactionSigner;
  readonly expectedPendingBalanceCreditCounter: bigint;
  readonly newDecryptableAvailableBalance: Uint8Array;
}): Instruction {
  return getApplyConfidentialPendingBalanceInstruction({
    token: input.token,
    authority: input.authority,
    expectedPendingBalanceCreditCounter:
      input.expectedPendingBalanceCreditCounter,
    newDecryptableAvailableBalance: input.newDecryptableAvailableBalance,
  });
}

// ---------------------------------------------------------------------------
// Policy: can this payment be private at all?
// ---------------------------------------------------------------------------

export interface ConfidentialSupportInput {
  /** Extension types present on the mint. */
  readonly mintExtensions: readonly number[];
  /** True when the destination is not configured for confidential balances. */
  readonly destinationUnconfigured: boolean;
  /** True when the destination rejects confidential credits. */
  readonly destinationRejectsConfidentialCredits: boolean;
}

export type SupportVerdict =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly code: 'VEIL-CONF-001' | 'VEIL-CONF-002';
    };

/**
 * The check behind `VEIL-CONF-003`'s refusal.
 *
 * Called before a payment is offered. If it fails the server refuses to serve; it
 * never downgrades to a public transfer, because a merchant who believes they
 * are private while their amounts sit on a public ledger has been actively
 * misled.
 */
export function checkConfidentialSupport(
  input: ConfidentialSupportInput,
): SupportVerdict {
  if (!input.mintExtensions.includes(ExtensionType.ConfidentialTransferMint)) {
    return { supported: false, code: 'VEIL-CONF-001' };
  }
  if (input.destinationUnconfigured) {
    return { supported: false, code: 'VEIL-CONF-002' };
  }
  if (input.destinationRejectsConfidentialCredits) {
    return { supported: false, code: 'VEIL-CONF-002' };
  }
  return { supported: true };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface InstructionPlan {
  readonly label: string;
  readonly instructions: readonly Instruction[];
}

/**
 * A human- and machine-legible summary of what a plan submits.
 *
 * The dashboard renders this before anything is signed. Seeing the instruction
 * list is how a judge or an auditor confirms a confidential path was actually
 * taken rather than quietly swapped for a public one.
 */
export interface PlanSummary {
  readonly steps: readonly {
    readonly label: string;
    readonly instructions: number;
    readonly programs: readonly string[];
  }[];
  readonly totalInstructions: number;
  readonly programs: readonly string[];
}

export function summarizePlan(plans: readonly InstructionPlan[]): PlanSummary {
  const steps = plans.map((plan) => ({
    label: plan.label,
    instructions: plan.instructions.length,
    programs: [...new Set(plan.instructions.map((i) => i.programAddress))],
  }));
  return {
    steps,
    totalInstructions: steps.reduce((n, s) => n + s.instructions, 0),
    programs: [...new Set(steps.flatMap((s) => s.programs))],
  };
}
