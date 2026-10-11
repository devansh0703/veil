#!/usr/bin/env node
// Generate the pitch video's narration with the local Kokoro engine and report
// each clip's real duration, so the composition can be placed against measured
// audio rather than an estimate.
//
//   node scripts/gen-vo.mjs --cut pitch
//
// Writes assets/vo/<cut>-<n>.wav and prints a JSON manifest on stdout.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// `--project <dir>` lets one generator serve both video projects; the default
// keeps the original behaviour of operating on the script's parent directory.
const projIdx = process.argv.indexOf('--project');
const PROJECT = projIdx === -1 ? resolve(HERE, '..') : resolve(process.cwd(), process.argv[projIdx + 1]);

// Scene windows and narration, one entry per scene of the composition.
// `voStart` is absolute composition time; it trails the scene start by 0.6 s so
// the entrance motion lands before the voice.
export const PITCH = [
  {
    scene: 's1-hook', voStart: 0.6, sceneEnd: 9.5,
    text: 'x402 lets an agent pay for an API call with no account and no human — and makes every payment public.',
  },
  {
    scene: 's2-scale', voStart: 10.1, sceneEnd: 23.5,
    text: 'Two hundred million payments settled on this rail, moving fifty-two million dollars. The average ticket: thirty-one cents. At thirty-one cents a call, your price list becomes public infrastructure.',
  },
  {
    scene: 's3-leaks', voStart: 24.1, sceneEnd: 37.5,
    text: "What leaks isn't your balance. It's your business. What each customer pays you. Whether you charge them differently. Which new client is ramping. Your book, broken down by counterparty.",
  },
  {
    scene: 's4-what', voStart: 38.0, sceneEnd: 54.0,
    text: "Veil is an x402 scheme on Solana. The amount is ciphertext, and the chain does the checking: ElGamal and zero-knowledge proofs, verified by Solana's own Token-2022 program.",
  },
  {
    scene: 's5-ledger', voStart: 54.6, sceneEnd: 70.0,
    text: "This is the merchant's ledger after a real run. Amounts are readable only with the merchant's own key. The addresses stay public, so the dashboard prints them. That is the honest boundary of the primitive.",
  },
  {
    scene: 's6-replay', voStart: 70.6, sceneEnd: 86.5,
    text: "You don't have to believe any of that. The proof is a command, not a promise. Replay reads the chain, not our database, and asserts seven things: the transaction exists, it succeeded, and no readable amount moved.",
  },
  {
    scene: 's7-field', voStart: 87.1, sceneEnd: 101.0,
    text: 'Others ship privacy for x402: an MPC cluster, a TEE, an FHE coprocessor. Each asks you to trust an operator set. This one is verified by the chain.',
  },
  {
    scene: 's8-closing', voStart: 101.5, sceneEnd: 113.0,
    text: 'Live on devnet, with every receipt in the repository. A hosted facilitator, an npm CLI, and an agent sandbox any client can call today.',
  },
];

// The technical demo (<= 170 s). Nine scenes; the argument is the mechanism,
// not the pitch, so every line names a real artifact the repo ships.
export const DEMO = [
  {
    scene: 'd1-title', voStart: 0.5, sceneEnd: 7.0,
    text: 'Veil. A technical walkthrough of a confidential x402 rail on Solana.',
  },
  {
    scene: 'd2-request', voStart: 7.5, sceneEnd: 27.0,
    text: 'An agent asks for a resource. Unpaid, it gets a standard 402: a price, a one-time account, and a privacy claim it can check. Before quoting, the rail reads the mint and the destination, confirming both can hold a confidential transfer.',
  },
  {
    scene: 'd3-proofs', voStart: 27.5, sceneEnd: 49.0,
    text: 'A confidential transfer needs three proofs: ciphertext-commitment equality, batched ciphertext validity, and a range proof over the remaining balance. All three are built on the payer\'s own machine, by WASM inside the Solana ZK SDK. No prover service, no fee, about fifty milliseconds.',
  },
  {
    scene: 'd4-settle', voStart: 49.5, sceneEnd: 73.0,
    text: 'The transfer is Token-2022, instruction family twenty-seven, operation seven. Solana\'s own token program verifies those proofs on chain. The payer signs the money movement; the rail co-signs only the network fee. The merchant decrypts its own recipient ciphertext with its own wallet key — one key per merchant.',
  },
  {
    scene: 'd5-refusals', voStart: 73.5, sceneEnd: 93.0,
    text: 'Every refusal has one code, one cause, one remedy. The load-bearing one is VEIL-CONF-003: if the rail cannot demonstrate that a payment will be confidential, it refuses and offers nothing. A refusal carries no accepts entry at all.',
  },
  {
    scene: 'd6-graph', voStart: 93.5, sceneEnd: 111.0,
    text: 'Confidential balances hide the amount, not that an account exists. So every payment lands in a different one-time account from a pre-created pool. Seats are never re-armed — reusing one would link two payments on the public graph.',
  },
  {
    scene: 'd7-replay', voStart: 111.5, sceneEnd: 133.0,
    text: 'The claim is about someone else\'s blockchain, so it should not be taken on our word. Replay reads the chain, not our ledger, and asserts seven things: the transaction exists, it succeeded, it carries exactly one confidential transfer, and no readable amount moved.',
  },
  {
    scene: 'd8-2026', voStart: 133.5, sceneEnd: 152.0,
    text: 'Three things landed in 2026. Batch settlement: capital committed once, a signed voucher per call, and a confidential redemption — only the session total reaches the chain. One-transaction settlement behind txv1. And V2 headers.',
  },
  {
    scene: 'd9-limits', voStart: 152.5, sceneEnd: 167.0,
    text: 'What stays public, stated plainly: the account addresses, the mint, and the timing. That is the limit of this primitive, and it is on our limits page in the same words.',
  },
];

const args = process.argv.slice(2);
const cut = (args.includes('--cut') ? args[args.indexOf('--cut') + 1] : 'pitch') || 'pitch';
const voice = (args.includes('--voice') ? args[args.indexOf('--voice') + 1] : 'am_michael') || 'am_michael';
const speed = args.includes('--speed') ? args[args.indexOf('--speed') + 1] : '1.0';

const SEGMENTS = { pitch: PITCH, demo: DEMO };

const segments = SEGMENTS[cut];
if (!segments) {
  console.error(`unknown cut "${cut}" — known: ${Object.keys(SEGMENTS).join(', ')}`);
  process.exit(2);
}

const outDir = join(PROJECT, 'assets', 'vo');
mkdirSync(outDir, { recursive: true });

const cli = process.env.HF_CLI || 'hyperframes@0.8.149';
const manifest = [];
let failed = false;

for (const [i, seg] of segments.entries()) {
  const n = String(i + 1).padStart(2, '0');
  const out = join(outDir, `${cut}-${n}.wav`);
  process.stderr.write(`[${n}] ${seg.scene} … `);
  execFileSync(
    'npx',
    ['--yes', cli, 'tts', seg.text, '-o', out, '--voice', voice, '--speed', speed, '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  const duration = Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', out,
    ], { encoding: 'utf8' }).trim(),
  );
  const available = seg.sceneEnd - seg.voStart;
  const fits = duration <= available;
  if (!fits) failed = true;
  process.stderr.write(`${duration.toFixed(2)}s / ${available.toFixed(2)}s ${fits ? 'ok' : 'OVERFLOW'}\n`);
  manifest.push({
    n: i + 1, scene: seg.scene, text: seg.text,
    file: `assets/vo/${cut}-${n}.wav`,
    voStart: seg.voStart, duration: Number(duration.toFixed(3)),
    sceneEnd: seg.sceneEnd, available: Number(available.toFixed(3)), fits,
  });
}

const metaPath = join(PROJECT, `audio_${cut}.json`);
writeFileSync(metaPath, JSON.stringify({ cut, voice, speed, segments: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ cut, voice, metaPath, segments: manifest }, null, 2));
if (failed) process.exit(1);
