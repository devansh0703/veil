#!/usr/bin/env python3
"""Prove the snapshots are genuinely self-contained.

Loads each finalized.html from disk over file://, aborts every non-file request,
and asserts the faces still resolve, the layout still computes, and nothing
overflows — i.e. the artifact a reviewer opens offline is the design that was
verified, not a fallback rendering.
"""
import glob
import json
import os

from playwright.sync_api import sync_playwright

DESIGNS = "/home/devansh/colosseum/.gstack/projects/devansh/designs"
EXPECT = {"index": "paper", "limits": "paper",
          "402": "graphite", "dashboard": "graphite"}
WIDTHS = [375, 1440]


def main():
    files = sorted(glob.glob(os.path.join(DESIGNS, "*-20261002", "finalized.html")))
    report, bad = {}, 0
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        for f in files:
            name = os.path.basename(os.path.dirname(f)).replace("-20261002", "")
            for w in WIDTHS:
                ctx = browser.new_context(viewport={"width": w, "height": 900})
                blocked = []
                # nothing may leave the machine
                ctx.route("**/*", lambda route: (
                    blocked.append(route.request.url),
                    route.abort()) if not route.request.url.startswith("file://")
                    else route.continue_())
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto("file://" + f, wait_until="load")
                page.wait_for_timeout(700)
                m = page.evaluate("""() => {
                  const de=document.documentElement;
                  return {
                    ground: de.getAttribute('data-ground'),
                    overflow: Math.max(de.scrollWidth, document.body.scrollWidth) - de.clientWidth,
                    pretext: !!window.Pretext,
                    faces: {
                      display: document.fonts.check('700 44px "Cabinet Grotesk"'),
                      body: document.fonts.check('400 16px "General Sans"'),
                      semibold: document.fonts.check('600 14px "General Sans"'),
                      mono400: document.fonts.check('400 13px "JetBrains Mono"'),
                      mono600: document.fonts.check('600 13px "JetBrains Mono"'),
                    },
                    bars: document.querySelectorAll('.redaction-bar').length,
                    flow: document.querySelectorAll('.obstacle-host .line').length
                  };
                }""")
                missing = [k for k, v in m["faces"].items() if not v]
                key = "%s-%d" % (name, w)
                ok = (not missing and m["overflow"] == 0 and m["pretext"]
                      and m["ground"] == EXPECT[name] and not errors)
                if not ok:
                    bad += 1
                report[key] = {**m, "blocked_requests": sorted(set(blocked)),
                               "page_errors": errors, "ok": ok}
                print("%-18s %s ground=%-8s overflow=%-3d pretext=%s faces=%-9s bars=%-3d blocked=%d"
                      % (key, "OK  " if ok else "FAIL", m["ground"], m["overflow"],
                         m["pretext"], "all" if not missing else "MISSING:" + ",".join(missing),
                         m["bars"], len(set(blocked))))
                ctx.close()
        browser.close()
    out = os.path.join(DESIGNS, "shots-20261002", "offline-report.json")
    with open(out, "w") as fh:
        json.dump(report, fh, indent=2)
    print("\n%d failure(s) — report: %s" % (bad, out))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
