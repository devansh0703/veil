# TODOS

Deferred work from the [CEO plan review](docs/plans/veil-ceo-review.md) (HOLD SCOPE, 2026-10-02).
Deferred means postponed, not rejected. Each item is non-blocking for the 2026-10-12 submission.

**Design surfaces:** the four user-facing surfaces the UI spec calls for are built and verified —
see T-2. Design artifacts (self-contained offline snapshots + metadata) live under
`.gstack/projects/devansh/designs/<screen>-20261002/`.

---

## T-1 — Take-rate / pricing model

**What:** Decide and document how Veil charges (0.5-1% of settled volume vs a flat monthly dashboard fee).
**Why:** The submission is judged on Viability. A number on a slide is stronger than "we'll figure it out," and the choice determines whether the dashboard is the product or a freebie.
**Pros:** Strengthens the Viability criterion; forces the buyer question (merchant vs agent operator) to be answered in writing.
**Cons:** Depends on demand evidence nobody has yet; a wrong number on a slide is worse than a stated plan to test.
**Context:** Blocked on the Assignment from the design doc (three x402 merchants on the record). Do not invent a price before those three answers exist.
**Effort:** human: S / CC: S
**Priority:** P2
**Depends on:** merchant outreach answers (design doc Assignment)

---

## T-2 — Landing page beyond the minimum — ✅ DONE 2026-10-02

**What:** Design and build a real landing page beyond claim + video embed + verify link.
**Why:** Communication is a scored criterion and judges open the URL on phones.
**Outcome:** Built as one of four surfaces in the `/design-html` pass, not just the landing. The product now ships `web/index.html` (poster hero + two-window demo as the hero asset), `web/dashboard.html` (merchant ledger, two totals, refusal panel), `web/limits.html` (the honest-limits surface as a real page), and `web/402.html` (facilitator body, machine + human legible). All four share `assets/tokens.css`, `assets/app.css`, `assets/veil.js` and a self-hosted `assets/fonts.css`. Verified at 375/768/1440 with Chromium via Playwright: 12/12 pages with zero horizontal overflow, zero page errors, all five font faces resolved, `window.Pretext` live.
**Precise detector result:** `counted: 0` on every page, exit 0. Advisory findings were 1 on `index`/`limits`/`402` and 2 on `dashboard`, and all are accepted with a reason recorded in `finalized.json`: the redaction bar's hatch (a pattern `DESIGN.md` specifies) and the em-dash density in the dashboard body copy (the house parenthetical device, 13 instances, worth watching). Four further advisory colour findings were *not* accepted — they were the undocumented `prefers-contrast:more` ramp, which is now named in `DESIGN.md` as four contrast tokens.
**Still open from this item:** the demo *video* (the landing currently argues with a static two-window composition plus a live control, which is legible but is not the recorded run the review scoped).
**Effort:** human: M / CC: S
**Priority:** P3
**Depends on:** demo video existing

---

## T-3 — More than two merchants in the demo

**What:** Extend the demo harness to 3+ merchants.
**Why:** Proves the graph claim generalizes beyond a pair.
**Pros:** Stronger evidence for CS3.
**Cons:** Each extra merchant multiplies RPC calls against a 40-req/10s single-method devnet limit, risking the recording.
**Context:** Two merchants already prove the claim (a repeated counterparty would show up). Add more only if rate-limit headroom is measured and comfortable.
**Effort:** human: S / CC: S
**Priority:** P3
**Depends on:** T8 (RPC budget) from the review

---

## T-4 — Mint-per-merchant vs shared mint at production scale

**What:** Decide the mint topology for more than one merchant, and implement onboarding for it.
**Why:** The auditor ElGamal key is global per mint, so a shared mint means one auditor secret can decrypt every merchant's transfers.
**Pros:** Makes the per-merchant privacy claim structurally true at scale.
**Cons:** Mint creation becomes part of merchant onboarding, which adds a real step to the "one-line integration" wedge.
**Context:** The review resolved the *reconciliation* path (merchant decrypts its own recipient ciphertext) so the global auditor key is no longer on the critical path. The remaining question is how many merchants can share one test-dollar mint before the auditor key becomes a shared secret. Decide with real users, not now.
**Effort:** human: M / CC: M
**Priority:** P2
**Depends on:** T2 (mint init) landing in the demo build

---

## T-6 — Demonstrate on-chain execution on a funded devnet keypair — ✅ DONE 2026-10-03

**What:** Run the real confidential transfer path end to end: fund a devnet keypair, initialise the mint with the confidential-transfer extension, create and arm a pool, then broadcast a genuine private payment and read the ciphertext back.
**Outcome:** Closed on both clusters, not just devnet. The devnet pool is 3/3 armed (`data/pool-ledger.devnet.json`) and the testnet pool 24/24 (`data/pool-ledger.json`); `npm run status --chain` reports "A server may report privacySource: chain" for each, from a bare command, because the default ledger is now cluster-aware. A real payment settled through the **hosted** facilitator on testnet — [3L47ttQ…](https://explorer.solana.com/tx/3L47ttQouoXWxu8Y7AZcKPH6FX6T6tvhG9upj5yRQK84PrqEf8HuKMrWa3BcEbNkuoAcuTfeFJ83h4ToxZ6AXKoy?cluster=testnet) — with four earlier devnet/testnet transfers recorded in README. The funding blocker this item named turned out to be solvable with a faucet or transferred lamports; the proving routine was never the constraint.
**Effort:** human: S (fund one address) / CC: M
**Priority:** closed
**Depends on:** nothing

<details><summary>Original blocked statement, kept for the record</summary>

**Why:** This is the one gap this build could not close, and it is the gap a judge is most likely to probe. The instruction layer, the refusal policy and the facilitator are all verified; the broadcast is not.
**Pros:** Turns the strongest claim ("every number traces to a live devnet transaction") from *architected* into *demonstrated*, and closes CEO gap A1 and eng AR1/AR2.
**Cons:** Blocked by a concrete environment fact rather than by effort — devnet's faucet requires GitHub authentication, no funded keypair exists on this machine, and each pool account needs rent. Needs either a human to fund one address, or a paid-RPC-free funding route.
**Context:** `npm run status -- --chain` already reads devnet for real and prints the four conditions and which is unmet (`mint exists on devnet: false`, `accounts that can read confidentially: 0`). That command is the acceptance test for this item: it should report `true`/non-zero when it is done.

**Corrected 2026-10-02:** this item previously claimed the proving routines live in the Rust prover and that the JS toolchain could only verify. That was wrong. `npm run prove:check` demonstrates 13 measured facts including real proof generation: `new PubkeyValidityProofData(kp)` yields a 96-byte proof and `new ZeroCiphertextProofData(kp, ct)` a 192-byte one, both self-verifying on construction, both surviving a byte round-trip, and both correctly *rejecting* the inputs they must reject. Decryption is confirmed too — own key reads the amount exactly, a foreign key is refused outright. So the on-chain path is implementable end to end from Node, and the only blocker is lamports for fees and rent. The obstacle is funding, not capability, which is a materially different and much smaller problem.
</details>

---

## T-8 — Per-instance pool memory on the hosted rail — **CLOSED**

**What:** Give the hosted rail one durable ledger instead of a per-instance `/tmp` copy seeded from the bundle.
**Why:** Each warm instance re-seeds from the inlined ledger, so a consumed seat is remembered only by the instance that consumed it, and a deliberate caller can walk a pool to exhaustion per instance (readme documents both). Chain balances are unaffected — this is accounting memory, not money — but "already settled" and "which seats are spent" answers differ depending on which instance answers.
**Done:** `scripts/ledger-store.ts` keeps the ledger in Upstash Redis over its HTTP REST API (one key per cluster, `veil:pool-ledger:v1[.devnet|.mainnet]`), with a merge + compare-and-set write so two instances settling at once lose no seat. `loadLedgerFor` merges the store's consumption over the bundle's structure, so a redeploy that armed new seats grows the pool rather than shrinking back to the first write, and the request path reads through (`facilitator.refresh()`) before every quote and settlement so a reservation made by one instance is visible to the next. `flush()` writes to the store when configured and the file when not, and `/v1/health` reports `durable-store` vs `local-file` so the difference is visible rather than silent. Verified against the real Upstash account (GET/SET/EVAL incl. the CAS) and covered by tests that stand a Redis stub in front of the store to force a lost race on demand.
**Also:** A settlement may now adopt a seat that is still free when the instance answering the payment never saw the quote's reservation — refusing there would take a real payment into the merchant's own account and record nothing. A seat a *different* payment already owns is still refused, which is the relinking the pool exists to prevent.
**Remaining (not needed for the above):** a truly simultaneous quote racing on the same free seat is still decided by whichever instance writes last; closing it means an atomic reserve in the store rather than an atomic save.

---

## T-7 — Standalone artifacts in the verification path

**What:** Run `npm run standalone` as part of `npm run verify`, and screenshot the standalone files in the same Playwright sweep as `web/`.
**Why:** The self-contained artifacts are what gets handed to someone who will not clone the repo. They are generated, not hand-maintained, so they cannot drift in content — but nothing currently fails if the generator itself breaks.
**Pros:** Cheap. The generator already asserts two invariants (`window.Pretext` survives inlining, no HTML tag leaked into the inline script) precisely because both failed once during this build.
**Cons:** Adds ~1s to the verify loop and four more screenshots.
**Context:** Two real bugs came out of this path already: `String.replace` expanding `$&` inside the minified Pretext bundle (which injected a literal `</body>` into a JavaScript expression and silently disabled all text layout), and the four undocumented contrast literals. Both were found by running the artifact in a browser rather than by reasoning about it.
**Effort:** human: XS / CC: XS
**Priority:** P2
**Depends on:** nothing

---

## T-5 — Public volume leaderboard

**What:** A public page showing total volume settled privately through Veil.
**Why:** Distribution and social proof; a merchant-facing funnel.
**Pros:** Free marketing surface; gives the "traction" number a home.
**Cons:** A privacy product shipping a public volume counter is an obvious tension and needs a carful design (aggregate only, opt-in).
**Context:** Rejected for this build as an expansion under HOLD SCOPE. Worth revisiting only after the product is real, and only with the aggregation design settled first.
**Effort:** human: M / CC: S
**Priority:** P3
**Depends on:** real settled volume existing

---

## 2026-10-05 — Batched confidential x402 plan (design: docs/designs/veil-2026-batched-confidential.md)

Deferred from the /office-hours 2026 session. Full plan in the design doc; nothing here changes existing features. Order is fixed: deliverables (1-10) → 2026 features (F1-F6) → further user ideas.

- **D-1..D-9 (P1):** remaining deliverables on the stable rail — verify-integration, rpc-budget doc, replay command, structured logs + assertion counter, 50-payment smoke, hostile-QA test, glossary, runbooks, dashboard pending column.
- **D-10 (P1, last):** demo video, recorded after D-1..D-9 land.
- **F1 (P1):** `batch-confidential` scheme — session escrow + signed cumulative vouchers + one confidential settlement per session into a pooled seat. Headline feature; stock batch settlement is public-chain-only, this composition is novel.
- **F2 (P1):** txv1 (SIMD-0385) single-transaction confidential settlement path; legacy multi-tx flow kept as fallback. Gate verified ACTIVE on devnet (slot 493,742,080).
- **F3 (P2):** x402 V2 header support (PAYMENT-SIGNATURE / PAYMENT-REQUIRED / PAYMENT-RESPONSE) alongside V1 X-PAYMENT, negotiated per request.
- **F4 (P2):** name the moat in docs: stock facilitators structurally cannot verify confidential transfers (published Sep 2026 audit); Veil's verifier asserts proof inclusion + merchant-only decryption.
- **F5 (P2):** `docs/notes/confidential-liquidity-2026.md` — PYUSD/USDG auto_approve=false, USDC/USDT/EURC not extension-capable, wrap-mint route; feeds T-4 mint-topology inputs.
- **F6 (P2):** session receipts — per-session reconciliation artifact (voucher head, merchant-decrypted total, settled seat).
