/**
 * Bring Veil's on-chain half up on devnet.
 *
 *   npm run setup:devnet                              # plan only — reads the chain, changes nothing
 *   npm run setup:devnet -- --check                   # verify the current configuration by reading it
 *   npm run setup:devnet -- --create-mint --apply     # create the mint and arm the pool
 *   npm run setup:devnet -- --mint <address> --apply  # use an existing mint
 *
 * ## The design decision that matters here
 *
 * The default is a dry run. This script signs transactions that spend real SOL
 * and creates accounts that cannot be un-created, so it prints the plan, the
 * exact lamport cost and the instruction counts first. `--apply` is the only
 * thing that writes, and it is never inferred.
 *
 * ## What this script can and cannot finish
 *
 * Creating the mint with the confidential-transfer extension: yes.
 * Creating the pool accounts and arming them for confidential credits: yes.
 * *Configuring* an account (which needs a `PubkeyValidity` and a
 * `ZeroCiphertext` proof): yes, and this is worth stating because an earlier
 * version of this file claimed otherwise.
 *
 * The claim was that proving needs the Rust prover. That is wrong.
 * `@solana/zk-sdk` ships the proof *generators*: `new PubkeyValidityProofData(kp)`
 * produces a 96-byte proof and `new ZeroCiphertextProofData(kp, ciphertext)` a
 * 192-byte one, both self-verifying on construction. `npm run prove:check`
 * demonstrates this, including the negative cases, so the claim is checkable
 * rather than asserted. The instruction is fed the proof's *context* and the
 * proof is submitted to the ZK ElGamal Proof program in the same transaction.
 *
 * That correction is load-bearing in the other direction too. With proving
 * available, the only thing between this repo and a live confidential transfer
 * is lamports — fees and rent — which is a funding problem, not a capability
 * one. Stating the obstacle accurately is what makes it fixable.
 *
 * That honesty is load-bearing. An armed-but-unconfigured account makes a
 * confidential credit fail visibly on chain, which is a refusal. Assuming it
 * worked would produce the one outcome Veil exists to prevent: a merchant who
 * believes an amount was hidden while it is not.
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';

import {
  buildArmForConfidentialCredits,
  buildConfigureAccount,
  buildCreatePaymentAccount,
  buildInitializeConfidentialMint,
  confidentialAccountSpace,
  confidentialMintSpace,
  summarizePlan,
  TOKEN_2022_PROGRAM_ADDRESS,
  type InstructionPlan,
} from '../packages/onchain/src/index.ts';
import {
  buildPubkeyValidityProof,
  confidentialDerivationMessage,
  confidentialKeysFrom,
  encryptBalance,
  PROOF_OFFSET_IMMEDIATELY_PRECEDING,
} from '../packages/onchain/src/proofs.ts';
import {
  readAccountConfidentiality,
  readChainFacts,
  summarizeRead,
} from '../packages/onchain/src/chain.ts';
import { DEFAULT_RESOURCES } from '../packages/server/src/index.ts';
import { PoolLedger } from '../packages/derive/src/index.ts';
import { PLACEHOLDER_MINT, networkFromRpc } from '../packages/x402-core/src/index.ts';
import {
  decodeSecret,
  KEYS_DIR,
  LEDGER_PATH,
  loadLedger,
  MINT_PATH,
  optionsFromEnv,
  readJSON,
  relative,
  saveJSON,
  saveLedger,
  table,
} from './lib.ts';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}
const has = (name: string): boolean => flag(name) !== undefined;

const APPLY = has('apply');
const CHECK_ONLY = has('check');
const CREATE_MINT = has('create-mint');
const options = optionsFromEnv(argv);
const rpcUrl = flag('rpc') || options.rpcUrl || 'https://api.devnet.solana.com';
const poolSize = Math.max(1, Math.floor(Number(flag('pool-size') || options.poolSize)));

function out(lines: readonly string[]): void {
  process.stdout.write(`${lines.filter((l) => l !== '').join('\n')}\n`);
}

function fail(lines: readonly string[]): never {
  out(['', ...lines, '']);
  process.exit(1);
}

/**
 * The payer is created on demand rather than described in prose.
 *
 * A setup script that tells the user to write their own keypair is a setup
 * script with a hole in it, so a missing payer is generated here, its address
 * printed, and the run stopped with one instruction: fund it.
 */
const PAYER_PATH = `${KEYS_DIR}/payer.json`;

/**
 * Load or create a keypair inside the project. Never reads outside it.
 *
 * Generation writes the 32-byte seed rather than trying to export a CryptoKey.
 * `generateKeyPairSigner()` returns a non-extractable key in Node — which is the
 * right default for a signer and the wrong primitive for a file — so a new
 * keypair is built from raw seed bytes, which are both writable and readable in
 * the format `solana-keygen` uses for its 64-byte arrays.
 */
async function loadOrCreate(
  path: string,
  create: boolean,
): Promise<{ signer?: KeyPairSigner; created: boolean; problem?: string }> {
  try {
    const raw = await readFile(path, 'utf8');
    const bytes = decodeSecret(raw);
    if (!bytes) return { created: false, problem: `${relative(path)} is not a valid keypair` };
    return { signer: await signerFromBytes(bytes), created: false };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') {
      return { created: false, problem: `${relative(path)}: ${(error as Error).message}` };
    }
  }
  if (!create) return { created: false, problem: `${relative(path)} does not exist` };
  const seed = new Uint8Array(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  await writeFile(path, `${JSON.stringify([...seed])}\n`, { mode: 0o600 });
  return { signer, created: true };
}

/** A 64-byte secret key or a 32-byte seed, both of which users actually have. */
async function signerFromBytes(bytes: Uint8Array): Promise<KeyPairSigner> {
  return bytes.length === 32
    ? createKeyPairSignerFromPrivateKeyBytes(bytes)
    : createKeyPairSignerFromBytes(bytes);
}

// ---------------------------------------------------------------------------
// --check — read the configuration and report what devnet actually says
// ---------------------------------------------------------------------------

async function loadLedgerForRead(): Promise<PoolLedger> {
  try {
    const raw = await readFile(options.ledgerPath, 'utf8');
    return PoolLedger.fromJSON(JSON.parse(raw));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return PoolLedger.empty();
    throw error;
  }
}

async function check(mint: string): Promise<never> {
  const ledger = await loadLedgerForRead();
  const addresses = ledger.allFor().map((e) => e.address);

  out([
    '',
    'Veil — reading the configuration from devnet',
    '',
    table([
      ['rpc', rpcUrl],
      ['mint', mint],
      ['pool accounts', String(addresses.length)],
    ]),
    '',
    `Reading… (batched ${Math.ceil((addresses.length + 1) / 50)} RPC call(s); devnet rate-limits per method)`,
  ]);

  const facts = await readChainFacts(rpcUrl, mint, addresses);
  const mintRead = summarizeRead(facts.mint);
  const armed = facts.accounts.filter((a) => a.hasConfidentialExtension);

  out([
    '',
    'Mint',
    table([
      ['address', mintRead.address],
      ['exists', String(mintRead.exists)],
      ['token-2022 owner', String(facts.mint.isToken2022)],
      ['confidential extension', mintRead.confidential],
      ['extension types', mintRead.extensions],
      ['data length', String(facts.mint.dataLength)],
    ]),
    '',
    `Accounts: ${armed.length}/${facts.accounts.length} carry the confidential-transfer extension`,
    '',
  ]);

  // The verdict is the point of the command: it is what a deployment repeats to
  // justify reporting `privacySource: chain`.
  if (facts.mint.hasConfidentialExtension && armed.length > 0) {
    out([
      `VERDICT ok — ${armed.length} account(s) can receive a confidential credit.`,
      '',
      'A server started against these facts may report privacySource: chain:',
      '',
      `  VEIL_MINT=${mint} VEIL_RPC_URL=${rpcUrl} npm run serve -- --privacy-source chain`,
      '',
    ]);
    process.exit(0);
  }

  const why: string[] = [];
  if (!facts.mint.exists) {
    why.push('the mint account does not exist on devnet yet, so nothing can settle in it');
  } else if (!facts.mint.hasConfidentialExtension) {
    why.push('the mint exists but does not carry the confidential-transfer extension');
  }
  if (addresses.length === 0) {
    why.push('the pool is empty, so there is nothing to receive a payment');
  } else if (armed.length === 0) {
    why.push(
      'no pool account carries the confidential-transfer extension, so a credit into any of them would fail rather than settle privately',
    );
  }

  out([
    'VERDICT refused',
    '',
    'A server started against these facts must answer VEIL-CONF-001/002/003 rather',
    'than quote a price. Reasons:',
    ...why.map((w) => `  - ${w}`),
    '',
    `Fix by running with --apply${CREATE_MINT ? '' : ' --create-mint'} (costs devnet SOL).`,
  ]);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Plan, then apply only if asked
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // A mint address is needed either to create it or to use it, and which one
  // depends on the mode. Creating resolves the address from a stored keypair, so
  // the address is knowable and reusable rather than invented.
  /**
   * Which mint to work against.
   *
   * `optionsFromEnv` falls back to a placeholder address. That default is fine
   * for the offline scripts and actively dangerous here: the plan below decides
   * whether to create a mint by testing whether this address exists, so a
   * placeholder reads as "no mint yet" and `--apply` would create a *second* mint
   * and a second pool against it. When no mint was passed, the one this project
   * recorded is used, and the choice is reported so it is never silent.
   */
  const recordedMint = await readJSON<{ mint?: string } | null>(MINT_PATH, null);
  const mintWasPassed = Boolean(flag('mint')) || options.mint !== PLACEHOLDER_MINT;
  let mint = mintWasPassed ? flag('mint') || options.mint : (recordedMint?.mint ?? options.mint);

  if (!mintWasPassed && recordedMint?.mint && !CREATE_MINT) {
    out(['', `No --mint passed; using the recorded one: ${mint}`]);
  }

  if (CREATE_MINT) {
    const mintKeypair = await loadOrCreate(`${KEYS_DIR}/mint.json`, true);
    if (!mintKeypair.signer) {
      fail([`Cannot create a mint: ${mintKeypair.problem}`]);
    }
    mint = mintKeypair.signer.address;
    if (mintKeypair.created) {
      out(['', `Generated a mint keypair: ${relative(`${KEYS_DIR}/mint.json`)}`]);
    }
  }

  if (CHECK_ONLY) {
    if (!flag('mint') && !CREATE_MINT) {
      fail([
        '--check needs a mint to read.',
        '',
        '  npm run setup:devnet -- --check --mint <address>',
      ]);
    }
    return check(mint);
  }

  let payerLoad = await loadOrCreate(PAYER_PATH, false);
  if (!payerLoad.signer) {
    payerLoad = await loadOrCreate(PAYER_PATH, true);
    if (!payerLoad.signer) {
      fail([`Cannot set up devnet: ${payerLoad.problem}`]);
    }
    fail([
      `Created a devnet payer keypair at ${relative(PAYER_PATH)}`,
      '',
      'Its address:',
      '',
      `  ${payerLoad.signer.address}`,
      '',
      'Fund it, then re-run. Devnet SOL is free:',
      '',
      '  https://faucet.solana.com   (browser; paste the address)',
      '',
      'The public JSON-RPC faucet (requestAirdrop) needs a GitHub-authenticated',
      'session, which is why this script does not try it and then fail obscurely.',
      '',
      'Nothing was created on chain and nothing was spent.',
    ]);
  }
  const payer = payerLoad.signer;

  const rpc = createSolanaRpc(rpcUrl);

  const facts = await readChainFacts(
    rpcUrl,
    mint,
    (await loadLedgerForRead()).allFor().map((e) => e.address),
  );
  const balance = (await rpc.getBalance(payer.address).send()).value;
  // Rent exemption comes back as lamports already; `getBalance` is the one that
  // wraps its answer, which is the sort of asymmetry that gets mis-copied.
  const mintRent = await rpc
    .getMinimumBalanceForRentExemption(BigInt(confidentialMintSpace()))
    .send();
  const accountRent = await rpc
    .getMinimumBalanceForRentExemption(BigInt(confidentialAccountSpace()))
    .send();

  const aliases = [...new Set(DEFAULT_RESOURCES.map((r) => r.alias))];
  const accountsToCreate = aliases.length * poolSize;
  const needsMint = !facts.mint.hasConfidentialExtension;
  const rent = (needsMint ? mintRent : 0n) + accountRent * BigInt(accountsToCreate);
  // 5000 lamports per signature. Creating an account needs two (payer + the new
  // account); arming adds one more on a separate transaction. Rounded up,
  // because a budget that under-counts is not a budget.
  const feeBudget = 5000n * BigInt(accountsToCreate * 3 + 60);
  const total = rent + feeBudget;

  out([
    '',
    'Veil — devnet setup plan',
    '',
    table([
      ['rpc', rpcUrl],
      ['payer', payer.address],
      ['payer balance', `${balance} lamports`],
      ['mint', mint],
      ['create the mint', needsMint ? 'yes (not present, or not confidential)' : 'no (already configured)'],
      ['pool size per merchant', String(poolSize)],
      ['merchants', aliases.join(', ')],
      ['accounts to create', String(accountsToCreate)],
      ['mint rent', `${mintRent} lamports`],
      ['account rent (each)', `${accountRent} lamports`],
      ['fee budget', `${feeBudget} lamports`],
      ['total required', `${total} lamports (${(Number(total) / 1e9).toFixed(4)} SOL)`],
    ]),
    '',
  ]);

  // The plan is built from the same builders the server and the tests use, with
  // a real generated signer standing in for a pool account, so the instruction
  // counts below are the counts a real run submits rather than estimates.
  const sampleAccount = await generateKeyPairSigner();
  const plans: InstructionPlan[] = [];
  if (needsMint) {
    plans.push({
      label: 'create mint + confidential-transfer extension',
      instructions: [
        ...(await mintInstructions(payer, mintRent)),
      ],
    });
  }
  plans.push({
    label: 'create + initialise one payment account',
    instructions: buildCreatePaymentAccount({
      payer,
      account: sampleAccount,
      mint: mint as Address,
      owner: payer.address,
      lamports: accountRent,
    }),
  });
  plans.push({
    label: 'arm it for confidential credits (and refuse plain ones)',
    instructions: buildArmForConfidentialCredits({
      token: sampleAccount.address,
      authority: payer,
    }),
  });
  plans.push({
    label: 'configure it for confidential balances — needs a proof',
    instructions: [
      buildConfigureAccount({
        token: sampleAccount.address,
        mint: mint as Address,
        authority: payer,
        proofInstructionOffset: 0,
        maximumPendingBalanceCreditCounter: 65535n,
      }),
    ],
  });

  const summary = summarizePlan(plans);
  out([
    'Instruction plan',
    table([
      ['step', 'instructions', 'programs'],
      ...summary.steps.map((s) => [
        s.label,
        String(s.instructions),
        s.programs
          .map((p) => (p === TOKEN_2022_PROGRAM_ADDRESS ? 'token-2022' : `system`))
          .join(', '),
      ]),
      ['', ''],
      ['total', String(summary.totalInstructions), `${summary.programs.length} programs`],
    ]),
    '',
  ]);

  if (!APPLY) {
    out([
      'Dry run: nothing was signed and nothing was sent. This is the default.',
      '',
      'To execute, re-run with --apply and enough devnet SOL:',
      '',
      CREATE_MINT
        ? `  npm run setup:devnet -- --create-mint --apply`
        : `  npm run setup:devnet -- --mint ${mint} --apply`,
      '',
      balance < total
        ? `Note: the payer holds ${balance} lamports and the plan needs ${total}. Fund it first.`
        : `The payer holds enough (${balance} lamports).`,
      '',
    ]);
    process.exit(0);
  }

  if (balance < total) {
    fail([
      'Refusing to start: the payer cannot pay for the plan.',
      '',
      table([
        ['payer', payer.address],
        ['balance', `${balance} lamports`],
        ['required', `${total} lamports`],
        ['shortfall', `${total - balance} lamports`],
      ]),
      '',
      'Fund this address on devnet, then re-run. https://faucet.solana.com works',
      'in a browser; the public RPC faucet needs a GitHub-authenticated session.',
    ]);
  }

  const sent: { label: string; signature: string }[] = [];

  if (needsMint) {
    out(['Creating the mint…']);
    const signature = await send(rpc, payer, await mintInstructions(payer, mintRent));
    sent.push({ label: 'mint account + confidential-transfer extension', signature });
    out([`  ${signature}`]);
    await confirmSignature(rpc, signature as Signature);
    out(['  confirmed — the pool below can now simulate against it']);
  }

  // ---------------------------------------------------------------------------
  // The pool: create, configure with a locally-generated proof, then arm
  // ---------------------------------------------------------------------------

  // The instruction order below is not a stylistic choice; it was settled by
  // simulating both orderings against the live program:
  //
  //   create, init, proof, configure(-1), enable, disable
  //
  // Arming *first* fails with custom error 0x30, because
  // EnableConfidentialCredits requires the ConfidentialTransferAccount
  // extension that only ConfigureAccount creates. And the proof must sit
  // immediately before its consumer: `verify_and_extract_context` resolves it
  // as `current_index + offset`, so the offset is -1, not +1.

  const ledger = await loadLedger(options.ledgerPath);
  const already = new Set(ledger.allFor().map((e) => e.address));
  // Slots the ledger already holds, keyed by alias+slot. The address set above
  // cannot catch a re-run: a freshly generated keypair is never in the ledger,
  // so the old check fell through to `send()` and created a real duplicate
  // account, failing only afterwards at `register` (18 orphans on testnet from
  // exactly that). A slot is the identity of a pool seat, so that is what the
  // skip checks — before anything is generated, signed or sent.
  const occupiedSlots = new Set(
    ledger.allFor().map((e) => `${e.alias}#${e.slot}`),
  );

  // The payer signs the fixed derivation message once and reuses the resulting
  // confidential keys for every account it configures. One signature, one set of
  // keys, matching what a wallet does across all of its accounts.
  const payerSeed = await readFile(PAYER_PATH, 'utf8').then((raw) => decodeSecret(raw));
  if (!payerSeed) {
    fail([`${relative(PAYER_PATH)} is not a valid keypair; cannot derive confidential keys.`]);
  }
  const keys = await confidentialKeysFrom(() => signDerivation(payerSeed));
  out(['', `Confidential ElGamal key derived for ${payer.address}`]);

  // Imported here rather than at the top of the file because this script loads
  // its token-2022 surface lazily, so that the offline paths never pull the
  // program client in.
  const { getApproveConfidentialTransferAccountInstruction } = await import(
    '@solana-program/token-2022'
  );

  const created: { alias: string; slot: number; address: string; signature: string }[] = [];
  const skipped = already.size;

  /**
   * Approve existing pool accounts that were configured without approval.
   *
   * This is a repair pass, not part of creating a pool. Earlier versions of this
   * script configured and enabled accounts but never approved them, and because
   * the loop below skips slots the ledger already occupies, those accounts could
   * not be fixed by re-running — they sat in the pool, recorded as armed, unable
   * to receive anything. `npm run status -- --chain` reports exactly this split
   * ("carry the extension" against "approved by the mint authority"), so the gap
   * is visible rather than silent; this closes it.
   */
  const APPROVAL_BATCH = 6;
  const needsApproval: string[] = [];
  // Read regardless of --apply: this is a read-only pass, and a dry run that does
  // not mention the gap is a dry run that lets the gap persist.
  {
    const existing = ledger.allFor();
    for (let i = 0; i < existing.length; i += 12) {
      const batch = existing.slice(i, i + 12);
      const reads = await Promise.all(
        batch.map((entry) => readAccountConfidentiality(rpcUrl, entry.address)),
      );
      reads.forEach((read, index) => {
        if (read.hasConfidentialExtension && read.approved === false) {
          needsApproval.push(batch[index]!.address);
        }
      });
    }
  }

  if (needsApproval.length > 0 && !APPLY) {
    out([
      '',
      `${needsApproval.length} pooled account(s) carry the confidential extension but the mint`,
      'authority never approved them, so they cannot receive anything yet.',
      'Re-run with --apply to approve them.',
      '',
    ]);
  }

  if (needsApproval.length > 0 && APPLY) {
    out(['', `Approving ${needsApproval.length} pooled account(s) the mint authority never vouched for`]);
    for (let i = 0; i < needsApproval.length; i += APPROVAL_BATCH) {
      const batch = needsApproval.slice(i, i + APPROVAL_BATCH);
      try {
        const signature = await send(
          rpc,
          payer,
          batch.map((address) =>
            getApproveConfidentialTransferAccountInstruction({
              token: address as Address,
              mint: mint as Address,
              authority: payer,
            }),
          ),
        );
        out([`  approved ${batch.length}  ${signature}`]);
      } catch (error) {
        out([`  FAILED to approve ${batch.length}: ${(error as Error).message}`]);
      }
    }
  }

  for (const alias of aliases) {
    for (let slot = 0; slot < poolSize; slot++) {
      // A fresh keypair per account. Its secret is needed exactly once — to
      // sign the SystemProgram create — and is discarded immediately after.
      // The token account's authority is the payer, not the account key.
      if (occupiedSlots.has(`${alias}#${slot}`)) continue;
      const account = await generateKeyPairSigner();
      if (already.has(account.address)) continue;

      const instructions: Instruction[] = [
        ...buildCreatePaymentAccount({
          payer,
          account,
          mint: mint as Address,
          owner: payer.address,
          lamports: accountRent,
        }),
        buildPubkeyValidityProof(keys),
        buildConfigureAccount({
          token: account.address,
          mint: mint as Address,
          authority: payer,
          proofInstructionOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
          maximumPendingBalanceCreditCounter: 65535n,
          decryptableZeroBalance: encryptBalance(keys, 0n),
        }),
        ...buildArmForConfidentialCredits({ token: account.address, authority: payer }),
        // The mint sets `autoApproveNewAccounts: false`, so an account is not
        // usable for confidential transfers until the mint authority vouches for
        // it. Skipping this is invisible at setup time — the account is created,
        // configured and enabled exactly as expected — and then fails on the
        // first `Deposit` or incoming `Transfer` with `custom program error:
        // 0x18`, which names neither the account nor the missing step. An
        // account registered as armed has to be one that can really receive.
        getApproveConfidentialTransferAccountInstruction({
          token: account.address,
          mint: mint as Address,
          authority: payer,
        }),
      ];

      try {
        const signature = await send(rpc, payer, instructions);
        ledger.register({ slot, address: account.address, alias, armed: true });
        created.push({ alias, slot, address: account.address, signature });
        out([`  ${alias} slot ${slot}  ${account.address}`]);
      } catch (error) {
        out([`  ${alias} slot ${slot}  FAILED: ${(error as Error).message}`]);
      }
    }
  }

  await saveLedger(ledger, options.ledgerPath);

  const armed = ledger.allFor().length;
  out([
    '',
    table([
      ['pool accounts', String(armed)],
      ['created now', String(created.length)],
      ['skipped (already registered)', String(skipped)],
      ['merchants', String(aliases.length)],
      ['ledger', relative(options.ledgerPath)],
    ]),
    '',
  ]);

  if (created.length === 0 && armed === 0) {
    fail([
      'No pool accounts were created and none are registered.',
      '',
      'Nothing was armed, so no payment can settle. The mint still landed if it',
      'was created above; re-run once the payer holds enough SOL.',
    ]);
  }

  /**
   * The network recorded is the one derived from the endpoint, not the one
   * configured.
   *
   * These disagree easily — `VEIL_NETWORK` defaults to devnet while the RPC can
   * be pointed anywhere — and the previous record in this repository said
   * `solana:devnet` next to a testnet `rpcUrl`, which is a label that would send
   * the next reader to the wrong cluster. The endpoint is where the reads and
   * writes actually went, so it decides the label; the configured value is only
   * reported when it differs.
   */
  const rpcNetwork = networkFromRpc(rpcUrl);
  if (rpcNetwork && rpcNetwork !== options.network) {
    out([
      '',
      `Note: VEIL_NETWORK is ${options.network} but the endpoint is ${rpcUrl},`,
      `so the record is written as ${rpcNetwork}.`,
      '',
    ]);
  }

  await saveJSON(MINT_PATH, {
    mint,
    network: rpcNetwork ?? options.network,
    rpcUrl,
    confidentialExtension: true,
    verifiedAt: facts.readAt,
    verifiedFrom: 'chain',
    payer: payer.address,
    poolSize,
    poolCreated: armed > 0,
    configured: armed > 0,
    poolAccounts: armed,
    ledger: relative(options.ledgerPath),
    outstanding: [],
    sent,
    created,
  });
  out([`Wrote ${relative(MINT_PATH)} (configured: ${armed > 0}).`]);
}

/**
 * Sign the fixed confidential-key derivation message with a raw seed.
 *
 * `@solana/kit`'s `signBytes` wants a WebCrypto `CryptoKey`, which a seed-derived
 * signer does not expose. Wrapping the 32-byte seed in a PKCS#8 Ed25519 envelope
 * lets Node's `crypto` sign it directly, which is what the wallet on the other
 * side does with the same bytes.
 */
async function signDerivation(seed: Uint8Array): Promise<Uint8Array> {
  const { createPrivateKey, sign } = await import('node:crypto');
  const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const message = confidentialDerivationMessage();
  return new Uint8Array(sign(null, Buffer.from(message), key));
}

/**
 * The mint transaction, built from the real builders.
 *
 * Order matters and is not cosmetic: the confidential-transfer extension must be
 * initialised BEFORE `InitializeMint`, because the program's `InitializeMint`
 * reads the TLV region to recompute the account's exact length and rejects the
 * transaction if it does not match (`InvalidAccountData`). A zero-filled TLV
 * region presents no extensions, so 82 != the allocated length and it fails.
 *
 * This order was determined by simulating all ten (order, space) combinations
 * against the live program: only `extension-first, space=235` passes. The old
 * code ran `InitializeMint` first with a hand-rolled 152-byte space and failed
 * the first time `--apply` ever reached a real cluster.
 */
async function mintInstructions(
  payer: TransactionSigner,
  lamports: bigint,
): Promise<Instruction[]> {
  const { getCreateAccountInstruction } = await import('@solana-program/system');
  const { getInitializeMintInstruction } = await import('@solana-program/token-2022');
  const mintKeypair = await loadOrCreate(`${KEYS_DIR}/mint.json`, true);
  if (!mintKeypair.signer) throw new Error(`mint keypair unavailable: ${mintKeypair.problem}`);
  return [
    getCreateAccountInstruction({
      payer,
      newAccount: mintKeypair.signer,
      lamports,
      space: confidentialMintSpace(),
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    // Extension init FIRST. See the note above.
    buildInitializeConfidentialMint({
      mint: mintKeypair.signer.address,
      authority: payer.address,
      autoApproveNewAccounts: false,
      // No auditor key. It is a single global key per mint and cannot be a
      // merchant's reconciliation path, so defaulting one on would be a feature
      // that reads as a back door.
      auditorElgamalPubkey: null,
    }),
    getInitializeMintInstruction({
      mint: mintKeypair.signer.address,
      decimals: options.decimals,
      // The generated instruction takes an address here, not a signer: the mint
      // authority's signature is not required to initialise the mint.
      mintAuthority: payer.address,
    }),
  ];
}

/**
 * Whether a failure is worth another attempt.
 *
 * The public testnet endpoint rate-limits per IP (HTTP 429) and the shared
 * connection pool times out under a burst of sends — neither says anything
 * about the transaction, so both are retried. A deterministic rejection
 * (preflight failure, bad proof) is not transient and retrying it would only
 * slow down the report of a real problem.
 */
function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|timeout|timed out|ECONNRESET|ETIMEDOUT|UND_ERR|fetch failed|socket hang up|HTTP error \(5\d\d\)/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sign and send one transaction, returning its signature.
 *
 * Retried on transient transport failures with exponential backoff because a
 * 429 from the shared testnet endpoint is a fact about the endpoint, not about
 * the transaction. The blockhash is fetched fresh on every attempt: a backoff
 * that outlived the previous blockhash would otherwise send a transaction that
 * could no longer land. The first apply run hit exactly this — 18 accounts
 * landed and the last 6 died on 429 in a burst — which is why this loop exists.
 */
async function send(
  rpc: ReturnType<typeof createSolanaRpc>,
  payer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<string> {
  const MAX_SEND_ATTEMPTS = 5;
  let lastError: unknown = new Error('send failed');
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const { value: lifetime } = await rpc.getLatestBlockhash().send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayerSigner(payer, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
        (tx) => appendTransactionMessageInstructions(instructions, tx),
      );
      const signed = await signTransactionMessageWithSigners(message);
      assertIsFullySignedTransaction(signed);
      return await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
        })
        .send();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === MAX_SEND_ATTEMPTS) throw error;
      await sleep(1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
    }
  }
  throw lastError;
}

/**
 * Wait until a sent transaction is actually on chain.
 *
 * `sendTransaction` returns once the preflight passes, not once the transaction
 * lands — and on a fresh cluster the next transaction simulates against what
 * the previous one was supposed to create. The first devnet run hit exactly
 * that: the mint was sent, then all three pool-account transactions failed
 * simulation against a mint the RPC had not yet confirmed, so the pool cost a
 * failed run rather than a transaction. Testnet never showed it because its
 * mint already existed from an earlier session.
 */
async function confirmSignature(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) {
        fail(['The transaction landed but failed on chain:', String(status.err)]);
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail([
    `Transaction ${signature} did not reach confirmed within 60s.`,
    'The cluster may be congested; re-run — the mint (if that was the one) is',
    'either confirmed by now or the run will report it as missing.',
  ]);
}

await main();
