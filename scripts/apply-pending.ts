/**
 * scripts/apply-pending.ts — turn a pending confidential credit into a
 * spendable balance.
 *
 *   node scripts/apply-pending.ts --key .keys/test-payee.json --mint H1WQ… \
 *     --rpc https://api.testnet.solana.com
 *
 * A confidential transfer credits the destination's *pending* balance, not its
 * available one. The recipient has to run `ApplyPendingBalance` (signed by the
 * account's owner, paid by the owner's SOL) before it can spend the money. This
 * is that step, on its own, so a payee can settle its own books without
 * re-running anything on the payer's side.
 *
 * The account is located from the owner's token accounts for the mint unless
 * `--account` names one directly.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createSolanaRpc, type Address } from '@solana/kit';

import { applyPending, readTokenAccount } from '../packages/client/src/index.ts';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { signerFromKeyBytes } from './lib.ts';
import {
  confidentialDerivationMessage,
  confidentialKeysFrom,
} from '../packages/onchain/src/proofs.ts';

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

const readOnly = process.argv.includes('--read-only');
const keyPath = flag('key');
if (!keyPath) {
  console.error('usage: node scripts/apply-pending.ts --key <owner.json> --mint <mint> [--account <addr>] [--rpc <url>]');
  process.exit(2);
}
const rpcUrl = flag('rpc') ?? process.env.VEIL_RPC_URL ?? 'https://api.testnet.solana.com';
const cluster = rpcUrl.includes('devnet') ? '?cluster=devnet' : '?cluster=testnet';

// `resolve`, not `join` — see the note in scripts/sandbox.ts.
const ownerBytes = Uint8Array.from(JSON.parse(await readFile(resolve(process.cwd(), keyPath), 'utf8')));
const owner = await signerFromKeyBytes(ownerBytes);
const keys = await confidentialKeysFrom(() => signDerivation(ownerBytes.slice(0, 32)));
const rpc = createSolanaRpc(rpcUrl);

console.log('');
console.log(`  owner     ${owner.address}`);
console.log(`  rpc       ${rpcUrl}`);

const mint = (flag('mint') ?? process.env.VEIL_MINT) as Address | undefined;
const explicit = flag('account') as Address | undefined;

/**
 * Which accounts to report.
 *
 * A merchant's money is spread across its one-time seats, so looking up "the"
 * account for a mint reports whichever one the RPC happens to return first —
 * which, after a few payments, is frequently an empty seat. That reads as "the
 * payment never arrived" when it plainly did, so every seat is enumerated and
 * the totals are summed. `--account` still narrows to one when you want that.
 */
let accounts: Address[];
if (explicit) {
  accounts = [explicit];
} else {
  if (!mint) {
    console.error('  provide --account <token account> or --mint <mint>');
    process.exit(2);
  }
  const owned = await rpc
    .getTokenAccountsByOwner(
      owner.address,
      { programId: TOKEN_2022_PROGRAM_ADDRESS },
      { encoding: 'base64' },
    )
    .send();
  accounts = [];
  for (const entry of owned.value) {
    // The mint is on the decoded account, not on the client's summary type.
    const state = await readTokenAccount(rpc, entry.pubkey as Address, keys);
    const decodedMint = (state.decoded as { mint?: string }).mint;
    if (decodedMint === mint) accounts.push(entry.pubkey as Address);
  }
  if (accounts.length === 0) {
    console.error(`  no Token-2022 account for ${owner.address} holding ${mint}`);
    process.exit(1);
  }
}

let totalAvailable = 0n;
let totalPending = 0n;
let lastSignature: string | null = null;

for (const account of accounts) {
  const before = await readTokenAccount(rpc, account, keys);
  totalAvailable += before.available;
  totalPending += before.pending;
  console.log(`  account   ${account}`);
  console.log(`            available ${before.available}, pending ${before.pending}`);
  if (before.pending === 0n || readOnly) continue;

  const signature = await applyPending(rpc, account, owner, keys);
  lastSignature = signature;
  console.log(`  applied   ${signature}`);
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await rpc.getSignatureStatuses([signature as never]).send();
    const entry = status.value[0];
    if (entry?.err) {
      console.error('  FAILED on chain', JSON.stringify(entry.err));
      process.exit(1);
    }
    if (entry?.confirmationStatus) {
      console.log(`  confirmed (${entry.confirmationStatus})`);
      break;
    }
  }
  const after = await readTokenAccount(rpc, account, keys);
  console.log(`            after: available ${after.available}, pending ${after.pending}`);
}

console.log('');
console.log(
  `  total     available ${totalAvailable}, pending ${totalPending}  across ${accounts.length} seat(s)`,
);
if (readOnly) console.log('  read-only; nothing applied');
if (lastSignature) console.log(`  explorer  https://explorer.solana.com/tx/${lastSignature}${cluster}`);
