#!/usr/bin/env -S node --experimental-strip-types
/**
 * @veil/cli — the `veil` command.
 *
 * The DX spec asks for one entry point with a three-step start and a
 * non-interactive `--ci` mode, and the whole point is that it *wraps* the same
 * code paths the library uses rather than re-implementing them. So `init` shells
 * out to the sandbox runner and `pay` shells out to the agent CLI: one
 * implementation of the confidential-account ceremony, reachable two ways. If
 * the CLI re-did that work itself it would drift from the SDK, and the drift
 * would show up as a payer that works from one surface and not the other.
 *
 *   veil init --sandbox [--key ~/.veil/agent.json]   # fund + arm + dollars
 *   veil balance [--key ...]                         # what the agent holds
 *   veil pay --url <rail-resource> --budget 0.10
 *   veil doctor                                      # is the rail reachable?
 *
 * Every command takes `--ci` for non-interactive use: no prompts, machine
 * readable output, and a non-zero exit on failure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const VERSION = '0.1.0';
const RAIL = process.env.VEIL_RAIL ?? 'https://veil-devnet.vercel.app';
const MINT = process.env.VEIL_MINT ?? 'H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p';

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) ?? 'help';
const ci = argv.includes('--ci');
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * The agent's key, created on first use.
 *
 * The file format matters: every other script here reads a JSON array of 64
 * bytes laid out as `seed ‖ publicKey`, and derives the confidential keys from
 * the first 32. So the generator produces exactly that, from a random seed,
 * rather than whatever shape a keypair API happens to return — a mismatch here
 * shows up much later as a decryption failure with no obvious cause.
 */
function ensureKey(): string {
  // An explicit --key is created too, not just the default path: the quickstart
  // tells people to pass one, and a command that failed there for a file that
  // does not exist yet would be the first thing a new developer hit.
  const given = flag('key') ?? process.env.VEIL_KEY;
  const target = given ? resolve(given) : join(process.env.HOME ?? '.', '.veil', 'agent.json');
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) return target;

  const { createPrivateKey, createPublicKey, randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  writeFileSync(target, JSON.stringify([...seed, ...publicKey]), { mode: 0o600 });
  if (!ci) console.log(`  created a new agent key at ${target}`);
  return target;
}

function run(label: string, args: string[]): number {
  const result = spawnSync('node', args, { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0 && !ci) console.error(`  ${label} exited ${result.status ?? 'signal'}`);
  return result.status ?? 1;
}

function help(): void {
  console.log(`
  veil ${VERSION} — private payment rails for the agent economy

  usage
    veil init --sandbox [--key <path>] [--amount 100] [--sol 0.05]
        Create a key if needed, fund it, arm its confidential account and give
        it test dollars. One command, no wallet ceremony.

    veil balance [--key <path>] [--rpc <url>] [--mint <mint>]
        Decrypt what this agent holds — available and pending. Read-only.

    veil pay --url <rail-resource> [--key <path>] [--budget 0.10] [--url ...]
        Fetch a paid resource through the rail, paying privately. Repeat --url
        to run as a stateful agent with one shared budget.

    veil doctor [--rail <origin>]
        Print whether the rail is reachable and what it quotes.

    veil scaffold <dir>
        Write a runnable Express merchant whose handler is already wrapped in
        veil({ price }).

  global
    --ci        non-interactive: no prompts, machine-readable, non-zero exit
                on failure
    --version   print the version
    --help      this text
`);
}

async function doctor(): Promise<number> {
  const rail = (flag('rail') ?? RAIL).replace(/\/$/, '');
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  for (const [name, path] of [
    ['health', '/v1/health'],
    ['supported', '/supported'],
    ['facilitator', '/facilitator/health'],
  ] as const) {
    try {
      const res = await fetch(`${rail}${path}`);
      const body = await res.text();
      checks.push({ name, ok: res.ok, detail: `${res.status} ${body.slice(0, 160)}` });
    } catch (cause) {
      checks.push({ name, ok: false, detail: String(cause) });
    }
  }
  if (ci) {
    console.log(JSON.stringify({ rail, checks }, null, 2));
  } else {
    console.log('');
    console.log(`  rail  ${rail}`);
    for (const check of checks) {
      console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(12)} ${check.detail}`);
    }
    console.log('');
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

switch (command) {
  case 'init': {
    const args = ['scripts/sandbox.ts', '--key', ensureKey()];
    if (flag('amount')) args.push('--amount', flag('amount')!);
    if (flag('sol')) args.push('--sol', flag('sol')!);
    if (flag('rpc')) args.push('--rpc', flag('rpc')!);
    if (flag('mint')) args.push('--mint', flag('mint')!);
    process.exit(run('veil init', args));
  }
  case 'balance': {
    const args = [
      'scripts/apply-pending.ts',
      '--key',
      ensureKey(),
      '--read-only',
      '--mint',
      flag('mint') ?? MINT,
    ];
    if (flag('rpc')) args.push('--rpc', flag('rpc')!);
    process.exit(run('veil balance', args));
  }
  case 'pay': {
    const urls: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--url' && argv[i + 1]) urls.push(argv[i + 1]!);
    }
    if (urls.length === 0) {
      console.error('  veil pay: at least one --url is required');
      process.exit(2);
    }
    const args = ['scripts/veil-fetch.ts', '--key', ensureKey()];
    for (const url of urls) args.push('--url', url);
    if (flag('budget')) args.push('--budget', flag('budget')!);
    if (flag('rpc')) args.push('--rpc', flag('rpc')!);
    process.exit(run('veil pay', args));
  }
  case 'scaffold': {
    const after = argv[argv.indexOf('scaffold') + 1];
    const dir = flag('dir') ?? (after && !after.startsWith('-') ? after : undefined);
    if (!dir) {
      console.error('  veil scaffold: a target directory is required');
      process.exit(2);
    }
    process.exit(run('veil scaffold', ['scripts/create-merchant.mjs', dir]));
  }
  case 'doctor':
    process.exit(await doctor());
  case 'version':
    console.log(VERSION);
    break;
  default:
    help();
}
