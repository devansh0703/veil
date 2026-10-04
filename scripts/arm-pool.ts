/**
 * scripts/arm-pool.ts — grow a merchant's pool of one-time payment seats.
 *
 *   node scripts/arm-pool.ts --alias payee.test --count 3 \
 *     --owner-key .keys/test-payee.json --ledger data/pool-ledger.json
 *
 * A seat is a Token-2022 account owned by the merchant, configured with the
 * merchant's own derived confidential keys, and approved by the mint authority
 * so it can receive confidential credits. Each payment lands in a different seat,
 * which is what keeps two payments to one merchant from sitting next to each
 * other on the account graph.
 *
 * This is the operation the "anyone can pay" claim actually depends on. A pool
 * with one armed seat serves exactly one payment per ledger instance; the second
 * distinct payer gets a 503 `VEIL-CONF-005` refusal. Growing the pool is the fix,
 * and it is deliberately *not* re-arming a consumed seat — re-arming would put a
 * second payment into an account that already holds a settled one and link them.
 *
 * Chain first, ledger second. If the create/configures fail the ledger is left
 * untouched, so it never claims a seat is armed that is not.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  getApproveConfidentialTransferAccountInstruction,
  getEnableConfidentialCreditsInstruction,
} from '@solana-program/token-2022';

import {
  buildConfigureAccount,
  buildCreatePaymentAccount,
  confidentialAccountSpace,
} from '../packages/onchain/src/index.ts';
import {
  buildPubkeyValidityProof,
  confidentialDerivationMessage,
  confidentialKeysFrom,
  encryptBalance,
  PROOF_OFFSET_IMMEDIATELY_PRECEDING,
} from '../packages/onchain/src/proofs.ts';
import { HOSTED_DEFAULTS } from '../packages/server/src/index.ts';
import { KEYS_DIR, decodeSecret, loadLedger, saveLedger, signerFromKeyBytes } from './lib.ts';

const MAX_PENDING_CREDIT_COUNTER = 65_535n;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const alias = flag('alias');
const ownerKeyPath = flag('owner-key');
const count = Number(flag('count') ?? '3');
if (!alias || !ownerKeyPath) {
  console.error(
    'usage: node scripts/arm-pool.ts --alias <alias> --owner-key <merchant.json> [--count 3] [--ledger data/pool-ledger.json] [--rpc <url>]',
  );
  process.exit(2);
}

const ledgerPath = resolve(process.cwd(), flag('ledger') ?? 'data/pool-ledger.json');
const rpcUrl = flag('rpc') ?? process.env.VEIL_RPC_URL ?? 'https://api.testnet.solana.com';
const mint = (flag('mint') ?? process.env.VEIL_MINT ?? HOSTED_DEFAULTS.asset) as Address;

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

const ownerBytes = Uint8Array.from(
  JSON.parse(await readFile(resolve(process.cwd(), ownerKeyPath), 'utf8')),
);
const merchantSigner = await signerFromKeyBytes(ownerBytes);
const merchantKeys = await confidentialKeysFrom(() => signDerivation(ownerBytes.slice(0, 32)));

const operatorSeed =
  decodeSecret(process.env.VEIL_PAYER_SECRET ?? '') ??
  decodeSecret(await readFile(resolve(KEYS_DIR, 'payer.json'), 'utf8'));
if (!operatorSeed) {
  console.error('  no operator key: set VEIL_PAYER_SECRET or create .keys/payer.json');
  process.exit(1);
}
const operator = await createKeyPairSignerFromPrivateKeyBytes(operatorSeed);

// A merchant who is also the operator is common (it is what the devnet pool
// does). Two signer *instances* for one address make the transaction fail with
// "multiple distinct signers were identified for address", so the same instance
// is reused when the addresses match.
const merchant = merchantSigner.address === operator.address ? operator : merchantSigner;

const rpc = createSolanaRpc(rpcUrl);
const ledger = await loadLedger(ledgerPath);

console.log('');
console.log(`  ledger    ${ledgerPath}`);
console.log(`  alias     ${alias}`);
console.log(`  merchant  ${merchant.address}  (owner of every seat)`);
console.log(`  operator  ${operator.address}  (fee payer + mint authority)`);
console.log(`  mint      ${mint}`);
console.log('');

async function send(label: string, instructions: readonly Instruction[]): Promise<void> {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(operator, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    const status = await rpc.getSignatureStatuses([signature]).send();
    const entry = status.value[0];
    if (entry?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(entry.err)}`);
    if (entry?.confirmationStatus) break;
  }
  console.log(`  ok    ${label}`);
}

const rent = await rpc
  .getMinimumBalanceForRentExemption(BigInt(confidentialAccountSpace()))
  .send();

// Slots are scoped to the alias, so the next free indices are what matter.
const taken = new Set(ledger.allFor(alias).map((entry) => entry.slot));
let added = 0;
for (let slot = 0; added < count; slot++) {
  if (taken.has(slot)) continue;

  const seat = await generateKeyPairSigner();
  await send(`armed seat ${slot} for ${alias} (${seat.address})`, [
    ...buildCreatePaymentAccount({
      payer: operator,
      account: seat,
      mint,
      owner: merchant.address,
      lamports: rent,
    }),
    // The proof and the configure that names it by offset must share a
    // transaction — the offset is the only thing binding them.
    buildPubkeyValidityProof(merchantKeys),
    buildConfigureAccount({
      token: seat.address,
      mint,
      authority: merchant,
      proofInstructionOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
      maximumPendingBalanceCreditCounter: MAX_PENDING_CREDIT_COUNTER,
      decryptableZeroBalance: encryptBalance(merchantKeys, 0n),
    }),
    getEnableConfidentialCreditsInstruction({ token: seat.address, authority: merchant }),
    // `autoApproveNewAccounts` is false on this mint, so the mint authority
    // vouches for the seat before it can take a credit.
    getApproveConfidentialTransferAccountInstruction({
      token: seat.address,
      mint,
      authority: operator,
    }),
  ]);

  // Only now is it true, so only now is it recorded.
  ledger.register({ slot, address: seat.address, alias, armed: true });
  await saveLedger(ledger, ledgerPath);
  added += 1;
}

console.log('');
console.log(`  ${alias} now has ${ledger.armedFor(alias).length} free armed seat(s):`);
for (const entry of ledger.armedFor(alias)) {
  console.log(`    slot ${entry.slot}  ${entry.address}`);
}
console.log('');
