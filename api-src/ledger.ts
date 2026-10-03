/**
 * Vercel function: `GET /api/ledger`, the dashboard's data feed.
 *
 * Mounted as a real function (not a rewrite) because /api/* is the platform's
 * function namespace: the destination path the handler sees is already
 * `/api/ledger`, which is exactly the route packages/server answers. The
 * heavy lifting lives in api/veil.ts.
 */

export { default } from './veil.ts';
