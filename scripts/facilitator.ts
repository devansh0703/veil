/**
 * Run the Veil facilitator as an x402 facilitator.
 *
 *   npm run facilitator
 *   npm run facilitator -- --port 4022 --rpc https://api.testnet.solana.com
 *
 * All of the facilitator's behaviour lives in `scripts/facilitator-app.ts` so
 * the hosted deployment (Vercel `api/facilitator.ts`) runs the identical
 * handler. This file is only the local lifecycle around it: parse flags, build
 * the app, listen, print the banner, exit cleanly on signal.
 *
 * The fee key comes from `.keys/payer.json` locally, or from the
 * `VEIL_PAYER_SECRET` environment variable when hosted (see facilitator-app.ts).
 */

import { createServer } from 'node:http';

import { VEIL_SCHEME } from '../packages/x402-core/src/index.ts';
import { optionsFromEnv, table } from './lib.ts';
import { getFacilitatorApp } from './facilitator-app.ts';

const options = optionsFromEnv(process.argv.slice(2));
const port = Number(process.env.VEIL_FACILITATOR_PORT ?? options.port + 1);

const app = await getFacilitatorApp(options).catch((error: unknown) => {
  process.stdout.write(`${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});

const server = createServer((req, res) => {
  void app.handler(req, res);
});

// VEIL_BIND=0.0.0.0 publishes the facilitator beyond loopback (hosted rail);
// the default stays loopback so a dev machine never exposes its fee key.
const bind = process.env.VEIL_BIND ?? '127.0.0.1';

server.listen(port, bind, () => {
  process.stdout.write(
    [
      table([
        ['facilitator', `http://${bind}:${port}`],
        ['scheme', VEIL_SCHEME],
        ['network', app.network],
        ['fee payer', app.feePayerAddress],
        ['pool accounts', String(app.poolAccounts)],
        ['kinds', app.kinds.join(', ')],
        ['simulate', String(process.env.VEIL_SKIP_SIMULATE !== 'true')],
      ]),
      '',
      'POST /verify and POST /settle take x402 VerifyRequest / SettleRequest bodies.',
      `Waiting for a payer on http://${bind}:${port} …`,
    ].join('\n') + '\n',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
