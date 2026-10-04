/**
 * The hosted rail's one piece of routing logic.
 *
 * Vercel delivers the *destination* path and carries the original in
 * `?route=`, so `rewriteRoute` restores it before the shared handler's
 * exact-match router runs. Restoring the path alone silently dropped every
 * other param — `?nonce=` is half a payment's identity, and losing it collapsed
 * every hosted payment from one payer onto one payment id. That is what these
 * tests pin.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewriteRoute } from './hosted.ts';

test('rewriteRoute: restores the path a rewrite carried in ?route=', () => {
  assert.equal(rewriteRoute('/api/veil?route=/v1/health'), '/v1/health');
});

test('rewriteRoute: keeps the caller\'s params, because a nonce is an identity', () => {
  assert.equal(
    rewriteRoute('/api/veil?route=/v1/oracle/tide&nonce=7'),
    '/v1/oracle/tide?nonce=7',
  );
});

test('rewriteRoute: the marker never leaks into the restored url', () => {
  const restored = rewriteRoute('/api/veil?route=/v1/oracle/tide&nonce=7');
  assert.ok(restored !== null);
  assert.equal(new URL(restored, 'http://localhost').searchParams.get('route'), null);
});

test('rewriteRoute: a param order that puts nonce first still survives', () => {
  assert.equal(
    rewriteRoute('/api/veil?nonce=abc&route=/v1/oracle/tide'),
    '/v1/oracle/tide?nonce=abc',
  );
});

test('rewriteRoute: appends with & when the route already carries a query', () => {
  assert.equal(
    rewriteRoute('/api/veil?route=/v1/oracle/tide?units=3&nonce=1'),
    '/v1/oracle/tide?units=3&nonce=1',
  );
});

test('rewriteRoute: no marker means no rewrite (the local server path)', () => {
  assert.equal(rewriteRoute('/v1/health'), null);
  assert.equal(rewriteRoute('/v1/oracle/tide?nonce=7'), null);
});

test('rewriteRoute: an empty or absent url cannot invent a route', () => {
  assert.equal(rewriteRoute(undefined), null);
  assert.equal(rewriteRoute('/api/veil?route='), null);
});

// ---------------------------------------------------------------------------
// Which cluster, and therefore which durable ledger
// ---------------------------------------------------------------------------

import { HOSTED_LEDGER_KEY, clusterTagForEnv } from './hosted.ts';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the configured network decides the cluster when no rpc names one', () => {
  withEnv({ VEIL_RPC_URL: undefined, VEIL_NETWORK: 'solana:devnet' }, () => {
    assert.equal(clusterTagForEnv(), '.devnet');
  });
  withEnv({ VEIL_RPC_URL: undefined, VEIL_NETWORK: 'solana:testnet' }, () => {
    assert.equal(clusterTagForEnv(), '');
  });
});

test('an rpc url overrides the network flag, because it is the cluster you are really on', () => {
  withEnv(
    { VEIL_RPC_URL: 'https://api.devnet.solana.com', VEIL_NETWORK: 'solana:testnet' },
    () => {
      assert.equal(clusterTagForEnv(), '.devnet');
    },
  );
});

test('the durable ledger key is versioned and per cluster', () => {
  // One Upstash database serves both deployments; two pools under one key would
  // collide on `alias#slot` and the devnet rail would overwrite testnet seats.
  assert.match(HOSTED_LEDGER_KEY, /^veil:pool-ledger:v\d+(\.[a-z]+)?$/);
});
