/**
 * The cluster-aware ledger default.
 *
 * `data/pool-ledger.json` is not tied to a cluster, so pairing it with a
 * different cluster's RPC reports another cluster's seats as if they were this
 * one's: `status --chain` on devnet read the 24 testnet accounts, found 0 able to
 * receive confidentially, and told the operator a server must refuse — while
 * devnet's own pool was 3/3 healthy in `data/pool-ledger.devnet.json`.
 *
 * An explicit choice (flag or env) must always win, because the hosted rail pins
 * its ledger through `VEIL_LEDGER` and must not be re-pointed by this default.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basename } from 'node:path';

import { DEVNET } from '../packages/x402-core/src/index.ts';
import { LEDGER_PATH, optionsFromEnv } from './lib.ts';

/** Endpoints, not CAIP-2 ids: the rpc flag takes a URL. */
const DEVNET_RPC = 'https://api.devnet.solana.com';
const TESTNET_RPC = 'https://api.testnet.solana.com';

/** Run with a clean slate so ambient VEIL_* vars cannot decide the outcome. */
function withoutEnv<T>(vars: string[], run: () => T): T {
  const saved = vars.map((name) => [name, process.env[name]] as const);
  for (const name of vars) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const ENV_VARS = ['VEIL_LEDGER', 'VEIL_NETWORK', 'VEIL_RPC_URL'];

test('the devnet ledger is the default on devnet, not the shared file', () => {
  withoutEnv(ENV_VARS, () => {
    const options = optionsFromEnv(['--network', DEVNET]);
    assert.equal(
      basename(options.ledgerPath),
      'pool-ledger.devnet.json',
      'devnet must read devnet seats, or status reports a healthy pool as dead',
    );
  });
});

test('a cluster with no suffixed ledger falls back to the shared file', () => {
  withoutEnv(ENV_VARS, () => {
    const options = optionsFromEnv(['--network', 'testnet', '--rpc', TESTNET_RPC]);
    assert.equal(
      options.ledgerPath,
      LEDGER_PATH,
      'testnet keeps the untagged filename, so its live record is unchanged',
    );
  });
});

test('an explicit --ledger beats the cluster default', () => {
  withoutEnv(ENV_VARS, () => {
    const options = optionsFromEnv([
      '--network',
      DEVNET,
      '--rpc',
      DEVNET_RPC,
      '--ledger',
      'data/custom.json',
    ]);
    assert.equal(options.ledgerPath, 'data/custom.json');
  });
});

test('VEIL_LEDGER beats the cluster default, which is how the hosted rail pins its file', () => {
  withoutEnv(ENV_VARS, () => {
    process.env.VEIL_LEDGER = '/tmp/pinned.json';
    try {
      assert.equal(optionsFromEnv(['--network', DEVNET]).ledgerPath, '/tmp/pinned.json');
    } finally {
      delete process.env.VEIL_LEDGER;
    }
  });
});

test('the rpc url decides the cluster when the network flag is absent', () => {
  withoutEnv(ENV_VARS, () => {
    process.env.VEIL_RPC_URL = DEVNET_RPC;
    try {
      assert.equal(
        basename(optionsFromEnv([]).ledgerPath),
        'pool-ledger.devnet.json',
      );
    } finally {
      delete process.env.VEIL_RPC_URL;
    }
  });
});

// ---------------------------------------------------------------------------
// RPC provider selection
// ---------------------------------------------------------------------------

import { HELIUS_DEVNET_RPC_HOST, SOLAMI_RPC_HOST, heliusRpcUrl, solamiRpcUrl } from './lib.ts';

test('Solami is offered for mainnet and only mainnet', () => {
  // Solami's Solana route is mainnet-beta only — the cluster segment takes
  // `solana` and nothing else, and query params do not change it. Pointing a
  // devnet rail at it would silently read the wrong chain's state, so the
  // helper must refuse rather than guess.
  const mainnet = solamiRpcUrl('solana:mainnet', 'k');
  assert.ok(mainnet, 'mainnet is the one cluster Solami can serve');
  assert.equal(mainnet.startsWith(SOLAMI_RPC_HOST), true);
  assert.equal(solamiRpcUrl('solana:devnet', 'k'), undefined);
  assert.equal(solamiRpcUrl('solana:testnet', 'k'), undefined);
});

test('no key means no Solami endpoint, so a deployment without one is unchanged', () => {
  assert.equal(solamiRpcUrl('solana:mainnet', undefined), undefined);
});

test('the key is carried on the query string where Solami reads it', () => {
  assert.equal(
    solamiRpcUrl('solana:mainnet', 'sk_test key'),
    `${SOLAMI_RPC_HOST}/solana?api-key=sk_test%20key`,
  );
});

test('Helius serves devnet and mainnet, never a testnet it does not run', () => {
  // `testnet.helius-rpc.com` does not resolve and the provider documents two
  // clusters. Returning that URL anyway would fail at the first RPC call of a
  // testnet run — so the helper refuses, and testnet keeps its own endpoint.
  const devnet = heliusRpcUrl('solana:devnet', 'k');
  assert.ok(devnet, 'devnet is the cluster this project runs on');
  assert.equal(devnet.startsWith(HELIUS_DEVNET_RPC_HOST), true);
  assert.notEqual(heliusRpcUrl('solana:mainnet', 'k'), undefined);
  assert.equal(heliusRpcUrl('solana:testnet', 'k'), undefined);
  assert.equal(heliusRpcUrl('not-a-network', 'k'), undefined);
});

test('no key means no Helius endpoint, so a deployment without one is unchanged', () => {
  assert.equal(heliusRpcUrl('solana:devnet', undefined), undefined);
});

test('the Helius key is carried on the query string where Helius reads it', () => {
  assert.equal(
    heliusRpcUrl('solana:devnet', 'hk test'),
    `${HELIUS_DEVNET_RPC_HOST}/?api-key=hk%20test`,
  );
});
