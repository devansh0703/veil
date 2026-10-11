#!/usr/bin/env python3
"""Draw the Veil architecture diagram as a self-contained SVG.

    uv run --with fonttools --with brotli python3 brand/build-diagram.py

Every label is outlined via `fontkit`, so the file needs no font installed.
Palette and geometry come from DESIGN.md: paper ground, one red, 3px radii,
rules instead of cards, no gradients or shadows.

Box widths and the canvas are **derived from measured text**, not guessed: the
content is measured first, each column is sized to its widest line, and the
canvas is widened to fit. A line that does not fit its container is a build
failure rather than something to notice in the output later.
"""

from __future__ import annotations

from pathlib import Path

from fontkit import Face, label

ROOT = Path(__file__).resolve().parent

PAPER = "#F2F2F0"
INK = "#17161A"
MUTED = "#6B6862"
RULE = "#D5D5D1"
TILE = "#101114"
TILE_TEXT = "#E8E6E1"
TILE_MUTED = "#8A8C93"
TILE_RULE = "#2A2C31"
REDACT = "#B4341F"

display = Face("cabinet-grotesk-700.woff2")
body = Face("general-sans-400.woff2")
semi = Face("general-sans-600.woff2")
mono = Face("jetbrains-mono-var.woff2")

out: list[str] = []
problems: list[str] = []

PAD = 26.0
MARGIN = 72.0
COL_GAP = 150.0
BODY_SIZE = 17.0
ROW_STEP = 26.0


# ------------------------------------------------------------------ helpers
def rect(x, y, w, h, fill, rx=3, stroke=None, sw=1):
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    out.append(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{s}/>')


def line(x1, y1, x2, y2, stroke=RULE, sw=1):
    out.append(
        f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"/>'
    )


def arrow(x1, y1, x2, y2, stroke=INK):
    out.append(
        f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" '
        f'stroke-width="1.5" marker-end="url(#arrow)"/>'
    )


def text(face, s, size, x, y, fill, tracking=0.0, anchor="start"):
    out.append(label(face, s, size, x, y, fill, tracking, anchor))


def measure(face, lines, size, tracking=0.0):
    return max((face.advance(s, size, tracking) for s in lines if s), default=0.0)


def check(face, s, size, available, tag, tracking=0.0):
    w = face.advance(s, size, tracking)
    if w > available:
        problems.append(f"{tag}: {w:.0f}px in {available:.0f}px")
    return w


def block(lines, x, y0, size, fill, available, tag, step=ROW_STEP, face=None):
    face = face or body
    for i, s in enumerate(lines):
        if not s:
            continue
        check(face, s, size, available, f"{tag} line {i + 1}")
        text(face, s, size, x, y0 + i * step, fill)


# ------------------------------------------------------------------ content
AGENT_LINES = [
    "checks the price against its budget",
    "before anything is signed",
    "",
    "builds three ZK proofs locally, in",
    "WASM - no prover service, no fee",
    "",
    "signs its own half; the fee slot is",
    "left open for the rail to fill",
]
RAIL_ROWS = [
    ("quote", "reserves a one-time seat, then names a price"),
    ("gate", "reads the mint and the destination first"),
    ("verify", "reads the signed bytes for a real"),
    ("", "confidential transfer (family 27, op 7)"),
    ("settle", "co-signs the network fee, broadcasts,"),
    ("", "and records the settlement"),
]
POOL_LINES = ["claim / settleable, compare-and-set -", "one seat, one payment, never re-armed"]
SOLANA_LINES = [
    "the amount is an ElGamal ciphertext,",
    "plus an AES ciphertext of the balance",
    "",
    "the zk-elgamal-proof program verifies",
    "all three proofs on chain - read from",
    "the Instructions sysvar at a signed",
    "offset of -1",
]
MERCHANT_LINES = [
    "the auditor key is one global key per",
    "mint, so it is not a per-merchant path",
    "- it is off by default (auditor: null)",
    "",
    "public either way: the seat address,",
    "the mint, and the timing",
]
CHECK_LINES = [
    "npm run replay -- <signature>   reads the chain, not our ledger, and asserts:",
    "the transaction exists - it succeeded - it carries exactly one Token-2022",
    "confidential transfer (family 27, op 7) - no plaintext transfer is present -",
    "the amount is not a plaintext field - no readable balance moved in public",
    "state - the destination is a one-time seat of this rail. Anything the host",
    "cannot answer prints INFO rather than counting as a pass.",
]
CHECK_HEAD = "The claim is re-derivable from chain state, not taken on our word."

SUBTITLE = (
    "Veil - a confidential x402 rail on Solana. Two privacy layers, one facilitator "
    "that refuses what it cannot make private."
)
TITLE = "How a payment settles"
PROMISE_HEAD = "It never downgrades to a public payment."
PROMISE_A = (
    "If the rail cannot demonstrate that a payment will be confidential it refuses with "
    "VEIL-CONF-003, and a refusal carries no accepts[] entry at all -"
)
PROMISE_B = (
    "an offer alongside a refusal would invite a client to pay for something the rail has "
    "already said it cannot settle privately."
)

# ------------------------------------------------------- derive the geometry
RAIL_LABEL_COL = 92.0  # width of the quote/gate/verify/settle label column

AW = PAD * 2 + measure(body, AGENT_LINES, BODY_SIZE)
RW = PAD * 2 + RAIL_LABEL_COL + measure(body, [v for _, v in RAIL_ROWS], BODY_SIZE)
SW = PAD * 2 + measure(body, SOLANA_LINES, BODY_SIZE)
MW = PAD * 2 + measure(body, MERCHANT_LINES, BODY_SIZE)
CW = PAD * 2 + measure(body, CHECK_LINES, BODY_SIZE)
CHECK_HEAD_W = semi.advance(CHECK_HEAD, 24)

# the lower-left card spans the two left columns, so it must be at least as wide
# as its own content
CW = max(CW, CHECK_HEAD_W + PAD * 2)

W = MARGIN * 2 + AW + COL_GAP + RW + COL_GAP + SW
LOWER_SPAN = AW + COL_GAP + RW  # the lower-left card's width

AX = MARGIN
RX = AX + AW + COL_GAP
SX = RX + RW + COL_GAP

AY = SY = 240.0
AH = 142.0 + (len(AGENT_LINES) - 1) * ROW_STEP + PAD + 18
SH = 142.0 + (len(SOLANA_LINES) - 1) * ROW_STEP + PAD + 18
RY = 210.0
RH = 140.0 + len(RAIL_ROWS) * 27 + 96
MX = SX
MY = SY + SH + 110.0
MH = 142.0 + (len(MERCHANT_LINES) - 1) * ROW_STEP + PAD + 18
CY = MY
CH = 132.0 + (len(CHECK_LINES) - 1) * ROW_STEP + PAD + 18

PROMISE_Y = CY + CH + 60.0
H = PROMISE_Y + 190.0

# ---------------------------------------------------------------- header
check(display, TITLE, 46, W - MARGIN * 2, "title")
check(body, SUBTITLE, 21, W - MARGIN * 2, "subtitle")
text(display, TITLE, 46, AX, 116, INK)
text(body, SUBTITLE, 21, AX + 2, 152, MUTED)

# ------------------------------------------------------------- agent card
rect(AX, AY, AW, AH, TILE)
text(mono, "THE AGENT", 15, AX + PAD, AY + 42, TILE_MUTED, 0.14)
text(semi, "veilFetch / createVeilAgent", 21, AX + PAD, AY + 84, TILE_TEXT)
line(AX + PAD, AY + 104, AX + AW - PAD, AY + 104, TILE_RULE)
block(AGENT_LINES, AX + PAD, AY + 142, BODY_SIZE, TILE_MUTED, AW - PAD * 2, "agent")

# -------------------------------------------------------------- rail card
rect(RX, RY, RW, RH, TILE)
text(mono, "THE VEIL RAIL", 15, RX + PAD, RY + 42, TILE_MUTED, 0.14)
text(semi, "createVeilHandler", 22, RX + PAD, RY + 84, TILE_TEXT)
line(RX + PAD, RY + 104, RX + RW - PAD, RY + 104, TILE_RULE)
yy = RY + 142
for k, v in RAIL_ROWS:
    if k:
        text(mono, k, 16, RX + PAD, yy, REDACT)
    check(body, v, BODY_SIZE, RW - PAD * 2 - RAIL_LABEL_COL, f"rail {k or 'cont'}")
    text(body, v, BODY_SIZE, RX + PAD + RAIL_LABEL_COL, yy, TILE_MUTED)
    yy += 27
line(RX + PAD, yy + 8, RX + RW - PAD, yy + 8, TILE_RULE)
text(semi, "PoolLedger", 18, RX + PAD, yy + 46, TILE_TEXT)
block(
    POOL_LINES,
    RX + PAD + RAIL_LABEL_COL,
    yy + 46,
    16,
    TILE_MUTED,
    RW - PAD * 2 - RAIL_LABEL_COL,
    "pool",
)

# ------------------------------------------------------------ solana card
rect(SX, SY, SW, SH, TILE)
text(mono, "SOLANA", 15, SX + PAD, SY + 42, TILE_MUTED, 0.14)
text(semi, "Token-2022 Confidential Balances", 20, SX + PAD, SY + 84, TILE_TEXT)
line(SX + PAD, SY + 104, SX + SW - PAD, SY + 104, TILE_RULE)
block(SOLANA_LINES, SX + PAD, SY + 142, BODY_SIZE, TILE_MUTED, SW - PAD * 2, "solana")

# ---------------------------------------------------------- merchant card
rect(MX, MY, MW, MH, TILE)
text(mono, "THE MERCHANT", 15, MX + PAD, MY + 42, TILE_MUTED, 0.14)
text(semi, "decrypts with its own wallet key", 20, MX + PAD, MY + 84, TILE_TEXT)
line(MX + PAD, MY + 104, MX + MW - PAD, MY + 104, TILE_RULE)
block(MERCHANT_LINES, MX + PAD, MY + 142, BODY_SIZE, TILE_MUTED, MW - PAD * 2, "merchant")

# ----------------------------------------------------- what a stranger runs
CX, CWD = AX, LOWER_SPAN
rect(CX, CY, CWD, CH, PAPER, stroke=RULE)
text(mono, "WHAT A STRANGER CAN RUN", 15, CX + PAD, CY + 42, MUTED, 0.14)
check(semi, CHECK_HEAD, 24, CWD - PAD * 2, "check heading")
text(semi, CHECK_HEAD, 24, CX + PAD, CY + 90, INK)
block(CHECK_LINES, CX + PAD, CY + 134, BODY_SIZE, MUTED, CWD - PAD * 2, "check")

# ------------------------------------------------------------------ arrows
GAP_AR0, GAP_AR1 = AX + AW, RX
GAP_RS0, GAP_RS1 = RX + RW, SX


def gap_label(face, s, size, x0, x1, y, fill, tracking=0.0, tag=""):
    w = face.advance(s, size, tracking)
    if w > (x1 - x0) - 8:
        problems.append(f"{tag or s!r}: {w:.0f}px in a {x1 - x0:.0f}px gap")
    text(face, s, size, (x0 + x1) / 2, y, fill, tracking, "middle")


arrow(GAP_AR0 + 12, 300, GAP_AR1 - 12, 300)
gap_label(mono, "GET /resource", 15, GAP_AR0, GAP_AR1, 288, INK, 0.06)
text(body, "unpaid", 14, (GAP_AR0 + GAP_AR1) / 2, 322, MUTED, 0, "middle")

arrow(GAP_AR1 - 12, 372, GAP_AR0 + 12, 372)
gap_label(mono, "402 + seat", 15, GAP_AR0, GAP_AR1, 360, REDACT, 0.06)
text(body, "price, mint, extra.privacy", 14, (GAP_AR0 + GAP_AR1) / 2, 394, MUTED, 0, "middle")

arrow(GAP_AR0 + 12, 452, GAP_AR1 - 12, 452)
gap_label(mono, "X-PAYMENT", 15, GAP_AR0, GAP_AR1, 440, INK, 0.06)
text(body, "the signed transfer", 14, (GAP_AR0 + GAP_AR1) / 2, 474, MUTED, 0, "middle")

arrow(GAP_RS0 + 12, 330, GAP_RS1 - 12, 330)
gap_label(mono, "settle", 15, GAP_RS0, GAP_RS1, 318, INK, 0.06)
text(body, "co-signed, broadcast", 14, (GAP_RS0 + GAP_RS1) / 2, 352, MUTED, 0, "middle")

arrow(MX + MW / 2, SY + SH + 10, MX + MW / 2, MY - 10)
text(mono, "one transfer", 15, MX + MW / 2 + 18, MY - 50, INK, 0.06)
text(body, "into a fresh one-time seat", 14, MX + MW / 2 + 18, MY - 28, MUTED)

# --------------------------------------------------------------- the promise
line(MARGIN, PROMISE_Y, W - MARGIN, PROMISE_Y, RULE)
rect(MARGIN, PROMISE_Y + 34, 6, 92, REDACT, rx=3)
text(display, PROMISE_HEAD, 34, MARGIN + 32, PROMISE_Y + 78, INK)
check(body, PROMISE_A, 19, W - MARGIN * 2 - 32, "promise a")
check(body, PROMISE_B, 19, W - MARGIN * 2 - 32, "promise b")
text(body, PROMISE_A, 19, MARGIN + 32, PROMISE_Y + 112, MUTED)
text(body, PROMISE_B, 19, MARGIN + 32, PROMISE_Y + 140, MUTED)

# ------------------------------------------------------------------ assemble
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="0 0 {W:.0f} {H:.0f}" role="img">
  <title>Veil - how a payment settles</title>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="{INK}"/>
    </marker>
  </defs>
  <rect width="{W:.0f}" height="{H:.0f}" fill="{PAPER}"/>
{chr(10).join(out)}
</svg>
"""

(ROOT / "veil-architecture.svg").write_text(svg, encoding="utf-8")
print(f"wrote veil-architecture.svg  {W:.0f}x{H:.0f}  {len(svg)} bytes")
print(f"  columns: agent {AW:.0f}  rail {RW:.0f}  solana {SW:.0f}  merchant {MW:.0f}  check {CWD:.0f}")
if problems:
    print("\nFIT PROBLEMS:")
    for p in problems:
        print("  -", p)
    raise SystemExit(1)
print("every label fits its container")
