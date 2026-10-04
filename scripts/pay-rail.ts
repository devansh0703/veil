/**
 * scripts/pay-rail.ts — pay a *hosted* Veil rail from a local wallet.
 *
 *   node scripts/pay-rail.ts --key .keys/test-payer.json --rail <origin> \
 *     --resource /v1/payee/test --nonce 1001
 *
 * This is the client the protocol claims exists: nothing runs beside it except
 * the rail itself, and the payer needs no SOL beyond the fee budget for its own
 * proof-verification transactions. It prints every step, then re-asks the same
 * nonce to show the `409` — a settled payment identity is spent, not resold.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createKeyPairSignerFromBytes, getBase58Decoder, type Address } from '@solana/kit';
import { ElGamalPubkey } from '@solana/zk-sdk';

import {
  feePayerOf,
  payVeilResource,
  readTokenAccount,
} from '../packages/client/src/index.ts';
import {
  confidentialDerivationMessage,
  confidentialKeysFrom,
} from '../packages/onchain/src/proofs.ts';
import { defaultRpcUrl } from './lib.ts';

const KEYS_DIR = join(process.cwd(), '.keys');

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

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

const rail = (flag('rail') ?? process.env.VEIL_RAIL ?? 'https://veil-devnet.vercel.app').replace(/\/$/, '');
const resource = flag('resource') ?? '/v1/payee/test';
const nonce = Number(flag('nonce') ?? process.env.VEIL_NONCE ?? '1001');
const payerName = flag('payer') ?? 'cli-payer';
const rpcUrl = flag('rpc') ?? process.env.VEIL_RPC_URL ?? defaultRpcUrl(rail);
const keyPath = flag('key') ?? join(KEYS_DIR, 'test-payer.json');

const payerBytes = Uint8Array.from(JSON.parse(await readFile(keyPath, 'utf8')));
const payer = await createKeyPairSignerFromBytes(payerBytes);
const keys = await confidentialKeysFrom(() => signDerivation(payerBytes.slice(0, 32)));

console.log('');
console.log(`  rail      ${rail}`);
console.log(`  resource  ${resource}?nonce=${nonce}`);
console.log(`  payer     ${payer.address}  (X-Payer: ${payerName})`);
console.log('');

const feePayer = await feePayerOf(rail);
console.log(`  ok    the rail named its fee payer  ${feePayer}`);

const started = Date.now();
const result = await payVeilResource({
  rail,
  resource,
  nonce,
  payer: payerName,
  rpcUrl,
  payerSigner: payer,
  keys,
  feePayer,
  decimals: 6,
  onStep: (step) => console.log(`  ok    ${step.label}  ${step.detail}`),
});

console.log('');
console.log(`  http ${result.status}`);
console.log(`  ${JSON.stringify(result.body).slice(0, 400)}`);
console.log(`  took ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (result.signature) {
  const cluster = rpcUrl.includes('testnet') ? '?cluster=testnet' : '?cluster=devnet';
  console.log('');
  console.log(`  settlement  ${result.signature}`);
  console.log(`  explorer    https://explorer.solana.com/tx/${result.signature}${cluster}`);
  console.log(
    `  solscan     https://solscan.io/tx/${result.signature}${rpcUrl.includes('testnet') ? '?cluster=testnet' : '?cluster=devnet'}`,
  );
}

// The same identity, asked again. A settled payment is spent.
const replay = await fetch(`${rail}${resource}?nonce=${nonce}`, {
  headers: { 'X-Payer': payerName },
});
const replayBody = (await replay.json()) as { error?: string; settledAt?: string };
console.log('');
console.log(`  replay (no X-PAYMENT)  http ${replay.status}  ${JSON.stringify(replayBody).slice(0, 240)}`);

// What the payee actually holds, decrypted with the payee's own key.
const payeePath = flag('payee-key');
if (payeePath) {
  const payeeBytes = Uint8Array.from(JSON.parse(await readFile(payeePath, 'utf8')));
  const payee = await createKeyPairSignerFromBytes(payeeBytes);
  const payeeKeys = await confidentialKeysFrom(() => signDerivation(payeeBytes.slice(0, 32)));
  const seat = result.payTo as Address;
  const state = await readTokenAccount(
    (await import('@solana/kit')).createSolanaRpc(rpcUrl) as never,
    seat,
    payeeKeys,
  );
  console.log(
    `  payee ${payee.address} seat ${seat} → pending ${state.pending}, available ${state.available}`,
  );
  void ElGamalPubkey;
  void getBase58Decoder;
}
