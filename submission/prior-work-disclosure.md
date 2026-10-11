# Prior development disclosure

Colosseum's rules require disclosure of pre-existing code and prior development
work, and state that products are judged only on work completed between
**14 September 2026** and **12 October 2026**. This is the disclosure, written to
be checkable against the repository rather than taken on trust.

## 1. Timeline

Every commit in this repository falls inside the competition window.

| Date | What happened |
|---|---|
| **2 Oct 2026** | The first design document (`docs/designs/veil-agent-payments.md`), written before any code. No implementation existed. |
| **4 Oct 2026** | First commit. The rail, the four web surfaces, the hosted deployments and CI land across ~25 commits. |
| **5 Oct 2026** | Second design document (`docs/designs/veil-2026-batched-confidential.md`); the rail is rebuilt into a deployed, paying confidential x402 facilitator. |
| **12 Oct 2026** | Batch-confidential sessions, the replay verifier, the honest-claims pass, and this submission packet. |

**No line of Veil existed before 2 October 2026.** The earliest author date in the
object database is `2026-10-04`; the design docs that precede it are documents,
not code.

## 2. History rewriting — disclosed, not hidden

On **12 Oct 2026** the `main` branch was squashed into three commits. The full
development history is **preserved and pushed** on the `backup/pre-squash`
branch, so the day-by-day work is still auditable:

```bash
git log backup/pre-squash --date=iso --pretty='%h %ad %s'
```

Reasons for the squash, stated plainly: the working history contained a handful
of commits whose messages referenced intermediate scaffolding and local
experiments that no longer exist in the tree, and a submission whose whole
argument is "every claim is checkable" should not ship a history a reviewer
cannot follow. Nothing was removed from the tree — the squash is a history
operation, not a content one, and the pre-squash branch is public.

## 3. Pre-existing code used

**Nothing from this project's author.** Veil is written from scratch. No code was
copied from a previous personal project, an employer, or a template.

**Third-party code: fully inventoried.** Every npm package in the tree, its
version, its licence, and whether it is a direct or transitive dependency is in
`submission/dependency-inventory.md`, generated from `package-lock.json` by
`submission/build-inventory.mjs`. Summary: 138 packages, 0 copyleft, 0 with an
undeclared licence, 11 direct dependencies, all permissively licensed (MIT or
Apache-2.0).

The load-bearing third-party pieces, named because a reviewer will want to know
where the hard parts come from:

| What | Where it comes from | What Veil does with it |
|---|---|---|
| Confidential-transfer **proof generation** | `@solana/zk-sdk` (WASM) | Calls it. Does not reimplement the cryptography. |
| Confidential-transfer **instruction construction** | `@solana-program/token-2022` | Calls it. |
| On-chain **proof verification** | `@solana-program/zk-elgamal-proof` | Calls it. |
| **x402 protocol types** | `@x402/core`, `@x402/svm` 2.28.0 | Used for type compatibility. Veil's own protocol core (`packages/x402-core`) deliberately does **not** depend on them. |
| **Pretext** (text layout) | Vendored into `web/assets/pretext.js` | Used so the dashboard's refusal panel computes its own height. |
| **Fonts** | Cabinet Grotesk + General Sans (Fontshare, free commercial licence), JetBrains Mono (SIL OFL 1.1) | Self-hosted. |

**Nothing was forked.** There is no vendored copy of another project's source in
this tree apart from the Pretext bundle named above, and no patch applied to a
third-party package.

**No prior art was copied.** The prior-art review (TACEO Merces, PrivateX402,
Fhenix, Umbra, ZecShield, the x402 batch-settlement spec and its SVM binding) is
recorded in `docs/notes/x402-2026-landscape.md` with a dated primary source for
every claim. Veil's batch binding is authored as a **sibling** to upstream's, not
an implementation of it, and `docs/notes/svm-batch-binding.md` § 0 states every
divergence.

## 4. Related but separate projects

Two other projects exist on the same development machine from earlier sessions.
Neither shares code, design, or assets with Veil, and neither is submitted:

| Project | What it is | Relationship to Veil |
|---|---|---|
| Drip Monad | A Monad-native creator-payout concept | **None.** Different chain, different product, no shared code. |
| Competitive-intel workbench | An internal research tool | **None.** No shared code. |

They are named because the design doc's own review flagged the pattern of
"someone who likes starting more than finishing", and a disclosure that omits
them would be the kind of selective honesty this project's rules exist to
prevent.

## 5. AI tooling and agent assistance — disclosed

This is a solo entry, and it was built with AI assistance. That is stated rather
than implied, because a judge assessing Founder + Market Fit should know what
they are assessing.

| Tool | What it was used for |
|---|---|
| **Claude (Anthropic)** with the **gstack** skill suite | Plan reviews (CEO, engineering, design, developer-experience), the QA pass recorded in `.gstack/qa-reports/`, and design consultation |
| **HyperFrames** | The two submission videos — composition, local Kokoro-82M narration, and render |
| **Hermes Agent** (Nous Research) | Session orchestration, the brand assets, this submission packet |
| **Web research** | The 2026 landscape register. Every external claim is attributed to a dated primary source in `docs/notes/x402-2026-landscape.md`; the `§ N7` register records what may and may not be claimed about other teams' work |

**What is not AI-generated:** the protocol design, the Solana integration, the
facilitator, the CLI, the four web surfaces, the tests, the deployments and the
on-chain runs are code and transactions authored in this repository, and every
one of them is verifiable — `npm run verify`, `npm run demo`, `npm run replay`,
and the explorer links in `README.md`.

**The negative claim was the point.** This product's entire pitch is a claim that
cannot be read — *the amount is ciphertext*. A negative claim can only be
believed if the thing behind it is real, which is why the standing rule for this
build was "no mocks, no stubs, no seeded demo data, no hardcoded metrics", and
why `npm run replay` exists: it lets a stranger re-derive the claim from chain
state instead of trusting the demo.

## 6. Third-party services and accounts

| Service | Tier | Used for |
|---|---|---|
| Vercel | Hobby (free, no card) | Hosting two rail deployments |
| Upstash Redis | Free | The durable shared seat ledger |
| Helius | Free | A dedicated devnet RPC node |
| GitHub | Free | Public repository, Actions CI |
| Solana devnet + testnet faucets | Free | All SOL used in testing |

**No paid service is used anywhere, and no mainnet deployment exists.** The only
real cost in the project is SOL on devnet and testnet, both faucet-funded; the
spend on each cluster is documented in `README.md`.

## 7. What a reviewer should check rather than accept

Every claim above is falsifiable with a command in the repository:

```bash
git log --all --date=iso --pretty='%h %ad %s'   # the full timeline, both branches
node submission/build-inventory.mjs             # regenerate the licence inventory
npm run verify                                  # typecheck + the whole test suite
npm run demo                                    # 10 protocol scenarios over real HTTP
npm run replay -- <signature>                   # re-derive a settlement's privacy from chain state
```

If any of them contradicts a sentence in this packet, the command is right and
the sentence is wrong.
