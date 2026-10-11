---
workflow: product-launch-video
flow: standalone
storyboard: none
mode: autonomous
length: two deliverables — pitch ≤120s, technical demo ≤170s
format: landscape 1920x1080
audience: Colosseum Crypto World's Fair judges (pitch) and a technical reviewer (demo)
subject: Veil — private payment rails for the agent economy (x402 on Solana)
style_preset: editorial ledger, from DESIGN.md
music: none
captions: burned in; both videos also ship a read-aloud script
---

# Brief

## What is being made, and for whom

Two videos for one submission, per Colosseum's own guidance:

- **Pitch video (≤ 2 min).** The why: the problem, who it is for, what is built, what is
  verified, and the vision. Colosseum reviews this first and it decides shortlisting.
- **Technical demo (≈ 2.5 min).** The how: architecture, the Solana integration, the
  design decisions, and the reasoning behind them. Explicitly not another pitch.

## Source material: real, and only real

Nothing in either video is drawn, mocked or estimated. The material is:

- `assets/{index,dashboard,limits,402}.png` — screenshots of the four product surfaces,
  captured at 1920×1080 @2x from the pages `npm run demo` regenerates out of a real
  protocol run.
- The settlement transaction `53pN4tq…SetmFqg8tf` on devnet, and its `npm run replay`
  output, copied verbatim from the terminal.
- Figures about the market, each attributed on screen to the source and date it came
  from. Where a number is someone else's measurement, it says whose.

## The one thing the videos must not do

Claim privacy that cannot be checked. Three other teams ship confidential x402 (an MPC
set, a TEE, an FHE coprocessor), so the differentiator is not the word *privacy* — it is
that this rail's claim is **re-derivable from chain state by a stranger**, with a command
shipped in the repo. The honest limits (addresses, mint and timing stay public) are stated
on screen in both videos, because they are stated on the product's own limits page.

## Look

DESIGN.md, unchanged: paper `#F2F2F0` and graphite `#101114` grounds, one redaction red
`#B4341F` (lifted to `#DE523C` on graphite for small text), Cabinet Grotesk display,
General Sans body, JetBrains Mono with tabular figures for every number, addresses and
code. Rules instead of cards, 2–4px radii, no shadows, no gradients, no neon. The single
authored motion is the redaction reveal.

## Delivery

`renders/veil-pitch.mp4` and `renders/veil-demo.mp4`, 1920×1080, plus
`docs/video-scripts.md` (both read-aloud scripts with timings) so a human voice can be
laid over either cut.
