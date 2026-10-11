# Go-to-market, demand validation, and distribution

Colosseum's portal asks for three things here: a go-to-market strategy, evidence
of demand validation, and a plan for developing distribution. The honest version
of the first is a wedge and a sequence; the honest version of the second is that
**it has not been run yet**, and saying so is worth more than a constructed
number. The third is real today and is the part with receipts.

---

## 1. The wedge

**A merchant adds one settlement address and one wrapper. Nothing else changes.**

x402's seller quickstart is *your API + a receive address + the middleware
pointed at the facilitator*. Veil keeps that sentence and drops one clause: the
facilitator runs in the same process, so there is no facilitator URL to
configure. What a merchant supplies is a wallet to be paid at and a price:

```ts
const merchant = await veil({
  payTo: process.env.VEIL_PAY_TO,
  price: '0.01',
  path: '/api/insight',
  produce: ({ paid }) => ({ insight: 'the thing you paid for', paid }),
});

app.get('/api/insight', merchant.handler);
```

That is the entire integration. `node examples/merchant.ts` runs exactly it. The
first run provisions the one-time seat pool and records it; later runs reuse it.
The request and response bodies stay standard x402 — the 402 carries the ordinary
`accepts[]` shape with `scheme: "exact-confidential"`.

**Why the wedge is the integration and not the cryptography.** Privacy is only
interesting here if adopting it costs a merchant almost nothing. Any design that
requires a merchant to rewrite payout logic produces zero measurable traction in
a hackathon window — and traction is a scored criterion. The cryptography is
Solana's; the product is the facilitator and the fact that adopting it is a diff,
not a migration.

## 2. Who pays, and for what

Two candidate buyers, with the case for each stated as a hypothesis rather than a
finding:

| Buyer | Their pain | Why they might pay |
|---|---|---|
| **The merchant** (primary) | Per-client revenue is public, so pricing power leaks at every renewal; competitors can read the book | The dashboard is a reconciliation tool they need anyway, and the confidentiality is a property of the rail they already use |
| **The agent operator** | Their vendor list, spend curve and per-vendor price are a public research stack | It is their strategy that is being published, and the fix is one budget-checked client call |

The design is merchant-first: a merchant has revenue to protect and a bookkeeping
need that a dashboard serves. The buyer has the sharper pain but no bookkeeping
need, which makes them a harder first sale.

**Business model: not decided, and deliberately so.** The two live options are a
take rate on settled volume (0.5–1%) and a flat monthly fee for the dashboard and
auditor workflow. The choice depends on which buyer answers first, and inventing
a number before those answers exist would put a fabricated figure in the
submission. It is tracked as `TODOS.md` T-1, blocked on the demand test below.

## 3. Demand validation — the honest state

**No users. No revenue. No merchant conversation yet.**

What is real and checkable:

- **The protocol has distribution without us.** x402 is governed by the Linux
  Foundation (operational 14 Jul 2026) with Google, Visa, Mastercard, Stripe,
  Cloudflare, Anthropic, AWS, Microsoft, Circle, the **Solana Foundation** and
  Shopify. TRM measured ~198.9M settlement transactions and ~$52.7M moved
  (PYMNTS, 15 Sep 2026). This is a market already transacting on the exact rail
  privacy is being added to.
- **The leak is named in public writing, not invented here.** "All x402 payments
  are permanently visible on-chain…" — and TACEO, an independent team building
  confidential x402 on Base, published the same "what stays public" table we do
  (sender, receiver, frequency, timing). Three separate teams independently
  concluding this matters is evidence of a real problem, not proof of a market.
- **The structural reason it is a new problem:** the average ticket is ~$0.31
  (TACEO, 12 May 2026). Card networks cannot serve that size — which is why x402
  exists — and no heavyweight privacy chain can either, because the privacy cost
  per transaction would exceed the transaction. Solana's ~1/1000th-of-a-cent fee
  is what makes per-call private settlement economically possible at all.

**What is missing, and it is the most important thing on this page:** the
**Assignment** from the design doc. Find three live x402 merchants and ask each
one question, in their Discord or via their contact endpoint:

> "Your x402 revenue per client is public on-chain. Is that something you'd want
> private, and would you pay for it?"

Three answers, any three. A yes is a design partner to name. **A no is a more
valuable finding than a yes** — it moves the wedge to the agent-operator side and
the plan should change accordingly rather than defend itself.

**The red flag, flagged by us:** "everyone's payments are public" is a true
observation and a real pain, but *"will someone pay to fix it"* is unproven.
Some merchants treat public volume as a traction flex for their own fundraising;
if that is the majority, the merchant is not the buyer. Two recent Colosseum
winners (MCPay, Mercantill) were agent-payments infrastructure, which says the
category is judge-legible — not that privacy specifically sells.

**What would falsify the plan:** three merchants saying the exposure is fine, or
that they would only adopt if it were free. Either moves the product to the
buyer side and changes the dashboard from a merchant reconciliation tool into an
agent-side spend console.

## 4. Distribution — what exists today

This is the part with real artifacts behind it.

| Channel | Status | Artifact |
|---|---|---|
| **Hosted rail** | live | `https://veil-devnet.vercel.app` — the product page, a 402 offer with a real seat (`GET /v1/oracle/tide`), the facilitator (`/verify`, `/settle`), and `/.well-known/veil` discovery |
| **Discovery document** | live | `GET /.well-known/veil` returns scheme, mint, every resource with an absolute `url` and price, the privacy gate source, and the refusal catalog — what an agent reads first |
| **Docs set** | shipped | quickstart, concepts, API reference, troubleshooting keyed to every error code, and a verify-it-yourself walkthrough |
| **Merchant scaffold** | shipped | `node scripts/create-merchant.mjs my-api` writes a runnable Express merchant whose whole integration is one wrapped handler |
| **Agent sandbox** | shipped | `npm run sandbox -- --key .keys/agent.json` — key, SOL, confidential account, test dollars and an applied balance in one command |
| **CLI** | shipped | `veil init --sandbox`, `balance`, `pay`, `doctor`, `scaffold`, with a non-interactive `--ci` mode |
| **Verification tool** | shipped | `npm run replay -- <signature>` — the trust artifact, and the thing that makes every other claim checkable |
| **Repository** | public | MIT, `https://github.com/devansh0703/veil`, CI green |
| **npm package** | **not published** | `veil-x402` is scaffolded but not on the registry yet; the scaffold points at a working copy with a `file:` dependency. Publishing is the next distribution step and is stated as missing rather than implied |
| **Videos** | shipped | pitch + technical demo, captioned, in `video/` |

**Time-to-first-private-payment is the metric to move.** The DX review set the
target at **≤ 5 minutes** from `npm i` to a first confidential payment, against an
estimated 15–25 minutes before the sandbox existed. The sandbox and the scaffold
are what close that gap. Champion (< 2 min) was explicitly rejected as dishonest:
configuring a confidential account requires the owner's signature, so a sub-2-min
claim would be the kind of overclaim this project's own rules forbid.

## 5. How distribution deepens after the hackathon

In order, cheapest and most verifiable first:

1. **Publish `veil-x402` to npm.** Removes the `file:` dependency from the
   scaffold and makes the one-line integration real for a stranger. Smallest
   change with the largest reach.
2. **Run the Assignment.** Three merchants, one question. Everything downstream —
   pricing, the buyer, the dashboard's shape — is blocked on it.
3. **Grow the devnet pool and add a paid RPC.** The pool is 256 seats on devnet;
   the public RPC is rate-limited, and `docs/notes/rpc-budget.md` records the
   measured calls-per-payment. A busier rail needs both.
4. **Open the batch-session scheme for review.** `docs/notes/svm-batch-binding.md`
   is written in the spec's own section order so a standards reader can check it
   against the requirement it answers; the natural next step is a PR against
   `x402-foundation/x402`.
5. **Merchant-of-record (Approach C) stays the 12-month destination.** Buyers pay
   Veil, Veil settles out to merchants from a pooled account, and the graph is
   hidden completely rather than statistically. It is fully custodial, which is a
   legal and trust problem rather than an engineering one, and it would sink a
   ten-day build. It is in the roadmap because it is where the take-rate position
   actually lives.

## 6. Where the defensibility actually lives

**Not in the cryptography.** The confidential-transfer primitives are Solana's,
and if the x402 spec absorbs confidential settlement, that part is not ours.

What survives is:

- **The facilitator** — stock x402 facilitators structurally cannot verify a
  confidential transfer (the SVM exact scheme needs a readable `TransferChecked`
  with a plaintext amount and a public balance delta; a confidential transfer
  fails all three). This is now documented publicly in a Sep 2026 audit, which
  means judges and competitors have read it too. It is the pitch, and it is not a
  secret.
- **The refusal policy** — a rail that will not quote a settlement it cannot make
  private is a product decision, not a primitive.
- **The auditor workflow and the dashboard** — the reconciliation surface a
  business needs, and the compliance SKU.
- **The trust architecture** — an SSRN study (Aug 2026) measured x402 settlement
  routing as concentrated in a handful of facilitators. A concentration of
  settlement is a concentration of trust, and a self-hostable, independently
  verifiable rail is the structural answer. `npm run replay` is that answer in one
  command, and it is the one thing here that cannot be copied by adding a feature.

## 7. Why now

Three things changed in 2026 and all three point the same way:

- **Confidential Balances were re-enabled on Solana mainnet in June 2026** after a
  year-long security pause and a Code4rena audit. The primitive is new enough that
  most x402 builders have not looked at it.
- **x402 batch settlement shipped 11 May 2026** — buyers commit capital once and
  every call carries a signed cumulative voucher. Veil's `batch-confidential`
  scheme adds the confidential redemption upstream's SVM binding does not
  specify, so per-call amounts never reach public state at all.
- **txv1 / SIMD-0385 raised the transaction size cap from 1,232 to 4,096 bytes**
  (mainnet 15 Sep 2026), collapsing the multi-transaction proof-record dance into
  a single transaction. The legacy path is kept as a fallback.

A privacy rail for agent payments is only buildable on a chain with sub-cent
fees, and only *interesting* once the payment protocol is big enough that the
public ledger becomes competitive intelligence. Both became true this year.
