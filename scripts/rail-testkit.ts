/**
 * A rail you can start inside a script.
 *
 * Shared by `demo:batch` and `demo:smoke` so the two demos exercise the same
 * server code path the hosted rail runs — `createFacilitator` + `createVeilServer`
 * over real HTTP — rather than a mock of it. What is *not* shared is the claim:
 * both scripts report the settlement mode they actually ran in, and neither
 * pretends a chain-free settlement is a chain fact.
 *
 * The pool seats are real 32-byte addresses (generated), and the payment wires are
 * real compiled Solana transactions containing real Token-2022 confidential
 * transfer instructions. That is deliberate: the rail's central check reads the
 * signed bytes, and a demo handing it placeholder transactions would not exercise
 * the check at all — it would only exercise the branch that skips it.
 */

import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';

import { DEVNET, PLACEHOLDER_MINT, type Network } from '../packages/x402-core/src/index.ts';
import { buildConfidentialTransfer } from '../packages/onchain/src/index.ts';
import { PoolLedger } from '../packages/derive/src/index.ts';
import {
  BatchSessionManager,
  createFacilitator,
  createVeilServer,
  poolLedgerProbe,
  type ResourceDefinition,
  type ServerConfig,
} from '../packages/server/src/index.ts';
import { DATA_DIR } from './lib.ts';

const PLACEHOLDER_SIGNATURE_BYTES = new Uint8Array(64).fill(7) as never;

export interface LocalRail {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly config: ServerConfig;
  readonly ledger: PoolLedger;
  readonly sessions: BatchSessionManager;
  readonly seats: readonly string[];
  /** The payer identity every request in these demos carries. */
  readonly payer: string;
}

/**
 * A pool of one-time seats.
 *
 * Real key pairs, generated offline: the seats need addresses, and generating
 * them the same way a real pool is provisioned means the demo's ledger is the
 * same shape as the one on devnet — not a fixture with made-up strings.
 */
export async function provisionSeats(alias: string, count: number): Promise<{
  ledger: PoolLedger;
  addresses: readonly string[];
}> {
  const ledger = PoolLedger.empty();
  const addresses: string[] = [];
  for (let slot = 0; slot < count; slot++) {
    const signer = await generateKeyPairSigner();
    ledger.register({ slot, address: signer.address, alias, armed: true });
    addresses.push(signer.address);
  }
  return { ledger, addresses };
}

export async function startLocalRail(options: {
  readonly ledger: PoolLedger;
  readonly resources: readonly ResourceDefinition[];
  readonly seats: readonly string[];
  readonly decimals?: number;
  readonly network?: Network;
  readonly sessions?: boolean;
  readonly ledgerFile?: string;
  readonly payer?: string;
}): Promise<LocalRail> {
  const decimals = options.decimals ?? 6;
  const sessions = new BatchSessionManager({ decimals });
  const config: ServerConfig = {
    network: options.network ?? DEVNET,
    mint: PLACEHOLDER_MINT,
    decimals,
    ledgerPath: options.ledgerFile ?? join(DATA_DIR, 'demo', 'batch-ledger.json'),
    resources: options.resources,
    // The chain-free protocol mode, loudly labelled: every receipt and every
    // settlement row this rail produces says `local-ledger-only`, and the
    // scripts print that rather than calling it a settlement.
    allowLocalSettlement: true,
    privacy: poolLedgerProbe(options.ledger, true),
    privacySource: 'pool-ledger',
    ...(options.sessions === false ? {} : { batchSessions: sessions }),
  };

  const facilitator = createFacilitator(config, options.ledger);
  const server: Server = createVeilServer(config, facilitator);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    config,
    ledger: options.ledger,
    sessions,
    seats: options.seats,
    payer: options.payer ?? 'demo-agent',
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Make sure the scratch directory these scripts write to exists. */
export async function ensureScratch(): Promise<void> {
  await mkdir(join(DATA_DIR, 'demo'), { recursive: true });
}

/**
 * A real confidential-transfer transaction paying `destination`.
 *
 * Compiled and base64-encoded exactly as a funded payer's client would produce it,
 * with placeholder signature bytes: the rail reads the *message* (program ids,
 * discriminators, account list) and never verifies the signature here, because in
 * these demos there is no chain for the signature to matter to.
 */
export function confidentialWire(input: {
  readonly destination: string;
  readonly mint?: string;
  readonly feePayer?: string;
  readonly sourceToken?: string;
  readonly authority?: string;
  readonly sourceDecryptableBalance?: Uint8Array;
}): string {
  const feePayer = (input.feePayer ?? '3RWhpyX2JaE89UWqxM8LRsB3xykSVwHyEvBmgdo9N1FJ') as Address;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        buildConfidentialTransfer({
          sourceToken: (input.sourceToken ??
            '8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21') as Address,
          mint: (input.mint ?? PLACEHOLDER_MINT) as Address,
          destinationToken: input.destination as Address,
          authority: {
            address: (input.authority ?? 'Ep1X1BnzWk3u5tgbFUSi2xHiym8CbnmraJZaPVxhGpcR') as Address,
          } as never,
          newSourceDecryptableAvailableBalance:
            input.sourceDecryptableBalance ?? new Uint8Array(36),
        }),
        m,
      ),
  );
  const compiled = compileTransaction(message);
  return getBase64EncodedWireTransaction({
    ...compiled,
    signatures: { [feePayer]: PLACEHOLDER_SIGNATURE_BYTES },
  });
}

/** The `accepted` entry a payer answers, taken from the rail's own 402 body. */
export function paymentHeaderFrom(input: {
  readonly accept: {
    readonly scheme: string;
    readonly network: string;
    readonly asset: string;
    readonly payTo: string;
    readonly amount: string;
    readonly maxAmountRequired: string;
    readonly resource: string;
    readonly maxTimeoutSeconds: number;
    readonly extra: Record<string, unknown>;
  };
  readonly destination: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: 'exact-confidential',
      network: input.accept.network,
      accepted: input.accept,
      payload: {
        transaction: confidentialWire({ destination: input.destination, mint: input.accept.asset }),
        payTo: input.destination,
        asset: input.accept.asset,
      },
    }),
    'utf8',
  ).toString('base64');
}

/** A tiny aligned table, so the demos read like output rather than a transcript. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows.reduce<number[]>((acc, row) => {
    row.forEach((cell, i) => {
      acc[i] = Math.max(acc[i] ?? 0, cell.length);
    });
    return acc;
  }, []);
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}
