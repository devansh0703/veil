/**
 * The merchant options the documentation promises, and the ones the code declares.
 *
 * `docs/api.md` is how an integrator learns what `veil(options)` accepts, and it
 * is written by hand. Nothing tied it to `VeilOptions`, so an option could be
 * added, renamed, or removed in `packages/server/src/index.ts` while the
 * reference kept advertising the old surface — the reader follows the docs, the
 * argument is ignored, and the failure is silent because an unknown key is not
 * an error in JavaScript. This test turns that drift into a test failure.
 *
 * It is a text comparison rather than a type-level one on purpose: an interface
 * erases at runtime, so the source text is the only durable record of what was
 * declared, and reading it also catches the case where the docs and the code are
 * both wrong in the same direction (a renamed key, a copy-paste row).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** From `scripts/`, the project root is one level up. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_SOURCE = `${ROOT}packages/server/src/index.ts`;
const CLIENT_ERRORS = `${ROOT}packages/client/src/errors.ts`;
const API_DOC = `${ROOT}docs/api.md`;

interface DeclaredOption {
  readonly name: string;
  /** No `?` on the member, so `veil()` requires it. */
  readonly optional: boolean;
}

/**
 * The members of `export interface VeilOptions { … }`.
 *
 * The body is taken from the declaration to the first line that is exactly `}` —
 * the interface is top level, so its members are indented and its terminator is
 * not. Anchoring member names at two spaces also keeps the nested `{ paid }`
 * inside `produce`'s callback type from being read as an option of its own.
 */
function declaredOptions(source: string): DeclaredOption[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('export interface VeilOptions {'));
  assert.notEqual(
    start,
    -1,
    'VeilOptions is not declared in packages/server/src/index.ts — this check cannot be trusted',
  );

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') break;
    body.push(lines[i]!);
  }

  const members: DeclaredOption[] = [];
  for (const line of body) {
    const match = /^\s{2}readonly\s+([A-Za-z_$][\w$]*)(\?)?:/.exec(line);
    if (match) members.push({ name: match[1]!, optional: match[2] === '?' });
  }

  assert.ok(
    members.length > 0,
    'parsed VeilOptions but found no members — the interface shape changed, so update this parser',
  );
  return members;
}

interface DocumentedOption {
  readonly name: string;
  /** The whole table row, so a `**Required.**` note can be checked against it. */
  readonly row: string;
}

/**
 * The rows of the option table in the `## Merchant — veil(options)` section.
 *
 * Scoped to that section so the other tables in the same file — low-level
 * helpers, error codes, rail endpoints — cannot be mistaken for options.
 */
function documentedOptions(markdown: string): DocumentedOption[] {
  const start = markdown.indexOf('## Merchant ');
  assert.notEqual(start, -1, 'docs/api.md has no `## Merchant` section — the reference moved');

  const rest = markdown.slice(start);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);

  const rows: DocumentedOption[] = [];
  for (const line of section.split('\n')) {
    // A table row whose first cell is a backticked identifier. The header
    // ("| Option |") and the separator are not backticked, so they fall out.
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) rows.push({ name: match[1]!, row: line });
  }

  assert.ok(
    rows.length > 0,
    'docs/api.md documents no options in the Merchant section — the table moved, so update this parser',
  );
  return rows;
}

/**
 * The error codes `CATALOG` declares.
 *
 * The same drift as the options table, on the other table a developer programs
 * against: the catalogue is the source of truth for what a caller can be handed,
 * and `docs/api.md` lists the codes they should expect. `VEIL-CONTEND-008` had
 * already gone missing from the reference before this check existed.
 */
function catalogCodes(source: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('const CATALOG = {'));
  assert.notEqual(start, -1, 'CATALOG is not declared in packages/client/src/errors.ts');

  const codes: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '} as const;' || lines[i] === '}') break;
    const match = /^\s{2}'([A-Z0-9-]+)':/.exec(lines[i]!);
    if (match) codes.push(match[1]!);
  }

  assert.ok(codes.length > 0, 'parsed CATALOG but found no codes — update this parser if the shape changed');
  return codes;
}

/** The code rows of the `## Errors` table in docs/api.md. */
function documentedCodes(markdown: string): string[] {
  const start = markdown.indexOf('## Errors');
  assert.notEqual(start, -1, 'docs/api.md has no `## Errors` section — the reference moved');

  const rest = markdown.slice(start);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);

  const codes: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^\|\s*`(VEIL-[A-Z0-9-]+)`\s*\|/.exec(line);
    if (match) codes.push(match[1]!);
  }

  assert.ok(codes.length > 0, 'docs/api.md documents no error codes — the table moved');
  return codes;
}

test('the reference documents exactly the options VeilOptions declares', async () => {
  const declared = declaredOptions(await readFile(SERVER_SOURCE, 'utf8'));
  const documented = documentedOptions(await readFile(API_DOC, 'utf8'));

  const declaredNames = declared.map((option) => option.name);
  const documentedNames = documented.map((option) => option.name);

  // Both directions, because a rename shows up as a removal here and an addition
  // there, and reporting only one of them sends the reader looking in the wrong
  // file.
  const undocumented = declaredNames.filter((name) => !documentedNames.includes(name));
  const invented = documentedNames.filter((name) => !declaredNames.includes(name));

  assert.deepEqual(
    { undocumented, invented },
    { undocumented: [], invented: [] },
    [
      'docs/api.md and VeilOptions disagree on the veil(options) surface.',
      undocumented.length > 0
        ? `  declared but undocumented: ${undocumented.join(', ')}`
        : '',
      invented.length > 0 ? `  documented but not declared: ${invented.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  // Same set, so the counts match; asserted separately to catch a duplicate row.
  assert.equal(
    new Set(documentedNames).size,
    documentedNames.length,
    'docs/api.md lists an option more than once',
  );
});

test('payTo is the only required option, and the reference marks it so', async () => {
  const declared = declaredOptions(await readFile(SERVER_SOURCE, 'utf8'));
  const documented = documentedOptions(await readFile(API_DOC, 'utf8'));

  const required = declared.filter((option) => !option.optional).map((option) => option.name);
  assert.deepEqual(
    required,
    ['payTo'],
    'VeilOptions gained or lost a required field — the reference table must be updated with it',
  );

  // The required/optional split is part of the contract, not decoration: a row
  // that says Required for an optional option (or the reverse) is wrong in a way
  // the key-set check above cannot see.
  const marked = documented.filter((option) => /\*\*Required\.\*\*/.test(option.row));
  assert.deepEqual(
    marked.map((option) => option.name),
    ['payTo'],
    'the reference must mark exactly payTo as required, matching VeilOptions',
  );
});

test('the reference documents exactly the error codes CATALOG declares', async () => {
  const declared = catalogCodes(await readFile(CLIENT_ERRORS, 'utf8'));
  const documented = documentedCodes(await readFile(API_DOC, 'utf8'));

  const undocumented = declared.filter((code) => !documented.includes(code));
  const invented = documented.filter((code) => !declared.includes(code));

  assert.deepEqual(
    { undocumented, invented },
    { undocumented: [], invented: [] },
    [
      'docs/api.md and CATALOG disagree on the error surface.',
      undocumented.length > 0 ? `  declared but undocumented: ${undocumented.join(', ')}` : '',
      invented.length > 0 ? `  documented but not declared: ${invented.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
});
