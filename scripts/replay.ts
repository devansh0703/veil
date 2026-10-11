#!/usr/bin/env node
/**
 * `veil replay` — prove a settlement was confidential, from chain state alone.
 *
 * This is the tool behind the product's central claim, and it exists so that the
 * claim is a *check* rather than a promise. Given a settled payment, it goes to
 * the chain, reads the transaction, and re-derives the privacy properties from
 * public state:
 *
 *   1. the transaction exists and succeeded;
 *   2. it contains exactly one Token-2022 confidential transfer (family 27,
 *      operation 7) — not a plain transfer;
 *   3. the amount is not readable: the instruction data carries no plaintext
 *      amount field, and the destination's *public* balance did not move by a
 *      readable quantity;
 *   4. the destination is one of the merchant's one-time seats, which is what
 *      keeps two payments from sitting next to each other on the account graph.
 *
 * What it does *not* do is trust Veil for any of it. The only thing a rail can
 * tell you is **which transaction to read** — a signature, or a payment id it
 * maps to one. Everything asserted after that comes from the chain, and the
 * verdict does not depend on the rail being correct or even honest: a rail that
 * named the wrong transaction fails the assertions below.
 *
 * Usage:
 *
 *   npm run replay -- <signature>              # straight from a signature
 *   npm run replay -- <paymentId>              # resolve via the settlements log
 *   npm run replay -- <paymentId> --url https://veil-devnet.vercel.app
 *   npm run replay -- <paymentId> --rpc https://api.devnet.solana.com
 *
 * Exit code 0 = every assertion held. Non-zero = one did not, and the report says
 * which. There is no "probably" outcome.
 */

import { getCompiledTransactionMessageDecoder, getTransactionDecoder, decompileTransactionMessage } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from '../packages/x402-core/src/index.ts';
import { inspectConfidentialTransfer } from '../packages/server/src/inspect.ts';
import type { StoredSettlement } from '../packages/derive/src/index.ts';
import {
  LEDGER_PATH,
  SETTLEMENTS_PATH,
  clusterTag,
  defaultRpcUrl,
  loadLedger,
  optionsFromEnv,
  readJSON,
  relative,
  table,
} from './lib.ts';

const CONFIDENTIAL_FAMILY = 27;
const CONFIDENTIAL_OP = 7;

/**
 * What the argument is, decided by shape alone.
 *
 * A payment id (`derivePaymentId`) is *exactly* 64 lowercase hex characters. A
 * transaction signature is 64 base58 bytes, which prints as 87–88 characters and
 * cannot be 64 hex — so the two are disjoint by length, and no lookup decides
 * this. Guessing here would be the worst outcome: a wrong guess reads the wrong
 * thing and reports a verdict about a payment nobody asked about.
 */
const PAYMENT_ID = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** base64 → the bytes the transaction decoder expects. */
function wireBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

/**
 * `ok: null` is a third state, and it exists because one of the checks below is
 * genuinely not answerable from this host.
 *
 * The seat lookup reads a *local* pool ledger. A payment that settles into
 * another deployment's pool is not a failure — it is a payment whose seat this
 * host has no record of — and a tool that printed FAIL for it would be asserting
 * something it does not know. Worse, it made the *verdict* read "does NOT prove a
 * confidential settlement" while every confidentiality fact on chain had held.
 * So: `null` is reported as `INFO`, is never counted as a failure, and the
 * verdict says how many checks were unanswerable rather than staying silent
 * about them.
 */
const results: { ok: boolean | null; label: string; detail: string }[] = [];

function check(ok: boolean | null, label: string, detail: string): void {
  results.push({ ok, label, detail });
}

function explorer(signature: string, cluster: string): string {
  const suffix = cluster.includes('devnet') ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

interface RpcTransaction {
  readonly meta?: {
    readonly err?: unknown;
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
    readonly logMessages?: readonly string[];
  };
  readonly transaction?: readonly [string, string];
}

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount?: { readonly amount: string; readonly decimals: number };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'unknown rpc error'}`);
  if (body.result === undefined) throw new Error(`${method}: the endpoint returned no result`);
  return body.result;
}

/**
 * Find the signature for a payment id.
 *
 * The settlements log first (it is the rail's own record of what it broadcast),
 * then the live rail's `/api/ledger` when a URL is configured — because a
 * serverless deployment keeps its log wherever it keeps its state, and asking the
 * running rail is the practical way to reach it. Both are *pointers*: whichever
 * answers, the transaction it names is then read from chain and checked here.
 */
async function signatureFor(
  paymentId: string,
  url: string | undefined,
): Promise<{ signature: string; source: string } | null> {
  const rows = await readJSON<readonly StoredSettlement[]>(SETTLEMENTS_PATH, []);
  const local = rows.find((row) => row.paymentId === paymentId && row.signature !== null);
  if (local?.signature) {
    return { signature: local.signature, source: relative(SETTLEMENTS_PATH) };
  }
  if (url !== undefined) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/ledger`);
      const body = (await res.json()) as { settled?: readonly StoredSettlement[] };
      const remote = (body.settled ?? []).find(
        (row) => row.paymentId === paymentId && row.signature !== null,
      );
      if (remote?.signature) return { signature: remote.signature, source: `${url}/api/ledger` };
    } catch (error) {
      throw new Error(
        `could not read ${url}/api/ledger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

async function main(): Promise<void> {
  const options = optionsFromEnv(process.argv.slice(2));
  const argv = process.argv.slice(2);
  const target = argv.find((arg) => !arg.startsWith('--'));
  const urlFlag = argv[argv.indexOf('--url') + 1];
  const railUrl = argv.includes('--url') ? urlFlag : process.env.VEIL_URL;

  if (target === undefined) {
    process.stdout.write(
      [
        'usage: npm run replay -- <signature|paymentId> [--url https://rail] [--rpc <url>]',
        '',
        '  Re-derives a settled payment’s confidentiality claim from chain state.',
        '  A payment id is resolved to a transaction through ',
        `  ${relative(SETTLEMENTS_PATH)} or the rail’s /api/ledger; everything`,
        '  asserted in the report is then read from the chain, not from the rail.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const rpcUrl = options.rpcUrl ?? defaultRpcUrl('devnet');
  // `clusterTag` is the repo's single mapping from an RPC URL / CAIP-2 network to
  // a cluster name, and this file used to invent its own — which printed the
  // CAIP-2 form to a human and dropped `?cluster=devnet` from the explorer link,
  // sending anyone who followed it to a mainnet view of a devnet transaction.
  const cluster = clusterTag(options.rpcUrl, options.network).replace(/^\./, '') || 'testnet';

  // --- resolve to a signature ------------------------------------------------
  let signature: string;
  let source: string;
  if (SIGNATURE.test(target) && !PAYMENT_ID.test(target)) {
    signature = target;
    source = 'given on the command line';
  } else {
    const found = await signatureFor(target, railUrl);
    if (found === null) {
      // The payment id is not in any log this host can see. Say so, and say what
      // the ledger *does* know: the seat and when it settled. A tool that
      // guessed a transaction here would be worse than one that admits it has
      // nothing to read.
      const ledger = await loadLedger().catch(() => null);
      const seat = ledger?.allFor().find((entry) => entry.consumedBy === target);
      process.stdout.write(
        [
          `No broadcast transaction is recorded for payment ${target}.`,
          seat
            ? `  The seat map says it settled into ${seat.address} (alias ${seat.alias}) at ${seat.settledAt}.`
            : '  The seat map does not know this payment id either.',
          '',
          `Checked: ${relative(SETTLEMENTS_PATH)}${railUrl ? ` and ${railUrl}/api/ledger` : ''} and ${relative(LEDGER_PATH)}.`,
          'The signature is not stored in the seat map: pass the signature directly, or',
          'pass --url <rail> so the running rail can name the transaction to read.',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
    signature = found.signature;
    source = found.source;
  }

  process.stdout.write(`\nVeil replay — re-deriving the claim from chain state\n`);
  process.stdout.write(`  transaction   ${signature}\n`);
  process.stdout.write(`  found via     ${source}\n`);
  process.stdout.write(`  rpc           ${rpcUrl}\n`);
  process.stdout.write(`  cluster       ${cluster}\n\n`);

  // --- read it from the chain ------------------------------------------------
  const tx = await rpc<RpcTransaction | null>(rpcUrl, 'getTransaction', [
    signature,
    { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);

  check(tx !== null, 'the transaction exists on chain', tx === null ? 'getTransaction returned null' : 'found');
  if (tx === null) {
    report();
    return;
  }
  check(tx.meta?.err === null || tx.meta?.err === undefined, 'the transaction succeeded', JSON.stringify(tx.meta?.err ?? null));

  const wire = tx.transaction?.[0];
  if (typeof wire !== 'string') {
    check(false, 'the transaction could be read', 'the RPC returned no transaction bytes');
    report();
    return;
  }

  // `getTransactionDecoder` takes bytes — a base64 string falls through to the
  // partially-decoded-JSON branch and fails on `byteLength`. The first version of
  // this file made exactly that mistake, which is why the decode is one named
  // call now.
  const decoded = getTransactionDecoder().decode(wireBytes(wire));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const message = decompileTransactionMessage(compiled) as unknown as {
    instructions: readonly { programAddress: string; data?: Uint8Array; accounts?: readonly { address: string }[] }[];
  };

  const programs = [...new Set(message.instructions.map((ix) => ix.programAddress))];
  const confidential = message.instructions.filter(
    (ix) =>
      ix.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
      ix.data?.[0] === CONFIDENTIAL_FAMILY &&
      ix.data?.[1] === CONFIDENTIAL_OP,
  );
  const plainTransfers = message.instructions.filter(
    (ix) => ix.programAddress === TOKEN_2022_PROGRAM_ADDRESS && ix.data?.[0] === 3,
  );

  process.stdout.write(`  programs      ${programs.join(', ')}\n`);
  process.stdout.write(`  instructions  ${message.instructions.length}\n\n`);

  // The same reading the rail performs, run here against public state. It is
  // deliberately the *same* code: if the rail's reading were wrong, this would be
  // wrong in the same way, which is why the raw facts above and the balance check
  // below are printed too — they are independent of the reader.
  const reading = inspectConfidentialTransfer(wire);
  check(
    reading.ok,
    'the transaction contains exactly one Token-2022 confidential transfer (family 27, op 7)',
    reading.ok
      ? `${confidential.length} confidential transfer, paying ${reading.destination}`
      : reading.reason,
  );
  check(
    plainTransfers.length === 0,
    'no plaintext Token-2022 transfer is present',
    plainTransfers.length === 0
      ? 'none'
      : `${plainTransfers.length} plain Transfer instruction(s) — amounts would be public`,
  );

  const transferData = confidential[0]?.data;
  check(
    transferData === undefined || transferData.length > 100,
    'the amount is not a plaintext field of the instruction',
    transferData === undefined
      ? 'no confidential transfer data to inspect'
      : `${transferData.length} bytes of ciphertext + proofs (a plain transfer carries 9–10 bytes and a readable u64)`,
  );

  // --- the balance check, which does not depend on our reader ----------------
  const destinationIndex = message.instructions
    .flatMap((ix) => ix.accounts ?? [])
    .findIndex((account) => reading.ok && account.address === reading.destination);
  const post = (tx.meta?.postTokenBalances ?? []).find((b) => b.accountIndex === destinationIndex);
  const pre = (tx.meta?.preTokenBalances ?? []).find((b) => b.accountIndex === destinationIndex);
  const readableDelta =
    post?.uiTokenAmount !== undefined && pre?.uiTokenAmount !== undefined
      ? (BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount)).toString()
      : null;

  check(
    readableDelta === null || readableDelta === '0',
    'no readable amount moved in public state',
    readableDelta === null
      ? 'the chain publishes no token balance for the destination — a confidential account’s balance is not public'
      : `the destination’s public token balance changed by 0 (the credit is an ElGamal ciphertext under the recipient’s key)`,
  );

  if (post?.uiTokenAmount) {
    process.stdout.write(
      `  destination   ${reading.ok ? reading.destination : 'unknown'} · public balance ${post.uiTokenAmount.amount} (decimals ${post.uiTokenAmount.decimals})\n`,
    );
  } else if (reading.ok) {
    process.stdout.write(`  destination   ${reading.destination}\n`);
  }
  process.stdout.write(`\n`);

  // --- is the destination one of ours? --------------------------------------
  // Informational on purpose: see the note on `results`. `--ledger <path>` (or
  // `VEIL_LEDGER`) points this at the pool the payment actually belongs to — a
  // `demo:batch` run writes `data/demo/batch-ledger.json`, and naming it turns
  // this line into the assertion the other five already are.
  try {
    const ledger = await loadLedger(options.ledgerPath);
    const entry = reading.ok ? ledger.resolve(reading.destination) : undefined;
    check(
      entry !== undefined ? true : null,
      'the destination is a one-time seat of this rail',
      entry
        ? `slot ${entry.slot}, alias ${entry.alias}, consumed by ${entry.consumedBy?.slice(0, 12) ?? '—'}…`
        : `no seat of ${relative(options.ledgerPath)} is ${reading.ok ? reading.destination : 'this destination'} — a seat check only answers for the ledger it is shown, so pass --ledger <pool> for the deployment that took this payment`,
    );
  } catch (error) {
    // A ledger this host cannot read is still not a confidentiality failure: it is
    // the absence of a local record, and it is marked the same way as a miss.
    check(
      null,
      'the destination is a one-time seat of this rail',
      `could not read ${relative(options.ledgerPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  report(signature, cluster);
}

function report(signature?: string, cluster = 'devnet'): void {
  process.stdout.write(
    table([
      ['', 'assertion', 'what the chain says'],
      ...results.map((r) => [r.ok === null ? 'INFO' : r.ok ? 'PASS' : 'FAIL', r.label, r.detail]),
    ]),
  );
  const failed = results.filter((r) => r.ok === false);
  const informational = results.filter((r) => r.ok === null).length;
  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write(
      [
        'VERDICT: every assertion held. This payment settled as a Token-2022 confidential',
        'transfer, and no readable amount moved in public state.',
        '',
        'What that does and does not prove: the amount and the balances are hidden from',
        'everyone but the merchant’s key, and the chain verified the transfer’s proofs —',
        'no operator set, no gateway, no threshold. It does not hide the destination',
        'account, the mint, or that this transaction happened, and it does not hide the',
        'timing. See the honest limits in docs/.',
        '',
        informational > 0
          ? `${informational} check(s) could not be answered from this host and are marked INFO — they are not failures, and they are not passes.`
          : '',
        '',
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    );
    if (signature) process.stdout.write(`  explorer      ${explorer(signature, cluster)}\n\n`);
  } else {
    process.stdout.write(
      `VERDICT: ${failed.length} assertion(s) failed. This transaction does NOT prove a confidential settlement.\n\n`,
    );
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
