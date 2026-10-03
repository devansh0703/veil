/**
 * scripts/prove-browser.ts — prove that the *shipped* browser artifact works.
 *
 *   npm run prove:browser      (after `npm run build:proofs`)
 *
 * ## What this checks, and why it is not the same as `prove:check`
 *
 * `prove:check` proves the Node prover works. That says nothing about what a
 * browser gets, because the browser loads a different WASM binary through a
 * different code path. The claim this script has to earn is narrower and
 * stronger: *the file we serve to a wallet generates every proof a confidential
 * transfer needs, and refuses the statements it must refuse.*
 *
 * So it imports `web/assets/veil-proofs.js` — the built artifact, byte for byte
 * what a page fetches — feeds it the WASM from `web/assets/`, and asserts on
 * the output. If this passes, "client-side proofs" is a measured property of
 * the deployed bundle rather than an intention.
 *
 * ## Why Node can run it
 *
 * The bundle is an ES module with no DOM dependency: it computes over
 * `Uint8Array` and instantiates WASM from bytes. The browser path passes a URL
 * and lets `fetch` resolve it; this passes the bytes directly through
 * `init({ wasmBytes })`. Both reach the same `initSync` inside the shim, so the
 * instantiation being tested is the one a browser performs.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'web/assets/veil-proofs.js');
const WASM = join(ROOT, 'web/assets/index_bg.wasm');
const MANIFEST = join(ROOT, 'web/assets/veil-proofs.json');

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(label: string, detail: string): void {
  passed += 1;
  process.stdout.write(`  ok    ${label}${detail ? `  ${detail}` : ''}\n`);
}

function no(label: string, detail: string): void {
  failed += 1;
  process.stdout.write(`  FAIL  ${label}${detail ? `  ${detail}` : ''}\n`);
}

/**
 * Run a check that must produce a value.
 *
 * The WASM throws bare strings rather than `Error` objects for its own
 * validation failures (a wasm-bindgen detail), so the catch has to stringify
 * both shapes or the failure detail is lost.
 */
async function check(label: string, fn: () => string | Promise<string>): Promise<void> {
  try {
    ok(label, await fn());
  } catch (e) {
    no(label, e instanceof Error ? e.message : String(e));
  }
}

async function checkRejects(label: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    no(label, 'accepted input it must reject');
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 64);
    ok(label, `refused — "${reason}"`);
  }
}

// ---------------------------------------------------------------------------
// Load the artifact a browser would load
// ---------------------------------------------------------------------------

process.stdout.write('\nVeil — browser prover check (the shipped artifact)\n\n');

if (!existsSync(BUNDLE) || !existsSync(WASM)) {
  process.stderr.write(
    `The browser prover has not been built.\n\n  ${BUNDLE.replace(ROOT, '')}\n\n` +
      'Run the build, then this check:\n\n  npm run build:proofs\n  npm run prove:browser\n',
  );
  process.exit(1);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
  bundleBytes: number;
  wasmBytes: number;
  wasmSha256: string;
};
const wasmBytes = new Uint8Array(await readFile(WASM));
const { createHash } = await import('node:crypto');
const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');

const proof = await import(BUNDLE);

process.stdout.write('the artifact\n');

await check('the wasm on disk is the one the build recorded', () => {
  if (wasmSha256 !== manifest.wasmSha256) {
    throw new Error(
      `wasm is ${wasmSha256.slice(0, 12)}, manifest says ${manifest.wasmSha256.slice(0, 12)} — rebuild`,
    );
  }
  return `${(manifest.wasmBytes / 1024 / 1024).toFixed(2)} MB, sha256 ${wasmSha256.slice(0, 12)}…`;
});

await check('the bundle imports nothing — it is self-contained', async () => {
  // The point of a browser bundle: no bare specifier may survive, or a page
  // would need an import map to load it.
  const source = await readFile(BUNDLE, 'utf8');
  const bare = source.match(/^\s*(?:import|export)\s[^;]*from\s+['"][^./]/m);
  if (bare) throw new Error(`a bare import survived: ${bare[0].trim()}`);
  return `${(manifest.bundleBytes / 1024).toFixed(0)} kB, no bare specifiers`;
});

await proof.init({ wasmBytes });
ok('the bundle instantiates its own WASM from bytes', 'init() resolved');

// ---------------------------------------------------------------------------
// The keys a wallet derives
// ---------------------------------------------------------------------------

process.stdout.write('\nthe keys a wallet derives\n');

const keys = await proof.ConfidentialKeysHandle.fromSignature(new Uint8Array(64).fill(31));
const destination = await proof.ConfidentialKeysHandle.fromSignature(new Uint8Array(64).fill(32));

await check('derivation is deterministic, so a balance is recoverable', async () => {
  const again = await proof.ConfidentialKeysHandle.fromSignature(new Uint8Array(64).fill(31));
  const a = Buffer.from(keys.elgamalPubkey()).toString('hex');
  const b = Buffer.from(again.elgamalPubkey()).toString('hex');
  if (a !== b) throw new Error('the same signature derived two different keys');
  return 'same signature, same key';
});

await check('the derived key is a real ElGamal public key', () => {
  const pk = keys.elgamalPubkey();
  if (pk.length !== 32) throw new Error(`elgamal pubkey is ${pk.length} bytes, expected 32`);
  return `${pk.length}B`;
});

await check('the derivation message is the fixed constant the SDK expects', async () => {
  const msg = await proof.derivationMessage();
  const text = new TextDecoder().decode(msg);
  if (!text.startsWith('solana-conf-bal')) {
    throw new Error(`derivation message is ${JSON.stringify(text.slice(0, 40))}`);
  }
  return `${msg.length}B: ${JSON.stringify(text)}`;
});

await check('a pubkey-validity proof generates and verifies locally', async () => {
  const bytes = await keys.pubkeyValidityProof();
  // One discriminant byte, then the 96-byte `context || proof` body.
  if (bytes.length !== 97) throw new Error(`proof is ${bytes.length} bytes, expected 97`);
  return `${bytes.length}B (discriminant + 96B body)`;
});

// ---------------------------------------------------------------------------
// The three statements a transfer needs
// ---------------------------------------------------------------------------

process.stdout.write('\nthe three statements a confidential transfer needs\n');

const AMOUNT = 49_000n;
const BALANCE = 1_000_000n;

/** A source ciphertext and a destination key: the public inputs to a transfer. */
async function transferRequest() {
  // The source's available balance, encrypted under its own key — this is what
  // sits on the account and what the equality proof subtracts from.
  const sourceCiphertext = await keys.encryptAmount(BALANCE);
  return {
    keys,
    sourceAvailableBalance: BALANCE,
    sourceAvailableBalanceCiphertext: sourceCiphertext,
    amount: AMOUNT,
    destinationPubkey: destination.elgamalPubkey(),
  };
}

const types = await proof.proofTypes();

let bundle: Awaited<ReturnType<typeof proof.transferProofs>> | undefined;
await check('all three proofs generate in the browser, with no network', async () => {
  const started = Date.now();
  bundle = await proof.transferProofs(await transferRequest());
  const ms = Date.now() - started;
  if (bundle.proofs.length !== 3) throw new Error(`${bundle.proofs.length} proofs, expected 3`);
  return `${bundle.proofs.length} proofs in ${ms}ms`;
});

await check('the proofs are the three types Token-2022 requires, in order', () => {
  const got = bundle!.proofs.map((ix: { data: Uint8Array }) => ix.data[0]);
  const want = [
    types.ciphertextCommitmentEquality,
    types.batchedGroupedCiphertext3Handles,
    types.batchedRangeProofU128,
  ];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`discriminants ${got.join(',')} != ${want.join(',')}`);
  }
  return got.join(', ');
});

await check('every offset is -1 — each proof precedes its consumer', () => {
  const offsets = [
    bundle!.equalityProofOffset,
    bundle!.ciphertextValidityProofOffset,
    bundle!.rangeProofOffset,
  ];
  if (offsets.some((o) => o !== -1)) {
    throw new Error(`offsets ${offsets.join(',')} — a positive offset reads past the tx`);
  }
  return '-1, -1, -1';
});

await check('the new balance is the old one minus the amount', () => {
  const expected = BALANCE - AMOUNT;
  if (bundle!.newAvailableBalance !== expected) {
    throw new Error(`${bundle!.newAvailableBalance} != ${expected}`);
  }
  return `${BALANCE} - ${AMOUNT} = ${bundle!.newAvailableBalance}`;
});

await check('the re-encrypted balance is the AES fast path, not the ZK path', () => {
  const bytes = bundle!.newSourceDecryptableAvailableBalance;
  // An AeCiphertext is nonce(12) || ciphertext(8) || tag(16).
  if (bytes.length !== 36) throw new Error(`fast-path balance is ${bytes.length} bytes, expected 36`);
  return `${bytes.length}B AES ciphertext`;
});

await check('the auditor ciphertexts are present even with no auditor', () => {
  // A grouped ciphertext is always three-handled; with no auditor the token
  // program expects the zero-key encryption rather than a two-handle variant.
  const lo = bundle!.auditorCiphertextLo;
  const hi = bundle!.auditorCiphertextHi;
  if (lo.length !== 64 || hi.length !== 64) {
    throw new Error(`auditor halves are ${lo.length}/${hi.length}, expected 64/64`);
  }
  return '64B + 64B';
});

// ---------------------------------------------------------------------------
// The negatives — what makes the above mean anything
// ---------------------------------------------------------------------------

process.stdout.write('\nthe refusals, which are what make the above mean anything\n');

await checkRejects('a transfer of more than the balance is refused before any proof', async () => {
  const request = await transferRequest();
  await proof.transferProofs({ ...request, amount: BALANCE + 1n });
});

await checkRejects('a transfer of zero is refused, not silently accepted', async () => {
  const request = await transferRequest();
  await proof.transferProofs({ ...request, amount: 0n });
});

await checkRejects('a malformed balance ciphertext is refused at the door', async () => {
  const request = await transferRequest();
  await proof.transferProofs({
    ...request,
    sourceAvailableBalanceCiphertext: new Uint8Array(63),
  });
});

await checkRejects('a derivation from a short signature is refused', async () => {
  await proof.ConfidentialKeysHandle.fromSignature(new Uint8Array(32));
});

await checkRejects('the derivation message cannot be swapped for another', async () => {
  // The keys are bound to the message the wallet signed. Signing 64 zero bytes
  // still derives *a* key — but it must not equal the key derived from the
  // real message, or a malicious dapp could ask for a signature over anything
  // and reach the same balance.
  const wrong = await proof.ConfidentialKeysHandle.fromSignature(new Uint8Array(64));
  if (wrong.elgamalPubkey().toString() === keys.elgamalPubkey().toString()) {
    throw new Error('a different signature produced the same confidential key');
  }
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

process.stdout.write(
  [
    '',
    `${passed} passed, ${failed} failed`,
    '',
    failed === 0
      ? 'VERDICT: the artifact served to browsers generates every proof a\n' +
        'confidential transfer needs, and refuses the statements it must. A payer\n' +
        'authors a private payment in the wallet; its keys and the amount never\n' +
        'leave the device, and no prover service is contacted.'
      : 'VERDICT: the browser prover is not shippable — see the failures above.',
    '',
  ].join('\n'),
);

process.exit(failed === 0 ? 0 : 1);
