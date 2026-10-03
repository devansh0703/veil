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

## T-6 — Demonstrate on-chain execution on a funded devnet keypair

**What:** Run the real confidential transfer path end to end: fund a devnet keypair, initialise the mint with the confidential-transfer extension, create and arm a pool, then broadcast a genuine private payment and read the ciphertext back.
**Why:** This is the one gap this build could not close, and it is the gap a judge is most likely to probe. The instruction layer, the refusal policy and the facilitator are all verified; the broadcast is not.
**Pros:** Turns the strongest claim ("every number traces to a live devnet transaction") from *architected* into *demonstrated*, and closes CEO gap A1 and eng AR1/AR2.
**Cons:** Blocked by a concrete environment fact rather than by effort — devnet's faucet requires GitHub authentication, no funded keypair exists on this machine, and each pool account needs rent. Needs either a human to fund one address, or a paid-RPC-free funding route.
**Context:** `npm run status -- --chain` already reads devnet for real and prints the four conditions and which is unmet (`mint exists on devnet: false`, `accounts that can read confidentially: 0`). That command is the acceptance test for this item: it should report `true`/non-zero when it is done.

**Corrected 2026-10-02:** this item previously claimed the proving routines live in the Rust prover and that the JS toolchain could only verify. That was wrong. `npm run prove:check` demonstrates 13 measured facts including real proof generation: `new PubkeyValidityProofData(kp)` yields a 96-byte proof and `new ZeroCiphertextProofData(kp, ct)` a 192-byte one, both self-verifying on construction, both surviving a byte round-trip, and both correctly *rejecting* the inputs they must reject. Decryption is confirmed too — own key reads the amount exactly, a foreign key is refused outright. So the on-chain path is implementable end to end from Node, and the only blocker is lamports for fees and rent. The obstacle is funding, not capability, which is a materially different and much smaller problem.
**Effort:** human: S (fund one address) / CC: M
**Priority:** P0 — highest-value remaining item before submission
**Depends on:** a funded devnet keypair

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
