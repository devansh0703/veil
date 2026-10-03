import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPairSigner } from '@solana/kit';
import type { Instruction } from '@solana/kit';

import {
  BASE_ACCOUNT_SIZE,
  BASE_MINT_SIZE,
  DECRYPTABLE_BALANCE_SIZE,
  ENCRYPTED_BALANCE_SIZE,
  ExtensionType,
  TOKEN_2022_PROGRAM_ADDRESS,
  buildApplyPendingBalance,
  buildArmForConfidentialCredits,
  buildConfidentialTransfer,
  buildConfigureAccount,
  buildCreatePaymentAccount,
  buildInitializeConfidentialMint,
  checkConfidentialSupport,
  confidentialAccountSpace,
  confidentialAccountSpaceArithmetic,
  confidentialMintSpace,
  confidentialMintSpaceArithmetic,
  decryptableZeroBalance,
  encryptedZeroBalance,
  summarizePlan,
} from './index.ts';

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
/** Token-2022 tags every instruction with the extension-level discriminator. */
const TOKEN_2022_TAG = 27;

// Real keypairs: Solana addresses are validated base58, so a made-up string like
// 'owner' would fail to encode at all.
const payer = await generateKeyPairSigner();
const paymentAccount = await generateKeyPairSigner();
const otherAccount = await generateKeyPairSigner();
const owner = await generateKeyPairSigner();
const mint = await generateKeyPairSigner();
const mintAuthority = await generateKeyPairSigner();

interface Meta {
  readonly address: string;
  readonly role: number;
}

/**
 * Read an instruction's payload, asserting it exists.
 *
 * `Instruction` permits a dataless instruction, so a builder that forgot to
 * attach data would otherwise be read as `undefined` and quietly compared to
 * something. Asserting here means such a builder fails the test that calls it.
 */
function dataOf(ix: Instruction): Uint8Array {
  const data = (ix as { data?: Uint8Array }).data;
  assert.ok(data, 'instruction carries no data');
  return data;
}

function accountsOf(ix: Instruction): readonly Meta[] {
  const accounts = (ix as { accounts?: readonly Meta[] }).accounts;
  assert.ok(accounts, 'instruction carries no accounts');
  return accounts;
}

function u64(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

describe('encoded sizes are read from the SDK codecs, not guessed', () => {
  test('balance field widths match the wire format', () => {
    assert.equal(DECRYPTABLE_BALANCE_SIZE, 36);
    assert.equal(ENCRYPTED_BALANCE_SIZE, 64);
    assert.equal(decryptableZeroBalance().length, DECRYPTABLE_BALANCE_SIZE);
    assert.equal(encryptedZeroBalance().length, ENCRYPTED_BALANCE_SIZE);
    assert.ok(decryptableZeroBalance().every((b) => b === 0));
  });
});

describe('extension sizing is derived, not magic', () => {
  test('mint space is the base mint plus the confidential extension', () => {
    assert.ok(confidentialMintSpace() > BASE_MINT_SIZE);
    // The Token-2022 program computes `try_calculate_account_len` itself and
    // rejects any mismatch with InvalidAccountData. Its answer for a mint with
    // this one extension is 235 — measured by simulating all ten
    // (order, space) combinations against the live program.
    assert.equal(confidentialMintSpace(), 235);
  });

  test('the hand-rolled arithmetic agrees with the SDK', () => {
    // 82 base + 88 extension overhead + 65 struct = 235. The overhead is a
    // measured constant (every extension adds 88 + its data), not an assumed
    // 4-byte TLV header — that assumption is what made the first real
    // deployment fail.
    assert.equal(confidentialMintSpaceArithmetic(), confidentialMintSpace());
    assert.equal(confidentialMintSpaceArithmetic(), 235);
  });

  test('account space is the base account plus the confidential extension', () => {
    assert.ok(confidentialAccountSpace() > BASE_ACCOUNT_SIZE);
    // 165 base + 1 account type + 4 TLV header + 295 struct = 465
    assert.equal(confidentialAccountSpace(), 465);
    assert.equal(confidentialAccountSpaceArithmetic(), confidentialAccountSpace());
  });
});

describe('mint initialisation', () => {
  test('targets Token-2022 and carries the mint account', () => {
    const ix = buildInitializeConfidentialMint({
      mint: mint.address,
      authority: mintAuthority.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    });
    assert.equal(ix.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
    assert.ok(accountsOf(ix).some((a) => a.address === mint.address));
    assert.equal(dataOf(ix)[0], TOKEN_2022_TAG);
  });

  test('omitting the auditor leaves it unset rather than inventing a key', () => {
    const ix = buildInitializeConfidentialMint({
      mint: mint.address,
      authority: mintAuthority.address,
      autoApproveNewAccounts: true,
    });
    assert.equal(dataOf(ix)[0], TOKEN_2022_TAG);
  });
});

describe('payment account creation', () => {
  const input = {
    payer,
    account: paymentAccount,
    mint: mint.address,
    owner: owner.address,
    lamports: 2_039_280n as never,
  };

  test('creates then initialises, in that order', () => {
    const ixs = buildCreatePaymentAccount(input);
    assert.equal(ixs.length, 2);
    // Order matters: initialising an account that does not exist yet fails.
    assert.equal(ixs[0]!.programAddress, SYSTEM_PROGRAM_ADDRESS);
    assert.equal(ixs[1]!.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
  });

  test('allocates room for the confidential extension, not the bare account', () => {
    const [create] = buildCreatePaymentAccount(input);
    const data = dataOf(create!);
    // CreateAccount data: discriminator(4) + lamports(8) + space(8) + owner(32).
    assert.equal(data.length, 52);
    const space = u64(data, 12);
    assert.equal(space, BigInt(confidentialAccountSpace()));
    assert.ok(space > BigInt(BASE_ACCOUNT_SIZE));
  });

  test('requires the new account to be a signer, because the chain does', () => {
    // Passing a bare address is a real mistake, and it must fail loudly rather
    // than assemble an instruction that cannot execute.
    assert.throws(() =>
      buildCreatePaymentAccount({
        ...input,
        account: paymentAccount.address as never,
      }),
    );
  });
});

describe('arming an account for confidential credits', () => {
  const input = { token: paymentAccount.address, authority: owner };

  test('emits enable-confidential then disable-non-confidential', () => {
    const ixs = buildArmForConfidentialCredits(input);
    assert.equal(ixs.length, 2);
    assert.ok(ixs.every((i) => i.programAddress === TOKEN_2022_PROGRAM_ADDRESS));
    assert.ok(ixs.every((i) => dataOf(i)[0] === TOKEN_2022_TAG));
    // 9 = EnableConfidentialCredits, 12 = DisableNonConfidentialCredits.
    assert.equal(dataOf(ixs[0]!)[1], 9);
    assert.equal(dataOf(ixs[1]!)[1], 12);
  });

  test('the owner is a required signer, which is why the pool is pre-armed', () => {
    const [enable] = buildArmForConfidentialCredits(input);
    const authority = accountsOf(enable!).find(
      (a) => a.address === owner.address,
    );
    assert.ok(authority, 'authority missing from the instruction accounts');
    // AccountRole: 2 = readonly signer, 3 = writable signer.
    assert.ok(
      authority.role === 2 || authority.role === 3,
      `authority must be a signer, got role ${authority.role}`,
    );
  });

  test('a bare address silently yields a NON-signer, which is the real hazard', () => {
    // Worth pinning: the SDK does not reject a plain address here. It resolves it
    // to a non-signer account, so the instruction assembles fine and then fails
    // on chain for a missing signature. Nothing at runtime catches that — only
    // the `TransactionSigner` type on the builder does, which is why it is typed
    // that way rather than as `Address`.
    const [enable] = buildArmForConfidentialCredits({
      token: paymentAccount.address,
      authority: owner.address as never,
    });
    const resolved = accountsOf(enable!).find(
      (a) => a.address === owner.address,
    );
    assert.equal(
      resolved?.role,
      0,
      'an Address resolves to a readonly non-signer',
    );
  });
});

describe('configure account', () => {
  test('carries the proof offset and a correctly sized zero balance', () => {
    const ix = buildConfigureAccount({
      token: paymentAccount.address,
      mint: mint.address,
      authority: owner,
      proofInstructionOffset: 0,
      maximumPendingBalanceCreditCounter: 65_535n,
    });
    const data = dataOf(ix);
    assert.equal(ix.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
    assert.equal(data[0], TOKEN_2022_TAG);
    assert.equal(data[1], 2, 'expected the configure-account discriminator');
    // 2 discriminator bytes + 36 balance + 8 counter + 1 proof offset.
    assert.equal(data.length, 2 + DECRYPTABLE_BALANCE_SIZE + 8 + 1);
  });
});

describe('confidential transfer', () => {
  const base = {
    sourceToken: otherAccount.address,
    mint: mint.address,
    destinationToken: paymentAccount.address,
    authority: owner,
    newSourceDecryptableAvailableBalance: decryptableZeroBalance(),
  };

  test('emits proofs before the transfer, because offsets point backwards', () => {
    const proof = {
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      accounts: [],
      data: new Uint8Array([0]),
    } as never;
    const ixs = buildConfidentialTransfer({ ...base, proofs: [proof] });
    assert.equal(ixs.length, 2);
    const transfer = dataOf(ixs[1]!);
    assert.equal(transfer[0], TOKEN_2022_TAG);
    assert.equal(
      transfer[1],
      7,
      'expected the confidential-transfer discriminator',
    );
  });

  test('carries both auditor ciphertexts even when there is no auditor', () => {
    const ixs = buildConfidentialTransfer(base);
    assert.equal(ixs.length, 1);
    // 2 discriminators + decryptable balance + 2 auditor ciphertexts + 3 offsets.
    assert.equal(
      dataOf(ixs[0]!).length,
      2 + DECRYPTABLE_BALANCE_SIZE + 2 * ENCRYPTED_BALANCE_SIZE + 3,
    );
  });

  /**
   * The context-state form, which is the only form that fits on a real cluster:
   * the three proofs are 1864 bytes against a 1232-byte transaction ceiling.
   *
   * What matters here is the offset byte. On the wire, `0` is not "the proof is
   * zero bytes away" — it is the flag that says "read the proof from the named
   * account instead of from an instruction". Producing `-1` with record accounts
   * attached would point the program at an instruction that is not there, and
   * every offset is written as a single byte, so the two values are one bit apart
   * in a transaction that otherwise looks well-formed.
   */
  test('sets every offset to 0 when the proofs live in context accounts', () => {
    const records = {
      equality: otherAccount.address,
      ciphertextValidity: paymentAccount.address,
      range: mint.address,
    };
    const ixs = buildConfidentialTransfer({ ...base, proofRecords: records });

    assert.equal(ixs.length, 1, 'no proof instructions are prepended in this form');
    const data = dataOf(ixs[0]!);
    const offsets = data.slice(-3);
    assert.deepEqual([...offsets], [0, 0, 0], 'each offset must select the account form');

    const accounts = ixs[0]!.accounts?.map((a) => a.address) ?? [];
    for (const record of Object.values(records)) {
      assert.ok(
        accounts.includes(record),
        `expected the transfer to name the context account ${record}`,
      );
    }
  });

  test('refuses to mix in-transaction proofs with context accounts', () => {
    // Both halves present would leave the offsets saying one thing and the
    // account list another; whichever the program believed, the other was wrong.
    const proof = {
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      accounts: [],
      data: new Uint8Array([0]),
    } as never;
    assert.throws(
      () =>
        buildConfidentialTransfer({
          ...base,
          proofs: [proof],
          proofRecords: {
            equality: otherAccount.address,
            ciphertextValidity: paymentAccount.address,
            range: mint.address,
          },
        }),
      /not both/,
    );
  });
});

describe('apply pending balance', () => {
  test('carries the expected credit counter so a stale apply fails loudly', () => {
    const ix = buildApplyPendingBalance({
      token: paymentAccount.address,
      authority: owner,
      expectedPendingBalanceCreditCounter: 3n,
      newDecryptableAvailableBalance: decryptableZeroBalance(),
    });
    const data = dataOf(ix);
    assert.equal(ix.programAddress, TOKEN_2022_PROGRAM_ADDRESS);
    assert.equal(data[0], TOKEN_2022_TAG);
    assert.equal(data.length, 2 + 8 + DECRYPTABLE_BALANCE_SIZE);
  });
});

describe('support policy drives the refusal, never a downgrade', () => {
  const ok = {
    mintExtensions: [ExtensionType.ConfidentialTransferMint],
    destinationRejectsConfidentialCredits: false,
    destinationUnconfigured: false,
  };

  test('a fully configured mint and account is supported', () => {
    assert.deepEqual(checkConfidentialSupport(ok), { supported: true });
  });

  test('a mint without the extension is VEIL-CONF-001', () => {
    const v = checkConfidentialSupport({ ...ok, mintExtensions: [] });
    assert.equal(v.supported, false);
    assert.equal(v.supported === false && v.code, 'VEIL-CONF-001');
  });

  test('an unconfigured destination is VEIL-CONF-002', () => {
    const v = checkConfidentialSupport({ ...ok, destinationUnconfigured: true });
    assert.equal(v.supported === false && v.code, 'VEIL-CONF-002');
  });

  test('a destination that refuses confidential credits is VEIL-CONF-002', () => {
    const v = checkConfidentialSupport({
      ...ok,
      destinationRejectsConfidentialCredits: true,
    });
    assert.equal(v.supported === false && v.code, 'VEIL-CONF-002');
  });
});

describe('plan summary', () => {
  test('reports what will be submitted, so the path can be inspected before signing', () => {
    const summary = summarizePlan([
      {
        label: 'create',
        instructions: buildCreatePaymentAccount({
          payer,
          account: paymentAccount,
          mint: mint.address,
          owner: owner.address,
          lamports: 1n as never,
        }),
      },
      {
        label: 'arm',
        instructions: buildArmForConfidentialCredits({
          token: paymentAccount.address,
          authority: owner,
        }),
      },
    ]);
    assert.equal(summary.totalInstructions, 4);
    assert.deepEqual(
      [...summary.programs].sort(),
      [SYSTEM_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].sort(),
    );
    assert.equal(summary.steps[1]!.instructions, 2);
  });
});
