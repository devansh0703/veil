/**
 * Shared helpers for the Veil scripts.
 *
 * Everything here resolves inside the repository. No script reads or writes a
 * path outside the project, and the paths are derived from this file's location
 * rather than from the caller's working directory.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from '@solana/kit';

import {
  DEVNET,
  PLACEHOLDER_MINT,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  type Network,
  networkFromRpc,
  normalizeNetwork,
} from '../packages/x402-core/src/index.ts';
import { PoolLedger } from '../packages/derive/src/index.ts';
import {
  DEFAULT_RESOURCES,
  poolLedgerProbe,
  type LedgerStore,
  type ServerConfig,
} from '../packages/server/src/index.ts';

// `fileURLToPath(new URL('..'))` keeps a trailing slash, which would break every
// `relative()` call by producing `//` and matching nothing.
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
export const DATA_DIR = join(PROJECT_ROOT, 'data');
export const LEDGER_PATH = join(DATA_DIR, 'pool-ledger.json');
export const SETTLEMENTS_PATH = join(DATA_DIR, 'settlements.json');
export const KEYS_DIR = join(PROJECT_ROOT, '.keys');
/** Where a verified mint is recorded, so `serve` never has to guess one. */
export const MINT_PATH = join(DATA_DIR, 'mint.json');
/**
 * The demo run's own data directory.
 *
 * Kept separate from `data/` so a demo run can be rebuilt from scratch every
 * time without destroying a pool that was actually created on chain. That
 * matters because a consumed pool is not reusable — the whole privacy claim is
 * that an address is used once — so a demo that silently reused one would be
 * lying about the thing it is demonstrating.
 */
export const DEMO_DIR = join(DATA_DIR, 'demo');
export const DEMO_LEDGER_PATH = join(DEMO_DIR, 'pool-ledger.json');
export const DEMO_RUN_PATH = join(DEMO_DIR, 'run.json');
export const FIXTURES_DIR = join(DATA_DIR, 'fixtures');

export function relative(path: string): string {
  return path.replace(`${PROJECT_ROOT}/`, '');
}

/**
 * A filename tag for the cluster a chain-facing run actually talked to.
 *
 * Pool seats and payer token accounts are derived from fixed seeds, so the
 * *same address* exists on every cluster. A run record keyed only by address
 * would then let a testnet run's `funded` set block a devnet run from paying
 * into its own, still-empty copy of that seat — and the check that refuses a
 * non-empty destination would fire against an account that is empty on this
 * chain because it was paid on another. The endpoint decides the tag; the
 * configured network is only a fallback for hosts the URL does not name.
 *
 * Testnet keeps the untagged filenames: those runs predate the tag and remain
 * that cluster's live record.
 */
export function clusterTag(rpcUrl: string | undefined, network: string): string {
  const resolved =
    (rpcUrl ? networkFromRpc(rpcUrl) : undefined) ??
    (() => {
      try {
        return normalizeNetwork(network);
      } catch {
        return undefined;
      }
    })();
  if (resolved === SOLANA_DEVNET) return '.devnet';
  if (resolved === SOLANA_MAINNET) return '.mainnet';
  return '';
}

/**
 * The public RPC to reach when the caller names a rail but not an RPC.
 *
 * The cluster follows the rail, never a hardcoded default. A client pointed at
 * a devnet resource but given a testnet endpoint builds a transfer for an
 * account that does not exist on that chain, and it fails as a confusing proof
 * or missing-account error instead of an obvious "wrong cluster". So an origin
 * that says `devnet` gets the devnet endpoint and anything else keeps testnet,
 * which is what these scripts defaulted to before the primary rail moved.
 *
 * An explicit `VEIL_RPC_URL` or `--rpc` still wins: this is only the default
 * for a caller that expressed no preference.
 */
export function defaultRpcUrl(rail: string): string {
  return rail.includes('devnet')
    ? 'https://api.devnet.solana.com'
    : 'https://api.testnet.solana.com';
}

/**
 * Where Solami serves Solana, and the key that unlocks it.
 *
 * Solami is a hosted RPC provider with a free tier (`SOLAMI_API_KEY`). Its
 * Solana route is **mainnet-beta only** — the cluster segment accepts `solana`
 * (plus `sol`/`Solana`) and nothing else, and query params cannot change that:
 * `?network=devnet` is ignored and the endpoint still answers with mainnet's
 * genesis hash. That is a property of the provider, not of this client, and it
 * is why `solamiRpcUrl` returns undefined off mainnet rather than guessing a
 * URL that does not exist.
 *
 * The tests and the devnet rail therefore keep their cluster's public endpoint.
 * Solami is wired here so a mainnet deployment is a configuration change — put
 * the key in the environment — instead of a code change.
 */
export const SOLAMI_RPC_HOST = 'https://rpc.solami.dev';

export function solamiRpcUrl(
  network: Network | string,
  apiKey: string | undefined = process.env.SOLAMI_API_KEY,
): string | undefined {
  if (!apiKey) return undefined;
  let resolved: string | undefined;
  try {
    resolved = normalizeNetwork(network);
  } catch {
    return undefined;
  }
  if (resolved !== SOLANA_MAINNET) return undefined;
  return `${SOLAMI_RPC_HOST}/solana?api-key=${encodeURIComponent(apiKey)}`;
}

/**
 * Where Helius serves Solana, and the key that unlocks it.
 *
 * Helius (`HELIUS_API_KEY`) is a hosted RPC provider with a free tier that
 * serves **mainnet and devnet only**: `testnet.helius-rpc.com` does not resolve
 * and the provider's own docs list exactly two clusters. Like `solamiRpcUrl`
 * and for the same reason, this returns undefined for testnet rather than a URL
 * that does not exist — testnet keeps its public endpoint instead of being
 * pointed at a node that answers for a different chain.
 *
 * It sits behind Solami in the fallback chain, so a mainnet rail configured for
 * Solami is untouched. Devnet — the rail this project actually runs — gets a
 * dedicated node the moment the key is in the environment, instead of the
 * rate-limited public one.
 */
export const HELIUS_DEVNET_RPC_HOST = 'https://devnet.helius-rpc.com';
export const HELIUS_MAINNET_RPC_HOST = 'https://mainnet.helius-rpc.com';

export function heliusRpcUrl(
  network: Network | string,
  apiKey: string | undefined = process.env.HELIUS_API_KEY,
): string | undefined {
  if (!apiKey) return undefined;
  let resolved: string | undefined;
  try {
    resolved = normalizeNetwork(network);
  } catch {
    return undefined;
  }
  if (resolved === SOLANA_DEVNET) {
    return `${HELIUS_DEVNET_RPC_HOST}/?api-key=${encodeURIComponent(apiKey)}`;
  }
  if (resolved === SOLANA_MAINNET) {
    return `${HELIUS_MAINNET_RPC_HOST}/?api-key=${encodeURIComponent(apiKey)}`;
  }
  return undefined;
}

export async function loadLedger(path = LEDGER_PATH): Promise<PoolLedger> {
  try {
    const raw = await readFile(path, 'utf8');
    return PoolLedger.fromJSON(JSON.parse(raw));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return PoolLedger.empty();
    throw error;
  }
}

export async function saveLedger(
  ledger: PoolLedger,
  path = LEDGER_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`, 'utf8');
}

export async function saveJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return fallback;
    throw error;
  }
}

export interface ScriptOptions {
  readonly mint: string;
  readonly decimals: number;
  readonly network: Network;
  readonly spendCap: string;
  readonly rpcUrl?: string;
  readonly allowLocalSettlement: boolean;
  readonly poolSize: number;
  readonly port: number;
  /** Where the pool ledger lives. Overridable so a demo run can own a fresh one. */
  readonly ledgerPath: string;
  /**
   * Whether the configured mint carries the confidential-transfer extension.
   *
   * `'unknown'` is the default and is *not* a pass: a deployment that has not
   * verified its mint refuses every paid resource with VEIL-CONF-003. The
   * devnet setup script sets this from a real read of the mint account; a
   * chain-free demo declares it, and says so through `privacySource`.
   */
  readonly mintConfidential: boolean | 'unknown';
}

/**
 * Options come from the environment so the same scripts run unchanged against a
 * local pool or a real devnet mint.
 */
export function optionsFromEnv(argv: readonly string[] = []): ScriptOptions {
  const flag = (name: string): string | undefined => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0) return argv[index + 1];
    return undefined;
  };

  const network = (flag('network') ?? process.env.VEIL_NETWORK ?? DEVNET) as Network;

  return {
    mint: flag('mint') ?? process.env.VEIL_MINT ?? PLACEHOLDER_MINT,
    decimals: Number(flag('decimals') ?? process.env.VEIL_DECIMALS ?? '6'),
    network,
    spendCap: flag('spend-cap') ?? process.env.VEIL_SPEND_CAP ?? '5.00',
    rpcUrl:
      flag('rpc') ??
      process.env.VEIL_RPC_URL ??
      // A configured endpoint always wins, because it names the cluster the
      // deployment is really on. Solami is the default only where it can serve
      // the cluster — mainnet — and undefined everywhere else. Helius runs
      // behind it and picks up devnet (and mainnet when no Solami key is set);
      // neither provider runs a testnet node, so testnet falls through to
      // undefined rather than being pointed at a cluster the provider does not
      // serve — the caller names one with --rpc or VEIL_RPC_URL, as always.
      solamiRpcUrl(network) ??
      heliusRpcUrl(network),
    allowLocalSettlement:
      flag('local-settlement') === 'true' ||
      process.env.VEIL_LOCAL_SETTLEMENT === 'true',
    poolSize: Number(flag('pool-size') ?? process.env.VEIL_POOL_SIZE ?? '8'),
    port: Number(flag('port') ?? process.env.VEIL_PORT ?? '4021'),
    ledgerPath:
      flag('ledger') ?? process.env.VEIL_LEDGER ?? defaultLedgerFor(network, flag('rpc') ?? process.env.VEIL_RPC_URL),
    mintConfidential: parseMintConfidential(
      flag('mint-confidential') ?? process.env.VEIL_MINT_CONFIDENTIAL,
    ),
  };
}

/**
 * The pool ledger that belongs to this cluster.
 *
 * `data/pool-ledger.json` holds whichever pool was set up most recently, and
 * nothing ties it to a cluster. Reading it against a different one reports
 * another cluster's seats: `status --chain` on devnet read the 24 testnet
 * accounts, found 0 able to receive confidentially, and told the operator a
 * server must refuse — while the devnet pool was 3/3 healthy in
 * `data/pool-ledger.devnet.json`. A cluster-suffixed file, when one exists, is
 * the honest default. An explicit `--ledger` or `VEIL_LEDGER` still wins, so the
 * hosted rail keeps its pinned file.
 */
function defaultLedgerFor(network: Network, rpcUrl: string | undefined): string {
  // clusterTag already follows the repo's convention: testnet keeps the
  // untagged name, devnet and mainnet carry a tag.
  const tagged = join(DATA_DIR, `pool-ledger${clusterTag(rpcUrl, network)}.json`);
  return existsSync(tagged) ? tagged : LEDGER_PATH;
}

/**
 * Read a secret key from either format a user is likely to have.
 *
 * `solana-keygen` writes a JSON array of bytes; a wallet export is usually
 * base58. Accepting only one of them means a user with the other gets an error
 * that blames the wrong thing.
 */
export function decodeSecret(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return null;
      const bytes = Uint8Array.from(parsed as number[]);
      return bytes.length >= 32 ? bytes : null;
    } catch {
      return null;
    }
  }
  const bytes = base58Decode(text);
  return bytes && bytes.length >= 32 ? bytes : null;
}

/**
 * A signer from key-file bytes, accepting both layouts this repo holds.
 *
 * `.keys/payer.json` is a 32-byte *seed*; the keys the CLI generates are 64-byte
 * `seed ‖ publicKey` keypairs. `createKeyPairSignerFromBytes` takes only the
 * 64-byte form and rejects a seed with a byte-length error that names neither
 * the file nor the difference, so both are accepted here rather than leaving the
 * caller to discover which file they happened to point at.
 */
export async function signerFromKeyBytes(bytes: Uint8Array): Promise<KeyPairSigner> {
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  return createKeyPairSignerFromBytes(bytes);
}

/** Minimal base58 decoder, so scripts do not need a dependency for one helper. */
export function base58Decode(value: string): Uint8Array | null {
  const alphabet =
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (value.length === 0) return null;
  const bytes: number[] = [0];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit === -1) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/** `true` / `false` / anything else stays `'unknown'` — never a silent pass. */
export function parseMintConfidential(
  raw: string | undefined,
): boolean | 'unknown' {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return 'unknown';
}

/**
 * Build the server config.
 *
 * The privacy probe is only wired when a ledger is supplied, because the probe's
 * job is to answer from a real record. Without one the server keeps the
 * fail-closed default and refuses every paid resource — which is the correct
 * behaviour for a process that has nothing to vouch for its own privacy claim.
 *
 * A `ledgerStore` is threaded through so the caller can keep the config it
 * built and the store it built it with in one place: `flush()` reads it off the
 * config, so a store left out here is a store the server never writes to.
 */
export function configFrom(
  options: ScriptOptions,
  ledger?: PoolLedger,
  ledgerStore?: LedgerStore,
): ServerConfig {
  return {
    network: options.network,
    mint: options.mint,
    decimals: options.decimals,
    ledgerPath: options.ledgerPath,
    resources: DEFAULT_RESOURCES,
    spendCap: options.spendCap,
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.allowLocalSettlement ? { allowLocalSettlement: true } : {}),
    ...(ledgerStore ? { ledgerStore } : {}),
    ...(ledger
      ? {
          privacy: poolLedgerProbe(ledger, options.mintConfidential),
          privacySource: 'pool-ledger' as const,
        }
      : { privacySource: 'none' as const }),
  };
}

/**
 * Build the fee-payer co-signer the resource server needs to settle inline.
 *
 * The payer signs only its own half of a payment transaction; the fee payer's
 * signature is filled in at settlement. The facilitator service owns that step
 * (`scripts/facilitator-app.ts`), but a resource server that broadcasts inline
 * — the hosted `/v1/*` rail and `npm run serve` — needs the same capability or
 * every settlement is rejected as "did not pass signature verification".
 *
 * The key is `VEIL_PAYER_SECRET` when the deployment supplies one (the hosted
 * runtime holds no `.keys/`), otherwise the local `payer.json`. No usable key is
 * not an error: it simply leaves the server's pass-through behaviour, which is
 * correct for a fully signed payer transaction.
 */
export async function feePayerCosignerFrom(
  options: ScriptOptions,
): Promise<((transaction: string) => Promise<string>) | undefined> {
  const fromEnv = process.env.VEIL_PAYER_SECRET;
  const seed = fromEnv
    ? decodeSecret(fromEnv)
    : await readFile(join(KEYS_DIR, 'payer.json'), 'utf8')
        .then((raw) => decodeSecret(raw))
        .catch(() => null);
  if (!seed) return undefined;

  // Imported lazily so a chain-free run (demo, tests) never loads the key
  // machinery, and the module's static graph stays small.
  const { createKeyPairSignerFromPrivateKeyBytes } = await import('@solana/kit');
  const { toFacilitatorSvmSigner } = await import('@x402/svm');
  const feePayer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const signer = toFacilitatorSvmSigner(feePayer, {
    ...(options.rpcUrl ? { defaultRpcUrl: options.rpcUrl } : {}),
  });
  // The CAIP-2 argument is unused by this signer (it only adds a signature the
  // facilitator's key already authorises); the payer's bytes are untouched.
  return (transaction: string) =>
    signer.signTransaction(transaction, feePayer.address, options.network);
}

/** Minimal aligned table printer, so script output is readable in a terminal. */
export function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? '').length)),
  );
  return rows
    .map((r) =>
      r.map((cell, col) => (cell ?? '').padEnd(widths[col]!)).join('  ').trimEnd(),
    )
    .join('\n');
}
