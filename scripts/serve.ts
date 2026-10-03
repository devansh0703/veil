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

import {
  createFacilitator,
  createVeilServer,
} from '../packages/server/src/index.ts';
import { loadLedger, configFrom, optionsFromEnv, table } from './lib.ts';

const options = optionsFromEnv(process.argv.slice(2));
const ledger = await loadLedger(options.ledgerPath);
// The probe is answered from the pool ledger Veil itself wrote, which is why the
// reported privacySource is `pool-ledger` and never `chain`. Run the devnet
// setup script to have the mint verified from a real read instead.
const config = configFrom(options, ledger);

const facilitator = createFacilitator(config, ledger);
const server = createVeilServer(config, facilitator);

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
