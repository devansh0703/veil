/**
 * One honest look at the current state of this build.
 *
 *   npm run status
 *
 * Prints what exists, what ran, and — the part that matters — what did not run.
 * It reads only files inside the project; with `--chain` it also reads devnet,
 * which is the only thing here that leaves the machine.
 */

import { stat } from 'node:fs/promises';

import { PoolLedger } from '../packages/derive/src/index.ts';
import { readChainFacts, summarizeRead } from '../packages/onchain/src/chain.ts';
import { PLACEHOLDER_MINT, isValidAddress } from '../packages/x402-core/src/index.ts';
import {
  DATA_DIR,
  DEMO_LEDGER_PATH,
  DEMO_RUN_PATH,
  FIXTURES_DIR,
  MINT_PATH,
  optionsFromEnv,
  PROJECT_ROOT,
  readJSON,
  relative,
  table,
} from './lib.ts';

const argv = process.argv.slice(2);
const WITH_CHAIN = argv.includes('--chain');
const options = optionsFromEnv(argv);
const rpcUrl = process.env.VEIL_RPC_URL ?? 'https://api.devnet.solana.com';

interface RunRecord {
  mode: string;
  chain: string;
  producedAt: string;
  privacyGate: { mode: string; preconditions: string; source: string };
  totals: Record<string, number | string>;
  scenarios: { name: string; outcome: string; pass: boolean }[];
}

const run = await readJSON<RunRecord | null>(DEMO_RUN_PATH, null);
const demoLedger = await readJSON<unknown[] | null>(DEMO_LEDGER_PATH, null);
const serveLedger = await readJSON<unknown[] | null>(options.ledgerPath, null);
const fixtures = await readJSON<{ capturedAt?: string } | null>(`${FIXTURES_DIR}/responses.json`, null);
const mintRecord = await readJSON<{ mint?: string; configured?: boolean } | null>(MINT_PATH, null);

const lines: string[] = ['', 'Veil — status', ''];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

if (!run) {
  lines.push(
    'Protocol run: none yet.',
    '',
    '  npm run demo        # runs the protocol, then renders the pages from it',
    '',
  );
} else {
  const passed = run.scenarios.filter((s) => s.pass).length;
  lines.push(
    'Protocol run',
    table([
      ['recorded', run.producedAt],
      ['settlement mode', run.mode],
      ['chain', run.chain === 'not-executed' ? 'not executed — nothing was broadcast' : run.chain],
      ['privacy gate', `${run.privacyGate.mode} · preconditions ${run.privacyGate.preconditions}`],
      ['scenarios', `${passed}/${run.scenarios.length} passed`],
      [`settled`, `${run.totals.settledCount} payments · ${run.totals.settledFormatted}`],
      ['in flight', String(run.totals.inFlightCount)],
      ['refused', String(run.totals.refusedCount)],
    ]),
    '',
  );
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

function ledgerSummary(json: unknown[] | null, path: string): string[] {
  if (!json) return [`${relative(path)}: absent`, ''];
  try {
    const ledger = PoolLedger.fromJSON(json);
    ledger.assertInvariants();
    const byAlias = new Map<string, { armed: number; consumed: number }>();
    for (const entry of ledger.allFor()) {
      const bucket = byAlias.get(entry.alias) ?? { armed: 0, consumed: 0 };
      if (entry.consumedBy) bucket.consumed += 1;
      else if (entry.armed) bucket.armed += 1;
      byAlias.set(entry.alias, bucket);
    }
    const rows = [...byAlias.entries()].map(([alias, b]) => [
      alias,
      String(b.armed),
      String(b.consumed),
    ]);
    return [
      `${relative(path)}: ${ledger.size} accounts, invariants hold`,
      table([['alias', 'free & armed', 'consumed'], ...rows]),
      '',
    ];
  } catch (error) {
    return [`${relative(path)}: FAILED invariants — ${(error as Error).message}`, ''];
  }
}

lines.push('Pools', ...ledgerSummary(demoLedger, DEMO_LEDGER_PATH), ...ledgerSummary(serveLedger, options.ledgerPath));

// ---------------------------------------------------------------------------
// Pages and fixtures
// ---------------------------------------------------------------------------

const pages = ['index', 'dashboard', 'limits', '402'];
const pageRows: string[][] = [];
for (const page of pages) {
  const path = `${PROJECT_ROOT}/web/${page}.html`;
  try {
    const info = await stat(path);
    pageRows.push([`web/${page}.html`, `${Math.round(info.size / 1024)} kB`]);
  } catch {
    pageRows.push([`web/${page}.html`, 'missing']);
  }
}

lines.push(
  'Surfaces',
  table([['page', 'size'], ...pageRows]),
  '',
  fixtures
    ? `Response fixtures: ${relative(`${FIXTURES_DIR}/responses.json`)} (captured ${fixtures.capturedAt ?? 'unknown'})`
    : 'Response fixtures: none — run `npm run pages` to capture them from a live server',
  '',
);

// ---------------------------------------------------------------------------
// Live runs, per cluster
// ---------------------------------------------------------------------------

{
  const rows: string[][] = [['cluster', 'live runs', 'most recent']];
  for (const [cluster, tag] of [
    ['testnet', ''],
    ['devnet', '.devnet'],
  ] as const) {
    const go = await readJSON<{ runs: { signature: string; at: string }[] } | null>(
      `${DATA_DIR}/go-live${tag}.json`,
      null,
    );
    const pay = await readJSON<{ runs: { signature: string; at: string }[] } | null>(
      `${DATA_DIR}/pay-live${tag}.json`,
      null,
    );
    const all = [...(go?.runs ?? []), ...(pay?.runs ?? [])].sort((a, b) =>
      b.at.localeCompare(a.at),
    );
    rows.push([
      cluster,
      String(all.length),
      all[0] ? `${all[0].signature.slice(0, 16)}… (${all[0].at.slice(0, 10)})` : 'none recorded',
    ]);
  }
  lines.push('Live runs (broadcast, decrypted locally)', table(rows), '');
}

// ---------------------------------------------------------------------------
// The honest part
// ---------------------------------------------------------------------------

lines.push(
  'What this build does not do',
  '',
  '  - The run above is local-ledger-only, so every figure on the pages is an',
  '    accounting record from a real run of the protocol code — not a chain tx.',
  '    The build itself does broadcast: go:live and pay:live have settled',
  '    confidential transfers on testnet and devnet (the table above), with the',
  '    three proofs generated locally on every run.',
  '  - Hosting exists, with a caveat. serve and the facilitator are deployed at',
  '    https://veil-devnet.vercel.app (free tier) and settle through the public',
  '    URL — but the hosted ledger is per-instance (/tmp, re-seeded on cold start)',
  '    and the public RPC still rate-limits bursts, so a busy rail needs a paid',
  '    endpoint and shared seat state.',
  '  - It does not create accounts it cannot finish. `npm run setup:devnet` shows',
  '    the plan and the real lamport cost, and only writes with --apply.',
  '',
);

// ---------------------------------------------------------------------------
// Optional: read devnet
// ---------------------------------------------------------------------------

if (WITH_CHAIN) {
  /**
   * The mint to read against.
   *
   * `optionsFromEnv` falls back to a placeholder, which is right for the offline
   * scripts and wrong here: this flag exists to read a chain, so a placeholder
   * sends it looking for an account that was never created and reports a healthy
   * deployment as unconfigured. When no mint is passed, the one this project
   * actually recorded is used.
   */
  const mint =
    options.mint !== PLACEHOLDER_MINT ? options.mint : (mintRecord?.mint ?? options.mint);
  if (!isValidAddress(mint)) {
    lines.push(`--chain skipped: ${mint} is not a valid address.`, '');
  } else {
    // The serve ledger is the one whose addresses were created on this RPC;
    // the demo ledger is a local fixture whose addresses exist nowhere. Reading
    // chain facts against demo addresses reports "0 armed" for a healthy pool.
    const ledgerJson = serveLedger ?? demoLedger ?? [];
    const addresses = (() => {
      try {
        return PoolLedger.fromJSON(ledgerJson).allFor().map((e) => e.address);
      } catch {
        return [];
      }
    })();
    lines.push(`Chain (${rpcUrl})`, '');
    try {
      const facts = await readChainFacts(rpcUrl, mint, addresses);
      const mintRead = summarizeRead(facts.mint);
      // "Can receive confidentially" is the conjunction, not one of the parts.
      // Carrying the extension is necessary but not sufficient: the mint does not
      // auto-approve, so an unapproved account carrying the extension and
      // accepting confidential credits still cannot receive anything. Counting
      // the extension alone would report unusable accounts as ready, which is the
      // single claim this project must not get wrong.
      const extended = facts.accounts.filter((a) => a.hasConfidentialExtension);
      const receiving = extended.filter((a) => a.approved && a.allowConfidentialCredits);
      const blocked: string[] = [];
      if (extended.length > 0 && receiving.length < extended.length) {
        blocked.push(
          `${extended.length - receiving.length} of ${extended.length} carry the extension but ` +
            'are not approved by the mint authority, so they cannot receive yet',
        );
      }
      lines.push(
        table([
          ['mint', mintRead.address],
          ['mint source', options.mint !== PLACEHOLDER_MINT ? 'passed in' : 'recorded'],
          ['exists on chain', String(mintRead.exists)],
          ['confidential extension', mintRead.confidential],
          ['accounts read', String(facts.accounts.length)],
          ['carry the extension', String(extended.length)],
          ['approved by the mint authority', String(extended.filter((a) => a.approved).length)],
          ['can receive confidentially', String(receiving.length)],
          ['read at', facts.readAt],
        ]),
        '',
        ...blocked.map((note) => `${note}`),
        ...(blocked.length > 0 ? [''] : []),
        facts.mint.hasConfidentialExtension && receiving.length > 0
          ? 'A server may report privacySource: chain against these facts.'
          : 'A server must refuse (VEIL-CONF-001/002/003) against these facts.',
        '',
      );
    } catch (error) {
      lines.push(`Chain read failed: ${(error as Error).message}`, '');
    }
  }
} else {
  lines.push('Add --chain to read the RPC and check the preconditions for real.', '');
}

if (mintRecord) {
  lines.push(
    'Recorded mint',
    table([
      ['mint', String(mintRecord.mint)],
      ['configured', String(mintRecord.configured)],
    ]),
    '',
  );
}

process.stdout.write(`${lines.join('\n')}\n`);
