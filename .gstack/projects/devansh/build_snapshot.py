#!/usr/bin/env python3
"""Build a self-contained snapshot of a Veil surface.

The app is four pages sharing assets/. That is the right shape to ship, but it
means a reviewer has to run a server. A snapshot inlines tokens.css, app.css,
fonts.css (with the woff2 files embedded as base64), veil.js and pretext.js into
one file that opens from the filesystem with no network and no server — which is
also the only form that survives being emailed or dropped in a submission zip.

Usage: python3 build_snapshot.py <page.html> <out-dir>
"""
import base64
import os
import re
import sys

WEB = "/home/devansh/colosseum/web"


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def inline_fonts(css_path):
    """fonts.css references fonts/*.woff2 — embed them so nothing is fetched."""
    css = read(css_path)
    base = os.path.dirname(css_path)

    def sub(m):
        rel = m.group(1)
        p = os.path.join(base, rel)
        with open(p, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return "url(data:font/woff2;base64,%s) format('woff2')" % b64

    return re.sub(r"url\('([^']+\.woff2)'\)\s*format\('woff2'\)", sub, css)


def build(page, out_dir):
    html = read(os.path.join(WEB, page))

    tokens = read(os.path.join(WEB, "assets/tokens.css"))
    app = read(os.path.join(WEB, "assets/app.css"))
    fonts = inline_fonts(os.path.join(WEB, "assets/fonts.css"))
    veil = read(os.path.join(WEB, "assets/veil.js"))
    pretext = read(os.path.join(WEB, "assets/pretext.js"))

    style = "<style>\n%s\n%s\n%s\n</style>" % (fonts, tokens, app)

    # swap the three local stylesheet links for one inline block
    html = re.sub(
        r'<link rel="stylesheet" href="assets/(?:fonts|tokens|app)\.css">\s*',
        "", html)
    html = html.replace("</head>", style + "\n</head>")

    # swap the two local script tags for one inline block
    html = re.sub(r'<script src="assets/(?:pretext|veil)\.js"></script>\s*', "", html)
    script = ("<script>\n%s\n</script>\n<script>\n%s\n</script>\n" % (pretext, veil))
    html = html.replace("</body>", script + "</body>")

    # the snapshot lives in its own folder, so the shared-site nav links are only
    # meaningful relative to the app; leave them but note the snapshot boundary
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "finalized.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    return out, len(html)


if __name__ == "__main__":
    page, out_dir = sys.argv[1], sys.argv[2]
    path, size = build(page, out_dir)
    print("%-18s -> %-58s %6.1f KB" % (page, path, size / 1024))
