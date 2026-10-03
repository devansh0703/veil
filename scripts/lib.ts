/**
 * Shared helpers for the Veil scripts.
 *
 * Everything here resolves inside the repository. No script reads or writes a
 * path outside the project, and the paths are derived from this file's location
 * rather than from the caller's working directory.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  return {
    mint: flag('mint') ?? process.env.VEIL_MINT ?? PLACEHOLDER_MINT,
    decimals: Number(flag('decimals') ?? process.env.VEIL_DECIMALS ?? '6'),
    network: (flag('network') ?? process.env.VEIL_NETWORK ?? DEVNET) as Network,
    spendCap: flag('spend-cap') ?? process.env.VEIL_SPEND_CAP ?? '5.00',
    rpcUrl: flag('rpc') ?? process.env.VEIL_RPC_URL,
    allowLocalSettlement:
      flag('local-settlement') === 'true' ||
      process.env.VEIL_LOCAL_SETTLEMENT === 'true',
    poolSize: Number(flag('pool-size') ?? process.env.VEIL_POOL_SIZE ?? '8'),
    port: Number(flag('port') ?? process.env.VEIL_PORT ?? '4021'),
    ledgerPath: flag('ledger') ?? process.env.VEIL_LEDGER ?? LEDGER_PATH,
    mintConfidential: parseMintConfidential(
      flag('mint-confidential') ?? process.env.VEIL_MINT_CONFIDENTIAL,
    ),
  };
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
 */
export function configFrom(options: ScriptOptions, ledger?: PoolLedger): ServerConfig {
  return {
    network: options.network,
    mint: options.mint,
    decimals: options.decimals,
    ledgerPath: options.ledgerPath,
    resources: DEFAULT_RESOURCES,
    spendCap: options.spendCap,
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.allowLocalSettlement ? { allowLocalSettlement: true } : {}),
    ...(ledger
      ? {
          privacy: poolLedgerProbe(ledger, options.mintConfidential),
          privacySource: 'pool-ledger' as const,
        }
      : { privacySource: 'none' as const }),
  };
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
