# Veil — submission packet

**Colosseum Crypto World's Fair · submissions close 2026-10-12 23:59 PT**

This folder holds the written submission. Everything here is either generated
from the repository or cites something in it, so no claim in this packet is
unbacked.

| | |
|---|---|
| Product | **Veil** — private payment rails for the agent economy |
| Repository | https://github.com/devansh0703/veil (public, MIT) |
| Live rail | https://veil-devnet.vercel.app (devnet) · https://veil-sable-five.vercel.app (testnet) |
| Entry | Solo — `devansh0703` |
| Location | India (IST, UTC+05:30) |

---

## Requirement → artifact

Colosseum's portal asks for a fixed list. This is where each answer lives.

| The portal asks for | Where it is |
|---|---|
| Product name and a brief description | [`product.md`](product.md) |
| Which blockchains and tools are being integrated | [`product.md`](product.md) § Blockchains and tools |
| All teammates, with backgrounds and previous experience | [`product.md`](product.md) § Teammates |
| Where the team is located | [`product.md`](product.md) § Location |
| **A product logo or graphic** | [`../brand/`](../brand/) — SVG + PNG exports, [`../brand/README.md`](../brand/README.md) |
| **A GitHub repository link** | https://github.com/devansh0703/veil — public, MIT |
| **A two-to-three-minute presentation video** | [`../video/veil-video/renders/veil-pitch.mp4`](../video/veil-video/renders/veil-pitch.mp4) — **113 s** |
| **A product-demo video of no more than three minutes** | [`../video/veil-demo/renders/veil-demo.mp4`](../video/veil-demo/renders/veil-demo.mp4) — **167 s** |
| Go-to-market strategy, demand validation, plans for distribution | [`go-to-market.md`](go-to-market.md) |
| Read-aloud scripts for both videos | [`../docs/video-scripts.md`](../docs/video-scripts.md) |

Two obligations from the official rules, both answered rather than skipped:

| Rules clause | Where it is |
|---|---|
| **§ 9** — "inform Administrator of the status and ownership of any open-source or other third party code" | [`dependency-inventory.md`](dependency-inventory.md) — generated from `package-lock.json` by [`build-inventory.mjs`](build-inventory.mjs); 138 packages, 0 copyleft, 0 undeclared |
| Disclosure of pre-existing code and prior development | [`prior-work-disclosure.md`](prior-work-disclosure.md) — full timeline, the history squash and why, the AI tooling used |

## The videos

| | File | Length | Notes |
|---|---|---|---|
| Pitch | `video/veil-video/renders/veil-pitch.mp4` | 113 s | The why: problem, who it is for, what is built, what is verified, the vision. Colosseum reviews this first. |
| Technical demo | `video/veil-demo/renders/veil-demo.mp4` | 167 s | The how: architecture, the Solana integration, the design decisions. Explicitly not another pitch. |

Both 1920×1080, H.264 + AAC, narrated (local Kokoro-82M, no service in the loop),
captioned so they work muted. Source compositions are the two HyperFrames
projects under `video/`, and `node scripts/gen-vo.mjs` refuses to exit 0 if any
narration clip overruns the scene it has to fit — so a script edit that runs long
is caught before a render, not after.

## The logo

`brand/` holds the mark and the lockups as SVG with the wordmark converted to
real vector outlines, plus PNG exports for a form upload. The mark is a **V**
whose right half is a redaction bar — the product's own claim applied to its own
name. Colours and geometry are taken from `DESIGN.md`; the reasoning and the
regeneration command are in `brand/README.md`.

## What a judge can check in five minutes

```bash
git clone https://github.com/devansh0703/veil && cd veil
npm install
npm run verify      # typecheck + the full test suite, no network
npm run demo        # 10 protocol scenarios over real HTTP, then render the pages
```

Then, against the live rail, with nothing running locally:

```bash
# ask unpaid — a real 402 with a one-time seat
curl -i "https://veil-devnet.vercel.app/v1/oracle/tide?nonce=1" -H "X-Payer: judge"

# what the rail publishes about itself
curl -s https://veil-devnet.vercel.app/.well-known/veil
curl -s https://veil-devnet.vercel.app/v1/health

# re-derive a settled payment's privacy from chain state, not from our database
npm run replay -- 2kmv4tYaDGWt2AdEE7wd194R2Zd7AfP9iqgNuci7uVuXPV7ZeMGCHuir7Jm5foZEJFTUY9f7sTphDdMiv64thYRr
```

## The claims this submission makes, and the ones it refuses to

**May claim, with a source or a command behind each:**

- Amounts and balances are ciphertext on chain, verified by Solana's own Token-2022
  program. Checkable: `npm run replay`.
- Every payment lands in a fresh one-time seat, so two payments to one merchant
  never share an address. Checkable: the two testnet payments in `README.md`
  landed in different seats, and `veil balance` reads both.
- A stranger can re-derive all of it from chain state with a command shipped in
  the repo. That is the whole differentiator.
- Three things landed in 2026 that this is built on: batch settlement (11 May),
  txv1/SIMD-0385 (mainnet 15 Sep), and x402 V2 headers (Dec 2025) — each cited in
  `docs/notes/x402-2026-landscape.md` with a dated primary source.

**May not claim, and does not:**

- *Anonymity.* Token account addresses, the mint and the timing stay public by
  design of the underlying extension. The merchant ledger prints every
  destination address rather than hiding it, because hiding it would misrepresent
  the boundary.
- *That low-volume timing correlation is defeated.* It is not. It is named on the
  limits page and in both videos.
- *That nobody else ships privacy for x402.* Three teams do — TACEO Merces (MPC),
  PrivateX402 (TEE), Fhenix (FHE). Each is described by its own published
  material and never measured. The honest statement is what each one requires you
  to trust.
- *That our batch binding is the first SVM binding.* Upstream published one on
  2026-08-21. Ours is a **sibling** with a confidential redemption upstream does
  not specify, and `docs/notes/svm-batch-binding.md` § 0 states every divergence
  including that the two are not wire-compatible.
- *Any traction number.* There are no users and no revenue. See
  [`go-to-market.md`](go-to-market.md) § 3.

The register governing every statement about another team's work is
`docs/notes/x402-2026-landscape.md` § N7. It exists because a claim about
someone else's product is a factual claim, and it needs the same source-and-date
treatment as one of ours.
