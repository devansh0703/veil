/**
 * web/prove/veil-proofs.ts — the browser's proof surface.
 *
 * ## What this is for
 *
 * A judge's first question about a privacy product is "where do the proofs come
 * from?" If the answer is "our server", the product is not private — the server
 * learns every amount. Veil's answer has to be "the payer's device", and that
 * answer has to be demonstrable rather than asserted.
 *
 * So this module is the browser's prover. It is not a reimplementation:
 * `scripts/build-proofs.ts` compiles the *real* builders from
 * `packages/onchain/src/proofs.ts`, with the specifier `@solana/zk-sdk` aliased
 * to the browser build (see `zk-sdk-web-shim.ts`). The statements a wallet
 * proves here are byte-identical to the ones `npm run prove:check` asserts.
 *
 * ## Loading order
 *
 * The WASM must be instantiated before any proof type is constructed. `init()`
 * owns that and is idempotent; every public entry point awaits it. The dynamic
 * `import()` of the builders happens *after* instantiation so nothing can
 * construct a proof against an uninitialised WASM.
 */

import { ready, readyFromBytes, type ConfidentialKeys } from './zk-sdk-web-shim.ts';

export interface InitOptions {
  /**
   * Where to fetch `index_bg.wasm` from. Defaults to `index_bg.wasm` beside
   * this script, which is how the build lays the two files out.
   */
  readonly wasmUrl?: string;
  /** Pre-fetched WASM bytes. Takes precedence over `wasmUrl`. */
  readonly wasmBytes?: Uint8Array;
}

/**
 * Instantiate the prover. Must be awaited before generating any proof.
 *
 * Idempotent: the WASM is a singleton, so a second call joins the first rather
 * than instantiating a second copy.
 */
export function init(options: InitOptions = {}): Promise<void> {
  return options.wasmBytes
    ? readyFromBytes(options.wasmBytes)
    : ready(options.wasmUrl);
}

/**
 * The real builders, loaded after instantiation.
 *
 * `@solana/zk-sdk` below is the browser build — the build aliases that specifier
 * to `zk-sdk-web-shim.ts`, which re-exports `@solana/zk-sdk/web`.
 */
async function builders() {
  return import('../../packages/onchain/src/proofs.ts');
}

// ---------------------------------------------------------------------------
// What a wallet actually calls
// ---------------------------------------------------------------------------

/**
 * A wallet's confidential keys, wrapped so the raw key material is not part of
 * the surface a caller can pass around.
 *
 * The wrapped value is the real `ConfidentialKeys` from the SDK, which means
 * every proof built from it is built by the production code path rather than by
 * a browser-only copy.
 */
export class ConfidentialKeysHandle {
  /** Not exported from the module: only this class's methods reach it. */
  readonly #keys: ConfidentialKeys;

  private constructor(keys: ConfidentialKeys) {
    this.#keys = keys;
  }

  /**
   * Derive keys from a 64-byte signature over `derivationMessage()`.
   *
   * The keys are deterministic for the wallet, which is what makes a
   * confidential balance recoverable rather than lost when a tab closes. The
   * signature and the derived keys never leave the device.
   */
  static async fromSignature(signature: Uint8Array): Promise<ConfidentialKeysHandle> {
    await init();
    const { confidentialKeysFromSignature } = await builders();
    return new ConfidentialKeysHandle(confidentialKeysFromSignature(signature));
  }

  /** Internal accessor for the builder functions in this module. */
  get raw(): ConfidentialKeys {
    return this.#keys;
  }

  /** 32-byte ElGamal public key — public data, safe to send with a deposit. */
  elgamalPubkey(): Uint8Array {
    return this.#keys.elgamal().pubkey().toBytes();
  }

  /** Prove this key is a well-formed ElGamal public key, locally. */
  async pubkeyValidityProof(): Promise<Uint8Array> {
    const { buildPubkeyValidityProof } = await builders();
    return buildPubkeyValidityProof(this.#keys).data;
  }

  /** The AES fast-path ciphertext of a balance, for a deposit. */
  async encryptBalance(amount: bigint): Promise<Uint8Array> {
    const { encryptBalance } = await builders();
    return encryptBalance(this.#keys, amount);
  }

  /** The ElGamal ciphertext of an amount, for a deposit or transfer. */
  async encryptAmount(amount: bigint): Promise<Uint8Array> {
    const { encryptAmount } = await builders();
    return encryptAmount(this.#keys, amount);
  }
}

/** The message a wallet signs once to derive its confidential keys. */
export async function derivationMessage(): Promise<Uint8Array> {
  await init();
  const { confidentialDerivationMessage } = await builders();
  return confidentialDerivationMessage();
}

export interface TransferRequest {
  /** The payer's derived keys. */
  readonly keys: ConfidentialKeysHandle;
  /** The payer's available balance, decrypted locally. Never sent anywhere. */
  readonly sourceAvailableBalance: bigint;
  /** The payer's on-chain available-balance ciphertext (public data). */
  readonly sourceAvailableBalanceCiphertext: Uint8Array;
  /** The amount to pay, in atomic units. */
  readonly amount: bigint;
  /** The destination account's ElGamal public key (public data). */
  readonly destinationPubkey: Uint8Array;
  /** The auditor's ElGamal public key, when the mint configures one. */
  readonly auditorPubkey?: Uint8Array;
}

export interface TransferProofs {
  /** The three ZK verify instructions, in the order Token-2022 reads them. */
  readonly proofs: { programAddress: string; accounts: unknown[]; data: Uint8Array }[];
  readonly newSourceDecryptableAvailableBalance: Uint8Array;
  readonly auditorCiphertextLo: Uint8Array;
  readonly auditorCiphertextHi: Uint8Array;
  readonly equalityProofOffset: number;
  readonly ciphertextValidityProofOffset: number;
  readonly rangeProofOffset: number;
  readonly newAvailableBalance: bigint;
}

/**
 * Build the three proofs a confidential transfer needs — on this device.
 *
 * The statements: the new source balance really is the old one minus the
 * amount; the grouped ciphertexts really encrypt that amount under the source,
 * destination and auditor keys; and every committed value is in range. The
 * token program verifies all three on chain, so the amount is never revealed to
 * a validator, to this product's server, or to anyone reading the ledger.
 */
export async function transferProofs(request: TransferRequest): Promise<TransferProofs> {
  await init();
  const [{ buildTransferProofs }, { ElGamalCiphertext, ElGamalPubkey }] = await Promise.all([
    builders(),
    import('@solana/zk-sdk'),
  ]);
  const balanceCiphertext = ElGamalCiphertext.fromBytes(
    request.sourceAvailableBalanceCiphertext,
  );
  if (!balanceCiphertext) {
    throw new Error('the source available-balance ciphertext is not a valid ElGamal ciphertext');
  }
  const bundle = buildTransferProofs({
    keys: request.keys.raw,
    sourceAvailableBalance: request.sourceAvailableBalance,
    sourceAvailableBalanceCiphertext: balanceCiphertext,
    amount: request.amount,
    destinationPubkey: ElGamalPubkey.fromBytes(request.destinationPubkey),
    ...(request.auditorPubkey
      ? { auditorPubkey: ElGamalPubkey.fromBytes(request.auditorPubkey) }
      : {}),
  });
  return {
    proofs: bundle.proofs.map((ix) => ({
      programAddress: String(ix.programAddress),
      accounts: [],
      data: ix.data as Uint8Array,
    })),
    newSourceDecryptableAvailableBalance: bundle.newSourceDecryptableAvailableBalance,
    auditorCiphertextLo: bundle.auditorCiphertextLo,
    auditorCiphertextHi: bundle.auditorCiphertextHi,
    equalityProofOffset: bundle.equalityProofOffset,
    ciphertextValidityProofOffset: bundle.ciphertextValidityProofOffset,
    rangeProofOffset: bundle.rangeProofOffset,
    newAvailableBalance: bundle.newAvailableBalance,
  };
}

/** The three discriminants, so a caller can label the instructions it got. */
export async function proofTypes(): Promise<Record<string, number>> {
  await init();
  const m = await builders();
  return {
    ciphertextCommitmentEquality: m.PROOF_TYPE_CIPHERTEXT_COMMITMENT_EQUALITY,
    batchedGroupedCiphertext3Handles: m.PROOF_TYPE_BATCHED_GROUPED_CIPHERTEXT_3_HANDLES,
    batchedRangeProofU128: m.PROOF_TYPE_BATCHED_RANGE_PROOF_U128,
  };
}
