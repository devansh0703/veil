#!/usr/bin/env node
// Sync a composition's caption lines and <audio> clips from a measured
// voiceover manifest, so what is on screen can never drift from what is heard.
//
//   node scripts/sync-audio.mjs --comp demo.html --meta audio_demo.json --prefix d
//
// The composition marks the two regions it owns:
//
//   <!-- captions:begin -->  …  <!-- captions:end -->
//   <!-- audio:begin -->     …  <!-- audio:end -->
//
// Everything inside those markers is generated. Everything outside is left
// exactly as authored.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// `--project <dir>` lets one sync script serve both video projects.
const projIdx = process.argv.indexOf('--project');
const PROJECT = projIdx === -1 ? resolve(HERE, '..') : resolve(process.cwd(), process.argv[projIdx + 1]);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const comp = arg('comp');
const metaPath = arg('meta');
const prefix = arg('prefix', '');
if (!comp || !metaPath) {
  console.error('usage: sync-audio.mjs --comp <file.html> --meta <manifest.json> [--prefix p]');
  process.exit(2);
}

const meta = JSON.parse(readFileSync(resolve(PROJECT, metaPath), 'utf8'));
const htmlPath = resolve(PROJECT, comp);
let html = readFileSync(htmlPath, 'utf8');

const num = (n) => {
  const s = Number(n).toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const captions = meta.segments
  .map(
    (s) =>
      `        <div class="clip cap" id="${prefix}cap-${s.n}" data-start="${num(s.voStart)}" ` +
      `data-duration="${num(s.duration)}">${esc(s.text)}</div>`,
  )
  .join('\n');

const audio = meta.segments
  .map(
    (s) =>
      `      <audio id="${prefix}vo-${s.n}" src="${s.file}" data-start="${num(s.voStart)}" ` +
      `data-duration="${num(s.duration)}" data-track-index="10" data-volume="1"></audio>`,
  )
  .join('\n');

function swap(source, begin, end, body) {
  const b = source.indexOf(begin);
  const e = source.indexOf(end);
  if (b === -1 || e === -1) throw new Error(`markers not found: ${begin} / ${end}`);
  return source.slice(0, b + begin.length) + '\n' + body + '\n      ' + source.slice(e);
}

html = swap(html, '<!-- captions:begin -->', '<!-- captions:end -->', captions);
html = swap(html, '<!-- audio:begin -->', '<!-- audio:end -->', audio);

writeFileSync(htmlPath, html);
const last = Math.max(...meta.segments.map((s) => s.voStart + s.duration));
console.log(
  `${comp}: ${meta.segments.length} clips synced from ${metaPath}; ` +
    `last narration ends at ${last.toFixed(2)}s`,
);
