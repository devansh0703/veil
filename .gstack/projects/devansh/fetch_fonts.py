#!/usr/bin/env python3
"""Vendor the two Fontshare faces into web/assets/fonts/ — correctly.

Why this exists: Fontshare serves protocol-relative `//cdn.fontshare.com/...`
URLs, so over plain http the display face silently falls back. And Fontshare
appends its own default family (Satoshi) to a response, so selecting blocks by
weight alone downloads the wrong face — the first attempt at this shipped
Satoshi 500/700 named `cabinet-grotesk-*.woff2`.

So a block is accepted only when its CSS `font-family` equals the family being
requested. The CSS descriptor is the authority the browser obeys; it is what
the page's stylesheet asks for, and the file's own name table cannot be used as
a second opinion: Fontshare obfuscates the hosted webfont's family, full and
postscript names to the literal string "false", leaving only a subfamily that
disagrees with the declared weight (the file served under `font-weight: 700`
reports subfamily 'Medium'). The internal names are therefore reported as a
note, never as a pass/fail gate.

JetBrains Mono is vendored too, but as ONE variable file. Google's css2 response
points the 400/500/600 blocks at the same woff2 whose `fvar` axis spans
wght 400-800, so a single @font-face with `font-weight: 400 800` is both correct
and smaller than three declarations — and it drops the last CDN fetch, which is
what makes a built snapshot genuinely offline.
"""
import os
import re
import shutil
import urllib.request

from fontTools.ttLib import TTFont

ROOT = "/home/devansh/colosseum/web/assets"
OUT = os.path.join(ROOT, "fonts")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# requested family -> (css family name to require, weights, expected subfamily)
JOBS = [
    # Only the weights the pages actually set. Cabinet Grotesk is display-only at
    # 700 (wordmark, h1, h2), so vendoring 500 would ship a face nothing requests.
    ("cabinet-grotesk", "Cabinet Grotesk", {700: "Bold"},
     "https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700&display=swap"),
    ("general-sans", "General Sans", {400: "Regular", 500: "Medium", 600: "Semibold"},
     "https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap"),
]

# A variable-font job: one file, one @font-face carrying the whole wght range.
VARIABLE = [
    ("jetbrains-mono", "JetBrains Mono",
     "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap"),
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=25).read()


def css_blocks(css):
    for b in re.findall(r"@font-face\s*\{(.*?)\}", css, re.S):
        fam = re.search(r"font-family:\s*'([^']+)'", b)
        wt = re.search(r"font-weight:\s*(\d+)", b)
        woff2 = [u for u in re.findall(r"url\((['\"]?)([^'\")]+)\1\)", b)
                 if u[1].endswith(".woff2")]
        if fam and wt and woff2:
            yield fam.group(1), int(wt.group(1)), woff2[0][1]


def font_names(path):
    t = TTFont(path)  # not lazy: lazy woff2 reads return junk name strings
    try:
        nm = t["name"]
        family = (nm.getDebugName(16) or nm.getDebugName(1) or "")
        sub = (nm.getDebugName(17) or nm.getDebugName(2) or "")
        return family, sub
    finally:
        t.close()


def latin_block_woff2(css, family):
    """Google splits by unicode-range; the plain `latin` run is the one with
    U+0000-00FF, and it is the only one a latin page needs inlined."""
    for b in re.findall(r"@font-face\s*\{(.*?)\}", css, re.S):
        fam = re.search(r"font-family:\s*'([^']+)'", b)
        rng = re.search(r"unicode-range:\s*([^;]+);", b)
        if not fam or fam.group(1) != family:
            continue
        if rng and "U+0000-00FF" not in rng.group(1):
            continue
        urls = [u for u in re.findall(r"url\((https://[^)]+\.woff2)\)", b)]
        if urls:
            return urls[0]
    return None


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    accepted, rejected = [], []
    for slug, css_family, weights, css_url in JOBS:
        css = get(css_url).decode("utf-8", "replace")
        available = {}
        for fam, wt, url in css_blocks(css):
            if fam == css_family and wt in weights:
                available.setdefault(wt, url)
        for wt, want_sub in weights.items():
            if wt not in available:
                rejected.append((slug, wt, "no block for this family/weight"))
                continue
            url = available[wt]
            url = "https:" + url if url.startswith("//") else url
            name = "%s-%d.woff2" % (slug, wt)
            path = os.path.join(OUT, name)
            with open(path, "wb") as f:
                f.write(get(url))
            family, sub = font_names(path)
            if family == "false":
                # Fontshare's deliberate obfuscation — expected, not a failure.
                family = css_family
            notes = []
            if family != css_family:
                notes.append("internal family=%r" % family)
            if sub and sub.lower().replace("-", "") != want_sub.lower().replace("-", ""):
                notes.append("internal subfamily=%r, declared weight %d" % (sub, wt))
            accepted.append((name, css_family, wt, sub, os.path.getsize(path), notes))

    # ── the variable mono: verify the axis before trusting one file for 3 weights
    variable = []
    for slug, css_family, css_url in VARIABLE:
        url = latin_block_woff2(get(css_url).decode("utf-8", "replace"), css_family)
        if not url:
            rejected.append((slug, 0, "no latin block for this family"))
            continue
        name = "%s-var.woff2" % slug
        path = os.path.join(OUT, name)
        with open(path, "wb") as f:
            f.write(get(url))
        t = TTFont(path)
        axes = [(a.axisTag, a.minValue, a.maxValue) for a in t["fvar"].axes] \
            if "fvar" in t else []
        t.close()
        wght = [a for a in axes if a[0] == "wght"]
        if not wght:
            rejected.append((slug, 0, "not a variable font — no wght axis"))
            os.remove(path)
            continue
        lo, hi = int(wght[0][1]), int(wght[0][2])
        variable.append((name, css_family, lo, hi, os.path.getsize(path)))

    css_path = os.path.join(ROOT, "fonts.css")
    with open(css_path, "w") as f:
        f.write("/* Self-hosted display + body faces.\n"
                "   Fontshare serves protocol-relative CDN URLs, so over plain http the\n"
                "   page fell back to Georgia; these are local so the poster headline is\n"
                "   deterministic. Blocks are matched on the CSS font-family descriptor,\n"
                "   because Fontshare appends its own default family (Satoshi) to a\n"
                "   response — a weight-only filter downloads the wrong face — and it\n"
                "   obfuscates the hosted file's internal names to \"false\".\n"
                "   Cabinet Grotesk and General Sans: Fontshare free licence.\n"
                "   JetBrains Mono stays on Google Fonts: its URLs are absolute https. */\n\n")
        for name, family, wt, sub, _size, _notes in accepted:
            f.write("@font-face{\n"
                    "  font-family:'%s';\n"
                    "  font-style:normal;\n"
                    "  font-weight:%d;\n"
                    "  font-display:block;\n"
                    "  src:url('fonts/%s') format('woff2');\n"
                    "}\n" % (family, wt, name))
        for name, family, lo, hi, _size in variable:
            f.write("@font-face{\n"
                    "  font-family:'%s';\n"
                    "  font-style:normal;\n"
                    "  font-weight:%d %d;   /* variable: one file, every weight */\n"
                    "  font-display:block;\n"
                    "  src:url('fonts/%s') format('woff2');\n"
                    "}\n" % (family, lo, hi, name))

    for name, family, wt, sub, size, notes in accepted:
        print("ok      %-24s %-16r w%-4d %-10r %6d B"
              % (name, family, wt, sub, size))
        for n in notes:
            print("          note: %s" % n)
    for name, family, lo, hi, size in variable:
        print("ok      %-24s %-16r wght %d-%d  %6d B  (variable)"
              % (name, family, lo, hi, size))
    for slug, wt, why in rejected:
        print("REJECT  %-24s %s" % ("%s-%d" % (slug, wt), why))
    print("\naccepted %d static + %d variable, rejected %d, wrote %s"
          % (len(accepted), len(variable), len(rejected), css_path))


if __name__ == "__main__":
    main()
