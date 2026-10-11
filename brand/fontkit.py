"""Turn strings into SVG paths, so brand assets carry no font dependency.

A diagram or a logo that needs a webfont installed is not a portable asset: it
renders differently (or falls back to a system face) in a PDF, in an image
viewer, or on a machine that has never seen the font. Converting to outlines
removes the dependency entirely.

Used by `build-logo.py` and `build-diagram.py`.
"""

from __future__ import annotations

from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

FONT_DIR = (
    Path(__file__).resolve().parent.parent / "video" / "veil-video" / "assets" / "fonts"
)

# Typographic characters the display and mono faces do not all carry. Substituted
# rather than allowed to raise: a diagram that fails to build because of an
# em dash is a worse outcome than one that prints a hyphen.
FALLBACK = {
    "\u2192": "->",  # rightwards arrow
    "\u2190": "<-",  # leftwards arrow
    "\u21d2": "=>",
    "\u2212": "-",  # minus sign
    "\u2013": "-",  # en dash
    "\u2014": "-",  # em dash
    "\u00b7": "-",  # middle dot
    "\u2022": "-",  # bullet
    "\u2264": "<=",
    "\u2265": ">=",
    "\u00a0": " ",  # nbsp
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
}


class Face:
    """One font, ready to turn strings into SVG path data."""

    def __init__(self, filename: str) -> None:
        self.font = TTFont(str(FONT_DIR / filename))
        self.font.flavor = None  # decompress woff2 -> raw sfnt so glyphs are readable
        self.upem = self.font["head"].unitsPerEm
        self.cmap = self.font.getBestCmap()
        self.glyphset = self.font.getGlyphSet()
        self.hmtx = self.font["hmtx"]
        self.name = self.font["name"].getDebugName(4) or filename

    def sanitize(self, text: str) -> str:
        """Replace characters this face has no glyph for."""
        missing = {ch for ch in text if ord(ch) not in self.cmap and not ch.isspace()}
        if not missing:
            return text
        for ch in sorted(missing):
            replacement = FALLBACK.get(ch, "?")
            print(f"  note: {self.name} has no {ch!r}; using {replacement!r}")
            text = text.replace(ch, replacement)
        return text

    def advance(self, text: str, size: float, tracking: float = 0.0) -> float:
        """Width of `text` set at `size` with `tracking` em of letter-spacing."""
        text = self.sanitize(text)
        total = 0.0
        for ch in text:
            glyph = self.cmap.get(ord(ch))
            if glyph is None:
                continue
            total += (self.hmtx[glyph][0] / self.upem + tracking) * size
        return total - tracking * size

    def text_path(self, text: str, size: float, tracking: float = 0.0) -> tuple[str, float]:
        """Return (path markup, advance width).

        Emits `<path>` elements in a y-down SVG user space at `size`, positioned
        from x=0. Wrap the result in a `<g transform="translate(x baseline)">`.
        """
        text = self.sanitize(text)
        scale = size / self.upem
        parts: list[str] = []
        x = 0.0
        for ch in text:
            glyph = self.cmap.get(ord(ch))
            if glyph is None:
                continue
            pen = SVGPathPen(self.glyphset)
            self.glyphset[glyph].draw(pen)
            d = pen.getCommands()
            if d:
                parts.append(
                    f'<path transform="translate({x:.3f} 0) scale({scale:.6f} -{scale:.6f})" d="{d}"/>'
                )
            x += (self.hmtx[glyph][0] / self.upem + tracking) * size
        return "".join(parts), x


def label(
    face: Face,
    text: str,
    size: float,
    x: float,
    baseline: float,
    fill: str,
    tracking: float = 0.0,
    anchor: str = "start",
) -> str:
    """One positioned run of outlined text."""
    if not text:
        return ""
    paths, width = face.text_path(text, size, tracking)
    if anchor == "middle":
        x -= width / 2
    elif anchor == "end":
        x -= width
    return f'  <g fill="{fill}" transform="translate({x:.2f} {baseline:.2f})">{paths}</g>'
