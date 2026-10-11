# Veil brand assets

The mark and the lockups, as SVG with the wordmark converted to real vector
outlines. Nothing here needs a font installed: the letterforms are geometry, so
the files render identically in a browser, in a PDF, on a slide and in a
submission form.

```
brand/
  veil-logo.svg                  primary lockup — mark + wordmark + descriptor, on paper
  veil-logo-dark.svg             the same lockup on graphite
  veil-mark.svg                  square mark on a graphite tile (app icon, avatar, favicon)
  veil-mark-on-paper.svg         the same mark on a paper tile, for light surfaces
  veil-wordmark.svg              the wordmark alone
  veil-wordmark-redacted.svg     the concept-led form: "V" + redaction bar + "l"
  png/                           raster exports for a form upload
  build-logo.py                  generates every SVG
  build-png.mjs                  rasterises the SVGs with Chrome
```

## The idea

**The mark is a V struck through by a redaction bar.**

The product's whole claim is a negative — *you cannot read this amount* — so the
mark is that claim applied to the product's own initial: the letterform is
unmistakably there, and a band of redaction ink sits across it. It is the same
element the dashboard uses over a hidden amount, at the same angle, in the same
red.

**One red, three treatments** (`DESIGN.md`): the bar is `#B4341F`, the redaction
ink — which is also the brand accent and the error treatment. Because brand and
error share a hue, error states never rely on colour alone; every one carries a
code, a glyph and words.

**Square corners.** 4px on the tile, 3px on the bar. A record does not have
bubbly edges.

**No gradients, no shadows, no neon.** The category default for a crypto product
is a dark ground with a neon accent and a 3D render. A privacy claim must not
look like that: it reads as a token, not as a record.

## Where the values come from

Every colour and dimension is a token in `DESIGN.md`, not a value invented here:

| Element | Value | Token |
|---|---|---|
| Tile | `#101114` | `surface-dark` (graphite) |
| Letterform | `#F2F2F0` | `surface` (paper) |
| Bar | `#B4341F` | `primary` / `redact-fill` — the only red a white label may sit on, 6.08:1 on both grounds |
| Wordmark | `#17161A` | `text` (ink) |
| Descriptor | `#6B6862` | `text-muted` |
| Rule | `#D5D5D1` | `rule` |
| Tile radius | 4px | `rounded.lg` |
| Bar radius | 3px | `rounded.md` |
| Display face | Cabinet Grotesk 700 | `typography.display` |
| Descriptor face | General Sans 600, 0.18em tracking | `typography.label` |

## Regenerating

```bash
# SVGs (needs fontTools + brotli for the woff2 source; uv fetches them)
uv run --with fonttools --with brotli python3 brand/build-logo.py

# PNG exports (uses the local Chrome so the hatch pattern rasterises correctly)
node brand/build-png.mjs
```

`build-logo.py` reads the self-hosted faces out of
`video/veil-video/assets/fonts/` and converts each glyph to an SVG path with
`fontTools`, so the wordmark is outlines rather than `<text>`.

## A note on the redaction bar and small sizes

The bar carries the 135° hatch `DESIGN.md` specifies. At a 16–32px favicon the
stripes fall below one pixel and the bar renders as a flat red band, which is the
intended reading — the hatch is a detail, the bar is the mark. `png/veil-mark-256.png`
is the smallest export worth using; below that, use the solid-bar form by setting
`fill` on the bar to `#B4341F` instead of `url(#hatch)`.

## Usage

- **App icon / avatar / favicon:** `veil-mark.svg` (or `png/veil-mark-512.png`)
- **Site header, deck, README:** `veil-logo.svg` on a light ground, `veil-logo-dark.svg` on a dark one
- **Submission form logo field:** `png/veil-logo-1600.png` or `png/veil-mark-1024.png`
- **Minimum clear space:** the height of the "V" on every side
- **Do not** recolour the bar, add a shadow, rotate the mark, or place the lockup
  on a mid-tone ground where the graphite tile and the ink wordmark have similar
  luminance.
