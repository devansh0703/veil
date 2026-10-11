#!/usr/bin/env node
// Render the brand SVGs to PNG at the sizes a submission form and a favicon
// actually want.
//
//   node brand/build-png.mjs
//
// Chrome does the rasterising, so what is exported is what a browser shows —
// including the redaction bar's hatch pattern, which some SVG rasterisers drop.
// The SVG is embedded in a wrapper page at the exact target width rather than
// relying on a device-scale factor, so the output dimensions are exact.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'png');
mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_BIN ||
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  });

if (!CHROME) {
  console.error('no Chrome binary found — set CHROME_BIN');
  process.exit(2);
}

// file -> [ [width, suffix], … ]
const JOBS = {
  'veil-logo.svg': [
    [1600, '1600'],
    [800, '800'],
  ],
  'veil-logo-dark.svg': [
    [1600, '1600'],
    [800, '800'],
  ],
  'veil-mark.svg': [
    [1024, '1024'],
    [512, '512'],
    [256, '256'],
  ],
  'veil-mark-on-paper.svg': [
    [1024, '1024'],
    [512, '512'],
  ],
  'veil-wordmark.svg': [[1200, '1200']],
  'veil-wordmark-redacted.svg': [[1200, '1200']],
  // 0 means "the SVG's own size" — the diagram's canvas is derived from its
  // content, so pinning a width here would letterbox it.
  'veil-architecture.svg': [[0, 'full']],
};

const dims = (svg) => {
  const w = Number(svg.match(/width="([\d.]+)"/)[1]);
  const h = Number(svg.match(/height="([\d.]+)"/)[1]);
  return { w, h };
};

let count = 0;
for (const [file, sizes] of Object.entries(JOBS)) {
  const svg = readFileSync(join(HERE, file), 'utf8');
  const { w, h } = dims(svg);
  for (const [targetRaw, suffix] of sizes) {
    const target = targetRaw === 0 ? Math.round(w) : targetRaw;
    const height = Math.round((h / w) * target);
    // Re-emit the SVG with explicit pixel dimensions so the wrapper lays it out
    // at exactly the target size.
    const scaled = svg
      .replace(/width="[\d.]+"/, `width="${target}"`)
      .replace(/height="[\d.]+"/, `height="${height}"`)
      .replace('<svg ', '<svg style="display:block" ');
    const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block}</style>
${scaled}`;
    const tmp = join(OUT, `.wrap-${suffix}.html`);
    writeFileSync(tmp, page);
    const name = file.replace(/\.svg$/, `-${suffix}.png`);
    execFileSync(
      CHROME,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--screenshot=${join(OUT, name)}`,
        `--window-size=${target},${height}`,
        `file://${tmp}`,
      ],
      { stdio: 'ignore' },
    );
    rmSync(tmp);
    const bytes = statSync(join(OUT, name)).size;
    console.log(`${name.padEnd(38)} ${String(target).padStart(5)}x${String(height).padEnd(5)} ${bytes} bytes`);
    count++;
  }
}

console.log(`\n${count} PNG exports written to brand/png/`);
