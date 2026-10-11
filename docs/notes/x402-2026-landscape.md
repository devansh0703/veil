# The 2026 x402 landscape — primary sources, verified 2026-10-05, re-verified 2026-10-12

This is the evidence register for the plan in `docs/designs/veil-2026-batched-confidential.md`.
Every claim in that doc traces to a dated primary source listed here. All findings are
read-only research; none are local measurements.

**2026-10-12 pass:** the batch-settlement repository, the four binding files, the competitor
articles and the adoption tracker were re-read today. One finding (N1) **changed an answer we
had already written down** — the SVM binding exists — so N1 is corrected in place with the
evidence, and N7 now holds the may-claim/may-not-claim register. Two standing claims (the
TACEO eprint number and the SSRN abstract) were **not** re-read today and are marked as such.

## Verified claims (already in the plan)

| # | Claim | Status | Primary source | Date |
|---|---|---|---|---|
| 1 | x402 batch settlement is a real official scheme | VERIFIED | x402.org/x402-batch-settlement/ (launch post); docs.x402.org/schemes/batch-settlement; x402-foundation/x402 spec `specs/schemes/batch-settlement/scheme_batch_settlement.md` | May 11, 2026 |
| 2 | txv1 (SIMD-0385): max tx 1,232 → 4,096 bytes; Confidential Transfers named beneficiary | VERIFIED | solana.com/upgrades/larger-transaction-sizes; solana-foundation/transaction-v1-examples README; solanacompass (mainnet Sep 15, 2026) | Sep 15, 2026 (mainnet) |
| 3 | Stock facilitators cannot verify confidential transfers (SVM exact scheme) | VERIFIED | llm4agents.com/blog/solana-confidential-transfers-x402-audit ("Solana confidential transfers are back. x402 cannot see them.") | Sep 19, 2026 |
| 4 | x402 V2: PAYMENT-SIGNATURE / PAYMENT-REQUIRED / PAYMENT-RESPONSE headers | VERIFIED | x402.org/x402-v2-launch/ ("Removes deprecated X-* headers... Uses more modern PAYMENT-SIGNATURE, PAYMENT-REQUIRED, PAYMENT-RESPONSE") | Dec 11, 2025 |
| 5 | PYUSD carries confidential transfers on Solana | VERIFIED | PayPal developer blog + Solana issuer guide; PYUSD auto_approve=false (issuer approval per account) — confirmed in the issuer guide's approve-policy section | 2024→2026 |
| 6 | x402 Foundation operational under Linux Foundation | VERIFIED | linuxfoundation.org press, operational launch | Jul 14, 2026 |
| 7 | USDC/USDT/EURC not extension-capable (plain SPL mints) | VERIFIED | Solana issuer guide (extension matrix); no confidential-transfer integration announced | current |

## New findings from this session (not previously in any Veil doc)

### N1 — CORRECTED 2026-10-12: the SVM binding exists, and it is not confidential

> This finding replaces an earlier version of this section which claimed "No SVM binding is
> published". **That was wrong.** Upstream added an SVM binding on 2026-08-21, and it is in
> the repository today. The correction is kept visible because the wrong claim was a limit
> that would have supported a claim about our own work ("the first SVM binding") that the
> facts do not support.

Verified 2026-10-12 by fetching the repository tree and the file itself:

The spec's model is: client commitment at request time → resource served immediately → value
moves later through a **network binding**. It defines two trust models:
- **capital-backed**: trust anchor is the client's own onchain funds (pre-funded escrow,
  payment channel, delegated authorization). No intermediary underwrites.
- **credit-backed**: a network intermediary underwrites; client needs no onchain capital.

Lifecycle: Commit → Accumulate → Redeem, with a mandatory per-binding spec for commitment
format, verification rules, storage behavior, double-spend prevention, expiry, redemption
mechanism, and trust model.

**The tree now holds four files** (`api.github.com/repos/x402-foundation/x402/contents/
specs/schemes/batch-settlement`, read today): `scheme_batch_settlement.md` (6,234 B),
`scheme_batch_settlement_cloudflare.md` (19,947 B), `scheme_batch_settlement_evm.md`
(45,113 B), and **`scheme_batch_settlement_svm.md` (99,062 B, blob
`ccf228fd4ddbea3f00b65e03824b6a50772f4aad`)**. What the SVM binding specifies:

| | Upstream SVM binding, from the file |
|---|---|
| Method | one payment method, backed by a **payment-channels program**: `open`, `deposit`, `claim`/`settle`, `distribute`, `seal`, `refund`, `reclaim` |
| Commitment | Ed25519 cumulative voucher, verified on chain via the **Ed25519 precompile**; onchain `settle` advances a public `settled` watermark to the voucher's exact `maxClaimableAmount` |
| Amount visibility | **plaintext.** `settled` and the distributed delta are public values; §8 calls bounded authorization its guarantee, not secrecy |
| Token-2022 | supported only as a **mint owner**: `tokenProgram` — "SPL Token (`Tokenkeg…`) or Token-2022 (`TokenzQ…`) program that owns `asset`" |
| Confidentiality | **none specified.** Over the file's text, `grep -in 'confidentialTransfer\|ElGamal\|confidential'` → no matches; Token-2022 appears four times, all as the mint owner (`asset`, `tokenProgram`, `token_program` ×2) |
| Expiry | vouchers never expire (`expiresAt` fixed at `0`); the channel's forced close is the only bound |
| Two modes | client-signed vouchers, or **server mode**, where §8 says plainly: "Operator delegation is explicit and high trust … The operator can therefore take up to the full deposit without another client signature or proof that it delivered service" |

**Consequence for our claims.** "The first SVM batch-settlement binding" is not available to
us — that slot is upstream's. The defensible claim is narrower and checkable: *the first SVM
batch **redemption** that settles the session total as a Token-2022 confidential transfer*,
sitting beside upstream's binding rather than claiming its place, with the divergences
(payment-channels vs. pre-armed seats, plaintext watermark vs. ciphertext, wire-incompatible)
declared in `docs/notes/svm-batch-binding.md` §0.

### N2 — Five attacks on x402 (arXiv 2605.11781, May 12, 2026)

Formal analysis + 25,000-request testbed across 48 configs, validated on live endpoints,
responsibly disclosed via Coinbase HackerOne (#3679163/#3679179/#3679220). The attacks, with
their published mitigations:

| Attack | Mechanism / result | Published mitigation | Veil exposure today |
|---|---|---|---|
| II. Replay / idempotency | One payment reused for many grants; live: **248 grants per payment** | Mandatory idempotency + resource binding | Strong: PoolLedger seat CAS reserve is exactly the atomic record |
| I-A. Revert-grant | Resource granted before settlement finality (RGP up to 5.18%, 100% byzantine) | Two-phase (verify-then-settle) with finality gating | Strong: Veil serves after verify+settle |
| I-B. Settlement preemption | Caller-unbound settle() consumed by observer (EVM Permit2-specific) | Bind settlement to caller | N/A structure — SVM settlement is caller-bound by construction |
| III. Header/proxy confusion | Caches leaking paid content (nginx 100%, live CDN) | `Cache-Control: no-store` on paid responses | Partial: needs an audit + test |
| IV. Discovery Sybils | 71.8% selection bias via metadata gaming; 60.2% via 5 Sybils | Trust-weighted discovery, agent-side signaling | N/A (Veil doesn't run discovery) — but Veil can help its merchant-defenders |

Why this matters to Veil specifically: privacy changes the threat model, it does not remove
it. A confidential rail with weak idempotency is a worse vault: an attacker who can replay
payments against a privacy rail gets *unattributable* unpaid service. The paper's mitigations
map directly onto features Veil can add on top of its existing CAS-ledger spine.

### N3 — The competitive field is real, live, and none of it is on Solana

Re-verified 2026-10-12 against live search. The crucial column is **trust model**: who or what
must you believe for the privacy to hold.

| Competitor | Date | Chain | Approach | What they hide | Trust model (who you must believe) | Status |
|---|---|---|---|---|---|---|
| **TACEO Merces** | May 12, 2026 | Base Sepolia (EVM) | a confidential x402 **scheme** ("drop-in alongside `exact`"): Groth16 proof at payment time, Poseidon2 amount commitment on chain, amount secret-shared with the MPC network | Amounts + balances ("only who interacted with whom" stays public) | **The MPC network — 3-of-3 shares, per their own article**: "A Poseidon2 commitment onchain. Real amount secret-shared with MPC" / "Actual balances known only to MPC network" | Live Base Sepolia demo, docs, GitHub |
| **Fhenix** | Oct 30, 2025 (blog) / Jan 2, 2026 ("privacy stages" press) | Base (EVM) | FHE; argues privacy "must be foundational" for x402 | Amounts (FHE-encrypted; "payments can be verified without revealing amounts") | An FHE coprocessor — the party that can compute on the ciphertext | Blog + press release + integration material |
| **PrivateX402** (Nethermind) | Feb 18, 2026 | EVM | payment channels; one deposit covers N agents; per-payment signatures, proofs only at channel lifecycle boundaries | Per-agent allocations (channel-scoped), read on chain | **"currently a TEE, designed to be replaceable by ZK circuits"** — the post's own words; plus 50% collateral and a 1-day dispute window | ethresear.ch research post + PoC |
| **ZK API Usage Credits** (Davide & Vitalik, cited by PrivateX402) | 2026 | EVM | RLN rate-limit nullifiers + a ZK solvency proof; unlinkable requests | The user-to-provider linkage for one provider | Per-request ZK proofs; N providers → N deposits/commitments | Cited design in related work |
| **EVM confidential-facilitator gaps** | — | — | — | — | — | Stock EVM facilitators can't verify Merces — same structural gap as Solana, other chain family |

**Veil's difference is kind, not degree (the user's framing, 2026-10-12):** every competitor's
privacy is *delegated* — it holds as long as an MPC operator set stays honest (threshold), an FHE
gateway stays online and correct, or a channel operator behaves. Veil's privacy is *chain-verified*:
Solana Token-2022 Confidential Balances means the transfer's ZK proofs are verified **by the
chain itself** (zk-elgamal-proof program), the amount ciphertexts are ElGamal under the recipient
key (merchant-only decryption), and the claim is re-derivable from public chain state by anyone
(`veil replay`) without trusting Veil, an MPC cluster, or a gateway. No operator set. No threshold.
The trust model is the program binary.

The SSRN concentration study (N4, Aug 2026) names Veil's space "structurally closed" to stock
facilitators — the same gap, measured as a market fact. And x402 scale context, re-verified
today: TRM measured ~198.9M settlement transactions / ~$52.7M value (PYMNTS, Sep 15, 2026);
Chainalysis counted 100M+ transactions on Base (Jun 3, 2026).

TACEO's own "what stays public" table is the honest-limits mirror of Veil's own: **sender,
receiver addresses, frequency, timing stay public.** That matches Veil's honest-limits surface
(addresses public, timing correlation possible) — the entire honest-privacy framing holds
cross-chain. TACEO explicitly names "fully private transactions" as *next* in their stack.

### N4 — Facilitator-concentration study (SSRN 7396241, Aug 31, 2026)

First measurement of x402 settlement routes across the chains carrying "materially all x402
activity" (Base, Solana, and one more). Reports heavy settlement concentration in a handful
of facilitators, with trust and availability implications. For Veil: the standing honest-claim
("a judge can run `veil verify` themselves") gets a market-facing counterpart — the
concentration paper is the *market* argument for the same point: a settlement concentration
of facilitators is a trust concentration. Self-hostable verifier is a trust-architecture
feature, not just a DX nicety.

### N5 — Confidential liquidity facts re-verified with dates

- PYUSD on Solana: confidential-transfer extension present, `auto_approve=false` — issuer
  (Paxos) approval per account. Confirmed via PayPal dev blog + Solana issuer guide.
- USDG (Global Dollar Network: Robinhood, Galaxy, etc.): extension-capable, auto_approve=false.
- USDC/USDT/EURC: plain SPL mints, cannot confidential-transfer at all. Wrap-mint route is
  the only path; wrap-mints are the actual product decision.
- **Self-issued test dollar remains the correct demo call** — now with competitive evidence:
  TACEO's demo runs on their own confidential token too, so using the issuer-approval token
  would be the *exception* among live competitors, not the rule.

### N6 — x402 Foundation operational launch (Jul 14, 2026)

Linux Foundation governance with Google, Visa, Mastercard, Stripe, Cloudflare, Anthropic,
AWS, Microsoft, Circle, **Solana Foundation**, Shopify. Confirms: x402 is not a Coinbase
product anymore; it is governance-level infrastructure. For the submission story: "Veil is
built on governance-level infrastructure" reads stronger than "we built on a Coinbase
protocol."

### N7 — The claims register: what this project may and may not say about others

Added 2026-10-12 at the user's direction: *"websearch before you commit claiming anything
about others."* The rule this file now enforces — a statement about another team's product
is a factual claim, and it needs the same source-and-date treatment as our own numbers.

**MAY claim, sourced above and re-read today**

- x402 batch settlement is shipped, chain-abstract, and now has **EVM, SVM and Cloudflare**
  bindings; the SVM one landed 2026-08-21 (repo tree + file, today).
- Neither the generic spec nor the SVM binding specifies confidentiality; SVM's only
  Token-2022 use is the mint owner (grep over blob `ccf228f…`, today).
- TACEO Merces ships confidential x402 on Base Sepolia with an MPC trust model, and its own
  honest-limits statement matches ours: sender/receiver addresses, frequency and timing
  stay public; amounts are "commitment only" (their article, May 12, 2026).
- Fhenix argues FHE is x402's privacy layer and announced privacy stages (Oct 30, 2025;
  Jan 2, 2026).
- PrivateX402 hides per-agent allocations across one channel and runs its proofs in a TEE
  today, with ZK as a stated target (Feb 18, 2026).
- ZK API Usage Credits proposes per-request ZK proofs with RLN nullifiers against a single
  provider (cited in PrivateX402's related work).

**MAY NOT claim**

- *That nobody else has privacy for x402.* Three efforts above ship or have shipped one.
- *That a competitor's privacy does not hold.* We have not measured their systems. The
  honest statement is what each one **requires you to trust** — an MPC operator set, an FHE
  coprocessor, a TEE — quoted from their own material and attributed.
- *Any performance number for their systems as our measurement.* Two TACEO figures exist and
  they are not the same kind of number: **~2.4M gas** is their characterization of *other*
  teams' heavyweight on-chain ZK approaches ("Onchain proof verification can run ~2.4 million
  gas"), while **~300K gas** is their own contract's on-chain Groth16 verification. Attributing
  the first to Merces would be backwards; if either is used it is quoted as theirs, dated, with
  which one is which.
- *That our binding is the first SVM binding*, or that it is wire-compatible with upstream's.
  See N1 and `svm-batch-binding.md` §0.
- *Any "private" claim about the account graph.* Confidential Balances hides amounts and
  balances; the seat pool breaks per-payment linkage but the addresses, mint and timing are
  public — including in the competitor table above, where TACEO says the same of itself.

**The design consequence, stated once:** our differentiator is not the word *privacy* (that
is contested and partly shipped by others). It is that our privacy claim is **re-derivable by
a third party from chain state with a tool we ship** — `npm run replay`, seven assertions,
exit code significant — where each competing design asks you to trust an operator set that a
replay tool cannot audit.

## In-distribution claims NOT re-verified this session (still standing from the Oct 2 doc)

- 200M transactions / $50B volume / 150k endpoints figures (the Oct 2 doc's basis).
- The Solana 38-49% share figure.
- Sub-50-cent average ticket (TACEO cites $0.31 average, independently consistent).

## Not covered here (honest boundaries)

- No local measurements were made. All findings are from public web research.
- No claims about mainnet economic viability of the composition.
- The SSRN paper's full text was not read; its abstract-level finding (concentration) is what
  the doc uses.
