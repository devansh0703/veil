/**
 * `exact-confidential` as a real x402 payment scheme.
 *
 * Veil does not re-implement x402. This file is the *only* thing Veil adds to it:
 * a scheme implementation that plugs into the stock `x402Facilitator` from
 * `@x402/core`. Registration, the verify/settle lifecycle, hook dispatch, the
 * `/supported` response, deduplication of concurrent settles, fee-payer
 * transaction signing and broadcast all come from x402's own code and from
 * `@x402/svm`'s `FacilitatorSvmSigner`. What is genuinely ours is the part that
 * is genuinely new: understanding a *confidential transfer* well enough to say
 * whether it pays the account the merchant asked it to pay.
 *
 * Why the split matters: an earlier version of Veil hand-rolled its own
 * verification and broadcast. That works until an integrator points a stock x402
 * client at it, at which point every difference from the spec is a bug they have
 * to find for us. Registering into the framework instead means a merchant can
 * mount Veil next to `exact` on the same facilitator, and a payer's stock client
 * speaks to it unchanged.
 *
 * The honest boundary, stated once here so it is not discovered later: a
 * confidential transfer carries an *encrypted* amount. This scheme verifies
 * everything the chain makes public — the destination, the mint, the fact that
 * the accompanying proofs are present and are the ones Token-2022 requires, and
 * that the transaction simulates successfully — but the amount itself is not
 * readable from the wire by anyone, including this facilitator. That is the
 * product, not a gap in it. Verifying the *amount* is the merchant's job, done
 * by decrypting its own balance with its own key; see `README.md`.
 */

import { x402Facilitator } from '@x402/core/facilitator';
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import {
  SettlementCache,
  decodeTransactionFromPayload,
  transactionMessageHash,
  type FacilitatorSvmSigner,
} from '@x402/svm';
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';

import {
  TOKEN_2022_PROGRAM_ADDRESS,
  VEIL_SCHEME,
  normalizeNetwork,
  type Network,
} from '../../x402-core/src/index.ts';

/** Token-2022's dispatcher byte for the confidential-transfer instruction family. */
const CONFIDENTIAL_TRANSFER_IX = 27;
/** The sub-discriminator inside that family for an actual transfer. */
const CONFIDENTIAL_TRANSFER_OP = 7;

/**
 * The parts of a decompiled transaction this scheme reads.
 *
 * Declared structurally rather than imported so the *reasoning* is legible: Veil
 * looks at a program id, at instruction data's first two bytes, and at the ordered
 * account list. Nothing else about the transaction is interpreted, which is the
 * property that makes this verifier auditable.
 */
interface DecompiledInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly { readonly address: string }[];
  readonly data?: Uint8Array;
}

interface DecompiledMessage {
  readonly feePayer?: { readonly address: string } | string;
  readonly instructions: readonly DecompiledInstruction[];
}

function addressOf(value: { readonly address: string } | string | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : value.address;
}

export interface ConfidentialSvmSchemeOptions {
  /** x402's own SVM signer: fee payer, signer, broadcaster, simulator. */
  readonly signer: FacilitatorSvmSigner;
  /**
   * Resolve a payment account to the merchant alias that owns it, or `undefined`.
   *
   * Without this, a facilitator is a generic x402 facilitator that accepts any
   * destination. With it, Veil can say *whose* account was paid — which is what
   * makes the surrounding merchant server's attribution check meaningful, and
   * what lets a refusal name the reason instead of blaming the payer.
   */
  readonly owner?: (address: string) => string | undefined;
  /**
   * Simulate before settling. Default `true`.
   *
   * The proofs inside a confidential transfer are checked by the chain, not by
   * this code. Simulating is how we learn the difference between "well-formed"
   * and "will actually settle" *before* spending a signature and a fee.
   */
  readonly simulate?: boolean;
  /**
   * Drop a settle whose key is already in flight. Shared with any other scheme
   * instance so a duplicate submission through a different version still collides.
   */
  readonly settlements?: SettlementCache;
}

/**
 * Verification that reports *why* it failed.
 *
 * The reason strings are stable and machine-readable on purpose: a merchant
 * choosing whether to ask the payer to retry needs to distinguish "your proofs
 * are invalid" from "you paid the wrong account", and both from "this facilitator
 * was never going to be able to sign that".
 */
function invalid(reason: string, message: string, payer?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, invalidMessage: message, ...(payer ? { payer } : {}) };
}

export class ConfidentialSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = VEIL_SCHEME;
  readonly caipFamily = 'solana:*';

  readonly #signer: FacilitatorSvmSigner;
  readonly #owner: ((address: string) => string | undefined) | undefined;
  readonly #simulate: boolean;
  readonly #settlements: SettlementCache;

  constructor(options: ConfidentialSvmSchemeOptions) {
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
  getExtra(_network: string): Record<string, unknown> | undefined {
    const [feePayer] = this.#signer.getAddresses();
    return {
      ...(feePayer ? { feePayer } : {}),
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      privacy: 'confidential-balances',
    };
  }

  getSigners(_network: string): string[] {
    return [...this.#signer.getAddresses()];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = payload.payload?.transaction;
    if (typeof raw !== 'string' || raw.length === 0) {
      return invalid(
        'invalid_payload',
        'payload.payload.transaction must be a base64 signed Solana transaction',
      );
    }
    const wire: string = raw;

    let decoded: ReturnType<typeof decodeTransactionFromPayload>;
    let message: DecompiledMessage;
    try {
      decoded = decodeTransactionFromPayload({ transaction: wire });
      const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
      message = decompileTransactionMessage(compiled) as unknown as DecompiledMessage;
    } catch (error) {
      return invalid(
        'invalid_transaction',
        `the transaction could not be decoded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // A facilitator is the fee payer. If the payer built a transaction naming
    // somebody else, settling it would require a key we do not hold, and failing
    // at that point would have wasted the payer's time — so it is checked first.
    const feePayer = addressOf(message.feePayer);
    const signers = this.#signer.getAddresses().map(String);
    if (feePayer === null || !signers.includes(feePayer)) {
      return invalid(
        'fee_payer_not_facilitator',
        `the transaction's fee payer (${feePayer ?? 'missing'}) is not one of this facilitator's signers (${signers.join(
          ', ',
        )}). Build the payment with the feePayer from /supported.`,
      );
    }

    const transfers = message.instructions.filter(
      (instruction) =>
        instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
        instruction.data?.[0] === CONFIDENTIAL_TRANSFER_IX &&
        instruction.data?.[1] === CONFIDENTIAL_TRANSFER_OP,
    );
    if (transfers.length === 0) {
      return invalid(
        'no_confidential_transfer',
        'the transaction contains no Token-2022 confidential transfer instruction, so it cannot settle an exact-confidential payment',
      );
    }
    if (transfers.length > 1) {
      // Refusing ambiguity rather than picking one: with two transfers in one
      // transaction there is no way to know which one the payer means, and
      // guessing would let a payer attach a large transfer and a small one and
      // have the merchant verify the wrong one.
      return invalid(
        'ambiguous_confidential_transfer',
        `the transaction contains ${transfers.length} confidential transfers; a payment must contain exactly one`,
      );
    }

    const transfer = transfers[0]!;
    const accounts = (transfer.accounts ?? []).map((account) => account.address);
    // Token-2022's confidential transfer takes (source, mint, destination, …).
    const [source, mint, destination] = accounts;
    if (!source || !mint || !destination) {
      return invalid(
        'malformed_transfer',
        `a confidential transfer needs at least source, mint and destination accounts; got ${accounts.length}`,
      );
    }

    if (destination !== requirements.payTo) {
      return invalid(
        'wrong_destination',
        `the transfer pays ${destination}, but the requirements name ${requirements.payTo}`,
      );
    }
    if (mint !== requirements.asset) {
      return invalid(
        'wrong_mint',
        `the transfer moves ${mint}, but the requirements are denominated in ${requirements.asset}`,
      );
    }
    if (!requirements.network.includes(':')) {
      return invalid(
        'wrong_network',
        `network must be CAIP-2 (e.g. solana:testnet), got ${String(requirements.network)}`,
      );
    }

    // The authority on the transfer is the payer. Reported rather than guessed:
    // x402 surfaces `payer` in the verify and settle responses, and a merchant
    // logging it deserves the address that actually signed the source account.
    const authority = accounts[accounts.length - 1] ?? null;

    if (this.#simulate) {
      try {
        await this.#signer.simulateTransaction(wire, requirements.network as string);
      } catch (error) {
        return invalid(
          'simulation_failed',
          `the transfer would not settle: ${
            error instanceof Error ? error.message : String(error)
          }`,
          authority ?? undefined,
        );
      }
    }

    if (this.#owner) {
      const owner = this.#owner(requirements.payTo);
      if (owner === undefined) {
        return invalid(
          'unowned_destination',
          `${requirements.payTo} is not a payment account this facilitator can attribute to a merchant`,
          authority ?? undefined,
        );
      }
    }

    return { isValid: true, ...(authority ? { payer: authority } : {}) };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network as Network;
    // Normalised once, here, so the two `unknown`s in the payload never reach
    // x402's signer API untyped.
    const wireValue = payload.payload?.transaction;
    const wire: string = typeof wireValue === 'string' ? wireValue : '';

    // Idempotency before the first await: Node is single-threaded, so a check and
    // an insert with no await between them cannot interleave. Two concurrent
    // settles of the same payment therefore become one broadcast and one refusal,
    // instead of two of each.
    let key: string | null = null;
    if (wire.length > 0) {
      try {
        key = transactionMessageHash(
          decodeTransactionFromPayload({ transaction: wire }),
        );
        if (this.#settlements.isDuplicate(key)) {
          return {
            success: false,
            errorReason: 'duplicate_settlement',
            errorMessage: 'this payment is already being settled',
            transaction: '',
            network,
          };
        }
      } catch {
        // An undecodable transaction is verify()'s problem to report, not
        // settle()'s to throw over; it will fail there with a real reason.
        key = null;
      }
    }

    try {
      const verdict = await this.verify(payload, requirements);
      if (!verdict.isValid) {
        return {
          success: false,
          errorReason: verdict.invalidReason ?? 'invalid_payment',
          errorMessage: verdict.invalidMessage ?? 'payment verification failed',
          ...(verdict.payer ? { payer: verdict.payer } : {}),
          transaction: '',
          network,
        };
      }

      const [feePayer] = this.#signer.getAddresses();
      if (!feePayer) {
        return {
          success: false,
          errorReason: 'no_fee_payer',
          errorMessage: 'this facilitator has no signer configured',
          transaction: '',
          network,
        };
      }

      // x402's signer does the work: it signs as fee payer, broadcasts, and waits
      // for confirmation. Veil supplies no transaction-building logic here, which
      // is deliberate — the payer signed specific bytes and we must send exactly
      // those.
      const signed = await this.#signer.signTransaction(wire, feePayer, network as string);
      const signature = await this.#signer.sendTransaction(signed, network as string);
      await this.#signer.confirmTransaction(signature, network as string);

      return {
        success: true,
        transaction: signature,
        network,
        ...(verdict.payer ? { payer: verdict.payer } : {}),
        extra: {
          // Enough for a merchant to reconcile without trusting our word.
          privacy: 'confidential-balances',
          program: TOKEN_2022_PROGRAM_ADDRESS,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        },
      };
    } catch (error) {
      // A settle that failed may be retried with the same bytes, so the key is
      // released — but only after the throw, never on the duplicate path, where
      // releasing it would readmit the very race the cache exists to stop.
      if (key !== null) this.#settlements.delete(key);
      return {
        success: false,
        errorReason: 'settlement_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        transaction: '',
        network,
      };
    }
  }
}

export interface VeilFacilitator {
  /** x402's facilitator, with `exact-confidential` registered on it. */
  readonly facilitator: x402Facilitator;
  readonly scheme: ConfidentialSvmScheme;
}

/**
 * Register Veil's scheme on a stock x402 facilitator.
 *
 * One call, and the facilitator it returns answers `/verify`, `/settle` and
 * `/supported` exactly as any other x402 facilitator does. That is the whole
 * integration story for a merchant: mount Veil beside `exact`, not instead of it.
 */
export function createVeilFacilitator(input: {
  readonly signer: FacilitatorSvmSigner;
  readonly networks: Network | readonly Network[];
  readonly owner?: (address: string) => string | undefined;
  readonly simulate?: boolean;
  readonly settlements?: SettlementCache;
}): VeilFacilitator {
  const scheme = new ConfidentialSvmScheme({
    signer: input.signer,
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.simulate !== undefined ? { simulate: input.simulate } : {}),
    ...(input.settlements ? { settlements: input.settlements } : {}),
  });
  // Registered under the identifiers x402 dispatches on. The 402 bodies Veil
  // emits carry normalised (genesis-hash) networks, so registering the raw
  // configured name would make every real verify fail with "No facilitator
  // registered for scheme … network" — a lookup miss, not a payment problem.
  const networks = (
    Array.isArray(input.networks) ? input.networks : [input.networks]
  ).map((network) => normalizeNetwork(network));
  const facilitator = new x402Facilitator();
  facilitator.register(networks, scheme);
  return { facilitator, scheme };
}
