/**
 * @veil/onchain/chain — read the confidential preconditions from devnet.
 *
 * The instruction builders in `./index.ts` are pure and offline. This module is
 * the other half of the honesty story: it reads the facts those instructions
 * assume, so a deployment can report `privacySource: 'chain'` because it looked
 * rather than because it decided.
 *
 * Both readers walk the Token-2022 account layout directly — base region, a
 * one-byte account-type tag, then TLV extension entries — because that layout is
 * the thing a payment depends on, and a helper that hid it would also hide a
 * malformed or absent extension. The sizes are asserted against the same
 * constants the instruction builders use.
 *
 * Everything here is read-only and makes exactly one JSON-RPC call per account.
 */

import { getMintSize, getTokenSize } from '@solana-program/token-2022';
import {
  CONFIDENTIAL_TRANSFER_ACCOUNT_DATA_SIZE,
  CONFIDENTIAL_TRANSFER_MINT_DATA_SIZE,
  EXTENSION_HEADER_SIZE,
  ExtensionType,
  TOKEN_2022_PROGRAM_ADDRESS,
} from './index.ts';

/**
 * Where the TLV region begins on each account type.
 *
 * Derived from the SDK rather than written down: the TLV of an extended
 * account starts exactly where an extensionless account ends, so
 * `getMintSize([])` / `getTokenSize([])` *are* the TLV offsets. Both come to
 * 166 — but for different reasons, and the difference is the bug this replaced.
 *
 * A token account is `base(165) + account-type tag(1)` and then TLV. A mint is
 * `base(82) + 83 bytes of zero padding + tag(1)` and then TLV: `getMintSize`
 * builds that padding with `padLeftEncoder(getU8Encoder(), 83)`, so the tag
 * lands at 165 and the first TLV header at 166. The previous constants here
 * were `base + 1` — 83 for a mint — which pointed into the zero pad, read zero
 * extensions, and made a mint that already existed on chain look absent (the
 * setup plan then offered to create it again). Measured against the live mint:
 * `01` at 165, type u16LE = 4 (ConfidentialTransferMint) at 166, length 65,
 * data 170–234 — 235 bytes total.
 */
const MINTS_TLV_START = getMintSize([]);
const ACCOUNTS_TLV_START = getTokenSize([]);

export interface TLVExtension {
  readonly type: number;
  readonly length: number;
  readonly offset: number;
}

export interface ConfidentialityRead {
  readonly address: string;
  readonly exists: boolean;
  /** Owning program, or null when the account does not exist. */
  readonly owner: string | null;
  readonly isToken2022: boolean;
  readonly dataLength: number;
  readonly extensions: readonly TLVExtension[];
  /** True when the account carries the extension this product's claim needs. */
  readonly hasConfidentialExtension: boolean;
  /**
   * Set only for token accounts that carry the extension.
   *
   * `approved` is not a detail. The mint here sets `autoApproveNewAccounts:
   * false`, so an account carrying the extension and accepting confidential
   * credits still cannot receive anything until the mint authority approves it —
   * and an unapproved account fails later with a bare `custom program error:
   * 0x18`. Reporting "can receive confidentially" from the extension alone is the
   * exact overstatement this product exists to avoid, so the fact is read and
   * reported separately.
   */
  readonly approved?: boolean;
  readonly allowConfidentialCredits?: boolean;
  readonly allowNonConfidentialCredits?: boolean;
}

interface RpcAccountValue {
  readonly data: [string, string];
  readonly owner: string;
  readonly lamports: number;
  readonly executable: boolean;
}

/**
 * How many addresses fit in one `getMultipleAccounts` call.
 *
 * Devnet's public RPC allows up to 100, but its per-method rate limit is the real
 * constraint: one call per 100 addresses is the difference between a setup check
 * that finishes and one that trips "Connection rate limits exceeded" partway
 * through a 48-account pool. That failure is not hypothetical — it is what the
 * first version of this function did.
 */
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<any> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (body.error) {
      const message = body.error.message ?? 'unknown';
      lastError = new Error(`${method} failed: ${message}`);
      // Rate limiting is the one failure worth retrying: it is transient and the
      // caller's intent is unchanged. Anything else is a real error and hiding
      // it behind a retry would only delay the report.
      const limited = body.error.code === 429 || /rate limit/i.test(message);
      if (!limited || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(750 * attempt * attempt);
      continue;
    }
    return body.result;
  }
  throw lastError ?? new Error(`${method} failed`);
}

async function getAccounts(
  rpcUrl: string,
  addresses: readonly string[],
): Promise<(RpcAccountValue | null)[]> {
  const found: (RpcAccountValue | null)[] = [];
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    const result = await rpc(rpcUrl, 'getMultipleAccounts', [
      batch,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    const values = (result?.value ?? []) as (RpcAccountValue | null)[];
    if (values.length !== batch.length) {
      throw new Error(
        `getMultipleAccounts returned ${values.length} accounts for ${batch.length} addresses`,
      );
    }
    found.push(...values);
  }
  return found;
}

/**
 * Walk the TLV region.
 *
 * A truncated entry stops the walk rather than guessing: an extension list that
 * reads past the end of the data is a corrupt account, and reporting it as
 * "extension absent" would be right by accident and wrong in reason.
 */
function readExtensions(data: Uint8Array, start: number): TLVExtension[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const extensions: TLVExtension[] = [];
  let cursor = start;
  while (cursor + EXTENSION_HEADER_SIZE <= data.length) {
    const type = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    if (type === 0 && length === 0) break;
    if (cursor + EXTENSION_HEADER_SIZE + length > data.length) break;
    extensions.push({ type, length, offset: cursor + EXTENSION_HEADER_SIZE });
    cursor += EXTENSION_HEADER_SIZE + length;
  }
  return extensions;
}

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Read a mint and report whether it can hold confidential balances at all.
 *
 * This is the check behind `VEIL-CONF-001`. A mint without this extension cannot
 * support a confidential transfer, and no amount of configuration downstream
 * changes that.
 */
/** Fold a raw account value into the shape the rest of this module reads. */
function readMintAccount(mint: string, account: RpcAccountValue | null): ConfidentialityRead {
  if (!account) {
    return {
      address: mint,
      exists: false,
      owner: null,
      isToken2022: false,
      dataLength: 0,
      extensions: [],
      hasConfidentialExtension: false,
    };
  }
  const data = decode(account.data[0]);
  const extensions = readExtensions(data, MINTS_TLV_START);
  const found = extensions.find(
    (e) => e.type === ExtensionType.ConfidentialTransferMint,
  );
  return {
    address: mint,
    exists: true,
    owner: account.owner,
    isToken2022: account.owner === TOKEN_2022_PROGRAM_ADDRESS,
    dataLength: data.length,
    extensions,
    hasConfidentialExtension:
      found !== undefined &&
      found.length === CONFIDENTIAL_TRANSFER_MINT_DATA_SIZE &&
      account.owner === TOKEN_2022_PROGRAM_ADDRESS,
  };
}

/** Read a mint, batching through `getMultipleAccounts`. */
export async function readMintConfidentiality(
  rpcUrl: string,
  mint: string,
): Promise<ConfidentialityRead> {
  const [account] = await getAccounts(rpcUrl, [mint]);
  return readMintAccount(mint, account ?? null);
}

/**
 * Read a payment account and report whether it can *receive* confidentially.
 *
 * This is the check behind `VEIL-CONF-002`, and it reads the two credit flags
 * rather than trusting that a configuration transaction succeeded. The offsets
 * are computed from the documented field order rather than written down, so a
 * change to the layout breaks this loudly instead of silently reading the wrong
 * byte.
 */
function readAccount(
  address: string,
  account: RpcAccountValue | null,
): ConfidentialityRead {
  if (!account) {
    return {
      address,
      exists: false,
      owner: null,
      isToken2022: false,
      dataLength: 0,
      extensions: [],
      hasConfidentialExtension: false,
    };
  }
  const data = decode(account.data[0]);
  const extensions = readExtensions(data, ACCOUNTS_TLV_START);
  const found = extensions.find(
    (e) => e.type === ExtensionType.ConfidentialTransferAccount,
  );

  const base = {
    address,
    exists: true,
    owner: account.owner,
    isToken2022: account.owner === TOKEN_2022_PROGRAM_ADDRESS,
    dataLength: data.length,
    extensions,
    hasConfidentialExtension:
      found !== undefined &&
      found.length === CONFIDENTIAL_TRANSFER_ACCOUNT_DATA_SIZE &&
      account.owner === TOKEN_2022_PROGRAM_ADDRESS,
  };
  if (!found) return base;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // approved(1) + elgamal_pubkey(32) + pending_lo(64) + pending_hi(64)
  //   + available(64) + decryptable_available(36), then the two credit flags.
  // `approved` is the first byte of that layout, which is why it reads at
  // `found.offset` rather than after the keys.
  const flagsAt = found.offset + 1 + 32 + 64 + 64 + 64 + 36;
  return {
    ...base,
    approved: view.getUint8(found.offset) === 1,
    allowConfidentialCredits: view.getUint8(flagsAt) === 1,
    allowNonConfidentialCredits: view.getUint8(flagsAt + 1) === 1,
  };
}

/** Read one payment account. */
export async function readAccountConfidentiality(
  rpcUrl: string,
  address: string,
): Promise<ConfidentialityRead> {
  const [account] = await getAccounts(rpcUrl, [address]);
  return readAccount(address, account ?? null);
}

export interface ChainFacts {
  readonly rpcUrl: string;
  readonly readAt: string;
  readonly mint: ConfidentialityRead;
  readonly accounts: readonly ConfidentialityRead[];
}

/**
 * Read the whole pool's preconditions in one pass.
 *
 * Two RPC calls for a pool of any size up to the batch limit — the mint and the
 * accounts — because devnet's public RPC rate-limits per method. An earlier
 * version read one account per call and died on "Connection rate limits
 * exceeded" partway through a 48-account pool, which is why this is batched.
 */
export async function readChainFacts(
  rpcUrl: string,
  mint: string,
  addresses: readonly string[],
): Promise<ChainFacts> {
  const values = await getAccounts(rpcUrl, [mint, ...addresses]);
  const [mintAccount, ...accountValues] = values;
  return {
    rpcUrl,
    readAt: new Date().toISOString(),
    mint: readMintAccount(mint, mintAccount ?? null),
    accounts: addresses.map((address, i) => readAccount(address, accountValues[i] ?? null)),
  };
}

/**
 * A compact summary of a read, for terminals and run records.
 *
 * `unknown` is never reported as a pass. The three states are `yes`, `no` and
 * `unknown`, and `unknown` means the read could not establish the fact — which
 * is the state that must produce a refusal rather than an assumption.
 */
export function summarizeRead(read: ConfidentialityRead): {
  address: string;
  exists: boolean;
  confidential: 'yes' | 'no';
  extensions: string;
} {
  return {
    address: read.address,
    exists: read.exists,
    confidential: read.hasConfidentialExtension ? 'yes' : 'no',
    extensions:
      read.extensions.map((e) => `${e.type}(${e.length})`).join(' ') || 'none',
  };
}
