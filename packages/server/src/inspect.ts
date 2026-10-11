/**
 * Does this transaction actually settle a payment confidentially?
 *
 * Veil's promise is one sentence — *it never settles a payment in the clear* —
 * and the 402 gate only enforces half of it. The gate checks the mint and the
 * destination account (VEIL-CONF-001/002), which are the preconditions for a
 * confidential transfer being *possible*. It says nothing about the transaction
 * the payer actually signed: a payer can hold a perfectly armed seat, answer a
 * perfectly valid offer, and still hand over a transaction containing a plain
 * SPL `Transfer` whose amount is public.
 *
 * The scheme path (`scheme.ts`, the x402 facilitator) has always refused that
 * shape. The resource server settles inline, so it needed the same reading — and
 * this module is it. It exists separately from `scheme.ts` because the two have
 * different jobs: the facilitator verifies against x402's `PaymentRequirements`
 * and simulates; the resource server reads a transaction it is about to cosign
 * and broadcast itself.
 *
 * What it reads is deliberately tiny, because a small reader is an auditable one:
 *
 *   - the program id of each instruction (Token-2022 only),
 *   - the first two bytes of that instruction's data (the confidential-transfer
 *     family and operation discriminators),
 *   - the ordered account list (source, mint, destination, …).
 *
 * Nothing about the amount is interpreted, because nothing about the amount is
 * readable: Token-2022 confidential transfers carry ElGamal ciphertext and the
 * chain verifies the accompanying zk proofs. That is the product, and this
 * module's job is to confirm the *shape* — that a confidential transfer is the
 * thing paying here — not to decrypt anything.
 *
 * ## Two kinds of failure, and why they are different
 *
 * `not-confidential` is a reading: the transaction decoded, and what it contains
 * is not a confidential transfer. That is a refusal on its own terms, and it is
 * a *confidentiality assertion failure* — the counter `confidential_assertion_failures`
 * exists to make it visible, because it is the exact event Veil claims cannot
 * happen.
 *
 * `opaque` is the absence of a reading: the bytes did not decode into a message.
 * Veil cannot assert confidentiality about a transaction it could not read, and
 * `'unknown'` is never a pass here — but the *consequence* depends on whether a
 * chain settlement was going to happen at all. A deployment with an RPC is about
 * to broadcast, so it refuses. A chain-free local run (the protocol demo, whose
 * placeholder transactions are documented as placeholders and which reports
 * itself as `local-ledger-only` everywhere) is not claiming a chain fact about
 * those bytes, so it does not refuse them. Reporting the mode is what keeps that
 * distinction honest rather than convenient: `/.well-known/veil` and `/v1/health`
 * both say which mode is running.
 */

import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { decodeTransactionFromPayload } from '@x402/svm';

import { TOKEN_2022_PROGRAM_ADDRESS } from '../../x402-core/src/index.ts';

/** Token-2022's dispatcher byte for the confidential-transfer instruction family. */
export const CONFIDENTIAL_TRANSFER_FAMILY = 27;
/** The sub-discriminator inside that family for an actual transfer. */
export const CONFIDENTIAL_TRANSFER_OP = 7;

/**
 * The parts of a decompiled transaction this reader looks at.
 *
 * Declared structurally rather than imported so the reasoning stays legible:
 * a program id, two discriminator bytes, and the ordered account list. Declaring
 * it this way also means a kit upgrade that reshapes the message type fails the
 * comparison loudly rather than silently reading `undefined` and calling every
 * payment confidential.
 */
interface DecompiledInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly { readonly address: string }[];
  readonly data?: Uint8Array;
}

interface DecompiledMessage {
  readonly instructions: readonly DecompiledInstruction[];
}

export type TransferInspection =
  | {
      readonly ok: true;
      /** Account the value leaves. */
      readonly source: string;
      /** Mint the value is denominated in. */
      readonly mint: string;
      /** Account the value arrives in — the one that must be ours. */
      readonly destination: string;
      /** Last account in the list: the source account's authority. */
      readonly authority: string | null;
    }
  | {
      readonly ok: false;
      /** No reading was possible. Not an assertion failure on its own. */
      readonly kind: 'opaque';
      readonly reason: string;
    }
  | {
      readonly ok: false;
      /** A reading was possible, and it is not a confidential transfer. */
      readonly kind: 'not-confidential';
      readonly reason: string;
    };

/**
 * Read a base64 wire transaction and report what is paying.
 *
 * Never throws: a caller deciding whether to broadcast cannot be handed an
 * exception where a refusal belongs, and every failure mode here has a reason
 * string that a payer can act on.
 */
export function inspectConfidentialTransfer(wire: string): TransferInspection {
  if (typeof wire !== 'string' || wire.length === 0) {
    return { ok: false, kind: 'opaque', reason: 'the payload carries no transaction bytes' };
  }

  let message: DecompiledMessage;
  try {
    const decoded = decodeTransactionFromPayload({ transaction: wire });
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    message = decompileTransactionMessage(compiled) as unknown as DecompiledMessage;
  } catch (error) {
    return {
      ok: false,
      kind: 'opaque',
      reason: `the transaction could not be decoded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const instructions = message.instructions ?? [];
  const transfers = instructions.filter(
    (instruction) =>
      instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
      instruction.data?.[0] === CONFIDENTIAL_TRANSFER_FAMILY &&
      instruction.data?.[1] === CONFIDENTIAL_TRANSFER_OP,
  );

  if (transfers.length === 0) {
    // The interesting negative, and the one that would let a merchant be paid in
    // public while believing otherwise. Naming the instruction we looked for is
    // the difference between a payer fixing its client and guessing.
    const programs = [...new Set(instructions.map((i) => i.programAddress))];
    return {
      ok: false,
      kind: 'not-confidential',
      reason:
        'the transaction contains no Token-2022 confidential transfer instruction, so its amount would be public. ' +
        `Programs invoked: ${programs.length > 0 ? programs.join(', ') : 'none'}. ` +
        'Build the payment with a confidential transfer (family 27, operation 7) or Veil will not settle it.',
    };
  }

  if (transfers.length > 1) {
    // Refusing ambiguity rather than picking one: two transfers in one
    // transaction means there is no way to know which one was meant, and picking
    // would let a payer attach a large transfer and a small one and have the
    // merchant credit the wrong one.
    return {
      ok: false,
      kind: 'not-confidential',
      reason: `the transaction contains ${transfers.length} confidential transfers; a payment must contain exactly one`,
    };
  }

  const accounts = (transfers[0]!.accounts ?? []).map((account) => account.address);
  // Token-2022's confidential transfer takes (source, mint, destination, …).
  const [source, mint, destination] = accounts;
  if (!source || !mint || !destination) {
    return {
      ok: false,
      kind: 'not-confidential',
      reason: `a confidential transfer needs at least source, mint and destination accounts; got ${accounts.length}`,
    };
  }

  return {
    ok: true,
    source,
    mint,
    destination,
    authority: accounts[accounts.length - 1] ?? null,
  };
}

/**
 * Does this transaction pay this exact account in this exact mint?
 *
 * The composition the settlement path actually needs: a reading that is
 * confidential *and* pointed where the merchant asked. Split from
 * {@link inspectConfidentialTransfer} so the account comparison stays visible at
 * the call site — a payment that is confidential but pays the wrong account is a
 * different bug from one that is not confidential at all, and the refusal says
 * which.
 */
export function inspectPaymentTransaction(
  wire: string,
  expected: { readonly payTo: string; readonly mint: string },
): TransferInspection {
  const reading = inspectConfidentialTransfer(wire);
  if (!reading.ok) return reading;
  if (reading.destination !== expected.payTo) {
    return {
      ok: false,
      kind: 'not-confidential',
      reason: `the confidential transfer pays ${reading.destination}, but this payment was offered the account ${expected.payTo}`,
    };
  }
  if (reading.mint !== expected.mint) {
    return {
      ok: false,
      kind: 'not-confidential',
      reason: `the confidential transfer moves ${reading.mint}, but this merchant settles in ${expected.mint}`,
    };
  }
  return reading;
}
