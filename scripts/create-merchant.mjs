#!/usr/bin/env node
/**
 * scripts/create-merchant.mjs — the `create-veil-merchant` scaffold.
 *
 *   node scripts/create-merchant.mjs my-api
 *   # or, from the CLI:
 *   npm run veil -- scaffold my-api
 *
 * The DX spec's step 1 is `npx create-veil-merchant my-api` → `veil init
 * --sandbox` → `npm run dev`, with a first private payment in under five
 * minutes. This writes the "my-api" half: a runnable Express server whose
 * *entire* privacy integration is one wrapped handler, plus the two commands
 * that finish the job. The scaffold is deliberately small — the point of the
 * product is that the diff is small, so a scaffold that hid a hundred lines of
 * setup would contradict the claim it is demonstrating.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = process.argv[2];
if (!dir || dir.startsWith('-')) {
  console.error('usage: node scripts/create-merchant.mjs <directory>');
  process.exit(2);
}
const root = resolve(process.cwd(), dir);
// The repo this scaffold came from, so the generated project depends on the
// working copy rather than a registry package that is not published yet. When
// veil-x402 is on npm this becomes `"veil-x402": "^0.1.0"` and nothing else
// changes.
const repo = resolve(process.cwd());

const files = {
  'package.json': JSON.stringify(
    {
      name: dir.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      private: true,
      type: 'module',
      scripts: {
        dev: 'node --experimental-strip-types server.ts',
        sandbox: 'node --experimental-strip-types node_modules/veil-x402/scripts/sandbox.ts --key .keys/agent.json',
        pay: 'node --experimental-strip-types node_modules/veil-x402/scripts/veil-fetch.ts --key .keys/agent.json',
      },
      dependencies: {
        // Not published to the registry yet — see the README this scaffold writes.
        'veil-x402': `file:${repo}`,
      },
    },
    null,
    2,
  ),

  'server.ts': `/**
 * A Veil merchant in one wrapped handler.
 *
 * Everything above the \`veil()\` call is an ordinary Express app. Everything the
 * product does is in the two lines that follow it: the handler is wrapped, and
 * paid callers reach \`produce\` while unpaid ones get a 402 that names the
 * price, the mint and the merchant's one-time account — never the merchant's
 * wallet twice.
 */
import express from 'express';
import { veil } from 'veil-x402';

const app = express();

const merchant = await veil({
  // The wallet you want to be paid at. This is the one required field.
  payTo: process.env.VEIL_PAY_TO ?? 'REPLACE_WITH_YOUR_WALLET',
  price: '0.01',
  path: '/api/insight',
  description: 'A paid endpoint — the seat a private payment lands in',
  produce: ({ paid }) => ({ insight: 'the thing you paid for', paid }),
});

app.get('/api/insight', merchant.handler);

// What the merchant's own dashboard reads. The number here is only visible to
// the merchant: on chain this same balance is ciphertext.
app.get('/ledger', (_req, res) => {
  res.json({
    merchant: merchant.config.resources[0].alias,
    seats: merchant.ledger.allFor(merchant.config.resources[0].alias),
    provisioned: merchant.provisioned,
  });
});

const port = Number(process.env.PORT ?? 4021);
app.listen(port, () => {
  console.log(\`  merchant listening on http://localhost:\${port}/api/insight\`);
  console.log(\`  pay it:  npm run pay -- --url http://localhost:\${port}/api/insight --budget 0.10\`);
});
`,

  'README.md': `# ${dir}

A Veil merchant — an x402 endpoint whose payments settle confidentially.

## Run it

\`\`\`bash
npm install

# 1. set the wallet you want to be paid at
export VEIL_PAY_TO=YourWalletAddress

# 2. give the paying agent a key, SOL and test dollars (one command)
npm run sandbox -- --key .keys/agent.json

# 3. start the merchant
npm run dev
\`\`\`

Then, in a second shell, pay it:

\`\`\`bash
npm run pay -- --url http://localhost:4021/api/insight --budget 0.10
\`\`\`

You should see a \`402\`, then a \`200\` with the resource, and an explorer link
for the settlement. The amount on that link is ciphertext; only the merchant's
key (and the auditor key) can read it.

## Why the dependency is a path

\`veil-x402\` is not on the public registry yet, so \`package.json\` points at the
working copy this scaffold was generated from (${repo}). When the package is
published, change that one line to \`"veil-x402": "^0.1.0"\` and nothing else in
this project changes.

## What is hidden, and what is not

- **Hidden:** the amount of every payment.
- **Not hidden:** that an account exists, and which alias it belongs to. Veil
  gives each payment its own one-time account so two payments to this merchant
  never sit next to each other, but this is a real limit and the honest wording
  is "not trivially correlatable", not "unlinkable".

See \`docs/troubleshooting.md\` in the Veil repo for the error codes this
endpoint can emit.
`,

  '.env.example': `# The wallet that receives payments.
VEIL_PAY_TO=

# Optional: point at a rail other than the hosted one.
# VEIL_RAIL=https://veil-devnet.vercel.app
# VEIL_RPC_URL=https://api.testnet.solana.com

# Optional: the port this merchant listens on.
# PORT=4021
`,

  '.gitignore': `node_modules
.env
.keys
data
`,
};

mkdirSync(root, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(root, name), content, { mode: name === '.env.example' ? 0o644 : 0o644 });
}

console.log(`
  created ${dir}/

    ${Object.keys(files).join('\n    ')}

  next
    cd ${dir}
    npm install
    export VEIL_PAY_TO=<your wallet>
    npm run sandbox -- --key .keys/agent.json
    npm run dev
`);
