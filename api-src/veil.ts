/**
 * Vercel function: the Veil merchant server (the 402 half), hosted.
 *
 * Same code path as `npm run serve` — `createVeilHandler` from
 * packages/server — including the privacy refusal codes and the ledger flush
 * after settlement (against the writable /tmp copy; see scripts/hosted.ts).
 *
 * Routing comes from vercel.json rewrites:
 *   /v1/*       → /api/veil?route=/v1/*   (paid resources + health)
 *   /api/ledger → api/ledger.ts           (direct mount, path already correct)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createFacilitator,
  createVeilHandler,
} from '../packages/server/src/index.ts';
import { configFrom, loadLedger, optionsFromEnv } from '../scripts/lib.ts';
import { rewriteRoute, seedHostedLedger } from '../scripts/hosted.ts';

type VeilHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

let cached: Promise<VeilHandler> | null = null;

async function build(): Promise<VeilHandler> {
  // Writable ledger copy first: optionsFromEnv must see VEIL_LEDGER before it
  // snapshots the config, or settlements would flush to a read-only path.
  process.env.VEIL_LEDGER = await seedHostedLedger();
  const options = optionsFromEnv([]);
  const ledger = await loadLedger(options.ledgerPath);
  const config = configFrom(options, ledger);
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
