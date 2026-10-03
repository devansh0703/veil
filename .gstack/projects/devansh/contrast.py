#!/usr/bin/env python3
"""WCAG 2.2 contrast sweep for the Veil token set.

DESIGN.md asserts measured ratios, so any change to a ground or a semantic hue
has to be re-measured rather than assumed — a hue swap does not preserve a ratio,
and a lifted accent that passes as text fails as a fill.

Usage: python3 contrast.py            # evaluate the shipped palette
       python3 contrast.py --paper '#F1F1EF'   # try a candidate ground
"""
import sys


def hexv(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(h):
    r, g, b = (lin(c) for c in hexv(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# ── the palette as it currently ships ────────────────────────────────────────
SKIN = {
    "paper": "#F4F1EA", "ink": "#17161A", "muted": "#6B6862",
    "rule": "#D8D3C8", "tint": "#EDE9DF",
    "graphite": "#101114", "raise": "#17181C", "fg": "#E8E6E1",
    "muted_dark": "#8A8C93", "rule_dark": "#2A2C31", "tint_dark": "#1D1F24",
    "redact": "#B4341F", "redact_dark": "#DE523C", "redact_fill": "#B4341F",
    "on_redact": "#FFFFFF",
    "success": "#2C7755", "success_dark": "#3E9C6B",
    "warning": "#8A611E", "warning_dark": "#C99A3B",
    "error": "#B8402A", "error_dark": "#DE523C",
}

# Pairs that carry meaning: (label, foreground, background, floor).
#
# Note on the hairline rules. WCAG 1.4.11 asks 3:1 of *UI components* and of
# graphical objects *required to understand the content*. A 1px row divider is
# neither: the table's structure is carried by <th scope>, <caption> and the
# row order, so the rule is decoration and takes no floor. Raising it to 3:1
# would put a hard black grid on a ledger — the opposite of the intent. What
# genuinely needs 3:1 is the focus indicator, which is checked separately below.
def pairs(s):
    return [
        ("light · body ink on paper",        s["ink"], s["paper"], 4.5),
        ("light · muted on paper",           s["muted"], s["paper"], 4.5),
        ("light · redact ink on paper",      s["redact"], s["paper"], 4.5),
        ("light · success on paper",         s["success"], s["paper"], 4.5),
        ("light · warning on paper",         s["warning"], s["paper"], 4.5),
        ("light · error on paper",           s["error"], s["paper"], 4.5),
        ("light · white on redact fill",     s["on_redact"], s["redact_fill"], 4.5),
        ("light · ink on tint",              s["ink"], s["tint"], 4.5),
        ("light · rule on paper (decorative)", s["rule"], s["paper"], 0.0),
        ("light · muted on tint",            s["muted"], s["tint"], 4.5),
        ("dark · fg on graphite",            s["fg"], s["graphite"], 4.5),
        ("dark · muted on graphite",         s["muted_dark"], s["graphite"], 4.5),
        ("dark · redact on graphite",        s["redact_dark"], s["graphite"], 4.5),
        ("dark · success on graphite",       s["success_dark"], s["graphite"], 4.5),
        ("dark · warning on graphite",       s["warning_dark"], s["graphite"], 4.5),
        ("dark · error on graphite",         s["error_dark"], s["graphite"], 4.5),
        ("dark · white on redact fill",      s["on_redact"], s["redact_fill"], 4.5),
        ("dark · fg on raise",               s["fg"], s["raise"], 4.5),
        ("dark · muted on raise",            s["muted_dark"], s["raise"], 4.5),
        ("dark · muted on tint-dark",        s["muted_dark"], s["tint_dark"], 4.5),
        ("dark · rule-dark on graphite (decorative)", s["rule_dark"], s["graphite"], 0.0),
        # 1.4.11: the keyboard focus ring is a real UI indicator and needs 3:1
        # against the adjacent ground on both grounds.
        ("focus ring (accent) on paper", s["redact"], s["paper"], 3.0),
        ("focus ring (accent) on graphite", s["redact_dark"], s["graphite"], 3.0),
        ("focus ring on surface-raise (dark)", s["redact_dark"], s["raise"], 3.0),
    ]


def main():
    s = dict(SKIN)
    if "--paper" in sys.argv:
        s["paper"] = sys.argv[sys.argv.index("--paper") + 1]
    if "--rule" in sys.argv:
        s["rule"] = sys.argv[sys.argv.index("--rule") + 1]
    if "--tint" in sys.argv:
        s["tint"] = sys.argv[sys.argv.index("--tint") + 1]
    if "--muted" in sys.argv:
        s["muted"] = sys.argv[sys.argv.index("--muted") + 1]

    print("ground: paper=%s rule=%s tint=%s muted=%s\n"
          % (s["paper"], s["rule"], s["tint"], s["muted"]))
    fails = 0
    for label, fg, bg, floor in pairs(s):
        r = ratio(fg, bg)
        if floor == 0.0:
            print("  %-36s %s on %s = %5.2f:1  decorative, no floor"
                  % (label, fg, bg, r))
            continue
        ok = r >= floor
        if not ok:
            fails += 1
        print("  %-36s %s on %s = %5.2f:1  need %.1f  %s"
              % (label, fg, bg, r, floor, "PASS" if ok else "** FAIL **"))
    print("\n%d failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
