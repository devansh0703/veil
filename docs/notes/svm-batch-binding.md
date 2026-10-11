# SVM binding for x402 batch settlement — confidential redemption

**Status:** authored 2026-10-12 · implements `batch-confidential` in `packages/server/src/batch.ts`
**Spec parent:** x402 Batch Settlement (x402.org/x402-batch-settlement, May 11, 2026; `specs/schemes/batch-settlement/scheme_batch_settlement.md`)
**Trust model:** capital-backed
**Chain:** Solana (SVM), Token-2022 Confidential Balances

The x402 batch-settlement scheme is chain-abstract: it defines Commit → Accumulate →
Redeem and delegates the per-chain specifics to a *network binding*. Each section
below is named exactly as the spec names it, because a binding is only conformant if
a reader can map it to the requirement it answers.

**An earlier revision of this file claimed the published reference binding was EVM and
that no SVM binding existed. That was wrong, and §0 corrects it.** The claim was checked
against the upstream repository on 2026-10-12 and the correction is recorded rather than
quietly overwritten, because the same mistake is the one this project's own rules warn
about: a wrong limit reads as "impossible" and stops work that was available.

## 0. Relationship to the published SVM binding (corrected 2026-10-12)

Upstream **does** publish an SVM binding. It has since 2026-08-21.

| | Upstream SVM binding | This document |
|---|---|---|
| File | `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md` | this file |
| Size / identity | 99,062 bytes, blob `ccf228fd4ddbea3f00b65e03824b6a50772f4aad` (verified 2026-10-12) | — |
| Backing | a **payment-channels program**: `open`/`deposit` lock escrow in a channel account | a **pre-armed seat pool**: Token-2022 accounts that already exist and are owned by the merchant |
| Commitment | Ed25519 cumulative voucher over `maxClaimableAmount`, verified on chain through the Ed25519 precompile | Ed25519 cumulative voucher, verified **off chain** by the merchant at charge time (`veil-batch-voucher-v1`, §1) |
| Redemption | program `settle` advances a **public** `settled` watermark, then `distribute` pays the delta in SPL or Token-2022 | **one `exact-confidential` payment**: the session total lands as an ElGamal ciphertext (§6) |
| Amount on chain | **plaintext** — `settled` and the distributed delta are public values | ciphertext; only the merchant's key reads it |
| Expiry | vouchers never expire (`expiresAt` fixed at `0`); the channel's forced-close path bounds the commitment | a session TTL bounds it, and late charges are refused (§5) |
| Token-2022 | supported as a **mint owner** (`tokenProgram`: "SPL Token or Token-2022 program that owns `asset`") | used for its **confidential-transfer instruction family** |
| Wire compatibility | — | **none.** Nothing here is byte-compatible with upstream's payment-channels program; this is a sibling binding, not an implementation of theirs |

The confidential gap in the upstream binding is checkable, not asserted: over that blob's
text, `grep -in 'confidentialTransfer\|ElGamal\|confidential'` returns **no matches**.
Token-2022 appears four times, and every one is a mint owner, never an instruction family —
`asset` ("Concrete SPL / Token-2022 mint pubkey") and `tokenProgram` ("SPL Token (`Tokenkeg…`)
or Token-2022 (`TokenzQ…`) program that owns `asset`") in §4.1, and `token_program` in the two
runtime account tables ("Onchain owner of `mint`; supported SPL Token or Token-2022 program").
Verified 2026-10-12 against the raw file at the sha above.

**So the claim this project may make is narrower than the one it was making.** Not "the
first SVM batch-settlement binding" — that slot is upstream's, and it is filled. The
checkable claim is: *the first SVM batch **redemption** that settles as a Token-2022
confidential transfer*, with the divergences above stated in the same breath. Anything
stronger would be a claim about someone else's work that we have not verified.

Upstream's own §8 is worth quoting for the same reason — it is honest about a mode that is
not private from the *operator* either: "Operator delegation is explicit and high trust …
The operator can therefore take up to the full deposit without another client signature",
and "Metered server pricing assumes an honest operator." Our §7 states the equivalent risk
for this binding in the same terms.

A conformance checklist is included at the end, and `packages/server/src/batch.test.ts`
**reads this file** and asserts every mandated section is present — so this document
is verified rather than asserted, in the same way the rail's other claims are.

---

## 1. Commitment format

A commitment is a **cumulative signed voucher**: the payer's ed25519 signature over a
four-part, length-prefixed encoding.

```
veil-batch-voucher-v1
u32be(len(sessionId))  sessionId   (utf8)
u32be(len(seq))        seq         (decimal ASCII, e.g. "3")
u32be(len(total))      total       (decimal ASCII atomic units, e.g. "147000")
```

- `sessionId` — 32 hex characters, opened once per session by the merchant.
- `seq` — 1-based, strictly increasing by exactly one per charge.
- `total` — the **cumulative** amount owed for the whole session so far, in atomic
  units of the settlement mint, as a decimal string (never a float, never a JSON
  number: money does not round).

Field lengths are prefixed so no two distinct vouchers can serialise to one byte
string — a bare concatenation would let `("ab","c")` and `("a","bc")` collide, and a
signature over a collision is a signature over two different commitments. The domain
tag stops a voucher signature from ever being reinterpretable as a transaction
signature or any other signature the same key produces.

On the wire the commitment travels as base64 of JSON, in the `X-VOUCHER` request
header:

```json
{ "voucher": { "sessionId": "…", "seq": 3, "total": "147000" },
  "signature": "…base64 ed25519…" }
```

Why cumulative rather than per-charge: the merchant only ever needs the *latest*
voucher to redeem, a dropped voucher costs nothing because the next one carries the
whole total, and an old voucher is detectable by its sequence instead of having to be
tracked as spent. It also keeps the hot path stateless — the voucher carries the
session's accumulated value, so no per-charge log has to be reconstructed to decide
whether a call is covered.

**The commitment is off-chain and carries no transaction.** This is the privacy
upgrade over stock batch settlement: per-call usage is a signature, so nothing about
per-call amounts, counts or timing is written to public state.

## 2. Verification rules

The merchant verifies a voucher **offline**, with no chain lookup, on the charge path.
The x402 batch post's "speed of HTTP" claim is a property of the scheme; keeping it
required rejecting every design that would have needed a read to decide whether to
serve.

In order, all of which must hold:

1. **Shape.** `sessionId` is a non-empty string, `seq` a safe integer ≥ 1, `total` a
   decimal-string of digits, `signature` a non-empty base64 string. Anything else is
   refused without interpretation.
2. **Signature.** ed25519 verify over §1's encoding, against the raw 32-byte public
   key recorded when the session was opened. A failed verification is a refusal.
3. **Session identity.** `voucher.sessionId` equals the session's own id.
4. **Sequence monotonicity.** `seq == headSeq + 1`, exactly. A repeat is a replay of a
   served call (`stale-seq`); a jump would let one signature cover charges nobody
   vouched for (`gap-seq`).
5. **Coverage.** `total ≥ served + price(resource)`, where `served` is what the
   merchant has actually handed over and `price` is the merchant's own price for the
   resource being called. The signature proves *who* committed; this proves *how much*
   was committed for this call.
6. **Cap.** `total ≤ cap`, the ceiling the payer set at session open.

`served` and the voucher `total` are deliberately separate numbers. `served` is the
merchant's accounts-receivable; the voucher total is what the payer authorised.
Collapsing them is how a receipt lies: showing only the voucher total overstates
revenue when a payer over-signed, and showing only `served` hides how much of the
authorisation was drawn down.

Refusals are stable, machine-readable codes (`underpaid`, `stale-seq`, `gap-seq`,
`over-cap`, `bad-signature`, `session-expired`, `session-closed`, `unknown-session`),
each returned with a sentence naming what the payer should do differently. A
malformed voucher is a 402 with a reason, never a 500.

## 3. Storage behaviour

Merchant-side, in memory, per session: id, payer identity, payer public key, alias,
cap, `headSeq`, `served`, the head voucher, open/expiry timestamps, and state.

- **No hot-path chain lookups.** Redemption is the only step that touches the chain.
- **No payer-side state is required.** The payer stores its own sequence and running
  total; the merchant's copy is a check, not a requirement for the payer to proceed.
- **Sessions are hot-path state and are declared as such.** This binding does not
  specify a distributed session store. A session opened on one instance is not visible
  to another, and a voucher presented to an instance that does not hold the session is
  refused as `unknown-session` — a refusal that tells the payer to retry against the
  instance that opened it, rather than a wrong answer derived from unverified state. A
  multi-instance deployment puts this behind the same store interface the seat pool
  uses; the *rules* stay in one place, exactly as the pool's rules live in `PoolLedger`.
- **Durability of the redemption**, not of the session, is what matters: the receipt and
  the settlement row outlive the process, and the money is on chain either way.

## 4. Double-spend prevention

Four mechanisms, in order of what they protect:

1. **Sequence monotonicity** (§2.4) stops a served call being charged twice inside one
   session.
2. **One redemption per session.** A settled session refuses every later voucher
   (`session-closed`) and every later redemption attempt (HTTP 409 with the receipt).
   A late voucher after redemption is a double-spend attempt, not a late arrival.
   `BatchSessionManager.settle` returns `null` for a session that is not open, so a
   second redemption cannot overwrite the first receipt with a second one.
3. **The seat pool's compare-and-set.** The redemption pays into a fresh one-time seat
   from `PoolLedger`, whose `claim`/`settleable` pair refuses a seat already consumed by
   a different payment and refuses settling the same seat twice. Two redemptions of the
   same session cannot land in one seat, and one seat cannot be credited twice.
   This is the same atomic record the arXiv replay taxonomy (2605.11781, attack II)
   names as the strongest available defence: one captured payment cannot be redeemed
   for a second grant.
4. **Resource binding.** Every payment and voucher names the resource it was signed
   for, and the rail refuses one presented against a different resource
   (`VEIL-CONF-007`). The seat ledger alone would not catch this — a payment replayed
   at another endpoint is a *different* payment identity, and therefore a different
   seat — so the binding is the check that closes it.

A replay of a captured voucher is refused by (1); a replay of a captured redemption is
refused by (3); a redirect of either to another endpoint is refused by (4).

## 5. Expiry

A session opens with a TTL (default 3600 s) and an explicit `expiresAt`. After it,
`get` marks the session `expired` and every charge is refused as `session-expired`.
Expiry bounds the merchant's exposure: the session's cap stops being a live claim on
future service, and a payer that abandoned a session does not leave an open-ended
authorisation behind.

- **Late charges are refused, not served** — an expiry the merchant silently honours
  after the fact is not an expiry.
- **Expiry does not move money.** It is one-sided: nothing was charged to the chain
  before redemption, so there is nothing to reverse. A session that expires with
  charged calls and no redemption is an unpaid receivable, and the merchant's remedy is
  its own business relationship with the payer — this binding deliberately does not put
  a mechanism between them.
- **Redemption after expiry is a policy choice left to the merchant**, and the
  reference implementation refuses it with the rest: an expired session is not open, so
  `settle` returns `null`. A merchant that wants to honour a late redemption can extend
  the TTL before it elapses; the binding's rule is that the *client-visible* state must
  match whatever the merchant does.

## 6. Redemption

Redemption is **one ordinary `exact-confidential` payment** for the voucher head's
cumulative total, into a fresh one-time seat, through the same verify/settle path every
per-call payment uses.

```
POST /v1/sessions/{sessionId}/settle      (no payment)  → 402 + one `accepts[]` entry
POST /v1/sessions/{sessionId}/settle      (PAYMENT-SIGNATURE) → 200 + receipt
```

What that composition buys, and why it is the whole point of binding to this chain:

- The redemption **inherits every existing guarantee** without a line of new settlement
  code: the confidentiality gate (mint + destination preconditions), the transaction
  reading (the signed bytes must contain a Token-2022 confidential transfer), the
  resource binding, the seat pool, and the refusal catalog.
- The amount that lands on chain is the **session total only**, and it lands as an
  ElGamal ciphertext under the merchant's key. Per-call amounts never exist in public
  state at all — they are voucher signatures.
- The transfer's proofs are verified **by the chain** (the `zk-elgamal-proof` program),
  not by an MPC cluster, an FHE coprocessor, or any other operator set. There is no
  threshold to trust and no gateway to be online. See `/.well-known/veil` → `trust`.
- When the txv1 gate is live (SIMD-0385, mainnet since 2026-09-15) the redemption fits
  in one ≤4,096-byte transaction. The legacy multi-transaction proof-record path
  remains as a fallback; nothing is deleted.

The redemption payment is bound to the settle path (`/v1/sessions/{id}/settle`), so a
payment built for a session cannot be spent on a resource and vice versa.

### Receipt (the merchant's reconciliation artifact)

The response to a successful redemption carries, and `GET /v1/sessions/{id}` retains:

| Field | Meaning | Who can check it |
|---|---|---|
| `voucherHead` | the payer's signed final commitment | anyone — re-verify the signature |
| `totalDecimal` | what the voucher authorised | the payer agrees by construction |
| `servedDecimal` | what the merchant actually served | the merchant's books |
| `calls` | how many calls the session carried | merchant |
| `seat` | the one-time account the value landed in | anyone — it is on chain |
| `signature` | the settlement transaction, or `null` | anyone, on an explorer |
| `settlementMode` | `rpc` or `local-ledger-only` | the rail's own mode, stated |

`settlementMode` is not decoration: a receipt from a chain-free run says so, so a
receipt can never be mistaken for a chain fact. The merchant decrypts its own balance
to confirm the amount — the one thing nobody else can do, and the reason the privacy
claim is merchant-only rather than universal.

## 7. Trust model

**Capital-backed.**The spec's two options are capital-backed (trust anchored in
the client's own on-chain funds) and credit-backed (a network intermediary underwrites, and
the client needs no on-chain capital). Veil is capital-backed, and there is absolutely **no intermediary** anywhere in it:

- **The escrow is real and pre-existing.** The one-time seats in the pool are armed
  token accounts on chain, created by the merchant, and their contents can only be
  moved by the merchant's authority. The merchant is not extending credit — it is
  drawing against accounts that already exist.
- **The payer's ceiling is the payer's signature.** The cap is enforced from the
  voucher, signed by the payer's key, and it is the *only* authority that raises the
  session's value. A merchant cannot charge a session past what the payer signed.
- **The merchant carries the risk of unpaid service, not the payer.** Between
  redemption points the merchant has served calls against a signature. That is the
  capital-backed bargain in the spec's own terms: no third party stands behind it.
- **No underwriter, no operator set, no gateway.** Other confidential x402 designs
  delegate the privacy to an operator set: TACEO Merces secret-shares the real amount
  3-of-3 with an MPC network (whose public material says balances are "known only to the
  MPC network"); PrivateX402's proofs are "generated by the TEE or ZK prover", currently
  a TEE; Fhenix's route is an FHE coprocessor. Those are sourced in
  `docs/notes/x402-2026-landscape.md`, quoted from each project's own material, and this
  document does **not** claim they fail — only that each requires you to trust an operator
  set that this binding does not have. Here the chain's own Token-2022 program verifies
  the transfer's proofs, and the redemption is re-derivable by anyone from public state
  (`npm run replay`, 7 assertions). The trust anchor is the program binary.
- **The one thing a reader should not take on faith** is that the redemption above is what
  actually happened. That is what `npm run replay` exists for: give it the signature and it
  reads the chain, not us. It reports `INFO` for anything it cannot answer rather than
  scoring it as a pass or a failure — a tool that failed a payment for being another
  deployment's seat would be asserting something it cannot know.

**What stays public**, stated as plainly as the limits page does: the seat address of
the redemption, the mint, the transaction's existence and timing, and the fact that a
session redeemed. Amounts and balances are ciphertexts; the account graph is not
hidden by Confidential Balances, only the values. Veil's one-time seat pool breaks the
per-payment graph linkage; it does not hide that a merchant was paid, or when.

## Conformance checklist

| Spec requirement | Where it is specified | Verified by |
|---|---|---|
| Commitment format | §1 | `canonicalVoucher` + `batch.test.ts` "a voucher signs the length-prefixed bytes…" |
| Verification rules | §2 | `verifyVoucher`, `BatchSessionManager.charge` + the six rule tests |
| Storage behaviour | §3 | `BatchSessionManager`; the `unknown-session` HTTP test |
| Double-spend prevention | §4 | seq tests, `session-closed`, `PoolLedger.claim/settleable`, `VEIL-CONF-007` test |
| Expiry | §5 | the TTL/clock test |
| Redemption | §6 | the end-to-end HTTP session test (charge → redeem → receipt → second redeem refused) |
| Trust model | §7 | `/.well-known/veil` → `trust`; the `local-ledger-only` receipt assertion |
| Section presence | this file | `batch.test.ts` "all seven mandated sections are present" |
| Relationship to the upstream SVM binding, and every divergence from it | §0 | the table in §0 — sources in `docs/notes/x402-2026-landscape.md`; the upstream blob is named by sha so the gap claim can be re-checked |

### What this binding does not claim

- **Not wire-compatible with upstream's SVM binding.** A payer or facilitator speaking
  upstream's payment-channels protocol cannot settle against this rail, and vice versa.
  Adopting this binding means adopting this rail, for now.
- **Not "the first SVM binding".** Upstream publishes one (§0), and its revocation and
  recovery story is more complete than ours: it has `request_close`, a grace period,
  `seal`, `refund` and `reclaim`. This binding has expiry and a merchant-side policy, and
  says so in §5 rather than implying a recovery mechanism it lacks.
- **Not private from the merchant.** The merchant decrypts its own balance; that is the
  point of the design, and it means per-call amounts are known to the party being paid.
