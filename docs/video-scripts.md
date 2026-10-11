# Video scripts

Read-aloud scripts for the two Colosseum submission videos. Both are cut to
measured audio, not estimates: the voiceover was generated first with the local
Kokoro-82M engine, each clip's real duration was measured with `ffprobe`, and the
composition's caption and audio windows were then written from that measurement
(`video/veil-video/audio_pitch.json`, `video/veil-demo/audio_demo.json`).

A human can lay their own voice over either cut: the per-scene lines below are
timed to the same windows, so re-recording them to the stated durations drops
straight in.

| | Pitch | Technical demo |
|---|---|---|
| Deliverable | `video/veil-video/renders/veil-pitch.mp4` | `video/veil-demo/renders/veil-demo.mp4` |
| Length | 113 s | 167 s |
| Colosseum cap | ≤ 3 min | ≤ 3 min |
| Format | 1920×1080, H.264 + AAC 48 kHz | same |
| Voice | Kokoro-82M `am_michael` (en-US), 1.1× | same |
| Music | none | none |
| Captions | burned in | burned in |

---

## Pitch — 113 s

The why: the problem, who it is for, what is built, what is verified, the vision.
Colosseum reviews this first and it decides shortlisting.

| # | Scene | In | Line to read |
|---|---|---|---|
| 1 | Hook | 0:00 | x402 lets an agent pay for an API call with no account and no human — and makes every payment public. |
| 2 | The rail, measured | 0:10 | Two hundred million payments settled on this rail, moving fifty-two million dollars. The average ticket: thirty-one cents. At thirty-one cents a call, your price list becomes public infrastructure. |
| 3 | What actually leaks | 0:24 | What leaks isn't your balance. It's your business. What each customer pays you. Whether you charge them differently. Which new client is ramping. Your book, broken down by counterparty. |
| 4 | What Veil is | 0:38 | Veil is an x402 scheme on Solana. The amount is ciphertext, and the chain does the checking: ElGamal and zero-knowledge proofs, verified by Solana's own Token-2022 program. |
| 5 | The merchant's ledger | 0:54 | This is the merchant's ledger after a real run. Amounts are readable only with the merchant's own key. The addresses stay public, so the dashboard prints them. That is the honest boundary of the primitive. |
| 6 | The check a stranger runs | 1:10 | You don't have to believe any of that. The proof is a command, not a promise. Replay reads the chain, not our database, and asserts seven things: the transaction exists, it succeeded, and no readable amount moved. |
| 7 | The field, stated plainly | 1:27 | Others ship privacy for x402: an MPC cluster, a TEE, an FHE coprocessor. Each asks you to trust an operator set. This one is verified by the chain. |
| 8 | Where it stands | 1:41 | Live on devnet, with every receipt in the repository. A hosted facilitator, an npm CLI, and an agent sandbox any client can call today. |

**254 words over 113 s.** The speech occupies ≈ 95 s; the remaining ≈ 18 s is the
entrances, the terminal read and the closing rule.

---

## Technical demo — 167 s

The how: architecture, the Solana integration, the design decisions and the
reasoning. Explicitly not another pitch.

| # | Scene | In | Line to read |
|---|---|---|---|
| 1 | Title | 0:00 | Veil. A technical walkthrough of a confidential x402 rail on Solana. |
| 2 | The request path | 0:07 | An agent asks for a resource. Unpaid, it gets a standard 402: a price, a one-time account, and a privacy claim it can check. Before quoting, the rail reads the mint and the destination, confirming both can hold a confidential transfer. |
| 3 | Where the proofs come from | 0:27 | A confidential transfer needs three proofs: ciphertext-commitment equality, batched ciphertext validity, and a range proof over the remaining balance. All three are built on the payer's own machine, by WASM inside the Solana ZK SDK. No prover service, no fee, about fifty milliseconds. |
| 4 | Settlement | 0:49 | The transfer is Token-2022, instruction family twenty-seven, operation seven. Solana's own token program verifies those proofs on chain. The payer signs the money movement; the rail co-signs only the network fee. The merchant decrypts its own recipient ciphertext with its own wallet key — one key per merchant. |
| 5 | The refusal policy | 1:13 | Every refusal has one code, one cause, one remedy. The load-bearing one is VEIL-CONF-003: if the rail cannot demonstrate that a payment will be confidential, it refuses and offers nothing. A refusal carries no accepts entry at all. |
| 6 | The graph layer | 1:33 | Confidential balances hide the amount, not that an account exists. So every payment lands in a different one-time account from a pre-created pool. Seats are never re-armed — reusing one would link two payments on the public graph. |
| 7 | Verification | 1:51 | The claim is about someone else's blockchain, so it should not be taken on our word. Replay reads the chain, not our ledger, and asserts seven things: the transaction exists, it succeeded, it carries exactly one confidential transfer, and no readable amount moved. |
| 8 | What landed in 2026 | 2:13 | Three things landed in 2026. Batch settlement: capital committed once, a signed voucher per call, and a confidential redemption — only the session total reaches the chain. One-transaction settlement behind txv1. And V2 headers. |
| 9 | What stays public | 2:32 | What stays public, stated plainly: the account addresses, the mint, and the timing. That is the limit of this primitive, and it is on our limits page in the same words. |

**338 words over 167 s.**

---

## Both cuts obey the same three rules

1. **No claim that cannot be checked.** The word "private" is never used as an
   adjective about the system; the script says what is hidden, what stays public,
   and how a stranger re-derives it. Every number spoken is attributed on screen
   to the source and date it came from.
2. **The honest limits are on screen.** Addresses, mint and timing are public;
   low-volume timing correlation remains possible. Stated in the same words the
   product's own limits page uses, because a claim the product will not make on
   its own page is not a claim the video should make either.
3. **Competitors are described, never measured.** The field scene names what each
   other design asks you to trust — an MPC operator set, a TEE, an FHE
   coprocessor — quoted from each project's own material. The may-claim /
   may-not-claim register behind those sentences is
   `docs/notes/x402-2026-landscape.md` § N7.

## Reproducing the audio

```bash
cd video/veil-video
export HYPERFRAMES_PYTHON="$PWD/.venv-tts/bin/python"   # kokoro-onnx + soundfile
node scripts/gen-vo.mjs --cut pitch --voice am_michael --speed 1.1
node scripts/sync-audio.mjs --comp index.html --meta audio_pitch.json

cd ../veil-demo
node scripts/gen-vo.mjs --cut demo --voice am_michael --speed 1.1 --project .
node scripts/sync-audio.mjs --comp index.html --meta audio_demo.json --prefix d --project .
```

`gen-vo.mjs` refuses to exit 0 if any clip is longer than the scene window it has
to fit, so a script edit that overruns is caught before a render, not after.
