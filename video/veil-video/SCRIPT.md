# Script — Veil pitch video

`workflow: product-launch-video` · `flow: standalone` · mode: autonomous
Voice: Kokoro-82M `am_michael` (en-US, offline) · music: none · captions burned in
Canvas: 1920×1080 · target ≤ 120 s · the composition's own duration is 113.0 s.

The read-aloud script for both cuts ships as `docs/video-scripts.md`; this file is
the machine-adjacent source the voiceover is generated from.

## Why the narration is shaped this way

The video's argument is a **negative claim** — *you cannot read this amount* — and a
negative claim is only believed if the thing behind it is real. So the script never
says "private". It says what is hidden, what stays public, and how a stranger checks
it. Every number spoken is attributed on screen to the source and date it came from.

## Segments

Times are absolute in the composition. `scene` is the composition's scene id; the
narration begins 0.6 s after the scene starts so the entrance motion lands first.

| # | Scene | Scene window | VO start | Words | Line |
| - | ----- | ------------ | -------- | ----- | ---- |
| 1 | `s1-hook` | 0.0–9.5 | 0.6 | 21 | x402 lets an agent pay for an API call with no account and no human — and makes every payment public. |
| 2 | `s2-scale` | 9.5–23.5 | 10.1 | 30 | Two hundred million payments settled on this rail, moving fifty-two million dollars. The average ticket: thirty-one cents. At thirty-one cents a call, your price list becomes public infrastructure. |
| 3 | `s3-leaks` | 23.5–37.5 | 24.1 | 30 | What leaks isn't your balance. It's your business. What each customer pays you. Whether you charge them differently. Which new client is ramping. Your book, broken down by counterparty. |
| 4 | `s4-what` | 37.5–54.0 | 38.1 | 37 | Veil is an x402 scheme on Solana. The amount is ciphertext, and the chain does the checking: ElGamal plus zero-knowledge proofs, verified by Solana's own Token-2022 program. No MPC cluster, no enclave, no coprocessor. |
| 5 | `s5-ledger` | 54.0–70.0 | 54.6 | 36 | This is the merchant's ledger after a real run. Amounts are readable only with the merchant's own key. The addresses stay public, so the dashboard prints them. That is the honest boundary of the primitive. |
| 6 | `s6-replay` | 70.0–86.5 | 70.6 | 38 | You don't have to believe any of that. The proof is a command, not a promise. Replay reads the chain, not our database, and asserts seven things: the transaction exists, it succeeded, and no readable amount moved. |
| 7 | `s7-field` | 86.5–101.0 | 87.1 | 35 | Others ship privacy for x402: an MPC cluster, a TEE, an FHE coprocessor. Each asks you to trust an operator set. This one is verified by the chain, and anyone can check it. |
| 8 | `s8-closing` | 101.0–113.0 | 101.6 | 27 | Live on devnet, with every receipt in the repository. A hosted facilitator, an npm CLI, and an agent sandbox any client can call today. MIT licensed, zero paid infrastructure. |

**254 words over 113 s.** Measured rate for this voice is 2.68 words/s, so the speech
occupies ≈ 95 s and leaves ≈ 18 s of silence across the cut for the entrances, the
terminal read and the closing rule to land.

## Delivery notes

- Every claim spoken on screen is on the product's own limits page in the same words:
  amounts and balances are ciphertext; **addresses, mint and timing stay public**;
  low-volume timing correlation remains possible.
- The competitor sentence names the trust model each design asks for, never a
  measurement of their systems — the may-claim/may-not-claim register behind it is
  `docs/notes/x402-2026-landscape.md` N7.
- "Anyone can check it" is literal: `npm run replay -- <signature>` is in the repo.
