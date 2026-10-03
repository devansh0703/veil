/**
 * The `exact-confidential` scheme, tested without a chain.
 *
 * Every case here builds a real Solana transaction offline, encodes it to the
 * same wire bytes a payer would send, and hands it to the scheme through x402's
 * *own* `x402Facilitator` — not by calling our methods directly. That distinction
 * is the point: these tests fail if Veil's scheme stops being dispatchable by the
 * stock framework, which is the property a merchant actually depends on.
 *
 * Simulation is disabled in the fixture. Simulating would need an RPC endpoint and
 * would test Solana rather than this verifier; the real simulation path is
 * exercised by the funded end-to-end script.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { FacilitatorSvmSigner } from '@x402/svm';

import { buildApplyPendingBalance, buildConfidentialTransfer } from '../../onchain/src/index.ts';
import { PLACEHOLDER_MINT, TOKEN_2022_PROGRAM_ADDRESS, normalizeNetwork } from '../../x402-core/src/index.ts';
import { ConfidentialSvmScheme, createVeilFacilitator } from './scheme.ts';

const FEE_PAYER = '3RWhpyX2JaE89UWqxM8LRsB3xykSVwHyEvBmgdo9N1FJ' as Address;
const OTHER_FEE_PAYER = 'HYLLJkNr7LpEGa8Eck8EP9vqNxHv1y8z71A7FLKUiHgc' as Address;
const SOURCE = '8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21' as Address;
const DESTINATION = '5QU2gN1M3cQTSQr5xRcSJWyo669s71Wco3ZFjFHMkgKX' as Address;
const FOREIGN_DESTINATION = 'DKxzFxrLgCQnaHrUWyCieDqpnydkTi7Mg3ugkvH1Mvf' as Address;
/**
 * The network a deployment configures, and the one x402 dispatches on.
 *
 * Both spellings are the same chain. Veil normalises on the way out, so a
 * requirements body built from `solana:testnet` reaches the facilitator as its
 * genesis hash — which is what registration matches against.
 */
const NETWORK = normalizeNetwork('solana:testnet');

/** The signature the fake signer reports after broadcasting. */
const SENT_SIGNATURE = '5'.repeat(88);

/**
 * A 64-byte signature slot.
 *
 * Cast because kit brands signature bytes nominally. The value is never
 * verified — a decoded transaction's signatures are not what this verifier
 * reads, and a real payer's signature cannot be produced without its key.
 */
const PLACEHOLDER_SIGNATURE_BYTES = new Uint8Array(64).fill(7) as never;

/**
 * A facilitator signer that signs nothing.
 *
 * It records the calls it received, so the tests can assert on *behaviour* — that
 * settle signed as this fee payer and confirmed the transaction it broadcast —
 * rather than only on return values.
 */
function fakeSigner(options: { readonly simulateFails?: string } = {}): FacilitatorSvmSigner & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    getAddresses: () => [FEE_PAYER],
    signTransaction: async (transaction: string, feePayer: Address) => {
      calls.push(`sign:${feePayer}`);
      return transaction;
    },
    simulateTransaction: async (transaction: string, network: string) => {
      calls.push(`simulate:${network}`);
      if (options.simulateFails) throw new Error(options.simulateFails);
    },
    sendTransaction: async () => {
      calls.push('send');
      return SENT_SIGNATURE;
    },
    confirmTransaction: async () => {
      calls.push('confirm');
      return { slot: 1n };
    },
  };
}

/** Build, compile and encode a transaction exactly as a payer's client would. */
function wire(
  instructions: readonly Instruction[],
  feePayer: Address = FEE_PAYER,
): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const compiled = compileTransaction(message);
  return getBase64EncodedWireTransaction({
    ...compiled,
    signatures: { [feePayer]: PLACEHOLDER_SIGNATURE_BYTES },
  });
}

function confidentialTransfer(input: {
  readonly destination?: Address;
  readonly mint?: Address;
  readonly authority?: Address;
} = {}): readonly Instruction[] {
  return buildConfidentialTransfer({
    sourceToken: SOURCE,
    // The same mint the requirements are denominated in. `PLACEHOLDER_MINT` is
    // typed as a plain string by the protocol core, which is the right type for a
    // wire field; the on-chain builder wants a branded address.
    mint: input.mint ?? (PLACEHOLDER_MINT as unknown as Address),
    destinationToken: input.destination ?? DESTINATION,
    // Only the address ends up in the compiled account list, which is all this
    // verifier reads.
    authority: { address: input.authority ?? SOURCE } as never,
    newSourceDecryptableAvailableBalance: new Uint8Array(36),
  });
}

const requirements: PaymentRequirements = {
  scheme: 'exact-confidential',
  network: NETWORK,
  asset: PLACEHOLDER_MINT,
  amount: '49000',
  payTo: DESTINATION,
  maxTimeoutSeconds: 60,
  extra: { privacy: 'confidential-balances', decimals: 6, poolIndex: 0 },
};

function payloadFor(transaction: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction },
  };
}

/** Submit through x402's own facilitator, so dispatch is under test too. */
function facilitatorFor(signer: FacilitatorSvmSigner, owner?: (a: string) => string | undefined) {
  return createVeilFacilitator({
    signer,
    networks: [NETWORK],
    simulate: false,
    ...(owner ? { owner } : {}),
  }).facilitator;
}

describe('exact-confidential scheme — what it advertises', () => {
  test('is registered on a stock x402 facilitator, under the CAIP-2 network', () => {
    const { facilitator } = createVeilFacilitator({
      signer: fakeSigner(),
      networks: [NETWORK],
      simulate: false,
    });
    const supported = facilitator.getSupported();
    const kind = supported.kinds.find((k) => k.scheme === 'exact-confidential');
    assert.ok(kind, `expected the scheme to be registered: ${JSON.stringify(supported.kinds)}`);
    assert.equal(kind.network, NETWORK);
  });

  test('a friendly network name registers as, and dispatches on, the genesis hash', async () => {
    // Regression: registration once used the configured name verbatim while the
    // 402 bodies carried the genesis hash, so x402's own dispatcher threw
    // "No facilitator registered for scheme … network" on every real payment.
    const { facilitator } = createVeilFacilitator({
      signer: fakeSigner(),
      networks: ['solana:testnet' as never],
      simulate: false,
    });
    const kind = facilitator
      .getSupported()
      .kinds.find((k) => k.scheme === 'exact-confidential');
    assert.equal(kind?.network, NETWORK);

    const verdict = await facilitator.verify(
      payloadFor(wire(confidentialTransfer())),
      requirements,
    );
    assert.equal(verdict.isValid, true, verdict.invalidMessage);
  });

  test('tells a client the fee payer, the token program and the privacy model', () => {
    const scheme = new ConfidentialSvmScheme({ signer: fakeSigner(), simulate: false });
    const extra = scheme.getExtra(NETWORK);
    assert.equal(extra?.feePayer, FEE_PAYER);
    assert.equal(extra?.tokenProgram, TOKEN_2022_PROGRAM_ADDRESS);
    assert.equal(extra?.privacy, 'confidential-balances');
    assert.deepEqual(scheme.getSigners(NETWORK), [FEE_PAYER]);
  });
});

describe('exact-confidential scheme — verification', () => {
  test('accepts a confidential transfer to the account the requirements name', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    const verdict = await facilitator.verify(
      payloadFor(wire(confidentialTransfer())),
      requirements,
    );
    assert.equal(verdict.isValid, true, verdict.invalidMessage);
    assert.equal(verdict.payer, SOURCE);
  });

  test('rejects a payment that pays a different account', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    const verdict = await facilitator.verify(
      payloadFor(wire(confidentialTransfer({ destination: FOREIGN_DESTINATION }))),
      requirements,
    );
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'wrong_destination');
  });

  test('rejects a payment in a different mint', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    const verdict = await facilitator.verify(
      payloadFor(wire(confidentialTransfer({ mint: FOREIGN_DESTINATION }))),
      requirements,
    );
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'wrong_mint');
  });

  test('rejects the same program family doing something other than a transfer', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    // `ApplyPendingBalance` is Token-2022, is discriminator 27, and is not a
    // payment. A verifier that only checked the program id would accept this.
    const verdict = await facilitator.verify(
      payloadFor(
        wire([
          buildApplyPendingBalance({
            token: DESTINATION,
            authority: { address: SOURCE } as never,
            expectedPendingBalanceCreditCounter: 0n,
            newDecryptableAvailableBalance: new Uint8Array(36),
          }),
        ]),
      ),
      requirements,
    );
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'no_confidential_transfer');
  });

  test('rejects a payment to a destination this facilitator does not own', async () => {
    const facilitator = facilitatorFor(fakeSigner(), () => undefined);
    const verdict = await facilitator.verify(payloadFor(wire(confidentialTransfer())), requirements);
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'unowned_destination');
  });

  test('accepts the same payment once the destination is attributable', async () => {
    const facilitator = facilitatorFor(fakeSigner(), (address) =>
      address === DESTINATION ? 'oracle.tide' : undefined,
    );
    const verdict = await facilitator.verify(payloadFor(wire(confidentialTransfer())), requirements);
    assert.equal(verdict.isValid, true, verdict.invalidMessage);
  });

  test('rejects a transaction this facilitator could never sign', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    const verdict = await facilitator.verify(
      payloadFor(wire(confidentialTransfer(), OTHER_FEE_PAYER)),
      requirements,
    );
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'fee_payer_not_facilitator');
  });

  test('rejects a payload with nothing to settle', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    const verdict = await facilitator.verify(
      { x402Version: 2, accepted: requirements, payload: {} },
      requirements,
    );
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'invalid_payload');
  });

  test('rejects bytes that are not a transaction', async () => {
    const facilitator = facilitatorFor(fakeSigner());
    const verdict = await facilitator.verify(
      payloadFor('not-a-transaction'),
      requirements,
    );
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'invalid_transaction');
  });

  test('turns a failed simulation into a refusal, not an exception', async () => {
    // The proofs are checked by the chain. When they are wrong, the payer must
    // hear that as a failed payment rather than as a crashed facilitator.
    const signer = fakeSigner({ simulateFails: 'custom program error: 0x1' });
    const facilitator = createVeilFacilitator({
      signer,
      networks: [NETWORK],
      simulate: true,
    }).facilitator;
    const verdict = await facilitator.verify(payloadFor(wire(confidentialTransfer())), requirements);
    assert.equal(verdict.isValid, false);
    assert.equal(verdict.invalidReason, 'simulation_failed');
    assert.match(verdict.invalidMessage ?? '', /0x1/);
  });
});

describe('exact-confidential scheme — settlement', () => {
  test('signs as the fee payer, broadcasts, and confirms', async () => {
    const signer = fakeSigner();
    const facilitator = facilitatorFor(signer);
    const result = await facilitator.settle(
      payloadFor(wire(confidentialTransfer())),
      requirements,
    );
    assert.equal(result.success, true, result.errorMessage);
    assert.equal(result.transaction, SENT_SIGNATURE);
    assert.equal(result.network, NETWORK);
    assert.equal(result.payer, SOURCE);
    // Signed as our fee payer, broadcast, then confirmed — in that order, and
    // never confirmed before it was sent.
    assert.deepEqual(signer.calls, [`sign:${FEE_PAYER}`, 'send', 'confirm']);
    assert.equal(result.extra?.privacy, 'confidential-balances');
  });

  test('never broadcasts a payment that does not verify', async () => {
    const signer = fakeSigner();
    const facilitator = facilitatorFor(signer);
    const result = await facilitator.settle(
      payloadFor(wire(confidentialTransfer({ destination: FOREIGN_DESTINATION }))),
      requirements,
    );
    assert.equal(result.success, false);
    assert.equal(result.errorReason, 'wrong_destination');
    // The important half: nothing was signed and nothing was sent.
    assert.deepEqual(signer.calls, []);
  });

  test('settling the same payment twice refuses the second attempt', async () => {
    const signer = fakeSigner();
    const facilitator = facilitatorFor(signer);
    const payload = payloadFor(wire(confidentialTransfer()));
    const first = await facilitator.settle(payload, requirements);
    const second = await facilitator.settle(payload, requirements);
    assert.equal(first.success, true, first.errorMessage);
    assert.equal(second.success, false);
    assert.equal(second.errorReason, 'duplicate_settlement');
    // One signature, one broadcast — a double-submit must not double-settle.
    assert.equal(signer.calls.filter((c) => c === 'send').length, 1);
  });

  test('a settlement that throws is reported, and released for retry', async () => {
    const signer = fakeSigner();
    signer.sendTransaction = async () => {
      throw new Error('blockhash not found');
    };
    const facilitator = createVeilFacilitator({
      signer,
      networks: [NETWORK],
      simulate: false,
    }).facilitator;
    const payload = payloadFor(wire(confidentialTransfer()));
    const failed = await facilitator.settle(payload, requirements);
    assert.equal(failed.success, false);
    assert.equal(failed.errorReason, 'settlement_failed');
    assert.match(failed.errorMessage ?? '', /blockhash not found/);

    // The dedup key was released, so a retry with the same bytes is attempted
    // again instead of being refused as a duplicate forever.
    signer.sendTransaction = async () => {
      signer.calls.push('send');
      return SENT_SIGNATURE;
    };
    const retried = await facilitator.settle(payload, requirements);
    assert.equal(retried.success, true, retried.errorMessage);
  });
});
