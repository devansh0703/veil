#!/usr/bin/env python3
"""Build the Veil brand assets as self-contained SVG.

A logo file that needs a font installed is not a logo file. This converts the
display face to outlines with fontTools, so every wordmark here is real vector
geometry and renders identically everywhere — no webfont, no fallback face.

Run with the deps available (they are not project deps):

    uv run --with fonttools --with brotli python3 brand/build-logo.py

Colours and geometry are taken from DESIGN.md, not invented here:
  paper #F2F2F0 · graphite #101114 · ink #17161A · text-dark #E8E6E1
  redact #B4341F (the redaction ink) · muted #6B6862 · muted-dark #8A8C93
  radius: sm 2px, md 3px, lg 4px. No gradients, no shadows.
"""

from __future__ import annotations

import base64
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
FONTS = REPO / "video" / "veil-video" / "assets" / "fonts"

# ---------------------------------------------------------------- palette
PAPER = "#F2F2F0"
GRAPHITE = "#101114"
INK = "#17161A"
TEXT_DARK = "#E8E6E1"
REDACT = "#B4341F"
MUTED = "#6B6862"
MUTED_DARK = "#8A8C93"
RULE = "#D5D5D1"
RULE_DARK = "#2A2C31"


def load(path: Path) -> TTFont:
    font = TTFont(str(path))
    font.flavor = None  # decompress woff2 -> raw sfnt so glyphs are readable
    return font


class Face:
    """One font, ready to turn strings into SVG path data."""

    def __init__(self, path: Path) -> None:
        self.font = load(path)
        self.upem = self.font["head"].unitsPerEm
        self.cmap = self.font.getBestCmap()
        self.glyphset = self.font.getGlyphSet()
        self.hmtx = self.font["hmtx"]

    def glyph_path(self, ch: str) -> tuple[str, float]:
        name = self.cmap.get(ord(ch))
        if name is None:
            raise KeyError(f"{ch!r} not in {self.font['name'].getDebugName(4)}")
        pen = SVGPathPen(self.glyphset)
        self.glyphset[name].draw(pen)
        return pen.getCommands(), self.hmtx[name][0] / self.upem

    def text_path(self, text: str, size: float, tracking: float = 0.0) -> tuple[str, float, list[float]]:
        """Return (combined path d, total advance width, per-glyph x offsets).

        `tracking` is in em (as CSS letter-spacing is). Paths are emitted in
        font units flipped into a y-down SVG user space at `size`.
        """
        scale = size / self.upem
        parts: list[str] = []
        xs: list[float] = []
        x = 0.0
        for ch in text:
            d, advance = self.glyph_path(ch)
            xs.append(x)
            if d:
                parts.append(f'<path transform="translate({x:.3f} 0) scale({scale:.6f} -{scale:.6f})" d="{d}"/>')
            x += (advance + tracking) * size
        return "".join(parts), x, xs


def svg(width: float, height: float, body: str, bg: str | None = None) -> str:
    ground = f'<rect width="{width}" height="{height}" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img">\n  {ground}\n{body}\n</svg>\n'
    )


# The signature element: a filled redaction bar with the 135 degree hatch that
# DESIGN.md specifies. `defs` emits the pattern once per file.
HATCH_DEFS = f"""  <defs>
    <pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse"
             patternTransform="rotate(135)">
      <rect width="14" height="14" fill="{REDACT}"/>
      <rect width="5" height="14" fill="#000000" fill-opacity="0.16"/>
    </pattern>
  </defs>"""


def bar(x: float, y: float, w: float, h: float, fill: str = "url(#hatch)") -> str:
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="3" fill="{fill}"/>'


def main() -> None:
    display = Face(FONTS / "cabinet-grotesk-700.woff2")
    sans600 = Face(FONTS / "general-sans-600.woff2")

    out = ROOT
    written: list[str] = []

    def emit(name: str, content: str) -> None:
        (out / name).write_text(content, encoding="utf-8")
        written.append(name)

    # ---------------------------------------------------------- 1. wordmark
    # "Veil" in the display face, outlined. Letter-spacing -0.02em per DESIGN.md.
    WM_SIZE = 200.0
    wm_paths, wm_w, _ = display.text_path("Veil", WM_SIZE, tracking=-0.02)
    wm_w -= -0.02 * WM_SIZE  # drop the trailing letter-space

    # Where the "e" starts and the "i" ends, so the redaction can be placed on
    # real glyph metrics rather than guessed.
    _, _, xs = display.text_path("Veil", WM_SIZE, tracking=-0.02)
    e_x, i_x = xs[1], xs[2]
    i_glyph = display.glyph_path("i")[1] * WM_SIZE
    redact_x = e_x
    redact_w = (i_x - e_x) + i_glyph

    PAD = 40.0
    WM_H = 260.0
    # baseline sits at 62% of the band, which centres the cap height on the tile
    wm_baseline_y = WM_H * 0.66
    emit(
        "veil-wordmark.svg",
        svg(
            PAD * 2 + wm_w,
            WM_H,
            "\n".join(
                [
                    f'  <g fill="{INK}" transform="translate({PAD} {wm_baseline_y:.1f})">{wm_paths}</g>',
                ]
            ),
            None,
        ),
    )

    # ------------------------------------------------------- 2. primary lockup
    DESC = "PRIVATE PAYMENT RAILS FOR THE AGENT ECONOMY"
    d_size = 23.0
    d_tracking = 0.18
    d_paths, d_w, _ = sans600.text_path(DESC, d_size, tracking=d_tracking)
    d_w -= d_tracking * d_size

    def _mark_parts(size: float, x: float = 0.0, y: float = 0.0):
        """Geometry shared by both mark forms: a centred V and its bar.

        The bar runs horizontally across the middle of the letterform, leaving
        the V's two top terminals and its bottom vertex showing. A bar that
        follows the diagonal was tried first and reads as a separate red block
        sitting beside a stray stroke; a bar across the middle is the design
        system's own signature element (a redaction bar over hidden text) and it
        is unambiguous at every size.
        """
        v_size = size * 1.02
        v_paths, v_advance, _ = display.text_path("V", v_size, tracking=0)
        x0 = x + (size - v_advance) / 2
        baseline = y + size * 0.80
        cap = v_size * 0.72
        # the bar oversails the letterform slightly, so it reads as a bar laid
        # over the letter rather than as part of it
        oversail = v_advance * 0.06
        bar_x = x0 - oversail
        bar_w = v_advance + oversail * 2
        bar_h = cap * 0.50
        bar_y = baseline - cap * 0.75
        return v_paths, x0, baseline, bar_x, bar_y, bar_w, bar_h

    def mark(size: float, on_dark: bool, x: float = 0.0, y: float = 0.0) -> str:
        """The mark: a 'V' struck through by a redaction bar, on a graphite tile."""
        v_paths, x0, baseline, bx, by, bw, bh = _mark_parts(size, x, y)
        ground = (
            f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="4" fill="{GRAPHITE}"/>'
        )
        return (
            f'  {ground}\n'
            f'  <g fill="{PAPER}" transform="translate({x0:.1f} {baseline:.1f})">{v_paths}</g>\n'
            f'  {bar(bx, by, bw, bh)}'
        )

    def mark_on_ground(size: float, ground_fill: str | None, letter: str) -> str:
        """The same mark on a chosen ground, for placing on a light surface."""
        v_paths, x0, baseline, bx, by, bw, bh = _mark_parts(size)
        tile = (
            f'  <rect width="{size}" height="{size}" rx="4" fill="{ground_fill}"/>\n'
            if ground_fill
            else ""
        )
        return (
            f"{tile}"
            f'  <g fill="{letter}" transform="translate({x0:.1f} {baseline:.1f})">{v_paths}</g>\n'
            f'  {bar(bx, by, bw, bh)}'
        )

    L_W, L_H = 1320.0, 340.0
    mark_x, mark_s = 56.0, 148.0
    wm_baseline = 196.0
    # baseline-align the mark with the wordmark, so the tile's bottom edge and
    # the text baseline sit on one line
    mark_y = wm_baseline - mark_s
    text_x = mark_x + mark_s + 54.0

    for name, bg, ink, muted, on_dark in (
        ("veil-logo.svg", PAPER, INK, MUTED, False),
        ("veil-logo-dark.svg", GRAPHITE, TEXT_DARK, MUTED_DARK, True),
    ):
        parts = [
            HATCH_DEFS,
            mark(mark_s, on_dark, mark_x, mark_y),
            f'  <g fill="{ink}" transform="translate({text_x} {wm_baseline:.1f})">{wm_paths}</g>',
            f'  <g fill="{muted}" transform="translate({text_x + 4} {wm_baseline + 62:.1f})">{d_paths}</g>',
            f'  <rect x="{text_x + 4}" y="{wm_baseline + 82:.1f}" width="{d_w:.1f}" height="1" fill="{RULE_DARK if on_dark else RULE}"/>',
        ]
        emit(name, svg(L_W, L_H, "\n".join(parts), bg))

    # ------------------------------------------------------------- 3. the mark
    # The app-icon form: a graphite tile, so it reads as a solid shape at any
    # size, and the on-paper form: transparent ground, ink letterform, for
    # placing on a light surface.
    M = 512.0
    # HATCH_DEFS must be emitted in every file that draws a bar: the bar's fill
    # is a `url(#hatch)` reference, and a pattern that is not defined in the same
    # document resolves to no fill at all — a redaction bar that silently
    # disappears is the one bug this mark cannot have.
    emit("veil-mark.svg", svg(M, M, "\n".join([HATCH_DEFS, mark(M, False, 0.0, 0.0)]), None))
    emit(
        "veil-mark-on-paper.svg",
        svg(M, M, "\n".join([HATCH_DEFS, mark_on_ground(M, PAPER, INK)]), None),
    )

    # -------------------------------------------- 4. redacted wordmark variant
    # The concept-led lockup: the "ei" struck out, the word still legible.
    R_W, R_H = PAD * 2 + wm_w, WM_H + 8
    emit(
        "veil-wordmark-redacted.svg",
        svg(
            R_W,
            R_H,
            "\n".join(
                [
                    HATCH_DEFS,
                    f'  <g fill="{INK}" transform="translate({PAD} {R_H * 0.66:.1f})">{wm_paths}</g>',
                    bar(PAD + redact_x, R_H * 0.66 - WM_SIZE * 0.72, redact_w, WM_SIZE * 0.72),
                ]
            ),
            None,
        ),
    )

    print(f"wrote {len(written)} files to {out}")
    for w in written:
        print(" ", w)


if __name__ == "__main__":
    main()
