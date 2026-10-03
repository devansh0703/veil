# Veil

[![CI](https://github.com/devansh0703/veil/actions/workflows/ci.yml/badge.svg)](https://github.com/devansh0703/veil/actions/workflows/ci.yml) [![Deployed](https://img.shields.io/badge/live-veil--sable--five.vercel.app-2f855a)](https://veil-sable-five.vercel.app)

**Private payment rails for the agent economy.**

**Live rail: [https://veil-sable-five.vercel.app](https://veil-sable-five.vercel.app)** —
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
npm run verify     # typecheck + 115 unit tests, no network
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

### What both clusters cost

| cluster | started | left | spent | where it went |
| --- | --- | --- | --- | --- |
| testnet | 5.0000 SOL | 4.8051 SOL | ≈ 0.195 SOL | 24-seat pool + mint + go:live / pay:live fees |
| devnet | 5.0000 SOL | 4.9828 SOL in the two wallets | ≈ 0.017 SOL | ≈ 0.0169 rent (mint, 3 seats, 2 run accounts — reclaimable by closing) + ≈ 0.0003 in fees |

### The rail, hosted — https://veil-sable-five.vercel.app

The merchant server and the facilitator are not just local processes. The same
code runs behind public HTTPS:

| | |
| --- | --- |
| product page | https://veil-sable-five.vercel.app/ |
| merchant health | `GET /v1/health` → 200, pool size + settlement mode |
| a 402 offer | `GET /v1/oracle/tide` → 402 with a live seat, price and testnet CAIP-2 (same for `/v1/quote/feedmarket`, `/v1/attest/sensor`) |
| facilitator | `GET /facilitator/health`, `GET /facilitator/supported`, `POST /facilitator/verify`, `POST /facilitator/settle` |
| dashboard feed | `GET /api/ledger` |
| CORS | `access-control-allow-origin: *` with `OPTIONS` preflight — a browser on any origin can pay |

It runs on Vercel's free Hobby tier (no card), so the hosted rail costs **$0**;
the only spend in this project is the SOL on chain. A real payment was settled
end-to-end **through the hosted facilitator** on testnet:
[`3L47ttQouoXWxu8Y7AZcKPH6FX6T6tvhG9upj5yRQK84PrqEf8HuKMrWa3BcEbNkuoAcuTfeFJ83h4ToxZ6AXKoy`](https://explorer.solana.com/tx/3L47ttQouoXWxu8Y7AZcKPH6FX6T6tvhG9upj5yRQK84PrqEf8HuKMrWa3BcEbNkuoAcuTfeFJ83h4ToxZ6AXKoy?cluster=testnet) —
payer funded itself, proved locally, `/verify` → `/settle` against the public URL,
merchant decrypted 49000 with its own key.

```bash
# the same run against the hosted facilitator (no local child process):
VEIL_RPC_URL=https://api.testnet.solana.com VEIL_NETWORK=solana:testnet \
  VEIL_FACILITATOR_URL=https://veil-sable-five.vercel.app/facilitator \
  npm run pay:live -- --apply

# redeploy after a change:
npm run build:api && npx vercel deploy --prod --yes
```

Environment (all set in the Vercel project, `VEIL_PAYER_SECRET` as a Secret from
`.keys/payer.json` — `.vercelignore` keeps `.keys/` out of the deploy):
`VEIL_NETWORK`, `VEIL_RPC_URL`, `VEIL_MINT`, `VEIL_DECIMALS=6`,
`VEIL_MINT_CONFIDENTIAL=true` (without it the gate refuses with `VEIL-CONF-003`),
`VEIL_PAYER_SECRET`.

Two things a hosted run has to admit:

- **The ledger is per-instance.** Seat reservations live in `/tmp`, seeded from
  `data/pool-ledger.json` on cold start, so a new instance starts from the
  committed pool again. Chain balances are unaffected — every seat address and
  balance is on chain — but seat *consumption* is not shared across instances.
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
