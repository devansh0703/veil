#!/usr/bin/env python3
"""Screenshot every Veil surface at the three documented breakpoints.

Uses the system Chromium (installed) through Playwright. Serves web/ over
localhost so relative asset paths resolve exactly as they will in production.
Also captures console + page errors and flags horizontal overflow per page.
"""
import http.server
import socketserver
import threading
import functools
import os
import sys
import json

from playwright.sync_api import sync_playwright

ROOT = "/home/devansh/colosseum/web"
OUT = "/home/devansh/colosseum/.gstack/projects/devansh/designs/shots-20261002"
PAGES = ["index.html", "dashboard.html", "limits.html", "402.html"]
WIDTHS = [375, 768, 1440]

os.makedirs(OUT, exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def picked_browser(p):
    """Prefer Playwright's own Chromium; fall back to a system binary."""
    for kwargs in ({}, {"channel": "chromium"},
                   {"executable_path": "/usr/bin/google-chrome"},
                   {"executable_path": "/usr/bin/chromium-browser"}):
        try:
            return p.chromium.launch(args=["--no-sandbox"], **kwargs)
        except Exception:
            continue
    raise RuntimeError("no chromium could be launched")


def main():
    httpd, port = serve()
    report = {}
    with sync_playwright() as p:
        browser = picked_browser(p)
        for page_name in PAGES:
            expect = "graphite" if page_name in ("dashboard.html", "402.html") else "paper"
            for w in WIDTHS:
                ctx = browser.new_context(
                    viewport={"width": w, "height": 900},
                    device_scale_factor=2,
                    reduced_motion="no-preference",
                )
                page = ctx.new_page()
                errors, console = [], []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: console.append(m.type + ": " + m.text)
                        if m.type in ("error", "warning") else None)
                page.goto("http://127.0.0.1:%d/%s" % (port, page_name),
                          wait_until="networkidle")
                page.wait_for_timeout(900)  # fonts + Pretext relayout
                # measure overflow and ground
                m = page.evaluate("""() => {
                  const de = document.documentElement;
                  const body = document.body;
                  return {
                    scrollW: Math.max(de.scrollWidth, body.scrollWidth),
                    clientW: de.clientWidth,
                    ground: de.getAttribute('data-ground'),
                    pretext: !!window.Pretext,
                    faces: {
                      display: document.fonts.check('700 44px "Cabinet Grotesk"'),
                      body: document.fonts.check('400 16px "General Sans"'),
                      semibold: document.fonts.check('600 14px "General Sans"'),
                      mono: document.fonts.check('500 13px "JetBrains Mono"'),
                    },
                    loaded: [].slice.call(document.fonts).length,
                    tokens: getComputedStyle(de).getPropertyValue('--redact-fill').trim(),
                    bars: document.querySelectorAll('.redaction-bar').length,
                    lines: document.querySelectorAll('.obstacle-host .line').length
                  };
                }""")
                stem = "%s-%d" % (page_name.replace(".html", ""), w)
                page.screenshot(path=os.path.join(OUT, stem + ".png"), full_page=True)
                bad = [k for k, v in m["faces"].items() if not v]
                report[stem] = {
                    "overflow": m["scrollW"] - m["clientW"],
                    "ground": m["ground"], "ground_ok": m["ground"] == expect,
                    "pretext": m["pretext"], "redact_fill": m["tokens"],
                    "faces": m["faces"], "fonts_loaded": m["loaded"],
                    "bars": m["bars"], "flow_lines": m["lines"],
                    "page_errors": errors[:5], "console": console[:8],
                }
                print("%-24s overflow=%-4d ground=%-8s pretext=%s bars=%-3d flow=%d faces=%s"
                      % (stem, m["scrollW"] - m["clientW"], m["ground"],
                         m["pretext"], m["bars"], m["lines"],
                         "all-5" if not bad else "MISSING:" + ",".join(bad)))
                if errors:
                    print("   PAGE ERRORS:", errors[:3])
                ctx.close()
        browser.close()
    httpd.shutdown()
    with open(os.path.join(OUT, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print("\nreport:", os.path.join(OUT, "report.json"))


if __name__ == "__main__":
    sys.exit(main())
