/**
 * scripts/fund-devnet.ts — get lamports onto a devnet keypair.
 *
 * Every on-chain step in Veil needs SOL: a transaction fee per transfer, plus
 * rent-exemption for each pool account. This script is the gate, and it is
 * deliberately explicit about how a route failed, because "the faucet didn't
 * work" is useless and "that RPC 429s and the web faucet needs a GitHub OAuth
 * app grant you do not have" is actionable.
 *
 *   node scripts/fund-devnet.ts                       # fund .keys/payer.json
 *   node scripts/fund-devnet.ts --lamports 2         # in SOL
 *   node scripts/fund-devnet.ts --check               # balance only
 *   node scripts/fund-devnet.ts --key .keys/fresh.json --create
 *
 * Keypair serialisation uses Node's own Ed25519 rather than any guess at the
 * SDK's writer, so the on-disk format is the Solana CLI's: a JSON array of 64
 * bytes, seed first then public key. Verified by round-trip — the same file
 * loads back to the same address.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from '@solana/kit';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Devnet endpoints that have historically served `requestAirdrop`.
 *
 * The official one is listed first, so the common failure mode (429 or the
 * method being disabled outright) is reported plainly instead of being hidden
 * behind a wall of fallbacks that all fail the same way.
 */
const ENDPOINTS = [
  'https://api.devnet.solana.com',
  'https://rpc.ankr.com/solana_devnet',
  'https://devnet.rpcpool.com',
  'https://api.devnet.solana.com',
];

/** No-auth community faucets, tried only after every RPC route refuses. */
const WEB_FAUCETS = ['faucet.triangleplatform.com', 'solfaucet.com'];

interface Args {
  readonly keyPath: string;
  readonly lamports: number;
  readonly check: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let keyPath = join(ROOT, '.keys/payer.json');
  let lamports = 2_000_000_000; // 2 SOL: fees plus rent for a comfortable pool
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') keyPath = argv[++i] ?? keyPath;
    else if (a === '--lamports') lamports = Number(argv[++i] ?? '2') * 1e9;
    else if (a === '--check') check = true;
    else if (a?.startsWith('--key=')) keyPath = a.slice(6);
    else if (a?.startsWith('--lamports=')) lamports = Number(a.slice(11)) * 1e9;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: node scripts/fund-devnet.ts [--key <path>] [--lamports <SOL>] [--check]\n',
      );
      process.exit(0);
    }
  }
  return { keyPath, lamports, check };
}

/** A fresh CLI-format keypair: 32-byte seed followed by the 32-byte public key. */
function generateCliKeyPair(): { bytes: Uint8Array; address: Uint8Array } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) {
    throw new Error(
      'the Node crypto backend did not expose raw Ed25519 key material; ' +
        'pass an existing keypair file instead of generating one',
    );
  }
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  if (seed.length !== 32 || pub.length !== 32) {
    throw new Error(`unexpected key sizes: seed=${seed.length} pub=${pub.length}`);
  }
  const bytes = new Uint8Array(64);
  bytes.set(seed, 0);
  bytes.set(pub, 32);
  void createPrivateKey;
  void createPublicKey;
  return { bytes, address: pub };
}

/**
 * Load a keypair from disk.
 *
 * Two formats are supported and both are exercised by this repo: a 32-byte
 * seed (what `setup-devnet.ts` writes) and a 64-byte CLI keypair, seed then
 * public key. A base58 string is deliberately *not* accepted — it is a format
 * nothing here produces, and silently accepting an unverified encoding in the
 * one function that handles secret keys is a worse trade than a clear error.
 */
async function loadSigner(path: string): Promise<KeyPairSigner> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${path} is not a JSON array of bytes. Supported: a 32-byte seed, or a ` +
        `64-byte CLI keypair (seed || public key).`,
    );
  }
  const bytes = Uint8Array.from(raw as number[]);
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(
    `${path} holds ${bytes.length} bytes; expected 64 (CLI keypair) or 32 (seed)`,
  );
}

async function rpc(
  url: string,
  method: string,
  params: readonly unknown[],
  timeoutMs = 15_000,
): Promise<{ result?: unknown; error?: { message?: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as never;
}

async function balanceAt(url: string, address: string): Promise<number | null> {
  try {
    const r = await rpc(url, 'getBalance', [address, { commitment: 'confirmed' }]);
    const v = r.result as { value?: number } | undefined;
    return typeof v?.value === 'number' ? v.value : null;
  } catch {
    return null;
  }
}

function report(address: string, lamports: number | null, label = 'balance'): void {
  const sol = lamports === null ? 'unreachable' : `${(lamports / 1e9).toFixed(9)} SOL`;
  process.stdout.write(`${label.padEnd(9)}${sol}   ${address}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let signer: KeyPairSigner;
  if (existsSync(args.keyPath)) {
    signer = await loadSigner(args.keyPath);
    process.stdout.write(`key      ${args.keyPath}\n`);
  } else {
    process.stdout.write(`key      ${args.keyPath} (not present — creating)\n`);
    const { bytes } = generateCliKeyPair();
    await mkdir(dirname(args.keyPath), { recursive: true });
    await writeFile(args.keyPath, JSON.stringify(Array.from(bytes)));
    signer = await createKeyPairSignerFromBytes(bytes);
    process.stdout.write('created  a fresh keypair in the Solana CLI format\n');
  }
  process.stdout.write(`address  ${signer.address}\n\n`);

  let best = 0;
  let reachable = false;
  for (const url of new Set(ENDPOINTS)) {
    const bal = await balanceAt(url, signer.address);
    if (bal !== null) reachable = true;
    if (bal !== null && bal > best) best = bal;
  }

  if (!reachable) {
    report(signer.address, null, 'balance');
    process.stdout.write(
      '\nNo devnet endpoint answered. Check network access, then re-run.\n',
    );
    process.exitCode = 2;
    return;
  }

  report(signer.address, best);
  if (best > 0) {
    process.stdout.write('\nalready funded — nothing to do.\n');
    return;
  }
  if (args.check) {
    process.stdout.write('\n(--check) balance only; no airdrop requested.\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nrequesting ${(args.lamports / 1e9).toFixed(2)} SOL\n\n`);
  for (const url of new Set(ENDPOINTS)) {
    const host = url.replace('https://', '').padEnd(30);
    try {
      const r = await rpc(url, 'requestAirdrop', [signer.address, args.lamports]);
      if (typeof r.result === 'string') {
        process.stdout.write(`${host}accepted   ${r.result}\n`);
        await new Promise((r) => setTimeout(r, 2500));
        const after = await balanceAt(url, signer.address);
        process.stdout.write(
          `\nfunded. balance now ${((after ?? 0) / 1e9).toFixed(9)} SOL\n` +
            `next: npm run setup:devnet -- --apply\n`,
        );
        return;
      }
      process.stdout.write(
        `${host}refused    ${(r.error?.message ?? 'no result').slice(0, 96)}\n`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`${host}unreachable  ${msg.slice(0, 84)}\n`);
    }
  }

  process.stdout.write('\nRPC faucets exhausted. Trying no-auth community faucets.\n\n');
  for (const host of WEB_FAUCETS) {
    try {
      const res = await fetch(`https://${host}/api/solana/devnet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: signer.address, amount: 1 }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = (await res.text()).slice(0, 110).replace(/\s+/g, ' ');
      process.stdout.write(`${host.padEnd(30)}HTTP ${res.status}  ${text}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`${host.padEnd(30)}unreachable  ${msg.slice(0, 80)}\n`);
    }
  }

  process.stdout.write(
    `
No route could fund this key from here. The remaining paths need a human, and
they are worth stating precisely rather than as "the faucet did not work":

  1. https://faucet.solana.com — the official web faucet. It needs a GitHub
     *OAuth app grant* for the Solana faucet specifically. A GitHub CLI token
     (gho_...) is not that grant, which is why having gh logged in does not
     help this script.
  2. Any wallet that already holds devnet SOL — send it to the address above.
  3. A free-tier RPC provider's dashboard (Helius, QuickNode, Alchemy) each
     expose a devnet airdrop button.

Once the address above holds SOL:

  npm run setup:devnet -- --apply                      # mint + pool, for real
  npm run status -- --chain                            # confirms the preconditions
  VEIL_RPC_URL=https://api.devnet.solana.com npm run veil -- serve

`,
  );
  process.exitCode = 2;
}

await main();
