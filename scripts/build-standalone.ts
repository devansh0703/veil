/**
 * scripts/build-standalone.ts — one self-contained HTML file per surface.
 *
 * Why this is a script and not a hand-written file: the surfaces live in `web/`
 * and share CSS and JS. A second, hand-maintained copy of a page is a copy that
 * silently goes stale — it would keep rendering yesterday's ledger, or worse,
 * yesterday's privacy claim. So the standalone artifact is *generated* from the
 * live page on every build, which makes drift impossible rather than unlikely.
 *
 * Everything is inlined: fonts become base64 data URIs, CSS and JS become inline
 * blocks. The result opens from any path with no network and no sibling files,
 * which is what makes it usable as a portable demo artifact.
 *
 *   node scripts/build-standalone.ts            # all four surfaces
 *   node scripts/build-standalone.ts dashboard  # just one
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const OUT = join(ROOT, '.gstack/projects/devansh/designs/standalone-20261002');

const SURFACES = ['index', 'dashboard', 'limits', '402'] as const;

/** Inline a stylesheet, recursively resolving its own `url()` font references. */
async function inlineCss(cssPath: string, depth = 0): Promise<string> {
  if (depth > 4) throw new Error(`@import nesting too deep at ${cssPath}`);
  let css = await readFile(cssPath, 'utf8');

  // Resolve @import by splicing the imported file in place.
  const imports = [...css.matchAll(/@import\s+url\(['"]?([^'")]+)['"]?\)\s*;/g)];
  for (const m of imports) {
    const target = join(cssPath, '..', m[1]!);
    css = css.replace(m[0], await inlineCss(target, depth + 1));
  }

  // Resolve url() against files on disk — fonts, and anything else local.
  const assets = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)];
  for (const m of assets) {
    const ref = m[1]!;
    if (ref.startsWith('data:') || /^https?:/.test(ref)) continue;
    const file = join(cssPath, '..', ref);
    if (!existsSync(file)) {
      throw new Error(`${cssPath} references ${ref}, which does not exist`);
    }
    const buf = await readFile(file);
    const ext = ref.split('.').pop()!.toLowerCase();
    const mime =
      ext === 'woff2' ? 'font/woff2'
      : ext === 'woff' ? 'font/woff'
      : ext === 'ttf' ? 'font/ttf'
      : ext === 'svg' ? 'image/svg+xml'
      : ext === 'png' ? 'image/png'
      : ext === 'css' ? 'text/css'
      : 'application/octet-stream';
    css = css.replace(
      m[0],
      `url(data:${mime};base64,${buf.toString('base64')})`,
    );
  }
  return css;
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/**
 * Splice `insert` in over the first occurrence of `needle`.
 *
 * A function replacer, not a string one, and that is load-bearing. With a string
 * replacement `String.prototype.replace` expands `$&`, `` $` ``, `$'` and `$n`.
 * The minified Pretext bundle contains `$&&D===C`, so `$&` was replaced by the
 * matched text: the literal `</body>` landed in the middle of a JavaScript
 * expression, the script block failed to parse, `window.Pretext` was never
 * assigned, and every page silently degraded to natural text flow. A function
 * replacer disables that expansion entirely.
 */
function splice(html: string, needle: string, insert: string): string {
  if (!html.includes(needle)) {
    throw new Error(`cannot splice: ${needle} not found in the page`);
  }
  return html.replace(needle, () => insert);
}

async function buildOne(name: (typeof SURFACES)[number]): Promise<string> {
  // Two names on disk: "402" is a valid URL stem but not a valid CSS-like token,
  // so the file is `402.html` and the output keeps the same name.
  const source = join(WEB, `${name}.html`);
  let html = await readFile(source, 'utf8');

  const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)];
  const firstSheet = stylesheets[0];
  if (!firstSheet) {
    throw new Error(`${name}.html has no stylesheets to inline`);
  }
  const css = (
    await Promise.all(
      stylesheets.map((m) => inlineCss(join(WEB, m[1]!))),
    )
  ).join('\n\n');
  html = splice(html, firstSheet[0], `<style>\n${indent(css, '  ')}\n</style>`);
  for (const m of stylesheets.slice(1)) html = html.replace(m[0], '');

  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)];
  if (scripts.length === 0) throw new Error(`${name}.html has no scripts to inline`);
  let js = '';
  for (const m of scripts) {
    const text = await readFile(join(WEB, m[1]!), 'utf8');
    // `</script>` anywhere in the source — even inside a string literal — would
    // close this block early, so it is escaped on the way in.
    const safe = text.replaceAll('</script', '<\\/script');
    js += `/* ${m[1]} */\n${safe}\n`;
    html = html.replace(m[0], '');
  }
  html = splice(
    html,
    '</body>',
    `<script>\n${indent(js, '  ')}\n</script>\n</body>`,
  );

  // A standalone artifact cannot be a stale copy of a shared asset set: say so
  // in the file, so anyone who reads it knows how it was produced and what it
  // would take to make it wrong.
  html = splice(
    html,
    '<head>',
    `<head>\n<!-- GENERATED by scripts/build-standalone.ts — do not edit by hand.\n` +
      `     Source: web/${name}.html plus web/assets/{fonts,tokens,app}.css and\n` +
      `     web/assets/{pretext,veil}.js, all inlined. Regenerate with\n` +
      `     \`npm run standalone\` after any change to those sources. -->`,
  );

  const leftovers = html.match(/(?:href|src)="(?:assets|fonts)\//);
  if (leftovers) {
    throw new Error(`${name}: ${leftovers[0]} still points at a sibling file`);
  }

  // The failure this build already shipped once: a stray HTML token inside the
  // inline script. Asserting the two obvious invariants here is cheaper than
  // diagnosing it in a browser. `Pretext` must survive, and no HTML tag may sit
  // inside the block.
  const block = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  if (!block.includes("window.Pretext=")) {
    throw new Error(`${name}: the inlined script does not assign window.Pretext`);
  }
  const stray = block.match(/<\/(?:body|html|div|p|span)>/);
  if (stray) {
    throw new Error(
      `${name}: ${stray[0]} leaked into the inlined script — the JS would not parse`,
    );
  }

  await mkdir(OUT, { recursive: true });
  const dest = join(OUT, `${name}.html`);
  await writeFile(dest, html);
  return dest;
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = requested.length > 0 ? requested : [...SURFACES];
for (const name of names) {
  if (!SURFACES.includes(name as (typeof SURFACES)[number])) {
    throw new Error(
      `unknown surface ${JSON.stringify(name)}; expected one of ${SURFACES.join(', ')}`,
    );
  }
}

const written: string[] = [];
for (const name of names) {
  written.push(await buildOne(name as (typeof SURFACES)[number]));
}

for (const path of written) {
  const { size } = await import('node:fs').then((fs) => fs.statSync(path));
  process.stdout.write(
    `${path.replace(ROOT, '')}  ${(size / 1024).toFixed(0)} kB\n`,
  );
}
process.stdout.write(
  `\n${written.length} standalone surface(s). Each opens from file:// with no siblings.\n`,
);
