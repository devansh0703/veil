/**
 * Render `docs/*.md` into the documentation section under `web/docs/`.
 *
 *   npm run docs
 *
 * ## Why this exists
 *
 * The docs were Markdown that nothing rendered. A product site whose
 * documentation is a folder of `.md` files is a folder of `.md` files — the
 * reader has to clone the repo to learn the API. This script turns them into
 * real pages: same shell as the rest of the site (masthead, theme switch,
 * footer), a sectioned sidebar the way protocol documentation is expected to
 * read, and anchors on every heading so a refusal code can be linked to
 * directly.
 *
 * The renderer covers the Markdown these files actually use — headings,
 * paragraphs, rules, fenced code, tables, two list kinds, and the three inline
 * forms — rather than importing a dependency to render five constructs. If a
 * doc grows a construct this does not handle, it renders as literal text, which
 * is visible rather than silently wrong.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PROJECT_ROOT, table } from './lib.ts';

const DOCS_DIR = join(PROJECT_ROOT, 'docs');
const OUT_DIR = join(PROJECT_ROOT, 'web', 'docs');

/**
 * The sidebar, in reading order.
 *
 * Explicit rather than derived from the filenames: the order a reader should
 * learn in is an editorial decision, and `readdir` gives inode order.
 */
const SECTIONS: readonly { readonly title: string; readonly pages: readonly string[] }[] = [
  { title: 'Getting started', pages: ['index', 'quickstart'] },
  { title: 'Core concepts', pages: ['concepts'] },
  { title: 'Reference', pages: ['api', 'troubleshooting'] },
  { title: 'Prove it', pages: ['verify-it-yourself'] },
];

const ORDER = SECTIONS.flatMap((section) => section.pages);

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Meta descriptions get cut at a word boundary, never mid-word. */
function truncate(text: string, limit = 160): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, '')}…`;
}

/** `## What a payment does` → `what-a-payment-does` */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Inline forms, in the order they must be applied.
 *
 * Code spans are lifted out first so nothing rewrites their contents: a `**`
 * inside a code span is literal asterisks, and a `<` inside one must still be
 * escaped for the HTML it is about to become.
 */
function inline(text: string): string {
  const codes: string[] = [];
  const lifted = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHTML(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  let out = escapeHTML(lifted);
  // [label](href) — href is escaped text, so a query string's & is already safe.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
}

interface Rendered {
  readonly html: string;
  readonly title: string;
  readonly lede: string;
  readonly toc: readonly { readonly id: string; readonly text: string }[];
}

function renderMarkdown(source: string): Rendered {
  const lines = source.split('\n');
  const out: string[] = [];
  const toc: { id: string; text: string }[] = [];
  let title = '';
  let lede = '';

  let i = 0;
  const flushParagraph = (buffer: string[]): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ');
    // The first paragraph is the page's lede — shown once under the title and
    // once as the meta description, not repeated as body copy underneath.
    if (!lede && title) {
      lede = joined;
      buffer.length = 0;
      return;
    }
    out.push(`<p>${inline(joined)}</p>`);
    buffer.length = 0;
  };

  const paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code — verbatim, escaped, tagged with its language.
    if (line.startsWith('```')) {
      flushParagraph(paragraph);
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      const cls = lang ? ` class="language-${escapeHTML(lang)}"` : '';
      out.push(`<pre class="code"><code${cls}>${escapeHTML(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Rule.
    if (/^---+\s*$/.test(line)) {
      flushParagraph(paragraph);
      out.push('<hr>');
      i++;
      continue;
    }

    // Heading. h1 is the page title, so it is consumed rather than repeated.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (level === 1) {
        title = text.replace(/[`*]/g, '');
        i++;
        continue;
      }
      const id = slug(text);
      if (level === 2) toc.push({ id, text: text.replace(/[`*]/g, '') });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // Table — the separator row is what makes a `|` line a table.
    if (line.startsWith('|') && /^\|[\s:-]+\|/.test(lines[i + 1] ?? '')) {
      flushParagraph(paragraph);
      const cells = (row: string): string[] =>
        // `\|` is an escaped pipe inside a cell (`string \| null`): park it
        // before splitting, restore it as the pipe it stands for after.
        row
          .replace(/\\\|/g, '\u0001')
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.replace(/\u0001/g, '|').trim());

      const head = cells(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        rows.push(cells(lines[i]!));
        i++;
      }
      const thead = head.map((cell) => `<th>${inline(cell)}</th>`).join('');
      const tbody = rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, index) => {
                const cls = index === 0 ? ' class="k"' : '';
                return `<td${cls}>${inline(cell)}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('');
      out.push(
        `<div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    // Unordered list. A following indented line continues the item.
    if (/^[-*]\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && (/^[-*]\s+/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!))) {
        const item = /^[-*]\s+/.test(lines[i]!) ? lines[i]!.replace(/^[-*]\s+/, '') : lines[i]!;
        items.push(item.trim());
        i++;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && (/^\d+\.\s+/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!))) {
        const item = /^\d+\.\s+/.test(lines[i]!) ? lines[i]!.replace(/^\d+\.\s+/, '') : lines[i]!;
        items.push(item.trim());
        i++;
      }
      out.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    // Blank line ends a paragraph.
    if (line.trim() === '') {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph(paragraph);

  return {
    html: out.join('\n'),
    title,
    // The lede doubles as the meta description, so it must be plain text: drop
    // emphasis, code ticks, and link syntax down to the label alone.
    lede: lede
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    toc,
  };
}

/**
 * Rewrite the links a Markdown file carries into the links the built site needs.
 *
 * Docs cross-reference each other as `.md` because that is what they are in the
 * repo. Rendered, they are siblings served at their own clean URLs, so
 * `./api.md` becomes `./api` — extensionless, like the sidebar and the pager,
 * and resolved by the same rewrite. A link to a top-level page (`../limits.html`)
 * already resolves from `web/docs/` and is left alone.
 */
function rewriteLinks(html: string): string {
  return html.replace(/href="((?:\.\/)?[\w-]+)\.md(#|")/g, 'href="$1$2');
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/** `../` — the docs live one directory below the rest of the site. */
const UP = '../';

const HEAD_SCRIPT = `<script>
/* The saved ground, applied before first paint so the page never flashes the
   one the reader did not ask for. Same key veil.js reads later. */
(function () {
  try {
    var g = localStorage.getItem("veil:ground");
    if (g === "graphite" || g === "paper") {
      document.documentElement.setAttribute("data-ground", g);
    }
  } catch (e) {}
})();
</script>`;

function sidebar(current: string): string {
  const nav = SECTIONS.map(
    (section) => `<div class="doc-group">
        <p class="k">${escapeHTML(section.title)}</p>
        <ul>
          ${section.pages
            .map((page) => {
              const href = pageHref(page);
              const current_attr = page === current ? ' aria-current="page"' : '';
              const label = page === 'index' ? 'Introduction' : TITLES[page] ?? page;
              return `<li><a href="${href}"${current_attr}>${escapeHTML(label)}</a></li>`;
            })
            .join('\n          ')}
        </ul>
      </div>`,
  ).join('\n      ');

  return `<aside class="doc-nav" aria-label="Documentation">
      ${nav}
    </aside>`;
}

/** Filled as pages render: slug → page title, for the sidebar and prev/next. */
const TITLES: Record<string, string> = {};

function page(options: {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly toc: readonly { readonly id: string; readonly text: string }[];
  readonly prev?: { readonly slug: string; readonly title: string };
  readonly next?: { readonly slug: string; readonly title: string };
}): string {
  const index = ORDER.indexOf(options.slug);
  const toc =
    options.toc.length > 1
      ? `<nav class="doc-toc" aria-label="On this page">
        <p class="k">On this page</p>
        <ul>
          ${options.toc
            .map((entry) => `<li><a href="#${entry.id}">${escapeHTML(entry.text)}</a></li>`)
            .join('\n          ')}
        </ul>
      </nav>`
      : '';

  const pager =
    options.prev || options.next
      ? `<nav class="doc-pager" aria-label="Documentation pages">
        ${
          options.prev
            ? `<a class="pager prev" href="${pageHref(options.prev.slug)}"><span class="k">Previous</span>${escapeHTML(options.prev.title)}</a>`
            : '<span></span>'
        }
        ${
          options.next
            ? `<a class="pager next" href="${pageHref(options.next.slug)}"><span class="k">Next</span>${escapeHTML(options.next.title)}</a>`
            : '<span></span>'
        }
      </nav>`
      : '';

  return `<!doctype html>
<html lang="en" data-ground="paper">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(options.title)} — Veil docs</title>
<meta name="description" content="${escapeHTML(truncate(options.description))}">
<!-- Every face is self-hosted (see assets/fonts.css). No font CDN at runtime. -->
<link rel="stylesheet" href="${UP}assets/fonts.css">
<link rel="stylesheet" href="${UP}assets/tokens.css">
<link rel="stylesheet" href="${UP}assets/app.css">
<link rel="stylesheet" href="${UP}assets/docs.css">
${HEAD_SCRIPT}
</head>

<body>
<a class="skip" href="#doc">Skip to the documentation</a>

<header class="masthead">
  <div class="wrap">
    <a class="wordmark" href="${UP}index.html"><span class="v">V</span>EIL</a>
    <div class="who">
      <span>docs <b>v1</b></span>
      <span>rail <b>x402</b></span>
    </div>
    <div class="tail">
      <nav>
        <a href="${UP}index.html">Landing</a>
        <a href="./" aria-current="page">Docs</a>
        <a href="${UP}dashboard.html">Ledger</a>
        <a href="${UP}limits.html">Limits</a>
      </nav>
      <button type="button" class="btn secondary theme" data-theme-toggle
              aria-pressed="false" aria-label="Switch the site to the graphite ground">Graphite</button>
    </div>
  </div>
</header>

<div class="wrap doc-layout">
  ${sidebar(options.slug)}

  <main class="doc-body" id="doc">
    <p class="doc-crumb"><a href="./">Docs</a> / ${escapeHTML(options.title)}</p>
    <h1 class="doc-title">${escapeHTML(options.title)}</h1>
    <p class="lede">${escapeHTML(options.description)}</p>
    ${options.body}
    ${pager}
  </main>

  ${toc}
</div>

<footer>
  <div class="foot">
    <span class="marker">docs built from <b>docs/*.md</b> · hosted rail: <b>veil-devnet.vercel.app</b></span>
    <nav>
      <a href="${UP}index.html">Landing</a>
      <a href="${UP}dashboard.html">Merchant ledger</a>
      <a href="${UP}limits.html">Honest limits</a>
      <a href="${UP}402.html">402 body</a>
    </nav>
    <div class="row">
      <a class="btn primary" href="./quickstart">Quickstart</a>
      <a class="btn secondary" href="${UP}index.html">Home</a>
    </div>
  </div>
</footer>

<script src="${UP}assets/pretext.js"></script>
<script src="${UP}assets/veil.js"></script>
</body>
</html>
`;
}

/**
 * A docs page's own URL, cleaned.
 *
 * `web/docs/api.html` is published at `/docs/api`, so a sibling link is `./api`
 * and the section root is `./` — both resolve correctly from every page, and
 * neither shows the `.html` a reader should not have to know about. The
 * extensionless form is what the deployment's rewrite serves (see
 * `vercel.json`), and what the local server resolves too.
 */
function pageHref(slug: string): string {
  return slug === 'index' ? './' : `./${slug}`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });

const files = (await readdir(DOCS_DIR)).filter(
  (name) => name.endsWith('.md') && !name.includes('/'),
);

// Two passes: render everything to learn the titles, then write the pages with
// a sidebar and pager that know their neighbours.
const rendered = new Map<string, Rendered>();
for (const file of files) {
  const slugName = file.replace(/\.md$/, '');
  const source = await readFile(join(DOCS_DIR, file), 'utf8');
  rendered.set(slugName, renderMarkdown(source));
}

for (const [slugName, doc] of rendered) {
  if (doc.title) TITLES[slugName] = doc.title;
}

const missing = ORDER.filter((slugName) => !rendered.has(slugName));
if (missing.length > 0) {
  throw new Error(`docs declared in SECTIONS but absent from docs/: ${missing.join(', ')}`);
}
const undeclared = [...rendered.keys()].filter((slugName) => !ORDER.includes(slugName));
if (undeclared.length > 0) {
  throw new Error(`docs/ files not listed in SECTIONS: ${undeclared.join(', ')}`);
}

const written: [string, number][] = [];
for (const slugName of ORDER) {
  const doc = rendered.get(slugName)!;
  const at = ORDER.indexOf(slugName);
  const prevSlug = ORDER[at - 1];
  const nextSlug = ORDER[at + 1];
  const html = rewriteLinks(
    page({
      slug: slugName,
      title: doc.title || (slugName === 'index' ? 'Introduction' : slugName),
      description: doc.lede,
      body: doc.html,
      toc: doc.toc,
      ...(prevSlug ? { prev: { slug: prevSlug, title: TITLES[prevSlug] ?? prevSlug } } : {}),
      ...(nextSlug ? { next: { slug: nextSlug, title: TITLES[nextSlug] ?? nextSlug } } : {}),
    }),
  );
  const target = join(OUT_DIR, `${slugName}.html`);
  await writeFile(target, html);
  written.push([`${slugName}.html`, html.length]);
}

process.stdout.write(
  `\n${table(written.map(([name, size]) => [name, `${size} B`]))}\n\nweb/docs written\n`,
);
