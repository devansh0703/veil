# The submission videos

Two videos, each its own HyperFrames project, because HyperFrames renders a
project's `index.html` and one project has one `index.html` — two videos need two
projects. They share the same fonts, palette and design system, so they read as
one pair.

| Project | Deliverable | Length |
|---|---|---|
| `veil-video/` | `renders/veil-pitch.mp4` — the pitch: problem, product, proof, vision | 113 s |
| `veil-demo/` | `renders/veil-demo.mp4` — the technical walkthrough: architecture, integration, decisions | 167 s |

Both are 1920×1080, H.264 + AAC 48 kHz, narrated, and captioned so they work
with the sound off. Colosseum caps each at three minutes.

## The audio pipeline

The narration is generated **locally** by Kokoro-82M through the HyperFrames CLI
— no service in the loop, which matches the product's own stance that the
payer's machine does the work. Two scripts drive it, and both refuse to produce
something that does not fit:

```
scripts/gen-vo.mjs      text -> WAV, per scene, with measured durations
scripts/sync-audio.mjs  measured durations -> the composition's <audio> + captions
```

`gen-vo.mjs` synthesises one clip per scene, measures each with `ffprobe`, and
**exits non-zero if any clip is longer than the scene window it has to fit**. A
narration edit that overruns is caught before a render, not discovered in one.

`sync-audio.mjs` rewrites everything between the composition's
`<!-- captions:begin -->`/`<!-- captions:end -->` and `<!-- audio:begin -->`/
`<!-- audio:end -->` markers from the measured manifest. Caption text and audio
windows therefore come from one source, so the words on screen cannot drift from
the words in the mix.

### One-time setup

The CLI looks for a Python that has `kokoro-onnx` and `soundfile`. It does not
have to be the system interpreter — point it at a venv:

```bash
cd video/veil-video
uv venv .venv-tts
uv pip install --python .venv-tts/bin/python kokoro-onnx soundfile
export HYPERFRAMES_PYTHON="$PWD/.venv-tts/bin/python"   # set this on every command
```

The venv is gitignored (235 MB of wheels). The Kokoro model itself is fetched to
`~/.cache/hyperframes/tts/` on first synthesis.

### Regenerating

```bash
cd video/veil-video
export HYPERFRAMES_PYTHON="$PWD/.venv-tts/bin/python"

node scripts/gen-vo.mjs --cut pitch --voice am_michael --speed 1.1
node scripts/sync-audio.mjs --comp index.html --meta audio_pitch.json

npx hyperframes check
npx hyperframes render --quality delivery --output renders/veil-pitch.mp4
```

```bash
cd video/veil-demo
export HYPERFRAMES_PYTHON="$PWD/../veil-video/.venv-tts/bin/python"

node scripts/gen-vo.mjs --cut demo --voice am_michael --speed 1.1 --project .
node scripts/sync-audio.mjs --comp index.html --meta audio_demo.json --prefix d --project .

npx hyperframes check
npx hyperframes render --quality delivery --output renders/veil-demo.mp4
```

Both scripts take `--project <dir>` so one copy serves both projects.

## Two pitfalls worth knowing before editing a composition

**Never put `white-space: pre` on the terminal box itself.** The `.term` style is
shared between the pre-formatted JSON (which needs preserved whitespace) and the
proof-output blocks (which are built from `<div>` children). With `pre` on the
container, the source whitespace *between* those block children renders as blank
lines and silently doubles the box's height — the text then runs off the bottom
of the frame and into the caption band. Put `pre` on a `.pre` child that holds
only the pre-formatted run. The comment in `veil-demo/index.html` marks the spot.

**A caption band is an untimed element holding timed children.** The band
(`#caption-layer`) is a direct child of the composition root with no `data-start`,
so the runtime skips its automatic layout and CSS owns its position; each line
inside it carries `data-start`/`data-duration`. Putting `data-start` on the band
instead would make it a full-frame clip and collapse the layout.

## What each video may and may not say

The rule both scripts follow is the same one the product follows: never claim
more than the primitive delivers. Amounts and balances are ciphertext; **the
account addresses, the mint and the timing stay public**, and low-volume timing
correlation remains possible. That is stated on screen in both cuts, in the same
words the product's own limits page uses.

Competitors are described by what each design asks you to trust — an MPC
operator set, a TEE, an FHE coprocessor — quoted from each project's own
material and never measured. The may-claim/may-not-claim register behind those
sentences is `docs/notes/x402-2026-landscape.md` § N7.

Read-aloud scripts with per-scene timings, for laying a human voice over either
cut: `docs/video-scripts.md`.
