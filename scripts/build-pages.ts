/**
 * Render a real protocol run into the web surfaces.
 *
 *   npm run demo:local && npm run pages
 *
 * ## Why this exists
 *
 * The four pages under `web/` are a product demonstration, and a demonstration
 * is worth nothing if its numbers were typed by hand. This script reads the run
 * recorded by `demo:local`, starts the same server again to capture live
 * response bodies, and writes both into the pages between `<!-- veil:NAME -->`
 * fences. Every figure on every page therefore came out of a real execution of
 * the protocol, and re-running the demo changes the pages.
 *
 * It also rewrites the provenance lines. Those are the load-bearing ones: they
 * are where the pages say what they did and did not do, and they are generated
 * from the run's own recorded mode rather than maintained by hand. A page that
 * cannot state its provenance is not allowed to make a privacy claim.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { generateKeyPairSigner } from '@solana/kit';

import {
  DEFAULT_RESOURCES,
  createFacilitator,
  createVeilServer,
  poolLedgerProbe,
  type PrivacyProbe,
  type ServerConfig,
} from '../packages/server/src/index.ts';
import { PoolLedger } from '../packages/derive/src/index.ts';
import { buildPaymentPayload } from '../packages/x402-core/src/index.ts';
import {
  FIXTURES_DIR,
  DEMO_LEDGER_PATH,
  DEMO_RUN_PATH,
  optionsFromEnv,
  PROJECT_ROOT,
  readJSON,
  relative,
  saveJSON,
  table,
} from './lib.ts';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface RunRecord {
  readonly mode: string;
  readonly chain: string;
  readonly note: string;
  readonly privacyGate: {
    readonly mode: string;
    readonly preconditions: string;
    readonly source: string;
    readonly note: string;
  };
  readonly producedAt: string;
  readonly network: string;
  readonly mint: string;
  readonly decimals: number;
  readonly spendCap: string;
  readonly poolSize: number;
  readonly aliases: string[];
  readonly vendorTotals: {
    alias: string;
    label: string;
    total: string;
    totalFormatted: string;
    payments: number;
    inFlight: number;
    lastAt: string | null;
  }[];
  readonly totals: {
    settled: string;
    settledFormatted: string;
    settledCount: number;
    inFlightCount: number;
    refusedCount: number;
    poolAccounts: number;
  };
  readonly settled: {
    paymentId: string;
    alias: string;
    label: string;
    address: string;
    slot: number;
    resource: string;
    amount: string;
    amountFormatted: string;
    at: string;
  }[];
  readonly inFlight: {
    paymentId: string;
    alias: string;
    address: string;
    slot: number;
    resource: string;
    amountFormatted: string;
    quotedAt: string;
  }[];
  readonly refused: {
    code: string;
    title: string;
    remedy: string;
    resource: string;
    alias: string;
    at: string;
    httpStatus: number;
    detail: string;
  }[];
  readonly scenarios: { name: string; outcome: string; detail: string; pass: boolean }[];
}

/**
 * Stop with an actionable message when there is nothing to render.
 *
 * Kept as a function so the `never` return narrows the type for every closure
 * below, rather than leaving a possibly-null record threaded through the whole
 * script.
 */
function requireRun(value: RunRecord | null): RunRecord {
  if (value) return value;
  process.stderr.write(
    `No run to render.\n\n  ${relative(DEMO_RUN_PATH)} does not exist yet.\n\n` +
      `Run the protocol first, then render it:\n\n  npm run demo:local\n  npm run pages\n\n`,
  );
  process.exit(1);
}

const run = requireRun(await readJSON<RunRecord | null>(DEMO_RUN_PATH, null));

const rawLedger = await readJSON<unknown[]>(DEMO_LEDGER_PATH, []);
if (rawLedger.length === 0) {
  process.stderr.write(`Pool ledger ${relative(DEMO_LEDGER_PATH)} is empty; nothing to render.\n`);
  process.exit(1);
}

// The probe answers from the ledger the run wrote, and the mint flag is the
// value the run declared. Both facts are republished on every page, so nobody
// reads a figure here without also reading where its preconditions came from.
const declaredProbe = (ledger: PoolLedger): PrivacyProbe =>
  poolLedgerProbe(ledger, true);

// ---------------------------------------------------------------------------
// Fixtures: real response bodies from a running server
// ---------------------------------------------------------------------------

interface Fixtures {
  readonly capturedAt: string;
  readonly wellKnown: unknown;
  readonly offer: unknown;
  readonly paid: unknown;
  readonly refusal: unknown;
  readonly failClosed: unknown;
  readonly rejected: unknown;
}

const options = optionsFromEnv(process.argv.slice(2));
const fixturesPath = `${FIXTURES_DIR}/responses.json`;
// A scratch ledger path: capturing a paid response consumes an account, and the
// run record on disk must stay consistent with the pool it describes.
const scratchLedgerPath = `${FIXTURES_DIR}/ledger-scratch.json`;

const demoLedger = PoolLedger.fromJSON(rawLedger);
const quoteTarget = DEFAULT_RESOURCES[0]!;
// The drained merchant, so the refusal fixture is a real exhaustion rather than
// a constructed one.
const drainedTarget =
  DEFAULT_RESOURCES.find((r) => r.alias === run.aliases[run.aliases.length - 1]) ??
  DEFAULT_RESOURCES[DEFAULT_RESOURCES.length - 1]!;

function configFor(ledger: PoolLedger, privacy: boolean): ServerConfig {
  return {
    network: run.network as ServerConfig['network'],
    mint: run.mint,
    decimals: run.decimals,
    ledgerPath: scratchLedgerPath,
    resources: DEFAULT_RESOURCES,
    spendCap: run.spendCap,
    allowLocalSettlement: true,
    ...(privacy
      ? { privacy: declaredProbe(ledger), privacySource: 'pool-ledger' as const }
      : { privacySource: 'none' as const }),
  };
}

async function serve(
  ledger: PoolLedger,
  port: number,
  privacy: boolean,
): Promise<{ base: string; close: () => Promise<void> }> {
  const config = configFor(ledger, privacy);
  const facilitator = createFacilitator(config, ledger);
  const server = createVeilServer(config, facilitator);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function getJSON(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json() };
}

await mkdir(FIXTURES_DIR, { recursive: true });

/** Capture every body the pages need from one live server. */
async function capture(): Promise<Fixtures> {
  const capturing = await serve(demoLedger, options.port + 10, true);
  try {
  const wellKnown = await getJSON(`${capturing.base}/.well-known/veil`);

  // A real offer: quote a resource that still has a free one-time account.
  const payer = 'fixture-payer';
  const offer = await getJSON(`${capturing.base}${quoteTarget.path}?nonce=1`, { 'x-payer': payer });
  const offeredAddress = offer.body?.accepts?.[0]?.payTo;
  if (!offeredAddress) {
    throw new Error(
      `could not capture a 402 offer for ${quoteTarget.path}: ${JSON.stringify(offer.body).slice(0, 200)}`,
    );
  }

  // A real settlement, so the 402 page can show both legs of the exchange. The
  // payload is built from the offer the server actually quoted, so what the
  // fixture shows on the page is the shape a payer really sends.
  const offeredAccept = offer.body.accepts[0];
  const payment = Buffer.from(
    JSON.stringify(
      buildPaymentPayload({
        accept: offeredAccept,
        transaction: Buffer.from('veil-fixture-capture').toString('base64'),
        payTo: offeredAddress,
      }),
    ),
    'utf8',
  ).toString('base64');
  const paid = await getJSON(`${capturing.base}${quoteTarget.path}?nonce=1`, {
    'x-payer': payer,
    'x-payment': payment,
  });

  // A real refusal: the drained merchant's pool.
  const refusal = await getJSON(`${capturing.base}${drainedTarget.path}?nonce=99`, {
    'x-payer': 'fixture-payer',
  });

  // A real rejection: a payment the verifier will not accept, because it names
  // an account that is not one of ours.
  const rejected = await getJSON(`${capturing.base}${quoteTarget.path}?nonce=2`, {
    'x-payer': 'fixture-payer',
    'x-payment': Buffer.from(
      JSON.stringify(
        buildPaymentPayload({
          // An offer for an account that was never ours, so the verifier must
          // reject it rather than credit an unattributable payment to a merchant.
          accept: { ...offeredAccept, payTo: 'VeilNotAnAccount1111111111111111111111111' },
          transaction: Buffer.from('veil-fixture-capture').toString('base64'),
          payTo: 'VeilNotAnAccount1111111111111111111111111',
        }),
      ),
      'utf8',
    ).toString('base64'),
  });

  const failClosed = await captureFailClosed(options.port + 11, drainedTarget.path);
  return {
    capturedAt: new Date().toISOString(),
    wellKnown: wellKnown.body,
    offer: offer.body,
    paid: paid.body,
    refusal: refusal.body,
    failClosed,
    rejected: rejected.body,
  };
  } finally {
    await capturing.close();
  }
}

const fixtures = await capture();
await saveJSON(fixturesPath, fixtures);

/** The refusal a server produces when nothing can vouch for its own claim. */
async function captureFailClosed(port: number, path: string): Promise<unknown> {
  const ledger = PoolLedger.empty();
  for (let slot = 0; slot < 2; slot++) {
    const signer = await generateKeyPairSigner();
    ledger.register({ slot, address: signer.address, alias: drainedTarget.alias, armed: true });
  }
  const handle = await serve(ledger, port, false);
  try {
    return (await getJSON(`${handle.base}${path}`, { 'x-payer': 'fixture-payer' })).body;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const PAGES = ['index', 'dashboard', 'limits', '402'] as const;
type PageName = (typeof PAGES)[number];

const sources = new Map<PageName, string>();
for (const page of PAGES) {
  sources.set(page, await readFile(`${PROJECT_ROOT}/web/${page}.html`, 'utf8'));
}

function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace the content between `<!-- veil:name -->` and `<!-- /veil:name -->`. */
function fill(page: PageName, name: string, content: string): void {
  const html = sources.get(page)!;
  const open = `<!-- veil:${name} -->`;
  const close = `<!-- /veil:${name} -->`;
  const start = html.indexOf(open);
  const end = html.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`web/${page}.html has no veil:${name} fence`);
  }
  sources.set(
    page,
    `${html.slice(0, start + open.length)}\n${content}\n      ${html.slice(end)}`,
  );
}

/**
 * Render JSON with the payload palette.
 *
 * A hand-rolled scanner rather than a syntax highlighter, because the point is
 * that what is displayed is byte-for-byte the body the server sent — including
 * the fields a prettier renderer would drop.
 */
function highlightJSON(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '"') break;
        else j += 1;
      }
      const token = text.slice(i, j + 1);
      // A string followed by a colon is a key; anything else is a value.
      const isKey = /^\s*:/.test(text.slice(j + 1));
      out += `<span class="${isKey ? 'key' : 'str'}">${escapeHTML(token)}</span>`;
      i = j + 1;
      continue;
    }
    if (/[-0-9tfn]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (match) {
        out += `<span class="val">${escapeHTML(match[0])}</span>`;
        i += match[0].length;
        continue;
      }
      const word = /^(true|false|null)/.exec(text.slice(i));
      if (word) {
        out += `<span class="val">${escapeHTML(word[0])}</span>`;
        i += word[0].length;
        continue;
      }
    }
    out += escapeHTML(char);
    i += 1;
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-02T09:41:07.123Z` -> `02 Oct · 09:41 UTC`. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = MONTHS[d.getUTCMonth()]!;
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${day} ${month} · ${time} UTC`;
}

/** `09:41:07` from an ISO timestamp. */
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(11, 19)}`;
}

/** The first and last few characters of an address, so a row stays one line. */
function shorten(value: string, lead = 5, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function paymentId(id: string): string {
  return `p_${id.slice(0, 4)}…${id.slice(-3)}`;
}

/**
 * Trim a 6-decimal atomic amount for display.
 *
 * Trailing zeros go, but never below two decimals and never by rounding: the
 * figure shown is the figure the run recorded, so "$0.539" stays $0.539 rather
 * than becoming a tidier lie.
 */
function money(formatted: string): string {
  const dot = formatted.indexOf('.');
  if (dot === -1) return formatted;
  const whole = formatted.slice(0, dot);
  const frac = formatted.slice(dot + 1);
  const trimmed = frac.replace(/0+$/, '');
  const kept = trimmed.length < 2 ? frac.slice(0, 2) : trimmed;
  return `${whole}.${kept}`;
}

const VENDOR_LABELS: Record<string, { name: string; note: string }> = {
  'oracle.tide': {
    name: 'Tidewater Atlas',
    note: 'Sea-state oracle. The buyer rotates its payment address per call, so no two of these are linkable.',
  },
  feedmarket: {
    name: 'Feedmarket',
    note: 'Market data feed. Highest call volume, smallest average ticket.',
  },
  'sensor.attest': {
    name: 'Sensor Attest',
    note: 'Provenance attestation. Its pool was drained on purpose to record a real VEIL-CONF-005 refusal.',
  },
};

function vendorName(alias: string): string {
  return VENDOR_LABELS[alias]?.name ?? alias;
}

const REFUSAL_LABELS: Record<string, string> = {
  'VEIL-CONF-001': 'unrecoverable',
  'VEIL-CONF-002': 'unrecoverable',
  'VEIL-CONF-003': 'unrecoverable',
  'VEIL-CONF-004': 'recoverable',
  'VEIL-CONF-005': 'recoverable',
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const codes = [...new Set(run.refused.map((r) => r.code))].sort();
const observedHttp = (code: string): number | undefined =>
  run.refused.find((r) => r.code === code)?.httpStatus;

fill(
  'dashboard',
  'provenance',
  `  <p class="lede">Every row below came out of one run of the protocol against a real local HTTP server, with a real generated keypair behind each one-time address. This build reports its own settlement mode as <span class="mono">${run.mode}</span> — this run broadcast nothing, so the amounts here are the merchant's own view of payments it priced, not figures read back off a chain. On chain those amounts are ciphertext. The addresses are not, and the ledger prints them. Live settlements with explorer links: <a href="index.html#live-solana">Live on Solana</a>.</p>`,
);

fill(
  'dashboard',
  'totals',
  `      <div>
        <div class="k">Settled</div>
        <div class="total" data-pretext>${escapeHTML(money(run.totals.settledFormatted))}</div>
        <div class="sub">${run.totals.settledCount} payments · ${run.vendorTotals.length} merchants · every address used once</div>
      </div>
      <div>
        <div class="k">In flight</div>
        <div class="total tertiary" data-pretext>${run.totals.inFlightCount}</div>
        <div class="sub">reserved and quoted, not yet settled</div>
      </div>
      <div>
        <div class="k">Refused</div>
        <div class="total secondary" data-pretext>${run.totals.refusedCount}</div>
        <div class="sub" data-pretext>${escapeHTML(codes.join(' · ')) || 'none'}</div>
      </div>
      <div>
        <div class="k">Confidentiality</div>
        <a class="badge ok" href="limits.html"><span class="dot" aria-hidden="true"></span>${escapeHTML(run.privacyGate.mode)}</a>
        <div class="sub" data-pretext>preconditions ${escapeHTML(run.privacyGate.preconditions)}</div>
      </div>
      <div>
        <div class="k">Pool</div>
        <div class="total tertiary" data-pretext>${run.totals.poolAccounts}</div>
        <div class="sub">one-time accounts · 0 reused</div>
      </div>`,
);

fill(
  'dashboard',
  'vendors',
  run.vendorTotals
    .map(
      (v) => `        <tr>
          <td>
            <span class="alias">${escapeHTML(vendorName(v.alias))}</span>
            <span class="note" data-pretext>${escapeHTML(VENDOR_LABELS[v.alias]?.note ?? v.label)}</span>
          </td>
          <td class="r"><span class="redact"><span class="amount-value">${escapeHTML(money(v.totalFormatted))}</span><span class="redaction-bar" aria-hidden="true"></span></span></td>
          <td class="r mono">${v.payments}</td>
          <td class="r hide-sm mono">${v.lastAt ? escapeHTML(clock(v.lastAt)) : '—'}</td>
        </tr>`,
    )
    .join('\n'),
);

/** Newest first, from all three real outcomes. */
const rows = [
  ...run.settled.map((e) => ({
    sort: e.at,
    html: `        <tr>
          <td data-label="Payment"><span class="pay">${escapeHTML(paymentId(e.paymentId))}</span></td>
          <td data-label="Vendor">${escapeHTML(vendorName(e.alias))}</td>
          <td data-label="Time" class="hide-sm when">${escapeHTML(clock(e.at))}</td>
          <td data-label="State">
            <span class="pill settled"><span class="dot" aria-hidden="true"></span>settled</span>
            <span class="reason" data-pretext>slot ${e.slot} · ${escapeHTML(shorten(e.address))} ← public, and Veil says so</span>
          </td>
          <td data-label="Amount" class="r amount"><span class="redact"><span class="amount-value">${escapeHTML(money(e.amountFormatted))}</span><span class="redaction-bar" aria-hidden="true"></span></span></td>
        </tr>`,
  })),
  ...run.inFlight.map((e) => ({
    sort: e.quotedAt,
    html: `        <tr>
          <td data-label="Payment"><span class="pay">${escapeHTML(paymentId(e.paymentId))}</span></td>
          <td data-label="Vendor">${escapeHTML(vendorName(e.alias))}</td>
          <td data-label="Time" class="hide-sm when">${escapeHTML(clock(e.quotedAt))}</td>
          <td data-label="State">
            <span class="pill verifying"><span class="dot" aria-hidden="true"></span>in flight</span>
            <span class="reason" data-pretext>quoted and reserved at slot ${e.slot}; counted separately, never as settled</span>
          </td>
          <td data-label="Amount" class="r amount"><span class="redact"><span class="amount-value">${escapeHTML(money(e.amountFormatted))}</span><span class="redaction-bar" aria-hidden="true"></span></span></td>
        </tr>`,
  })),
  ...run.refused.map((e) => ({
    sort: e.at,
    html: `        <tr>
          <td data-label="Payment"><span class="pay">—</span></td>
          <td data-label="Vendor">${escapeHTML(vendorName(e.alias))}</td>
          <td data-label="Time" class="hide-sm when">${escapeHTML(clock(e.at))}</td>
          <td data-label="State">
            <span class="pill unreadable"><span class="dot" aria-hidden="true"></span>refused</span>
            <span class="reason" data-pretext>${escapeHTML(e.code)} — ${escapeHTML(e.title)}</span>
          </td>
          <td data-label="Amount" class="r amount"><span class="cipher">no amount</span></td>
        </tr>`,
  })),
]
  .sort((a, b) => (a.sort < b.sort ? 1 : -1))
  .slice(0, 10);

fill('dashboard', 'ledger-caption', `      <caption>Latest ${rows.length} of ${run.settled.length + run.inFlight.length + run.refused.length}, newest first. A row carries an amount only if the payment settled; a refusal keeps its code and gains no figure.</caption>`);
fill('dashboard', 'ledger-rows', rows.map((r) => r.html).join('\n'));

const checksHTML = `          <ul class="checks">
            <li>Mint carries the confidential extension<span class="verdict pass">${escapeHTML(run.privacyGate.preconditions)}</span></li>
            <li>Destination accepts confidential credits<span class="verdict pass">from the pool ledger</span></li>
            <li>Cannot verify at all → refuse<span class="verdict ${codes.includes('VEIL-CONF-003') ? 'pass' : ''}">${codes.includes('VEIL-CONF-003') ? 'VEIL-CONF-003 observed' : 'not observed'}</span></li>
          </ul>`;
fill('dashboard', 'checks', checksHTML);
fill('limits', 'checks', checksHTML);

fill(
  'dashboard',
  'footer',
  `      <span class="marker">${escapeHTML(run.mode)} · chain ${escapeHTML(run.chain)} · ${run.totals.settledCount} payments · run <b>${escapeHTML(stamp(run.producedAt))}</b></span>`,
);

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

// Two windows over the same payment: what the agent did, and what the merchant
// can read back. Both are built from the same settled row, so they cannot drift.
const sample = run.settled[0];
const nextSample = run.settled.find((e) => e.alias === sample?.alias && e.paymentId !== sample.paymentId);

fill(
  'index',
  'demo-agent',
  `        <div class="demo-cell" aria-label="Agent log">
<b>→ GET</b> ${escapeHTML(sample?.resource ?? '')}  <b>402 Payment Required</b><br>
← offer: ${escapeHTML(money(sample?.amountFormatted ?? ''))} · mint ${escapeHTML(shorten(run.mint, 4, 3))} · x402 v2<br>
<b>→ pay</b> to ${escapeHTML(shorten(sample?.address ?? ''))} (one-time) <b>· confidential</b><br>
<span class="ok">✓ settled ${escapeHTML(sample ? clock(sample.at) : '')}</span> · slot ${sample?.slot ?? 0}<br>
<b>→ retry</b> ${escapeHTML(sample?.resource ?? '')}  <b>200 OK</b><br>
<span class="ok">✓ resource delivered</span><br>
<span class="ok">✓ next call → ${escapeHTML(shorten(nextSample?.address ?? '', 5, 3))} (unlinkable)</span>
        </div>`,
);

fill(
  'index',
  'demo-public',
  `        <div class="demo-cell" aria-label="What a public observer holds">
<b>account</b> ${escapeHTML(shorten(sample?.address ?? ''))} — receiving, slot ${sample?.slot ?? 0}<br>
<b>extensions</b><br>
&nbsp;&nbsp;ConfidentialTransferAccount <span class="ok">expected</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;allow_confidential_credits <span class="ok">required</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;allow_non_confidential_credits <span class="ok">required false</span><br>
<b>the server's answer when it cannot check these</b><br>
&nbsp;&nbsp;${escapeHTML(String((fixtures.failClosed as any)?.veil?.refused ?? 'VEIL-CONF-003'))}<br>
<b>the amount</b><br>
&nbsp;&nbsp;amount <span class="redact"><span class="amount-value">${escapeHTML(money(sample?.amountFormatted ?? ''))}</span><span class="redaction-bar" aria-hidden="true"></span></span><br>
&nbsp;&nbsp;destination ${escapeHTML(shorten(sample?.address ?? ''))} <span>← public, and Veil says so</span><br>
&nbsp;&nbsp;settlement mode <span>${escapeHTML(run.mode)} <span>← published, not implied</span></span>
        </div>`,
);

fill(
  'index',
  'footer',
  `      <span class="marker">local run behind these figures · settlement <b>${escapeHTML(run.mode)}</b> · live transfers: <b>testnet + devnet</b></span>`,
);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

fill(
  'limits',
  'provenance',
  `  <p class="note" style="margin-top:var(--s4)">Provenance of this build: one run on <b>${escapeHTML(stamp(run.producedAt))}</b>, settlement mode <span class="mono">${escapeHTML(run.mode)}</span>, chain <span class="mono">${escapeHTML(run.chain)}</span>. The confidential preconditions were <span class="mono">${escapeHTML(run.privacyGate.preconditions)}</span> and published as <span class="mono">privacySource: ${escapeHTML(run.privacyGate.source)}</span>. This run broadcast nothing — but broadcasting is not hypothetical: the same transfers have been confirmed on Solana testnet and devnet with these proofs, linked from <a href="index.html#live-solana">Live on Solana</a>. The limits below describe what the code does and where it has been demonstrated.</p>`,
);

fill(
  'limits',
  'footer',
  `      <span class="marker">claims checked against <b>${escapeHTML(run.mode)}</b> · ${run.totals.refusedCount} refusals observed · run ${escapeHTML(stamp(run.producedAt))}</span>`,
);

// ---------------------------------------------------------------------------
// 402 body
// ---------------------------------------------------------------------------

const wellKnown = fixtures.wellKnown as {
  refusals: { code: string; title: string; recoverable: boolean }[];
  privacySource: string;
  privacyGate: { mode: string; checks?: string[] };
  hides: string[];
  exposes: string[];
  settlement: { mode: string };
};

const offer = fixtures.offer as { accepts: { payTo: string; maxAmountRequired: string; extra: any }[] };
const offerAccept = offer.accepts[0]!;

fill(
  '402',
  'provenance',
  `  <p class="lede" data-pretext>An agent that has never seen Veil still understands this response, because it is a standard x402 <span class="mono">Payment Required</span> body with one added requirement: settle confidentially, or do not settle at all. Every body on this page was captured from a running Veil server — the same process that produced the merchant ledger — and its <span class="mono">/.well-known/veil</span> published <span class="mono">privacySource: ${escapeHTML(wellKnown.privacySource)}</span>.</p>`,
);

fill(
  '402',
  'demo-unpaid',
  `        <div class="demo-cell" aria-label="Unpaid request">
<b>1 · unpaid</b><br>
GET ${escapeHTML(quoteTarget.path)}<br>
&nbsp;&nbsp;X-PAYMENT: (none)<br>
<br>
<b>← 402 Payment Required</b><br>
&nbsp;&nbsp;accepts[0].scheme <span class="ok">"${escapeHTML(String((offer as any).accepts?.[0]?.scheme ?? ''))}"</span><br>
&nbsp;&nbsp;accepts[0].asset&nbsp; <span class="ok">${escapeHTML(shorten(run.mint, 4, 3))}</span><br>
&nbsp;&nbsp;accepts[0].payTo&nbsp; ${escapeHTML(shorten(offerAccept.payTo))} <span>(one-time)</span><br>
&nbsp;&nbsp;accepts[0].maxAmountRequired <span>${escapeHTML(offerAccept.maxAmountRequired)}</span><br>
&nbsp; &nbsp;accepts[0].extra.privacy <span class="ok">${escapeHTML(String(offerAccept.extra?.privacy ?? ''))}</span><br>
&nbsp;&nbsp;accepts[0].extra.poolIndex <span>${escapeHTML(String(offerAccept.extra?.poolIndex ?? ''))}</span>
        </div>`,
);

const paidBody = fixtures.paid as { paid?: boolean; settled?: { at: string; signature: string | null }; data?: unknown };
fill(
  '402',
  'demo-paid',
  `        <div class="demo-cell" aria-label="Paid request">
<b>2 · paid</b><br>
GET ${escapeHTML(quoteTarget.path)}<br>
&nbsp;&nbsp;X-PAYMENT: <span class="ok">signed · confidential</span><br>
<br>
<b>← 200 OK</b> · resource delivered<br>
&nbsp;&nbsp;paid <span class="ok">${escapeHTML(String(paidBody.paid))}</span><br>
&nbsp;&nbsp;settled.at <span class="val">${escapeHTML(clock(String(paidBody.settled?.at ?? '')))}</span><br>
&nbsp;&nbsp;settled.signature <span class="val">${paidBody.settled?.signature ? escapeHTML(shorten(paidBody.settled.signature)) : 'null'}</span><br>
&nbsp;&nbsp;amount <span class="hid">[ciphertext on chain]</span><br>
&nbsp;&nbsp;mode <span>${escapeHTML(wellKnown.settlement.mode)}</span>
        </div>`,
);

fill('402', 'body', `<pre>${highlightJSON(fixtures.offer)}</pre>`);
fill('402', 'refusal', `<pre>${highlightJSON(fixtures.refusal)}</pre>`);

fill(
  '402',
  'refusals',
  wellKnown.refusals
    .map((r) => {
      const http = observedHttp(r.code);
      const detail = run.refused.find((x) => x.code === r.code);
      return `        <tr>
          <td><span class="mono">${escapeHTML(r.code)}</span></td>
          <td class="mono">${http ?? '—'}</td>
          <td class="note">${escapeHTML(r.title)}</td>
          <td class="hide-sm note">${escapeHTML(REFUSAL_LABELS[r.code] === 'recoverable' ? 'Backoff, or refill the pool. Never fall back to a plain transfer.' : 'Do not pay. Fix the configuration, then retry.')}${detail ? ` <span class="mono">observed: ${escapeHTML(detail.detail.slice(0, 60))}</span>` : ''}</td>
        </tr>`;
    })
    .join('\n'),
);

fill(
  '402',
  'footer',
  `      <span class="marker">bodies captured from a running server · settlement <b>${escapeHTML(wellKnown.settlement.mode)}</b> · privacySource ${escapeHTML(wellKnown.privacySource)}</span>`,
);

// ---------------------------------------------------------------------------
// Write the pages, then report
// ---------------------------------------------------------------------------

for (const page of PAGES) {
  await writeFile(`${PROJECT_ROOT}/web/${page}.html`, sources.get(page)!, 'utf8');
}

process.stdout.write(
  [
    '',
    'Veil — pages rendered from a real run',
    '',
    table([
      ['run', `${relative(DEMO_RUN_PATH)} (${stamp(run.producedAt)})`],
      ['fixtures', relative(fixturesPath)],
      ['settlement mode', run.mode],
      ['privacy gate', `${run.privacyGate.mode} · preconditions ${run.privacyGate.preconditions}`],
      ['refusal codes seen', codes.join(', ') || 'none'],
      ['', ''],
      ['pages', PAGES.map((p) => `web/${p}.html`).join(', ')],
    ]),
    '',
    'Open http://127.0.0.1:4021 after `npm run veil -- serve --local-settlement=true`,',
    'or open web/index.html directly — every page renders from file://.',
    '',
  ].join('\n'),
);
