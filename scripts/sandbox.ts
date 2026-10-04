/**
 * scripts/sandbox.ts — get any payer ready to pay Veil.
 *
 *   node scripts/sandbox.ts --key .keys/my-payer.json
 *   npm run sandbox -- --key ../me.json --amount 100 --sol 0.05
 *
 * Veil settles in a self-issued Token-2022 test dollar, and a confidential
 * account has to be *configured with keys derived from its owner* before it can
 * hold anything — which means the payer's own key has to be here, not just its
 * address. This does the whole ceremony in one command so "anyone can pay like
 * x402" is true for a stranger with a keypair:
 *
 *   1. fund the payer with a little SOL (its own proof transactions, which it
 *      pays for; the fee payer only covers the settlement),
 *   2. create + configure + arm the payer's confidential token account,
 *   3. mint test dollars and deposit them into the confidential balance,
 *   4. apply the pending credit so the balance is spendable now.
 *
 * The operator key (`.keys/payer.json`, or `VEIL_PAYER_SECRET`) is the funder,
 * the mint authority and the setup fee payer. Nothing here is a mock: every step
 * is a real transaction with a link.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
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
  getConfidentialDepositInstruction,
  getEnableConfidentialCreditsInstruction,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { decryptConfidentialTransferBalance } from '@solana-program/token-2022/confidential';
import { getTransferSolInstruction } from '@solana-program/system';

import {
  buildApplyPendingBalance,
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
import { KEYS_DIR, decodeSecret, signerFromKeyBytes } from './lib.ts';

const MAX_PENDING_CREDIT_COUNTER = 65_535n;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

// The RPC hands account data back as base64 text, so it has to be base64-decoded
// to bytes before the token codec will read it. Encoding it as base58 compiles
// and then fails at runtime on the first non-base58 character.
const base64ToBytes = getBase64Encoder();
const tokenDecoder = getTokenDecoder();

const rpcUrl =
  flag('rpc') ?? process.env.VEIL_RPC_URL ?? 'https://api.testnet.solana.com';
const cluster = rpcUrl.includes('devnet') ? '?cluster=devnet' : '?cluster=testnet';
const mint = (flag('mint') ?? process.env.VEIL_MINT ?? HOSTED_DEFAULTS.asset) as Address;
const decimals = Number(flag('decimals') ?? process.env.VEIL_DECIMALS ?? '6');
const amount = BigInt(flag('amount') ?? process.env.VEIL_SANDBOX_AMOUNT ?? '100') * 10n ** BigInt(decimals);
const solLamports = BigInt(Math.round(Number(flag('sol') ?? '0.05') * 1e9));

const keyPath = flag('key');
if (!keyPath) {
  console.error(
    'usage: node scripts/sandbox.ts --key <payer.json> [--amount 100] [--sol 0.05] [--rpc <url>] [--mint <mint>]',
  );
  process.exit(2);
}

const rpc = createSolanaRpc(rpcUrl);
// `resolve`, not `join`: join('/repo', '/tmp/k.json') concatenates to
// '/repo/tmp/k.json', which silently breaks every absolute path a caller passes.
const payerBytes = Uint8Array.from(
  JSON.parse(await readFile(resolve(process.cwd(), keyPath), 'utf8')),
);
const payer = await signerFromKeyBytes(payerBytes);

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
const keys = await confidentialKeysFrom(() => signDerivation(payerBytes.slice(0, 32)));

const operatorSeed =
  decodeSecret(process.env.VEIL_PAYER_SECRET ?? '') ??
  decodeSecret(await readFile(join(KEYS_DIR, 'payer.json'), 'utf8'));
if (!operatorSeed) {
  console.error('  no operator key: set VEIL_PAYER_SECRET or create .keys/payer.json');
  process.exit(1);
}
const operator = await createKeyPairSignerFromPrivateKeyBytes(operatorSeed);

console.log('');
console.log(`  rail      ${rpcUrl}`);
console.log(`  payer     ${payer.address}`);
console.log(`  operator  ${operator.address}  (funder + mint authority)`);
console.log(`  mint      ${mint} · ${decimals}dp · ${amount / 10n ** BigInt(decimals)} tokens`);
console.log('');

/** Send one transaction, signed by the operator, and report its signature. */
async function send(label: string, instructions: readonly Instruction[]): Promise<string> {
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
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await rpc.getSignatureStatuses([signature]).send();
    const entry = status.value[0];
    if (entry?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(entry.err)}`);
    if (entry?.confirmationStatus) break;
  }
  console.log(`  ok    ${label}  ${signature}`);
  return signature;
}

async function decodedAccount(address: Address): Promise<unknown | null> {
  const info = await rpc.getAccountInfo(address, { encoding: 'base64' }).send();
  if (!info.value) return null;
  return tokenDecoder.decode(base64ToBytes.encode(info.value.data[0]));
}

// 1 · SOL, so the payer can pay for its own proof transactions.
const balance = await rpc.getBalance(payer.address).send();
if (balance.value < solLamports) {
  await send('funded the payer with SOL', [
    getTransferSolInstruction({
      source: operator,
      destination: payer.address,
      amount: solLamports,
    }),
  ]);
} else {
  console.log(`  ok    payer already holds ${Number(balance.value) / 1e9} SOL`);
}

// 2 · The payer's confidential token account, created/configured on first run.
let token = (await rpc
  .getTokenAccountsByOwner(payer.address, { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: 'base64' })
  .send()).value.find((entry) => {
  const decoded = tokenDecoder.decode(base64ToBytes.encode(entry.account.data[0]));
  return decoded.mint === mint;
})?.pubkey as Address | undefined;

if (!token) {
  const account = await generateKeyPairSigner();
  token = account.address;
  const rent = await rpc
    .getMinimumBalanceForRentExemption(BigInt(confidentialAccountSpace()))
    .send();
  await send('created + configured the payer confidential account', [
    ...buildCreatePaymentAccount({
      payer: operator,
      account,
      mint,
      owner: payer.address,
      lamports: rent,
    }),
    // The pubkey-validity proof and the configure instruction that names it by
    // offset must be in the same transaction; the offset is what binds them.
    buildPubkeyValidityProof(keys),
    buildConfigureAccount({
      token: account.address,
      mint,
      authority: payer,
      proofInstructionOffset: PROOF_OFFSET_IMMEDIATELY_PRECEDING,
      maximumPendingBalanceCreditCounter: MAX_PENDING_CREDIT_COUNTER,
      decryptableZeroBalance: encryptBalance(keys, 0n),
    }),
    getEnableConfidentialCreditsInstruction({ token: account.address, authority: payer }),
    // `autoApproveNewAccounts` is off on the mint, so the mint authority has to
    // vouch for every account before it can receive anything.
    getApproveConfidentialTransferAccountInstruction({
      token: account.address,
      mint,
      authority: operator,
    }),
  ]);
} else {
  console.log(`  ok    reusing the payer account ${token}`);
  await send('approved the payer account for confidential credits', [
    getApproveConfidentialTransferAccountInstruction({ token, mint, authority: operator }),
  ]);
}

// 3 · Mint test dollars, then deposit them into the confidential balance.
await send('minted test dollars to the payer', [
  getMintToInstruction({ mint, token, mintAuthority: operator, amount }),
]);
await send('deposited into the confidential balance', [
  getConfidentialDepositInstruction({
    token,
    mint,
    authority: payer,
    amount,
    decimals,
  }),
]);

// 4 · A deposit credits *pending*; apply it so it is spendable now.
const decoded = await decodedAccount(token);
const decrypted = decryptConfidentialTransferBalance({
  tokenAccount: decoded as never,
  elgamalSecretKey: keys.elgamal().secret(),
  aesKey: keys.ae(),
});
await send('applied the pending credit', [
  buildApplyPendingBalance({
    token,
    authority: payer,
    expectedPendingBalanceCreditCounter: decrypted.expectedPendingBalanceCreditCounter,
    newDecryptableAvailableBalance: encryptBalance(
      keys,
      decrypted.availableBalance + decrypted.pendingBalance,
    ),
  }),
]);

const after = await decodedAccount(token);
const read = decryptConfidentialTransferBalance({
  tokenAccount: after as never,
  elgamalSecretKey: keys.elgamal().secret(),
  aesKey: keys.ae(),
});

console.log('');
console.log(`  payer is ready: ${payer.address}`);
console.log(`  token account ${token}`);
console.log(`  balance       available ${read.availableBalance}, pending ${read.pendingBalance}`);
console.log(`  pay a rail:   node scripts/veil-fetch.ts --key ${keyPath} --url <rail-resource>`);
console.log('');
