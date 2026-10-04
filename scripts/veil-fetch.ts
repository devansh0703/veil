/**
 * scripts/veil-fetch.ts — the agent side, from the command line.
 *
 *   node scripts/veil-fetch.ts --key .keys/my-agent.json \
 *     --url https://veil-devnet.vercel.app/v1/payee/test --budget 0.10
 *
 * This is `veilFetch(url, { budget })` with a shell around it, and it is the
 * thinnest honest demonstration of the product: an agent with a keypair and a
 * spending limit asks for a resource, pays privately when it is asked, and stops
 * if the price would take it past its budget. It never silently pays in public.
 *
 * Repeat `--url` (or pass `--times N`) and it runs as a stateful agent, so the
 * budget and the nonce are threaded across calls the way a real agent would.
 */

import { readFile } from 'node:fs/promises';

import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';
import { ConfidentialKeys } from '@solana/zk-sdk';

import { createVeilAgent, isVeilError } from '../packages/client/src/index.ts';
import {
  confidentialDerivationMessage,
  confidentialKeysFrom,
} from '../packages/onchain/src/proofs.ts';
import { defaultRpcUrl } from './lib.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
function repeated(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  }
  return out;
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

const keyPath = flag('key');
if (!keyPath) {
  console.error('usage: node scripts/veil-fetch.ts --key <agent.json> --url <rail-resource> [--budget 0.10]');
  process.exit(2);
}

const bytes = Uint8Array.from(JSON.parse(await readFile(keyPath, 'utf8')));
const signer: KeyPairSigner = await createKeyPairSignerFromBytes(bytes);
const keys: ConfidentialKeys = await confidentialKeysFrom(() => signDerivation(bytes.slice(0, 32)));

const urls = repeated('url');
if (urls.length === 0) {
  console.error('  no --url given; nothing to fetch');
  process.exit(2);
}
const budget = flag('budget');
// The cluster follows the rail: a devnet resource must not be paid from a
// testnet endpoint, or the transfer names an account that is not on that chain.
const rpcUrl = flag('rpc') ?? process.env.VEIL_RPC_URL ?? defaultRpcUrl(urls[0]!);

console.log('');
console.log(`  agent   ${signer.address}`);
console.log(`  budget  ${budget ?? '(none set — the agent will pay whatever is asked)'}`);
console.log(`  rpc     ${rpcUrl}`);
console.log('');

const agent = createVeilAgent({
  payerSigner: signer,
  keys,
  rpcUrl,
  decimals: Number(flag('decimals') ?? '6'),
  ...(budget !== undefined ? { budget } : {}),
  onStep: (step) => console.log(`  ok    ${step.label}`),
  onPayment: (payment) =>
    console.log(
      `  paid  ${payment.amount} atomic → ${payment.payTo}\n        https://explorer.solana.com/tx/${payment.signature}?cluster=${rpcUrl.includes('devnet') ? 'devnet' : 'testnet'}`,
    ),
});

let served = 0;
for (const url of urls) {
  try {
    const result = await agent.fetch(url);
    served += 1;
    console.log(`  http ${result.status}  ${url}\n        ${JSON.stringify(result.data).slice(0, 200)}`);
  } catch (error) {
    if (isVeilError(error)) {
      const envelope = error.toEnvelope();
      console.log(`  refused  ${envelope.code}  ${envelope.type}`);
      console.log(`           ${envelope.message}`);
      console.log(`           fix: ${envelope.fix}`);
      console.log(`           ${envelope.doc_url}`);
    } else {
      console.log(`  failed   ${String(error)}`);
    }
    process.exitCode = 1;
    break;
  }
}

console.log('');
console.log(`  served ${served}/${urls.length} · agent spent ${agent.spent} atomic units`);
console.log('');
