---
# gstack: design-md-format=spec
name: Veil
description: A public ledger you can still keep. Paper and graphite, one redaction ink, and type that does the work.
colors:
  primary: "#B4341F"        # redact — the redaction ink; brand accent, redaction bars, error treatment
  on-primary: "#FFFFFF"
  surface: "#F2F2F0"        # paper — landing ground (deliberately neutral stock, not cream)
  surface-raise: "#FFFFFF"
  surface-dark: "#101114"   # graphite — dashboard ground
  surface-dark-raise: "#17181C"
  text: "#17161A"
  text-dark: "#E8E6E1"
  text-muted: "#6B6862"
  text-muted-dark: "#8A8C93"
  rule: "#D5D5D1"
  rule-dark: "#2A2C31"
  surface-tint: "#E8E8E4"    # row hover on paper — a step off the ground, not a new hue
  surface-tint-dark: "#1D1F24"
  accent: "#B4341F"
  success: "#2C7755"        # reconciled (paper, 4.83:1)
  success-dark: "#3E9C6B"   # reconciled (graphite, 5.55:1)
  warning: "#8A611E"        # needs attention (paper, 4.92:1)
  warning-dark: "#C99A3B"   # needs attention (graphite, 7.34:1)
  error: "#B8402A"          # error (paper, 4.92:1)
  error-dark: "#DE523C"     # error + lifted redact (graphite, 4.84:1)
  redact-fill: "#B4341F"    # the ONLY red a white label may sit on — 6.08:1 on both grounds
  # prefers-contrast:more overrides. Not new hues: each is the same role pushed
  # further from its ground, and each is only reachable behind the media query.
  # muted 4.95:1 → 7.47:1, rule 1.29:1 → 1.87:1 (rule is non-text, so the bar is 3:1)
  muted-contrast: "#4F4D49"
  muted-contrast-dark: "#B4B6BB"
  rule-contrast: "#B6AF9F"
  rule-contrast-dark: "#3C3F46"
typography:
  display:
    fontFamily: "Cabinet Grotesk"
    fontWeight: 700
    fontSize: "clamp(2.5rem, 5vw, 4.25rem)"
    letterSpacing: "-0.02em"
  body:
    fontFamily: "General Sans"
    fontSize: "1rem"
    lineHeight: 1.55
  label:
    fontFamily: "General Sans"
    fontWeight: 600
    fontSize: "0.8125rem"
    letterSpacing: "0.08em"
  mono:
    fontFamily: "JetBrains Mono"
    fontFeature: "tnum"
    fontSize: "0.8125rem"
  # The seven documented steps, expressed as roles so the scale is readable
  # by tooling instead of only by a human reading the prose below.
  h1:
    fontFamily: "Cabinet Grotesk"
    fontWeight: 700
    fontSize: "1.75rem"
    letterSpacing: "-0.02em"
  h2:
    fontFamily: "Cabinet Grotesk"
    fontWeight: 700
    fontSize: "1.25rem"
    letterSpacing: "-0.01em"
  ui:
    fontFamily: "General Sans"
    fontSize: "0.875rem"
  small:
    fontFamily: "General Sans"
    fontSize: "0.75rem"
  figure:
    fontFamily: "JetBrains Mono"
    fontWeight: 600
    fontSize: "2.75rem"
    letterSpacing: "-0.02em"
rounded:
  sm: "2px"
  md: "3px"
  lg: "4px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.redact-fill}"
    textColor: "{colors.on-primary}"
  button-primary-hover-dark:
    backgroundColor: "{colors.redact-fill}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.sm}"
  input:
    backgroundColor: "{colors.surface-raise}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.sm}"
    height: "44px"
  ledger-row:
    backgroundColor: "{colors.surface-dark-raise}"
    textColor: "{colors.text-dark}"
    borderColor: "{colors.rule-dark}"
  state-pill:
    rounded: "{rounded.sm}"
    fontFamily: "{typography.mono.fontFamily}"
  redaction-bar:
    backgroundColor: "{colors.primary}"
    rounded: "{rounded.sm}"
  redaction-bar-dark:
    backgroundColor: "{colors.error-dark}"
    rounded: "{rounded.sm}"
  state-pill-success:
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
  state-pill-success-dark:
    textColor: "{colors.success-dark}"
    rounded: "{rounded.sm}"
  state-pill-error:
    textColor: "{colors.error}"
    rounded: "{rounded.sm}"
  state-pill-error-dark:
    textColor: "{colors.error-dark}"
    rounded: "{rounded.sm}"
  nav-link:
    textColor: "{colors.text}"
---

# Veil

## Overview

**Creative North Star:** A redacted document. The product's whole claim is a negative — *you cannot read this amount* — so the interface should look like a record that has been deliberately struck out and then handed back to its owner intact. Paper and ink at the front, graphite and ciphertext at the desk.

**Product context:** Private payment rails for the agent economy. x402 (HTTP 402) agent payments on Solana, settled through Token-2022 Confidential Balances, with a merchant reconciliation dashboard. Users: the backend engineer integrating it, the merchant reconciling their book, and a hackathon judge deciding if it is real. Category peers: x402 SDKs, Fireblocks/Cloudflare facilitators, Solana privacy projects.

**Mode per surface:** Landing = Persuade. Dashboard = Operate. Honest-limits page = Read. Two-window demo = Persuade (evidence).

**Reference sites:** Fontshare (Cabinet Grotesk, General Sans), Google Fonts (JetBrains Mono), Solana branding page (category palette to depart from).

**Key characteristics:**
- A ledger, not a dashboard. Tables and rules, never a grid of cards.
- One red used three ways: the redaction bar, the accent, the error treatment. Colour carries meaning.
- Every number and address is monospaced with tabular figures so columns line up.
- Square corners (2-4px). A record does not have bubbly edges.

## Colors

**Strategy:** Restrained — one accent plus neutrals. Colour is rare and always meaningful.

**Light or dark is decided by the use scene, not by category.** The landing page is read in daylight, on a phone, by someone skimming: paper `#F2F2F0` with ink `#17161A`. The paper ground is a neutral document stock rather than a warm cream — warm off-white is the reflexive "tasteful" backdrop, and a redacted statement reads as printed paper without it. Cooling the ground also widened the headroom on every light-side ratio (muted 4.92→4.95, redact 5.39→5.43, success 4.80→4.83). The dashboard is watched for long stretches at a desk beside a terminal and a block explorer: graphite `#101114` with `#E8E6E1`. Same system, two grounds; dark mode is not an inversion of light, each is composed for its own ground (red is lifted to `#DE523C` on graphite, where the dark-ground variant only clears AA for small text from there upward).

**One red, three treatments.** `#B4341F` is the redaction ink. It appears as (1) the filled redaction bar over a hidden amount, (2) the primary accent (active view toggle, link emphasis), and (3) the error treatment. Because brand and error share a hue, error states must never rely on colour alone: every error carries a code, a glyph, and words. Do not introduce a second red to separate them.

**Neutrals derive from the ground, not from grey.** Muted text on paper is a warm `#6B6862`, not a desaturated black. On graphite, muted text is `#8A8C93` — a cool tint of the ground, never neutral grey. Secondary text on a coloured surface is tinted from that surface's hue.

**Red is never body text on graphite, and white never sits on the lifted red.** Measured, not eyeballed: `#B4341F` on paper is 5.43:1 and `#DE523C` on graphite is 4.84:1, so red does pass AA as small text on its own ground. But white on the lifted `#DE523C` fill is only 3.66:1 and fails, so any filled red surface carrying a white label uses `redact-fill` `#B4341F` (6.08:1) on both grounds. The redaction bar is a graphic, not text, and clears the 3:1 non-text floor on both grounds.

**Every token was measured against its own ground.** The semantic colours were swept for a 4.5:1 small-text floor with headroom rather than picked by eye, which is why the light-ground success, warning and error are darker than a default palette would set them. Measured pairs: muted on paper 4.95:1, muted on graphite 5.62:1, ink on paper 16.07:1, `#E8E6E1` on graphite 15.14:1, success light 4.83:1, success dark 5.55:1, warning light 4.92:1, warning dark 7.34:1, error light 4.92:1, error dark 4.84:1, white on `redact-fill` 6.08:1, and the keyboard focus ring 5.43:1 on paper / 4.84:1 on graphite / 4.54:1 on `surface-dark-raise`. Hairline rules are decoration and take no contrast floor: the table's structure is carried by `<th scope>`, `<caption>` and row order, so raising a 1px divider to 3:1 would put a hard black grid on a ledger. Everything else is re-measured after any token change, because a hue swap does not preserve the ratio.

## Typography

Three roles from two source worlds: a display grotesque with a slightly archival character, a geometric body sans from the same foundry, and a developer's mono for every figure.

- **Display — Cabinet Grotesk 700** (Fontshare, free for commercial use). Headlines, the wordmark, and section titles. Display tops out at 4.25rem; size is not hierarchy. It replaces the Space Grotesk that an earlier plan drafted, because Space Grotesk is a convergent default and cannot be the display voice.
- **Body and UI — General Sans 400/500/600** (Fontshare, free for commercial use). Body copy, labels, buttons. Labels are 600 with 0.08em tracking, uppercase, and always sit closer to the content they introduce than to what precedes them.
- **Mono — JetBrains Mono 400/500/600** (Google Fonts). Every amount, address, alias, slot number and error code. `font-variant-numeric: tabular-nums` is required so ledger columns align; JetBrains Mono carries tnum, and if a CDN strips the feature the face must be self-hosted rather than letting numerals go proportional.

**Scale:** 12 / 13 / 14 / 16 / 20 / 28 / 44px. Body never drops below 16px. Headings differ from body by more than a weight step — the levels are separate sizes, not bolder paragraphs.

**Loading:** `display=swap` on both providers, `preconnect` to `api.fontshare.com` and `fonts.gstatic.com`. Two faces plus one mono, no more.

## Layout

Grid-disciplined everywhere. A ledger is a grid and should look like one.

- **Max width:** 1120px content, 1180px outer, gutters 24px desktop / 16px mobile.
- **Density:** the dashboard is dense on purpose. Row height 44px, cell padding 11px vertical, 24px horizontal. The landing is the loose surface: 48px section rhythm.
- **Spacing rhythm:** 4 / 8 / 12 / 16 / 24 / 32 / 48. Less space between related things than unrelated ones; more space above a heading than below it.
- **Breakpoints:** 375 / 768 / 1120. At 375 the ledger table becomes stacked row blocks (one payment per block), the truth strip pins, and the demo splits into a vertical stack. A sideways-scrolling table is not responsive design.
- **Intentional grid break:** none on the dashboard. On the landing, the two-window demo is the one full-bleed element, because it is the argument.

## Elevation & Depth

Almost none. Depth in this system is a hairline rule and a ground change, not a shadow.

- **Surfaces:** two grounds (paper, graphite) and one raise per ground. A raise is a subtle lightness step (`#FFFFFF` on paper, `#17181C` on graphite), not a floating card.
- **Shadows:** reserved for the one place something genuinely overlays — a dropdown or an expanded row. Offset plus soft blur, never a zero-offset coloured halo, never a spotlight wash behind the hero.
- **Depth from rules:** 1px `--rule` / `--rule-dark` borders separate rows and zones. A ledger reads as a ledger because of its lines.

## Shapes

Radius hierarchy is deliberately flat and small.

- `rounded.sm` 2px — buttons, inputs, pills, toggles.
- `rounded.md` 3px — panels, the demo frame.
- `rounded.lg` 4px — the outer stage.
- `rounded.full` 9999px — reserved for the 7px status dot only. Never for cards, buttons, or images.

Nested inner radius = outer radius − gap. A card inside a card is always wrong and this system has no cards.

## Components

Every interactive component needs hover, focus-visible, active and disabled states; focus-visible is a 2px `--redact` ring with a 2px offset, never `outline: none` with no replacement.

- **button-primary** — ink fill, paper text, `rounded.sm`, 44px min height. Hover shifts to the redact fill with white text. Disabled drops to 45% opacity and keeps its label readable.
- **button-secondary** — transparent with a hairline border. Used for utility actions (Export CSV, Verify it yourself).
- **input** — raised ground, hairline border, visible persistent label above the field (never placeholder-as-label), 44px min height, helper text below. Invalid state pairs a red border with a red helper line and the reason.
- **ledger-row** — the core component. Alias + vendor + state pill + amount, with the amount right-aligned in tabular mono. Rows are separated by hairline rules, not by card chrome.
- **state-pill** — mono, `rounded.sm`, always carrying a text label. `settled` uses success; `verifying` uses a dashed border; an unreadable-amount row uses the error treatment plus the reason. Colour is never the only signal.
- **redaction-bar** — a filled `--redact` block sitting over the true digits, with a repeating hatch. In the reveal state it becomes transparent and the number shows. This is the system's signature element.
- **view-toggle** — a two-segment control (`Public` / `Auditor`), 44px targets, `aria-pressed` on the active segment, active segment filled with `--redact`.
- **confidentiality-badge** — the `enforced` badge in success, with a refusal variant in error when the assertion fails. Its tooltip names the two assertions checked.
- **empty-ledger** — warmth, a plain explanation, and one primary action. "No private payments yet" plus Copy alias and View integration. Never just "No data".

## Do's and Don'ts

- **Do** put the settled total in tabular mono at the largest size on the dashboard; it is the one number the merchant came for.
- **Do** show Settled and Available as two figures with the in-flight delta. A confidential transfer is not instantly spendable and hiding that breaks trust.
- **Do** give every state a label, not just a colour — codes, glyphs, and words.
- **Do** keep the redaction bar as the single authored motion; nothing else on the page animates.
- **Do** state the honest limits (addresses stay public, low-volume timing is correlatable) on a real page, reachable by keyboard.
- **Don't** use purple or blue gradients, dark neon glows, or any of the three converging looks. The category default — dark background, neon accent, 3D render — is exactly what a privacy claim must not look like; it reads as a token, not a record.
- **Don't** build a card grid. No 3-column feature rows, no icon-in-a-coloured-circle, no rounded card with a drop shadow. A ledger is a table.
- **Don't** use Space Grotesk, Inter, DM Sans, or any convergent default as the display voice, and never `system-ui` for display.
- **Don't** let red carry meaning alone, and never set red body text on graphite — measure it or use a filled bar instead.
- **Don't** put a white label on the lifted dark-ground red (`#DE523C`). White text goes on `redact-fill` `#B4341F` only; that is the one red that clears 4.5:1 with white on both grounds.
- **Don't** give every element the same large radius, add decorative blobs to fill space, or put a kicker above a heading.

## Motion

- **Approach:** intentional — minimal, but with one authored moment that carries the product's meaning.
- **Easing:** enter `cubic-bezier(0.22,1,0.36,1)` (ease-out); exit ease-in; move ease-in-out.
- **Duration:** micro 80ms · short 200ms · medium 320ms · long 560ms.
- **The one authored moment:** the redaction lift. When the merchant switches Public → Auditor, the redaction bars over the amounts lift in a 320ms stagger and the true numbers appear. Under `prefers-reduced-motion` the values swap instantly with no transform. No other element on the page animates on its own.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-02 | Initial design system created | Created by /design-consultation from the Veil product context and category research (Fontshare/Google Fonts verification, Solana brand palette reviewed as the category default to depart from) |
| 2026-10-02 | Display face changed from Space Grotesk to Cabinet Grotesk | Space Grotesk is on the convergent/overused-as-display list and cannot be the display voice; Cabinet Grotesk carries the archival character the redaction metaphor needs and is free for commercial use |
| 2026-10-02 | Light landing, dark dashboard (not one theme) | Decided by the use scene: landing read on a phone in daylight; dashboard watched beside a terminal for long stretches |
| 2026-10-02 | One red for redaction, accent and error; disambiguated by label and glyph | The redaction ink is the brand; splitting it into two reds would weaken the metaphor, so errors must never rely on colour alone |
| 2026-10-02 | Semantic tokens re-swept for a measured 4.5:1 floor; added `redact-fill` | A contrast sweep found four tokens failing AA as small text (`success` 4.43, `warning` 3.20, `error` 4.34, `error-dark` 4.26) and the file's own red-on-graphite figure wrong (written 3.9:1, measured 4.26:1). Every value is now measured with headroom, and `redact-fill` pins white-on-red to the only fill that clears 4.5:1 |
