/**
 * Vercel function: the Veil x402 facilitator, hosted.
 *
 * Invokes the identical handler `npm run facilitator` runs locally
 * (`scripts/facilitator-app.ts`) — same verification, same fee signing, same
 * broadcast. Routing comes from vercel.json rewrites:
 *
 *   /verify       → /api/facilitator?route=/verify
 *   /settle       → /api/facilitator?route=/settle
 *   /supported    → /api/facilitator?route=/supported
 *   /facilitator/*→ /api/facilitator?route=/facilitator/*
 *
 * The fee key arrives via `VEIL_PAYER_SECRET` (encrypted project env); the
 * bundled `.keys/` directory is excluded from the deployment by .vercelignore.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { getFacilitatorApp } from '../scripts/facilitator-app.ts';
import { optionsFromEnv } from '../scripts/lib.ts';
import { rewriteRoute, seedHostedLedger } from '../scripts/hosted.ts';

let ready: Promise<void> | null = null;

async function ensureReady(): Promise<void> {
  ready ??= (async () => {
    // Point the facilitator at the writable copy (it only ever reads, but the
    // seeded path is the one guaranteed to exist inside the bundle runtime).
    process.env.VEIL_LEDGER = await seedHostedLedger();
  })();
  return ready;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await ensureReady();
    const route = rewriteRoute(req.url);
    if (route !== null) req.url = route;
    const app = await getFacilitatorApp(optionsFromEnv([]));
    await app.handler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ error: 'facilitator-unavailable', detail }, null, 2));
    }
  }
}
