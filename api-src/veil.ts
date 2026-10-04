/**
 * Vercel function: the Veil merchant server (the 402 half), hosted.
 *
 * Same code path as `npm run serve` — `createVeilHandler` from
 * packages/server — including the privacy refusal codes and the ledger flush
 * after settlement (against the durable store when it is configured, else the
 * per-instance /tmp copy; see scripts/hosted.ts).
 *
 * Routing comes from vercel.json rewrites:
 *   /v1/*       → /api/veil?route=/v1/*   (paid resources + health)
 *   /api/ledger → api/ledger.ts           (direct mount, path already correct)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createFacilitator,
  createVeilHandler,
  loadLedgerFor,
} from '../packages/server/src/index.ts';
import {
  configFrom,
  feePayerCosignerFrom,
  optionsFromEnv,
} from '../scripts/lib.ts';
import {
  HOSTED_LEDGER_KEY,
  HOSTED_SETTLEMENTS_KEY,
  rewriteRoute,
  seedHostedLedger,
} from '../scripts/hosted.ts';
import { redisLedgerStore } from '../scripts/ledger-store.ts';

type VeilHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

let cached: Promise<VeilHandler> | null = null;

async function build(): Promise<VeilHandler> {
  // Writable ledger copy first: optionsFromEnv must see VEIL_LEDGER before it
  // snapshots the config, or settlements would flush to a read-only path.
  process.env.VEIL_LEDGER = await seedHostedLedger();
  const options = optionsFromEnv([]);
  // One durable ledger for every instance when the store is configured, and the
  // seeded copy when it is not. Returning null rather than throwing is the
  // point: a deployment without credentials keeps working exactly as before and
  // says so through /v1/health (`ledger: local-file`) rather than degrading
  // silently.
  // Keyed per cluster: the two deployments share one Upstash database, and two
  // pools under one key would collide on `alias#slot`.
  const ledgerStore =
    redisLedgerStore({
      key: HOSTED_LEDGER_KEY,
      settlementKey: HOSTED_SETTLEMENTS_KEY,
    }) ?? undefined;
  const ledger = await loadLedgerFor({
    ledgerPath: options.ledgerPath,
    ...(ledgerStore ? { ledgerStore } : {}),
  });
  // The payer signs only its own half of the payment; the fee payer's signature
  // is added here, at settlement. Without it the broadcast is rejected as
  // "did not pass signature verification". The key is VEIL_PAYER_SECRET — the
  // same one the hosted facilitator signs with.
  const cosigner = await feePayerCosignerFrom(options);
  const config = {
    ...configFrom(options, ledger, ledgerStore),
    ...(cosigner ? { feePayerCosigner: cosigner } : {}),
  };
  const facilitator = createFacilitator(config, ledger);
  return createVeilHandler(config, facilitator);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const veil = await (cached ??= build());
  const route = rewriteRoute(req.url);
  if (route !== null) req.url = route;
  await veil(req, res);
}
