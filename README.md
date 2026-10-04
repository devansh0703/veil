# Veil

[![CI](https://github.com/devansh0703/veil/actions/workflows/ci.yml/badge.svg)](https://github.com/devansh0703/veil/actions/workflows/ci.yml) [![Deployed](https://img.shields.io/badge/live-veil--sable--five.vercel.app-2f855a)](https://veil-devnet.vercel.app)

**Private payment rails for the agent economy.**

**Live rail: [https://veil-devnet.vercel.app](https://veil-devnet.vercel.app)** —
the product page, a 402 offer with a real seat (`GET /v1/oracle/tide`), and the
facilitator (`/facilitator/health`, `/verify`, `/settle`) over public HTTPS on
Solana testnet. Reproduce the hosted settlement with `VEIL_FACILITATOR_URL`
(see *The rail, hosted* below).

[x402](https://github.com/coinbase/x402) gave agents a way to pay for an API call
without a human and without an account. It left the amount, the counterparty, and
the payment pattern on a public ledger. Veil closes that gap using two primitives
that already exist on Solana — not a mixer, not a promise.

| Layer | Primitive | What it hides |
| --- | --- | --- |
| Amount | Token-2022 **Confidential Balances** (native ElGamal + ZK proofs) | transfer amounts, account balances |
| Graph | **One-time addresses** from a pre-created, pre-configured pool | which payments belong to the same buyer, and how many there were |

Neither layer is invented here. The first is a Solana token extension. The second
is an application of account hygiene. What Veil adds is the facilitator that refuses
to serve a payment it cannot make private.

---

## The claim, stated precisely

Privacy products lose trust in exactly the place they are tempted to be vague, so
this is stated once, in the strongest form that is still true.

**Hidden.** Every transfer amount is stored as ciphertext, and so is the balance of
every confidential account. A validator confirms a transfer is well-formed and
non-inflationary without learning the figure.

**Public.** Token account addresses. Confidential Balances encrypts the *fields*, not
the *existence* of an account. Anyone can see that a given one-time account received
a transfer. The merchant ledger prints the destination address of every row rather
than hiding it, because hiding it would misrepresent the boundary.

**Inferable.** Timing correlation. One-time addresses break the direct link between
an agent and a merchant, but not every link. If exactly one confidential transfer
arrives at a merchant within a minute of a specific agent going quiet, an observer
watching both ends can guess. At high volume that guess drowns; at low volume, as in
a demo, it does not. The UI names this as a limit, not a footnote.

**Not claimed.** Anonymity. The token account address stays public by design of the
underlying Solana extension. Veil is a payments-privacy layer, not an anonymity
network.

**The auditor key is not the merchant path.** Token-2022's confidential-transfer
mint carries a single *global* auditor ElGamal key per mint. Every confidential
transfer to every account under that mint is decryptable by that one key. That makes
it a genuine third-party affordance (a regulated venue's audit path) and completely
unusable as a per-merchant reconciliation mechanism — one key for all merchants is
not a reconciliation story. Veil therefore reconciles the way the cryptography
actually allows: **each merchant decrypts its own recipient ciphertext with the key
derived from its own wallet.** The auditor key is off by default (`auditor: null`).

---

## Quick start

Requires Node ≥ 22. No global installs.

```bash
npm install
npm run verify     # typecheck + 141 unit tests, no network
npm run demo       # 10 protocol scenarios over real HTTP, then render the pages
npm run standalone # optional: one self-contained HTML file per surface
```

Then open `web/index.html`. Every page renders from `file://` — no server needed to
look at them. `npm run standalone` emits the same four surfaces as single files with
fonts, CSS and JS inlined, which open from anywhere with no siblings.

To watch the merchant ledger update against a live server:

```bash
npm run veil -- serve --local-settlement=true
# http://127.0.0.1:4021
```

Flags (all optional):

| Flag | Default | Effect |
| --- | --- | --- |
| `--port` | `4021` | HTTP port |
| `--ledger` | `data/pool-ledger.json` | pool ledger path |
| `--local-settlement` | `false` | record settlements against the local ledger |
| `--spend-cap` | unset | buyer session cap, enforced server-side |

With no `--local-settlement` and no `VEIL_RPC_URL`, settle attempts return
**503 `settlement-unavailable`**. That is deliberate — see *Honest limits* below.

To run a real confidential payment on Solana testnet:

```bash
npm run build:proofs                               # the browser prover artifact
VEIL_RPC_URL=https://api.testnet.solana.com VEIL_NETWORK=solana:testnet npm run go:live
# add --apply to broadcast: it creates, funds, deposits, proves, transfers, applies
```

### Agent side, in one command

```bash
npm run sandbox     -- --key .keys/agent.json                 # key, SOL, confidential account, test dollars
npm run pay:agent   -- --key .keys/agent.json --url <rail-resource> --budget 0.10
npm run cli         -- balance --key .keys/agent.json         # decrypt what it holds
npm run cli         -- doctor                                 # is the rail reachable?
```

---

## Documentation

| Doc | What it is for |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Buy something, sell something, both in under five minutes. |
| [Concepts](docs/concepts.md) | Why amounts are hidden and addresses are not — and the honest limit of that. |
| [API reference](docs/api.md) | Every export, option and return value, plus the raw 402/`X-PAYMENT` protocol. |
| [Troubleshooting](docs/troubleshooting.md) | Every error code, keyed to its fix. Start here when a payment fails. |
| [Verify it yourself](docs/verify-it-yourself.md) | Go from an explorer link to the CLI check that reads the ciphertext back. |
| [CHANGELOG](CHANGELOG.md) | What changed, and the `0.x` breaking-change policy. |

License: [MIT](LICENSE). Questions and integration reports: GitHub Discussions.

---

## Set up your own merchant — a wallet and a price

x402's seller quickstart is *your API + a receive address + the middleware pointed
at the facilitator*. Veil keeps the same sentence and drops one clause: the
facilitator runs in the same process, so you never configure its URL. What you
supply is a wallet to be paid at and a price.

```ts
import { veil } from './packages/server/src/index.ts';

const { server } = await veil({
  payTo: 'YourWalletAddress',   // the one required field
  price: '0.05',                // default '0.05'
  path: '/data',                // default '/'
  produce: () => ({ hello: 'you paid, privately' }),
});
server.listen(4021);
```

`node examples/merchant.ts` runs exactly that. The first run provisions eight
one-time accounts for the wallet and records the pool on disk; later runs reuse
it. Network, mint and precision default to the hosted rail's public config
(`HOSTED_DEFAULTS` in `packages/server`), and the confidentiality gate is answered
from the pool that call wrote — reported as `pool-ledger`, never `chain`, so the
declared-vs-read distinction stays visible. If the preconditions cannot be
vouched for, the merchant refuses rather than downgrading the payment to public.

Everything a full deployment exposes works here with no more configuration:
`GET /.well-known/veil` describes the resource, an unpaid request returns a
standard x402 402, and a paid retry settles and serves `produce()`.

---

## What actually runs

```
                402 Payment Required
   agent  ─────────────────────────────────►  veil server
     │      accepts[]: one-time account,          │
     │      price, extra.privacy                    │ preconditions checked
     │                                              │ BEFORE quoting
     │  ◄── signed confidential transfer ───────────┘
     │
     ▼  Token-2022: ElGamal ciphertext + ZK proofs
  testnet  ────────────────────────────────────►  merchant decrypts
                                                  with its own wallet key
```

The server checks two preconditions *before it quotes a price*, because a price is
an offer to settle and Veil must not offer a settlement it cannot make private:

1. the mint carries the confidential-transfer extension, and
2. the destination account accepts confidential credits.

If either cannot be checked — a probe that is missing rather than failing — the
server answers **`VEIL-CONF-003`** and offers nothing. It never downgrades to a
public transfer. A merchant who believes they are private while their amounts sit
on a public ledger has been actively misled, which is worse than an error.

### Refusal codes

Every refusal has one code, one cause, and one thing the agent should do.

| Code | HTTP | Cause | Recoverable by retry? |
| --- | --- | --- | --- |
| `VEIL-CONF-001` | 402 | mint lacks the confidential-transfer extension | no |
| `VEIL-CONF-002` | 402 | destination cannot receive confidential credits | no |
| `VEIL-CONF-003` | 402 | confidentiality cannot be guaranteed — refuse to serve | no |
| `VEIL-CONF-004` | 402 | buyer would exceed its declared spend cap | only by changing the request |
| `VEIL-CONF-005` | 503 | one-time address pool exhausted | only by growing the pool |
| `VEIL-CONF-006` | 503 | could not claim an address before another instance took it | yes — and growing the pool if it persists |

A refusal carries **no `accepts[]` entry at all**. An offer alongside a refusal would
invite a client to pay something the server has already said it cannot settle
privately — which is the failure the whole surface exists to prevent.

---

## Where the zero-knowledge proofs come from

The first question anyone asks about a ZK payment system is who generates the
proofs, because that answer decides the trust model. Veil's answer is: **the
payer's own machine, locally, with no service in the loop.**

A Token-2022 confidential transfer needs three proofs, and all three are built by
WASM that ships inside `@solana/zk-sdk`:

| Proof | Statement |
| --- | --- |
| Ciphertext-commitment equality | the new balance I am writing is the old balance minus this amount, and I know the opening |
| Batched grouped ciphertext validity | the two grouped ciphertexts really encrypt that amount under the source, destination and auditor keys |
| Batched range proof (u128) | every committed value is in range, so no amount can wrap into a negative balance |

```bash
npm run prove:check   # 23 checks, including these three
```

What this means in practice:

- **No prover service.** There is no API to call and no fee to pay. `buildTransferProofs`
  takes the payer's key material, the amount, and the destination's *public* key —
  nothing else — and returns the three proof instructions plus the ciphertexts.
- **No RPC round trip to build them.** The proofs are generated before any network
  call, so a wallet that is offline can still author a payment; only broadcasting
  needs a connection.
- **Fast enough for an interactive client.** All three build in roughly 50 ms in
  Node. A browser runs the same WASM, which is why the client half of Veil is
  portable rather than server-side.
- **The amount never leaves the client to make them.** The only things transmitted
  are the signed transaction and the proofs that commit to it.

The token program verifies all three on chain, by reading the proof instructions
from the Instructions sysvar at a signed offset. Each proof sits immediately
*before* the transfer that consumes it, so each offset is `-1` — a sign that is
load-bearing and was measured against live testnet rather than assumed.

### In a browser, on the deployed artifact

A claim about client-side proving is worth nothing until it survives being
served. So the browser path is built from the *same* module, not a copy:

```bash
npm run build:proofs    # bundles packages/onchain/src/proofs.ts for the browser
npm run prove:browser   # 18 checks against the built artifact, in Node
npm run web             # serve the surfaces over HTTP
npm run check:ui        # 9 checks in headless Chrome, clicking the real button
```

`build:proofs` compiles `packages/onchain/src/proofs.ts` with one esbuild alias —
`@solana/zk-sdk` → the browser build — so the crypto the browser runs is the
crypto the test suite exercises. A forked browser prover would be a second
implementation that silently drifts, which is why there isn't one.

What `check:ui` asserts, in a real Chrome, on the page as served:

- the panel reaches the bundle and instantiates the WASM (`status: ready`)
- three proofs are generated, with the discriminants Token-2022 expects
  (`3`, `12`, `7`) and every offset `-1`
- **the number of network requests made while proving is `0`** — the panel counts
  `performance.getEntriesByType('resource')` before and after, so this is measured
  rather than asserted
- the page loads nothing from a third-party origin
- the browser raises no uncaught exception

You can watch it yourself: `npm run web`, open `http://127.0.0.1:4020/402.html`,
press *Generate a transfer proof*. The panel prints the proof sizes, the offsets,
and the request count. On `file://` it reports that the prover needs a served
origin instead of failing silently, because a browser will not resolve a module
import from the filesystem.

---

## Repository layout

```
packages/x402-core/   the 402 body, refusal catalog, budget guard, atomic price math
                      (zero runtime dependencies — readable in one sitting)
packages/derive/      deterministic slot assignment + the pool ledger
packages/onchain/     real Token-2022 confidential instruction construction
packages/server/      the HTTP facilitator: quote → verify → settle, and refusals
scripts/              serve · demo-local · build-pages · setup-devnet · status
                      facilitator · go-live · prove-check · build-proofs
api-src/              hosted entry sources → bundled to api/*.js by build:api
api/                  the deployed Vercel functions (committed build artifacts)
vercel.json           rewrites /v1/*, /verify, /settle, /facilitator/* → the functions
web/                  the four surfaces + shared tokens/CSS/behavior
data/                 pool ledger, settlement records, captured fixtures
```

The hosted deployment runs the *same* handlers as the local CLI:
`scripts/facilitator-app.ts` is the facilitator both `npm run veil -- facilitator`
and `api/facilitator.ts` call, and `createVeilHandler` is the merchant server both
`serve` and `api/veil.ts` call. There is no second implementation to drift.

Four surfaces, four jobs:

| Surface | Job | Ground |
| --- | --- | --- |
| `web/index.html` | persuade — the same payment seen from two places | paper |
| `web/dashboard.html` | the merchant's reconciled view | graphite |
| `web/limits.html` | the honest limits, as a first-class surface | paper |
| `web/402.html` | the protocol body, for machines and humans | graphite |

`web/dashboard.html`, `web/limits.html` and `web/402.html` are **rendered from a real
run** by `scripts/build-pages.ts`, which injects captured fixtures and the live
ledger between marker comments. Pages that describe a run the software did not
perform would be the cheapest kind of demo, so the build refuses placeholder data:
if `data/demo/run.json` is absent, `npm run pages` stops.

---

## Money

Every amount is a `bigint` in atomic units at the mint's precision. There is no
float anywhere in the price path. `toAtomic("0.049", 6)` is `49000n`;
`toAtomic("0.0000001", 6)` **throws** rather than rounding money it cannot represent
exactly. `priceFor` composes a flat charge with measured unit usage.

The budget guard is enforced by the **server**, not the client, so a merchant that
keeps raising its price cannot talk an agent into unbounded spend:

```ts
checkBudget(amount, { spendCap, alreadySpent })
// → { ok: false, refusal: VEIL-CONF-004 } once the cap would be exceeded
```

## Settlement ordering

Settlement is two steps with an irreversible broadcast in the middle, so the code
checks before it sends:

```
ledger.settleable(address, paymentId)   ← validates, mutates nothing
        ↓  passes
broadcast(signed transaction)           ← irreversible
        ↓  succeeds
ledger.settle(address, paymentId, at)   ← commits the accounting
```

An earlier version broadcast first and validated second. If the validation had
failed, real money would have moved while the merchant's own books recorded nothing:
the payer paid, the merchant was paid, and the ledger said no transaction happened.
Checking first costs one pass over a small array and removes that entire failure
mode. Settling the same account twice is likewise rejected rather than re-stamped, so
a payer that retries a settle it already got a 200 for cannot be counted twice.

---

## Live on chain

Confidential payments have been **broadcast and confirmed on both Solana testnet
and devnet**, two ways: the operator's own end-to-end run (`go:live`, below), and
an *independent payer* holding its own key, paying a merchant through the x402
facilitator (`pay:live`). Both clusters started from a 5 SOL budget; the spend is
reported at the end of this section.

```bash
VEIL_RPC_URL=https://api.testnet.solana.com VEIL_NETWORK=solana:testnet npm run go:live
VEIL_RPC_URL=https://api.testnet.solana.com VEIL_NETWORK=solana:testnet npm run go:live -- --apply
```

Without `--apply` it reads the chain and refuses to proceed unless every
precondition is really there. With it, it runs the whole sequence and reports what
landed:

| | |
| --- | --- |
| mint | `H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p` (Token-2022, confidential extension) |
| payer | `3RWhpyX2JaE89UWqxM8LRsB3xykSVwHyEvBmgdo9N1FJ` |
| destination | `HYLLJkNr7LpEGa8Eck8EP9vqNxHv1y8z71A7FLKUiHgc` |
| amount | 49000 atomic units — never in the clear |
| transfer | [`38FFhzJGbY4Rdt52fFgHujf5aymk8NRiGdbANbX3YmmeF4sbb6ByGBcKJqfzNbaMRqygSNxc8wziZCjC4tZc17tt`](https://explorer.solana.com/tx/38FFhzJGbY4Rdt52fFgHujf5aymk8NRiGdbANbX3YmmeF4sbb6ByGBcKJqfzNbaMRqygSNxc8wziZCjC4tZc17tt?cluster=testnet) |

What that run proves, in order: the source account was created with the extension
allocated, configured against a locally generated pubkey-validity proof, approved
by the mint authority; public tokens were minted in and deposited; the deposit was
moved from pending to available; **three proofs generated by Veil's own prover**
were verified; the transfer executed; the destination's pending balance was
applied; and the destination was re-read and decrypted locally to confirm
**49000 atomic units available, 0 pending**.

Every one of those steps was discovered by running against the live program rather
than by reading about it, and each failure taught something that is now encoded:

- **`ConfidentialTransferMint` is extension type 4, not 10.** 10 is
  `InterestBearingConfig`. Checking for 10 makes a correctly configured mint look
  unconfigured.
- **A configured account is not a usable one.** The mint sets
  `autoApproveNewAccounts: false`, so the mint authority must approve each account
  before it can deposit or receive. Skipping it fails later with `custom program
error: 0x18`, which names neither the account nor the missing step. `setup:devnet`
  was doing exactly this, and now approves.
- **A deposit credits the *pending* balance, not the available one.** An account can
  hold the full amount, decrypt it, and still have nothing spendable until
  `ApplyPendingBalance` runs. The first attempt reached the transfer with an
  available balance of zero.
- **In-transaction proof offsets cannot work at this size.** The three proofs are
  1864 bytes and a transaction is capped at 1232, so the offset form is not an
  option, and the range proof at 1000 bytes does not fit even alone. The proofs are
  verified into *context-state accounts*, with the range proof staged through a
  record account two writes wide.
- **A record account's payload starts at byte 33.** `Write` takes a
  payload-relative offset while the verify instruction takes an absolute one;
  reading at 0 fails as `proof verification failed: ProofContext`, which names
  neither the offset nor the record.

### An independent payer, through the x402 facilitator

`pay:live` is the product's full claim: a payer with **its own keypair** — not the
deployer's — funds itself from a faucet, generates its three proofs locally, and
pays a merchant seat through `POST /verify` → `POST /settle`. The facilitator
co-signs the fee; the merchant alone can read the amount.

```bash
VEIL_RPC_URL=https://api.testnet.solana.com VEIL_NETWORK=solana:testnet npm run pay:live -- --apply
```

| | |
| --- | --- |
| payer | `3BPvBJawS5uDaC72HmqnbA7K2XDcPkNwmGpXufhKojBr` (fresh key, `.keys/agent.json`) |
| merchant seat | `8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21` |
| verify | `valid`, 233 ms |
| settle | `confirmed`, 919 ms — [`64pgyaE6WPsrNueCKt788w81yBafB5WPmu55AbQykBzp9zwjF5XFXpW4dDBnAFfuSCT6qHFj67A5Y7kEE7MahsUQ`](https://explorer.solana.com/tx/64pgyaE6WPsrNueCKt788w81yBafB5WPmu55AbQykBzp9zwjF5XFXpW4dDBnAFfuSCT6qHFj67A5Y7kEE7MahsUQ?cluster=testnet) |
| result | merchant decrypted **49000 available, 0 pending**; the payer went 49000 → 0; its SOL came back to the fee float |

The payer signed only its own half of a 636-byte transaction — the fee-payer slot
stayed `null` until the facilitator filled it. The deployer's key is not in that
transaction at all.

### Devnet — the same flow, from a cold start

Devnet was deployed in one session from its untouched 5 SOL:

```bash
VEIL_RPC_URL=https://api.devnet.solana.com VEIL_NETWORK=devnet npm run setup:devnet -- --create-mint --ledger data/pool-ledger.devnet.json --pool-size 1 --apply
VEIL_RPC_URL=https://api.devnet.solana.com VEIL_NETWORK=devnet npm run go:live -- --apply --ledger data/pool-ledger.devnet.json
VEIL_RPC_URL=https://api.devnet.solana.com VEIL_NETWORK=devnet npm run pay:live -- --apply --ledger data/pool-ledger.devnet.json
```

| | |
| --- | --- |
| mint | same keypair → same address `H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p`, live on devnet |
| pool | 3 seats (oracle.tide, feedmarket, sensor.attest), armed **and** approved at creation |
| `go:live` transfer | [`4LqbC6UvJn6xzxN1tFktfpbVgjTiHz4RL5A1LEsoYQ9KVVXeEnmaBwSEvsGA9FXsf1HZhbPxdunV3kvuPT6asRUA`](https://explorer.solana.com/tx/4LqbC6UvJn6xzxN1tFktfpbVgjTiHz4RL5A1LEsoYQ9KVVXeEnmaBwSEvsGA9FXsf1HZhbPxdunV3kvuPT6asRUA?cluster=devnet) → seat `8NzXxVqL…` settled 49000 |
| `pay:live` settle | [`5ubbHpgE6kNbuWPzrSYX3HvksJzHarkgJVKhH9nAhUtm1Gnq5cv9ehaEkV9HUv3qCSABJuRHRwyhbNW4cemRfD8N`](https://explorer.solana.com/tx/5ubbHpgE6kNbuWPzrSYX3HvksJzHarkgJVKhH9nAhUtm1Gnq5cv9ehaEkV9HUv3qCSABJuRHRwyhbNW4cemRfD8N?cluster=devnet) — verify 260 ms, settle 916 ms |
| result | seat `H6Hm6TXydvh6aMW5QSpa3cggkSfEgKS6ooquRxuRkuX5` decrypted **49000 available** with the merchant key |

Pool addresses derive from fixed seeds, so the *same addresses* exist on both
clusters. Run records are tagged per cluster (`data/pay-live.json` against
`data/pay-live.devnet.json`), and the endpoint — not the environment — decides
which cluster a record belongs to, so one cluster's bookkeeping never blocks the
other.

#### Fresh runs — the sandbox and the agent CLI

Both clusters were re-run from the new tooling, on wallets that did not exist
before, to answer the question a stranger actually asks: *can I just pay?*

| cluster | what | settlement |
| --- | --- | --- |
| testnet | a stranger wallet, onboarded by `veil init --sandbox` and paid through the **hosted** rail | [`58oJFwwQ…`](https://explorer.solana.com/tx/58oJFwwQzwwHhJQ299sy9TvWvWvM2vPDq2PnyBnLB5yTNkz1xgBV2k5HfDzBM3vsPdtuUoKPaMkcxJPzQ5dgVsF1?cluster=testnet) → seat `6yLQjQH…` |
| testnet | a **second, distinct** payer (`.keys/test-payer.json`) through the same rail | [`4UHW96yi…`](https://explorer.solana.com/tx/4UHW96yi76ecKrFVVXFs8irpawaQzDx2Kp681EG899EWWnnv5VA9n2x5tg6CbPYBhvCM5fgREV8udKqsHPZq32Ec?cluster=testnet) → seat `Dbv7UiuJ…` |
| devnet | a stranger wallet, onboarded by the same command against devnet, paid through a locally-served devnet rail | [`66GQJ11z…`](https://explorer.solana.com/tx/66GQJ11z8NG1UcZmmJvjoKpVzBiXo8DksZBnRA74WD145KCMfjA6EAeBiWH85iiQNvtM1xFDChbrcNDsGHDRWB3d?cluster=devnet) → seat `8NzXxVqL…` |

The two testnet payments landed in **different seats** — one merchant, two
payments, two unrelated accounts. That is the graph claim made concrete rather
than argued, and `veil balance` reads both and totals them across every seat.

The devnet run needs a devnet rail, which the deployment does not serve (the
hosted rail is `solana:testnet`); it was served locally on the loopback, with
`/supported` and the facilitator endpoints mounted on the same origin so the
local surface answers exactly what the deployed one does. Neither cluster's
funding was disturbed: the operator's testnet balance funded the two testnet
runs, and devnet held.

`arm-pool.ts` grows a merchant's seats, and both clusters' pools are one seat
per alias on devnet and four for `payee.test` on testnet, so a second payment
from a *different* payer has somewhere to land instead of a `VEIL-CONF-005`
refusal.

### What both clusters cost

| cluster | started | left | spent | where it went |
| --- | --- | --- | --- | --- |
| testnet | 5.0000 SOL | 4.8051 SOL | ≈ 0.195 SOL | 24-seat pool + mint + go:live / pay:live fees |
| devnet | 5.0000 SOL | 4.9828 SOL in the two wallets | ≈ 0.017 SOL | ≈ 0.0169 rent (mint, 3 seats, 2 run accounts — reclaimable by closing) + ≈ 0.0003 in fees |

### The rail, hosted — https://veil-devnet.vercel.app

The merchant server and the facilitator are not just local processes. The same
code runs behind public HTTPS:

| | |
| --- | --- |
| product page | https://veil-devnet.vercel.app/ |
| discovery | `GET /.well-known/veil` → 200, scheme, mint, every resource with its **absolute** `url` and price, privacy gate source, refusal codes |
| merchant health | `GET /v1/health` → 200, pool size + settlement mode |
| a 402 offer | `GET /v1/oracle/tide` → 402 with a live seat, price, an absolute `resource.url` and testnet CAIP-2 (same for `/v1/quote/feedmarket`, `/v1/attest/sensor`) |
| facilitator | `GET /facilitator/health`, `GET /facilitator/supported`, `POST /facilitator/verify`, `POST /facilitator/settle` |
| dashboard feed | `GET /api/ledger` |
| CORS | `access-control-allow-origin: *`, `OPTIONS` preflight allows `content-type, x-payer, x-payment` — a browser on any origin can pay, and `x-payer` is allowed so browser payers are not forced onto one shared `anonymous` identity |

The whole rail is usable with nothing running locally. Ask unpaid and you get a
standard x402 402; settle a confidential transfer into the offered one-time
account; retry the same URL with `X-PAYMENT` and read the resource:

```bash
# 1) ask unpaid — 402 with a one-time payTo, price and extra.privacy
curl -i "https://veil-devnet.vercel.app/v1/oracle/tide?nonce=1" -H "X-Payer: my-agent"

# 2) retry the same URL + nonce with the x402 v2 payload
curl -i "https://veil-devnet.vercel.app/v1/oracle/tide?nonce=1" \
  -H "X-Payer: my-agent" -H "X-PAYMENT: <base64 x402 v2 payload>"
```

`?nonce=` identifies one payment (keep it unique; a retry of a settled nonce is
`409 payment-already-settled`, and a non-integer nonce is `400 invalid-nonce`).
`X-Payer` names the buyer so a retry gets its own seat back. Both are settable
cross-origin. `/.well-known/veil` is the discovery document an agent reads first.

It runs on Vercel's free Hobby tier (no card), so the hosted rail costs **$0**;
the only spend in this project is the SOL on chain. A real payment was settled
end-to-end **through the hosted facilitator** on the primary rail, devnet:
[`2kmv4tYaDGWt2AdEE7wd194R2Zd7AfP9iqgNuci7uVuXPV7ZeMGCHuir7Jm5foZEJFTUY9f7sTphDdMiv64thYRr`](https://explorer.solana.com/tx/2kmv4tYaDGWt2AdEE7wd194R2Zd7AfP9iqgNuci7uVuXPV7ZeMGCHuir7Jm5foZEJFTUY9f7sTphDdMiv64thYRr?cluster=devnet) —
payer funded itself, proved locally, `/verify` → `/settle` against the public URL,
merchant decrypted 49000 with its own key. The same was proven on testnet:
[`3L47ttQouoXWxu8Y7AZcKPH6FX6T6tvhG9upj5yRQK84PrqEf8HuKMrWa3BcEbNkuoAcuTfeFJ83h4ToxZ6AXKoy`](https://explorer.solana.com/tx/3L47ttQouoXWxu8Y7AZcKPH6FX6T6tvhG9upj5yRQK84PrqEf8HuKMrWa3BcEbNkuoAcuTfeFJ83h4ToxZ6AXKoy?cluster=testnet).

#### Two deployments — devnet is the primary rail

The same repository is deployed twice — once per cluster — because a rail's
ledger is only meaningful on the chain its payers are actually on. Every link on
the site and in the docs points at **devnet**, the rail a user should pay into:

| cluster | deployment | network id on the wire |
| --- | --- | --- |
| devnet (primary) | https://veil-devnet.vercel.app | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| testnet | https://veil-sable-five.vercel.app | `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` |

Both are the same code path; `VEIL_NETWORK` and `VEIL_RPC_URL` are the whole
difference. The seed is cluster-aware (`scripts/hosted.ts` picks
`pool-ledger.devnet.json` on devnet), so the devnet rail never offers a testnet
seat it cannot be paid into.

#### The hosted ledger is durable, and now shared

A serverless function's disk is read-only except `/tmp`, and `/tmp` belongs to
one instance. That made the ledger per-instance memory: a seat consumed here was
forgotten by the next cold start, which re-seeded from the bundle, and a caller
could walk a pool to exhaustion within one instance's lifetime. Chain balances
were never affected — this was accounting, not money — but "which seats are
spent" depended on which instance answered, and a quote and its payment could
land on two different ones.

The ledger now lives in **Upstash Redis**, read and written over its HTTP REST
API (`scripts/ledger-store.ts`). Three things make it correct rather than merely
persistent:

- **One key per cluster** (`veil:pool-ledger:v1`, `…v1.devnet`). Two pools under
  one key would collide on `alias#slot`, and the devnet rail would overwrite
  testnet's seats.
- **Merge, then compare-and-set.** Consumption is monotonic — `consumedBy` only
  goes from null to a payment id, `settledAt` is written once — so a concurrent
  write loses nothing: the stored value plus ours *is* the union. `save` reads,
  merges, and CASes in Lua, retrying if another instance moved the value first.
- **Read-through on the request path.** A durable ledger that is only read at
  cold start is still a snapshot, so every quote and settlement calls
  `facilitator.refresh()` first. Load-time also merges the store's consumption
  over the bundle's *structure*, so a redeploy that armed more seats grows the
  pool instead of shrinking back to the first write.

`GET /v1/health` reports which of the two it is (`ledger: durable-store` vs
`local-file`), so a deployment with no credentials degrades visibly rather than
silently. With neither `UPSTASH_REDIS_REST_URL` nor `UPSTASH_REDIS_REST_TOKEN`
set, nothing changes: the rail keeps the `/tmp` copy it always had.

A payment may also adopt a seat that is still free when the instance answering
it never saw the quote's reservation — refusing there would take a real payment
into the merchant's own account and record nothing. A seat a *different* payment
already owns is still refused, which is the relinking the pool exists to
prevent.

#### RPC providers

| cluster | endpoint | why |
| --- | --- | --- |
| testnet | `https://api.testnet.solana.com` | public — neither provider below runs a testnet node |
| devnet | Helius (`HELIUS_API_KEY`), else `https://api.devnet.solana.com` | free tier, hosted, no card |
| mainnet | Solami (`SOLAMI_API_KEY`), else Helius | free tier, hosted, no card |

Resolution order is `--rpc` → `VEIL_RPC_URL` → Solami → Helius: a configured
endpoint always wins because it names the cluster the deployment is really on.

[Helius](https://www.helius.dev) serves **devnet and mainnet only** —
`testnet.helius-rpc.com` does not resolve and the provider's docs list two
clusters — so with `HELIUS_API_KEY` set and no `VEIL_RPC_URL`, devnet runs use a
dedicated node instead of the rate-limited public one, and a testnet rail keeps
its own endpoint rather than being pointed at a chain Helius does not run.

[Solami](https://solami.dev) serves Solana on **mainnet-beta only** — its cluster
route accepts `solana` and nothing else, and query params cannot change it
(`?network=devnet` is ignored and the endpoint still answers with mainnet's
genesis hash). It sits ahead of Helius in the chain, so a mainnet rail with
`SOLAMI_API_KEY` set is unchanged; setting either key is a configuration change,
not a code change.

```bash
# the same run against the hosted facilitator (no local child process):
VEIL_RPC_URL=https://api.testnet.solana.com VEIL_NETWORK=solana:testnet \
  VEIL_FACILITATOR_URL=https://veil-devnet.vercel.app/facilitator \
  npm run pay:live -- --apply

# redeploy after a change:
npm run build:api && npx vercel deploy --prod --yes
```

Environment (all set in the Vercel project, `VEIL_PAYER_SECRET` as a Secret from
`.keys/payer.json` — `.vercelignore` keeps `.keys/` out of the deploy):
`VEIL_NETWORK`, `VEIL_RPC_URL`, `VEIL_MINT`, `VEIL_DECIMALS=6`,
`VEIL_MINT_CONFIDENTIAL=true` (without it the gate refuses with `VEIL-CONF-003`),
`VEIL_PAYER_SECRET`.

The hosted function derives its own origin from the request (`Host` +
`x-forwarded-proto`), so `resource.url` in every offer is the public
`https://veil-devnet.vercel.app/...` a client can fetch back — no base URL to
configure.

Two things a hosted run has to admit:

- **The ledger is durable, not automatic.** Seat consumption is shared through
  Upstash when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set,
  and `/v1/health` says which mode it is in. Without them the rail falls back to
  a per-instance `/tmp` copy seeded from `data/pool-ledger.json`, which is what
  the tests and a local run use. Chain balances are unaffected either way —
  every seat address and balance is on chain.
- **`vercel curl` cannot POST** (GET only) and project protection adds a checkpoint
  in front of a browser, so the checks above are plain `curl` against the
  production alias with protection disabled.

## Honest limits

These are the real ones, and they are stated here rather than buried.

**The live runs move one size.** Every run pays the demo ticket amount, 49000
atomic units, into a fresh one-time seat — on testnet and on devnet, both with the
operator's own key (`go:live`) and with an independent payer through the x402
facilitator (`pay:live`). What no run exercises is *many concurrent payers*: the
pool is 24 seats on testnet and 3 on devnet, seats are never reused, and the
public RPC is rate-limited. A busy rail needs the pool grown
(`npm run setup:devnet -- --apply` adds and approves) and a paid endpoint.

**All 24 testnet pool accounts are approved.** The backfill pass in `setup:devnet`
approved the 23 that predate the fix — 4 transactions, no new accounts, no rent.
The devnet pool was created after the fix, so every seat is approved at creation.

**The default ledger is cluster-aware.** `data/pool-ledger.json` holds the 24-seat
testnet pool; `data/pool-ledger.devnet.json` holds devnet's 3. Nothing ties the
file to a cluster, so `npm run status --chain` used to pair the devnet RPC with
the testnet file and report 24 accounts of which 0 could receive confidentially —
reading, in effect, as a broken deployment, while devnet was 3/3 healthy. Scripts
now pick the cluster's own ledger when a tagged file exists, and an explicit
`--ledger` or `VEIL_LEDGER` still wins (the hosted rail pins its file that way).

**Quoting spends a seat — retries used to, and no longer do.** A price is an offer
to settle, so the server reserves a one-time account *before* it quotes, and
reservations are never recycled: reusing one would put two payments on the same
public address. A retry of the same payment identity (`x-payer` + `?nonce`) now
gets its own account back instead of consuming a second one — before that fix,
eight unauthenticated GETs drained an alias's pool and the rail answered
`VEIL-CONF-005` to everyone on that instance. A caller that deliberately varies
the nonce still can walk through a pool; the only answers are a bigger pool
(`npm run setup:devnet -- --apply`). On the hosted rail the consumed seat is now
recorded in the durable ledger, so growth is the only answer there too rather
than "wait for the next cold start". A nonce that is not a non-negative integer
is refused with `400 invalid-nonce` rather than being allowed to collapse two
different callers onto one payment id. An identity that has *already settled* is
reported spent (`409 payment-already-settled`, naming when) instead of being
offered its own address again: the ledger refuses to count one address twice, so
a second payment into it would move funds that never get credited. A second
payment takes a second nonce.

**`go:live` refreshes its source account every run** rather than reusing one, which
costs about 0.003 SOL of rent per run and leaves the previous source behind. That is
the right trade for a script that has to start from a known balance, and the wrong
shape for a payment rail.

**Proofs are generated locally, and that is now measured** — see
`npm run prove:check` (13 checks, real proof generators, real refusal cases) and
`npm run prove:browser` (18 checks against the built browser artifact). Earlier
versions of this section claimed the JS toolchain could only *verify* proofs; that
was wrong, and it is worth saying plainly because it changed the trust model of the
whole design.

**Confidential keys derive from a wallet signature** over `"solana-conf-bal/v1"` and
are never stored. If the wallet is lost, the balances are unrecoverable. That is a
property of the extension, not a choice made here.

**Configuring a confidential account requires the owner's signature**, so it cannot
happen per payment. Hence a pre-created pool of N accounts, which is a real
operational cost: pool accounts are rent-exempt token accounts, and the pool must be
grown rather than recycled, because re-arming a consumed address would relink exactly
the two payments the pool exists to separate.

**Public RPC is rate-limited, and this run found out the hard way.**
`api.testnet.solana.com` answers `429` under a burst, and the live sequence is eight
transactions with reads between them. `go:live` now retries reads, spaces
transactions apart, and polls confirmations slowly — each poll is a request against
the same budget. A server holding per-request pool state is cheap; a design that
re-reads the chain per request needs a paid endpoint.

**The program is not audited.** Confidential Balances is a real, deployed Solana
token extension, but nothing here should hold value without an audit.

---

## Testing

```bash
npm run test        # 115 unit + integration tests, no network
npm run typecheck
npm run verify      # both
```

The suite is behavioural rather than snapshot-based, and several tests exist
specifically to pin a privacy or accounting invariant:

- two payments to the same merchant never share a destination address
- a consumed address is never offered again, even after settlement
- a settled account cannot be settled twice (a retry cannot double-count)
- `settleable` decides without mutating, so a broadcast can be gated on it
- a hand-edited ledger claiming an unarmed slot settled is rejected on load
- a duplicate address in the ledger is rejected — two aliases would be linkable
- `toAtomic` refuses precision it cannot represent exactly
- `parsePaymentRequired` rejects an offer whose privacy claim it cannot check
- the HTTP facilitator returns 402 with no `accepts[]` when it refuses
- a payer naming another merchant's account is rejected
- the server never fabricates a settlement when it cannot broadcast

`scripts/demo-local.ts` runs the ten hardest of these against a **real ephemeral
HTTP server** on a random port and prints a pass/fail table.

---

## Design system

`DESIGN.md` is the source of truth (five token groups, spec format). Every text and
ground pair in it was measured: the palette carries its contrast ratios as comments,
and `web/assets/tokens.css` restates them with the measurement. An automated
contrast sweep found the original palette asserting ratios its own tokens did not
meet — `warning` at 3.20:1, `error` at 4.34:1 — so the semantic colours were
re-derived and a dedicated `redact-fill` token was added for white-on-red surfaces.
`redact-fill` is the only red a white label may sit on, at 6.08:1 on both grounds.

Type, spacing, radii and motion are the other four groups. There is exactly one
authored motion moment — the redaction lift, a 320 ms stagger on
`cubic-bezier(.22,1,.36,1)` — and it is suppressed under `prefers-reduced-motion`,
which also removes the bars' hatch so they read as solid blocks instead.

Text layout uses [Pretext](https://github.com/gsvhq/pretext) vendored into
`web/assets/pretext.js`, so the dashboard's refusal panel computes its own height on
resize and the prose genuinely flows around it rather than reserving a column.

---

## Stack

Node 22+ with native TypeScript execution (no build step). Zero-runtime-dependency
protocol core. `@solana/kit` 8.4, `@solana-program/token-2022` 0.19,
`@solana-program/zk-elgamal-proof` 0.4, `@solana/zk-sdk` 0.5 for the WASM proofs.
`@x402/core` and `@x402/svm` 2.28 are used for type compatibility; Veil's own
protocol core deliberately does not depend on them, so the 402 body can be read in
one sitting.

Note: `@solana/spl-token` has virtually no support for the confidential-transfer
instructions. The dependency spine is `@solana-program/token-2022` and
`@solana/zk-sdk`, and that is not interchangeable.

MIT.
