# Project: Veil — private payment rails for the agent economy

Built for **Colosseum Crypto World's Fair Hackathon**. Submissions close **2026-10-12**.

Design doc: `docs/designs/veil-agent-payments.md`

## Standing rules for this repo

- **Everything lives in this folder.** `/home/devansh/colosseum` is the only place anything gets
  written. No design docs, configs, generated artifacts, wireframes, or notes in `~/.gstack`,
  `~/.claude`, `docs/` outside this repo, or `/tmp`. If a tool (gstack, skills, agents) defaults
  to writing somewhere else, redirect it here or skip the step and say so.
- **Everything real.** No mocks, no stubs, no seeded demo data, no hardcoded metrics. Every
  number in the submission traces to a live devnet transaction with an explorer link.
- **Zero budget.** Free tiers only. Solana devnet only, faucet-funded. Never introduce a
  dependency that requires payment or mainnet.
- **Self-issued test stablecoin.** We own the Token-2022 mint because Confidential Balances
  and the auditor key must be enabled on it.
- **Honest privacy claims.** Confidential Balances hides amounts and balances; token account
  addresses stay public. Never claim more than the primitive delivers.
- **Generated artifacts go in the project directory** (`docs/designs/`), never `/tmp`.

### `GSTACK_HOME` must be exported on every command, not once per session

`export GSTACK_HOME=/home/devansh/colosseum/.gstack` in **each** shell invocation.
Shell state does not persist between tool calls, so an export in one command is gone
the next. gstack's own scripts honour it (`gstack-design-detect.ts` resolves the
analytics root as `GSTACK_HOME || ~/.gstack`), but only when it is actually set —
which is how five detector scans from this session's work landed in
`~/.gstack/analytics/design-detector.jsonl` instead of here.

Set it on any gstack command. Do not prune the home store: deleting from it is itself
an out-of-project write, and it is gstack's own log rather than ours. Redirect, and
say so if something already leaked.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

Surfaces share `web/assets/{tokens.css,app.css,fonts.css,pretext.js,veil.js}`. Never
hardcode a colour, size, radius or duration in a page — add a token to `DESIGN.md` and
`tokens.css` instead. A literal that is genuinely needed (a `prefers-contrast:more`
override, say) gets a named token too, so an automated sweep can tell an intentional
value from a stray one.

## Build and verify

```bash
npm run verify       # typecheck + tests, no network
npm run prove:check  # 13 checks: does this toolchain generate real ZK proofs?
npm run demo:local   # 10 protocol scenarios over real HTTP
npm run pages        # render the four surfaces from the real run (refuses without one)
npm run standalone   # self-contained single-file copies of each surface
npm run fund:devnet  # try every faucet route, report each response honestly
npm run status -- --chain   # read devnet and report what is and is not verifiable
```

## Check a claim before writing it down

This project's whole argument is that its claims are checkable, so a claim in a
comment, a page or a README has to survive being tested. Two have already been
wrong here:

- "The JS toolchain cannot generate proofs, only verify them." **False.**
  `@solana/zk-sdk` exports the generators; `npm run prove:check` measures it.
- "`VEIL-CONF-001/002` are not returned over HTTP." **False.** `gate()` maps both
  to a 402 at quote time.

When you are about to write that something is impossible, blocked, or needs
another toolchain, spend one command proving it. A wrong limit is worse than no
limit: it stops work that was actually available.

`web/*.html` is generated content inside marker comments — edit the surrounding markup,
never the injected figures, and re-run `npm run pages`.
