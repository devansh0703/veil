/**
 * Run the Veil x402 server.
 *
 *   node scripts/serve.ts                       # serves the persisted pool
 *   node scripts/serve.ts --port 4021
 *   node scripts/serve.ts --local-settlement=true   # demo mode, chain-free
 *   VEIL_RPC_URL=https://api.devnet.solana.com node scripts/serve.ts
 *
 * The server refuses to pretend. If the pool has no armed accounts it still
 * starts, but every paid resource answers with VEIL-CONF-005 rather than
 * reusing an address — an empty pool is a configuration state, not an excuse to
 * weaken the privacy guarantee.
 */

import { createServer } from 'node:http';

import {
  createFacilitator,
  createVeilHandler,
  loadLedgerFor,
} from '../packages/server/src/index.ts';
import { getFacilitatorApp } from './facilitator-app.ts';
import { HOSTED_LEDGER_KEY, HOSTED_SETTLEMENTS_KEY } from './hosted.ts';
import { redisLedgerStore } from './ledger-store.ts';
import {
  configFrom,
  feePayerCosignerFrom,
  optionsFromEnv,
  table,
} from './lib.ts';

const options = optionsFromEnv(process.argv.slice(2));
// Same store the hosted rail uses. Local it is usually unset (the real file is
// the ledger), but running against it here is how the durable path gets
// exercised before a deployment depends on it.
// The same per-cluster key the hosted rail uses, so a local run against the
// durable store lands in the same ledger the deployment reads rather than
// creating a second, private copy of the pool.
const ledgerStore =
  redisLedgerStore({
    key: HOSTED_LEDGER_KEY,
    settlementKey: HOSTED_SETTLEMENTS_KEY,
  }) ?? undefined;
const ledger = await loadLedgerFor({
  ledgerPath: options.ledgerPath,
  ...(ledgerStore ? { ledgerStore } : {}),
});
// The probe is answered from the pool ledger Veil itself wrote, which is why the
// reported privacySource is `pool-ledger` and never `chain`. Run the devnet
// setup script to have the mint verified from a real read instead.
// A payer signs only its own half of a payment; the fee payer's signature is
// added at settlement. Without this the RPC rejects every inline settlement as
// "did not pass signature verification".
const cosigner = await feePayerCosignerFrom(options);
const config = {
  ...configFrom(options, ledger, ledgerStore),
  ...(cosigner ? { feePayerCosigner: cosigner } : {}),
};

const facilitator = createFacilitator(config, ledger);
const veilHandler = createVeilHandler(config, facilitator);

/**
 * One origin, like the deployment.
 *
 * The hosted rail reaches the facilitator through Vercel rewrites, so
 * `/supported`, `/verify`, `/settle` and `/facilitator/*` all answer from the
 * same host the resources do. A local rail that served only the resources was
 * therefore *not* the same product: a client reads the fee payer from
 * `/supported`, and against a loopback rail it got a 404 and could not complete
 * a payment at all. Composition here keeps the two surfaces identical instead of
 * leaving the difference to be discovered at runtime.
 */
const facilitatorApp = await getFacilitatorApp(options);
function isFacilitatorRoute(path: string): boolean {
  return (
    path === '/supported' ||
    path === '/verify' ||
    path === '/settle' ||
    path === '/facilitator' ||
    path.startsWith('/facilitator/')
  );
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const handler = isFacilitatorRoute(path) ? facilitatorApp.handler : veilHandler;
  void handler(req, res);
});

const mode = options.rpcUrl
  ? 'rpc (real broadcasts)'
  : options.allowLocalSettlement
    ? 'local-ledger-only (settlements are records, not chain facts)'
    : 'unavailable (payments will be refused with settlement-failed)';

// VEIL_BIND=0.0.0.0 publishes the rail beyond loopback (hosted deployment);
// default stays loopback so a dev machine is never exposed accidentally.
const bind = process.env.VEIL_BIND ?? '127.0.0.1';

server.listen(options.port, bind, () => {
  const base = `http://127.0.0.1:${options.port}`;
  process.stdout.write(
    [
      '',
      'Veil — private payment rails for the agent economy',
      '',
      table([
        ['network', String(config.network)],
        ['mint', config.mint],
        ['decimals', String(config.decimals)],
        ['pool accounts', String(ledger.size)],
        ['armed', String(ledger.allFor().filter((e) => e.armed && !e.consumedBy).length)],
        ['ledger store', ledgerStore ? 'durable (upstash)' : 'local file'],
        ['settlement mode', mode],
        ['privacy gate', config.privacy ? 'enforcing' : 'refusing (no probe)'],
        ['preconditions from', String(config.privacySource)],
        ['spend cap', String(config.spendCap)],
      ]),
      '',
      'Endpoints',
      table([
        ['capabilities', `GET ${base}/.well-known/veil`],
        ['health', `GET ${base}/v1/health`],
        ['x402 supported', `GET ${base}/supported`],
        ['dashboard data', `GET ${base}/api/ledger`],
        ...config.resources.map((r) => [
          r.path,
          `GET ${base}${r.path}`,
        ]),
      ]),
      '',
      ledger.size === 0
        ? 'Pool is empty. Run `npm run setup:devnet` (needs a funded devnet payer),\n' +
          'or `npm run demo:local` to drive the full protocol without chain funds.'
        : '',
      config.privacySource !== 'chain'
        ? 'Note: the confidential preconditions are being answered from the pool ledger,\n' +
          'not from a read of devnet. The server reports that difference at\n' +
          `${base}/.well-known/veil rather than implying a check it did not make.`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n') + '\n',
  );
});
