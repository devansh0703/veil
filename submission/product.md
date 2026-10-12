# Veil — submission form answers

The Colosseum product-submission portal asks a fixed set of questions. These are
the answers, written out in full so they can be pasted rather than improvised at
the deadline. Every factual claim here traces to a file in this repository or to
a live transaction with an explorer link.

---

## Form-ready answers

**Project name**

> Veil

**Brief description** — 491 characters, measured (limit 500)

> Veil makes the amount of an agent payment private. A conformant x402 facilitator
> on Solana, settling in Token-2022 Confidential Balances: amounts are ciphertext
> on chain, and each payment lands in a fresh one-time seat, so two payments to
> one merchant never share an address. Solana's own program verifies the proofs -
> no MPC cluster or enclave to trust. The rail refuses rather than downgrade to a
> public transfer. Live on devnet, MIT licensed, re-derivable from chain state in
> one command.

**Category** — one only

> **Payments & Remittance**

**Why that category.** Veil's literal function is settling payments: x402 is a
payments protocol and the product is a payment rail. The category's judges assess
settlement, fees, integration and compliance, and this project is strong on all
four — real settlements on two clusters with explorer links, ~1/1000th-of-a-cent
fees, a one-line merchant integration, and an auditor key for the compliance
path. The privacy is then a *differentiator inside payments* rather than the
whole category, which is the better relative position: a payments judge compares
this to public payment rails and finds it strictly better, where a privacy judge
would compare it to anonymity networks and find it lacking.

**Where the choice is weakest, stated plainly.** "Remittance" implies
cross-border person-to-person transfers; this is machine-to-machine API payments,
so a narrow reading of the category sees a mismatch. There is no "machine
payments" category, so Payments is the nearest home rather than a perfect one.

**The runner-up: Developer Infrastructure**, which is the cleaner literal fit —
the wedge *is* a drop-in facilitator, and the deliverables are an SDK, a CLI, a
scaffold and a docs set. It was not chosen because it undersells Novelty/Insight,
which is where the confidential-settlement primitive does the work: in Developer
Infrastructure this reads as another x402 facilitator, in Payments it reads as
the one whose amounts cannot be read.

**Categories deliberately avoided:**

| Category | Why not |
|---|---|
| Identity & Privacy | The honest limits are a strength in Payments and a weakness here. This project is explicitly *not* an anonymity network, and it says so in `README.md`: addresses, mint and timing stay public. |
| AI Platforms / Agents | Veil serves agents but is not an agent platform; the category would overclaim. |
| ZK / Crypto Research | Uses zero-knowledge proofs; produces no research. |
| Stablecoins | Settles in a self-issued test dollar, but that is the substrate, not the product. |
| FinTech | Broader and bank-shaped; Payments & Remittance is the precise fit. |

---

## Portal questions, answered

The second page of the submission form asks six more fields. All are written to
fit their character counters, measured rather than estimated.

**Project website**

> https://veil-devnet.vercel.app

**What are you building, and who is it for?** — 993/1000

> Veil is a payment rail for AI agents that keeps the amount private.
>
> x402 is how an agent pays for an API call with no account and no human. Every
> payment it settles is a permanent public record: who paid whom, how much, how
> often, at what price. For an agent operator that record is their research stack.
> For a merchant it is their book of business.
>
> Veil is a drop-in x402 facilitator that settles in Solana's Token-2022
> Confidential Balances instead of a plain transfer. The amount becomes ciphertext
> on chain, and each payment lands in a fresh one-time account, so two payments to
> the same merchant never share an address. The merchant still reconciles to the
> cent with its own wallet key. If the rail cannot demonstrate a payment will be
> confidential, it refuses to quote rather than fall back to a public transfer.
>
> Two buyers: the merchant, who loses pricing power at every renewal while
> per-client revenue is public, and the agent operator, whose vendor list is public
> on any explorer.

**Why did you decide to build this, and why build it now?** — 987/1000

> I already build x402 handlers, and the leak is not a bug in the protocol. A
> public ledger is what makes settlement auditable, so it is the design.
>
> Three things changed. Solana re-enabled Token-2022 Confidential Balances on
> mainnet in June 2026 after a year-long audit pause, putting ElGamal encryption
> and zero-knowledge proofs inside the token program. x402 batch settlement
> shipped in May, keeping per-call amounts off-chain. txv1 raised the transaction
> size cap in September, collapsing a four-transaction proof dance into one.
>
> So the primitive is new, the protocol is large enough that the ledger is
> competitive intelligence, and nobody had combined them. Three other teams ship
> confidential x402, all on EVM, each asking you to trust an operator set: TACEO
> on MPC, PrivateX402 in a TEE, Fhenix on FHE. None is on Solana, where the
> chain's own program verifies the proofs.
>
> Privacy is the one part of agent payments where a new entrant can be
> structurally better, not just cheaper.

**What technologies are you using or integrating with to build your product?**

> **Solana.** Token-2022 Confidential Balances is the settlement primitive: the
> three zero-knowledge proofs (ciphertext-commitment equality, batched grouped
> ciphertext validity, batched u128 range) are generated client-side by WASM
> inside `@solana/zk-sdk` and verified on chain by the `zk-elgamal-proof` program.
> `@solana/kit` for RPC and transaction building, `@solana-program/token-2022` for
> the confidential-transfer instruction family, `@solana-program/zk-elgamal-proof`
> for verification. txv1 (SIMD-0385) for single-transaction settlement, gated on
> runtime feature detection. The Ed25519 precompile verifies batch-session
> vouchers at redemption.
>
> **Protocol.** x402, both V1 (`X-PAYMENT`) and V2 (`PAYMENT-SIGNATURE` /
> `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`), negotiated per request. `@x402/core`
> and `@x402/svm` 2.28 for type compatibility; the protocol core is written from
> scratch with zero runtime dependencies so the 402 body can be read in one
> sitting.
>
> **Runtime and hosting.** Node 22+ with native TypeScript execution, no build
> step for the product. Vercel Hobby for two deployments, one per cluster.
> Upstash Redis over its HTTP REST API for the durable shared seat ledger.
> Helius free tier for a devnet RPC node. GitHub Actions for CI.
>
> **Developer tools.** TypeScript 5.7 and esbuild (the browser prover artifact and
> the Vercel function bundles), Node's built-in test runner (210 tests),
> Playwright-driven headless Chromium for the browser checks, ffmpeg for the video
> encodes, HyperFrames for the two submission videos, fontTools for converting the
> wordmark to vector outlines.
>
> **AI tools.** Claude with the gstack skill suite for plan review (CEO,
> engineering, design, developer-experience) and the recorded QA pass. Kokoro-82M
> run locally for the video narration, so no service is in the loop. Hermes Agent
> for session orchestration. Web research for the 2026 protocol landscape, with
> every external claim tied to a dated primary source in
> `docs/notes/x402-2026-landscape.md`.

**Which chains does your product use?**

> **Solana** only. Nothing else is integrated.

**How does your product use these chains?** — 487/500

> Solana is the settlement layer and trust anchor.
>
> Payments settle as Token-2022 confidential transfers (family 27, op 7) against a
> self-issued test-dollar mint we own, so we control Confidential Balances and the
> auditor policy. Solana's token program verifies the proofs, so no MPC cluster,
> enclave or coprocessor is trusted.
>
> Each payment lands in a fresh pre-armed account, never reused, so two payments
> to one merchant never share an address. The same code runs on devnet and
> testnet.

---

## Product name

**Veil**

## One-line description

Private payment rails for the agent economy: a conformant x402 facilitator that
settles in Solana Token-2022 Confidential Balances, so an agent's payment amount
is ciphertext on chain and a merchant's per-client revenue stops being public.

## Longer description

x402 gave AI agents a way to pay for an API call with no account, no API key and
no human. It left three things on a public ledger: the amount, the counterparty,
and the pattern of who pays whom and how often. On a chain, that is the whole
customer record. A trading desk's agent buying twelve data feeds has published
its research stack; a merchant's per-client revenue is readable by every buyer
before a renewal negotiation starts.

Veil closes that gap using two primitives that already exist on Solana, not a
mixer and not a promise:

| Layer | Primitive | What it hides |
|---|---|---|
| Amount | Token-2022 **Confidential Balances** (native ElGamal + ZK proofs) | transfer amounts and account balances |
| Graph | **One-time seats** from a pre-created, pre-armed pool | which payments belong to the same buyer, and how many there were |

Neither layer is invented here. The first is a Solana token extension; the second
is account hygiene. What Veil adds is a facilitator that **refuses to serve a
payment it cannot make private** — `VEIL-CONF-003`, with no `accepts[]` entry at
all, rather than a quiet downgrade to a public transfer.

What Veil deliberately does **not** claim: anonymity. Token account addresses,
the mint and the timing stay public — Confidential Balances encrypts the *fields*,
not the *existence* of an account. The merchant ledger prints every destination
address rather than hiding it, because hiding it would misrepresent where the
boundary actually is. At low volume, timing correlation remains possible. All of
this is stated on the product's own limits page, and again in both videos.

**The differentiator is not the word "privacy".** Three other teams ship
confidential x402 (TACEO Merces on MPC, PrivateX402 in a TEE, Fhenix on FHE), and
each delegates its privacy to an operator set a replay tool cannot audit. Veil's
claim is re-derivable from public chain state by a stranger, using a command
shipped in the repository:

```bash
npm run replay -- <transaction signature>
```

Seven assertions, read from the chain rather than from our database, exit code
significant.

## Blockchains and tools integrated

**Chain.** Solana — testnet and devnet, both live. No other chain is used.

| Cluster | Deployment | Network id on the wire |
|---|---|---|
| devnet (primary) | https://veil-devnet.vercel.app | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| testnet | https://veil-sable-five.vercel.app | `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` |

**Solana primitives used**

- **Token-2022 Confidential Balances** — the settlement asset. Instruction family
  27, operation 7 (`ConfidentialTransfer`). Self-issued test-dollar mint
  `H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p`, created by this project so the
  confidential-transfer extension and the auditor-key policy are ours to set.
- **Zero-knowledge proofs** — ciphertext-commitment equality, batched grouped
  ciphertext validity, and a batched u128 range proof, generated **client-side**
  by WASM inside `@solana/zk-sdk`. No prover service is called.
- **zk-elgamal-proof program** — verifies the three proofs on chain.
- **Instructions sysvar** — the token program reads each proof at a signed offset.
- **txv1 / SIMD-0385** — the single-transaction settlement path, gated on runtime
  feature detection (gate `txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL`).
- **Ed25519 precompile** — verifies batch-session vouchers on chain at redemption.
- **Associated token accounts + rent** — the one-time seat pool.

**Protocol**

- **x402** — the 402 / `X-PAYMENT` flow, V1 and V2 (`PAYMENT-SIGNATURE` /
  `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`) negotiated per request.
- **x402 batch settlement** (May 2026 scheme) — implemented as the additive
  `batch-confidential` scheme, with a spec-shaped SVM binding authored here
  (`docs/notes/svm-batch-binding.md`).

**Tools and infrastructure** (all free tier, zero paid services)

| Need | What is used |
|---|---|
| Runtime | Node.js 22+ with native TypeScript execution — no build step for the product |
| SDKs | `@solana/kit` 8.4, `@solana-program/token-2022` 0.19, `@solana-program/zk-elgamal-proof` 0.4, `@solana/zk-sdk` 0.5, `@x402/core` + `@x402/svm` 2.28 |
| Hosting | Vercel Hobby (two projects, one per cluster) |
| Durable ledger | Upstash Redis over its HTTP REST API |
| RPC | public devnet/testnet endpoints, Helius free tier on devnet |
| CI/CD | GitHub Actions → Vercel auto-deploy on merge to `main` |
| Video | HyperFrames (HTML → MP4) with local Kokoro-82M narration |
| Browser QA | headless Chromium (Playwright-driven checks, gstack QA pass) |

## Teammates

**Solo entry.** One builder.

| | |
|---|---|
| Name / handle | `devansh0703` |
| Role | Everything — protocol design, the Solana integration, the facilitator, the CLI, the four web surfaces, the videos |
| Contact | `devansh0703` on GitHub (the address on the commits is the GitHub noreply) |
| Previous experience | Not stated here to avoid an unverifiable claim; the repository is the evidence — the commit history, the decision docs under `docs/plans/` and `docs/designs/`, and the recorded transactions are what a judge can actually check |

*Colosseum requires every teammate to register separately and the team leader to
add them during submission. With a solo entry there is one registration.*

## Location

**India** (IST, UTC+05:30).

## Logo

`brand/veil-logo.svg` (primary, on paper), `brand/veil-logo-dark.svg` (on
graphite), `brand/veil-mark.svg` (square mark), plus PNG exports in `brand/png/`.

The mark is a **V** whose right half is a redaction bar — the product's own claim
applied to its own name: you can see that something is there, and you cannot read
it. One red (`#B4341F`, the redaction ink), 2–4px radii, no gradients, no
shadows. Colours and geometry come from `DESIGN.md`, and the wordmark is real
vector outlines, not font-dependent text, so the file renders identically
anywhere.

## GitHub repository

**https://github.com/devansh0703/veil** — **public**, MIT licensed.

```
git clone https://github.com/devansh0703/veil
cd veil && npm install
npm run verify        # typecheck + the full test suite, no network
npm run demo          # 10 protocol scenarios over real HTTP, then render the pages
```

## The two videos

| | Path | Length |
|---|---|---|
| Pitch (problem, product, proof, vision) | `video/veil-video/renders/veil-pitch.mp4` | 113 s |
| Technical demo (architecture, integration, decisions) | `video/veil-demo/renders/veil-demo.mp4` | 167 s |

Both are 1920×1080, narrated, captioned, and cut against measured audio. The
read-aloud scripts with per-scene timings are in `docs/video-scripts.md`.

## Verified, on chain

Every number in the submission traces to a transaction. A sample:

| What | Cluster | Transaction |
|---|---|---|
| Operator end-to-end run | testnet | [`38FFhzJGbY4Rdt52fFgHujf5aymk8NRiGdbANbX3YmmeF4sbb6ByGBcKJqfzNbaMRqygSNxc8wziZCjC4tZc17tt`](https://explorer.solana.com/tx/38FFhzJGbY4Rdt52fFgHujf5aymk8NRiGdbANbX3YmmeF4sbb6ByGBcKJqfzNbaMRqygSNxc8wziZCjC4tZc17tt?cluster=testnet) |
| Independent payer via the facilitator | testnet | [`64pgyaE6WPsrNueCKt788w81yBafB5WPmu55AbQykBzp9zwjF5XFXpW4dDBnAFfuSCT6qHFj67A5Y7kEE7MahsUQ`](https://explorer.solana.com/tx/64pgyaE6WPsrNueCKt788w81yBafB5WPmu55AbQykBzp9zwjF5XFXpW4dDBnAFfuSCT6qHFj67A5Y7kEE7MahsUQ?cluster=testnet) |
| Through the **hosted** facilitator | devnet | [`2kmv4tYaDGWt2AdEE7wd194R2Zd7AfP9iqgNuci7uVuXPV7ZeMGCHuir7Jm5foZEJFTUY9f7sTphDdMiv64thYRr`](https://explorer.solana.com/tx/2kmv4tYaDGWt2AdEE7wd194R2Zd7AfP9iqgNuci7uVuXPV7ZeMGCHuir7Jm5foZEJFTUY9f7sTphDdMiv64thYRr?cluster=devnet) |
| Batch-session redemption | devnet | [`53pN4tq487McwLmaRSFxBA5dnhztxPJv5DwsdFgCLG3ri9y41KV6ZiSbfdUVit7fkVmbPUyMEBoHx8SetmFqg8tf`](https://explorer.solana.com/tx/53pN4tq487McwLmaRSFxBA5dnhztxPJv5DwsdFgCLG3ri9y41KV6ZiSbfdUVit7fkVmbPUyMEBoHx8SetmFqg8tf?cluster=devnet) |

The full set, with what each one proves, is in `README.md`.

## What is not true yet

Stated because a judge will find it, and a submission that says it first is worth
more than one that is caught:

- **No users, no revenue.** Zero. There is no traction number to show.
- **The demand test is unrun.** The design doc's Assignment — three x402 merchants
  on the record answering "is your public per-client revenue something you'd pay
  to fix?" — has not been done. This is the weakest joint in the plan and it is
  named in `submission/go-to-market.md` rather than buried.
- **The program is not audited.** Confidential Balances is a real, deployed Solana
  token extension; nothing here should hold value without an audit.
- **Mainnet is untested.** Every run is devnet or testnet. `README.md` documents
  the spend on both clusters and the RPC limits that bound a busier rail.
