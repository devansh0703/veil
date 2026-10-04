# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: semver, from `0.1.0`.

**This is a `0.x` hackathon build. Expect churn.** The policy is stated plainly
rather than implied: while the version is `0.x`, minor versions may change
behaviour, and the breaking changes are listed here rather than discovered in
production.

## [Unreleased]

### Added

- **A durable, shared hosted ledger** (`scripts/ledger-store.ts`), on Upstash
  Redis over its HTTP REST API. One key per cluster; writes merge and
  compare-and-set in Lua so two instances settling at once lose no seat; reads
  go through the store on every quote and settlement, so a reservation made by
  one instance is visible to the next. `loadLedgerFor` merges the store's
  consumption over the bundle's structure, so a redeploy that armed more seats
  grows the pool instead of shrinking back to the first write. `GET /v1/health`
  reports `ledger: durable-store` or `local-file`, so a deployment without
  credentials degrades visibly rather than silently. Unset credentials change
  nothing.
- **A second deployment, on devnet** (`https://veil-devnet.vercel.app`): the same
  code, seeded with `data/pool-ledger.devnet.json`, on `solana:devnet`.
- `solamiRpcUrl()` in `scripts/lib.ts`: Solami as the RPC default where it can
  serve the cluster (mainnet-beta only; its Solana route accepts `solana` and
  ignores query params, so devnet and testnet keep their public endpoints).
- `.env.example` documenting every optional variable, including the durable
  ledger and the RPC provider.

- `docs/` — quickstart, concepts, API reference, troubleshooting (keyed to the
  error codes), and a verify-it-yourself walkthrough.
- `LICENSE` (MIT) and this changelog.
- The `veil` CLI: `init --sandbox`, `balance`, `pay`, `doctor`, `scaffold`,
  with a non-interactive `--ci` mode.
- `create-veil-merchant` scaffold (`scripts/create-merchant.mjs`): writes a
  runnable Express merchant whose whole integration is one wrapped handler.
- The sandbox faucet (`npm run sandbox`): a stranger with a keypair gets SOL,
  a confidential account, test dollars, and an applied balance in one command.

### Fixed

- **A settlement is no longer dropped when the quote and the payment land on
  different instances.** A hosted rail routes each request wherever, so the
  instance that settles may never have seen the quote's reservation. Refusing
  there takes a real payment into the merchant's own account and records
  nothing, so a payment may now **claim** a seat that is still free
  (`PoolLedger.claim`). A seat a *different* payment already owns is still
  refused — that is the relinking the pool exists to prevent.

- **A payment refusal arriving as `503` lost its reason.** The rail answers a
  `503` when a pool has run out, with the code in the body's `veil` field — the
  same field a `402` refusal uses. Reading the status first reported "no seat
  left" as "check your network". Any refusal status now surfaces its own code.
- **`veil balance` reported an empty seat.** A merchant's money is spread across
  its one-time seats; the single-account lookup returned whichever the RPC listed
  first, which after a few payments is often an empty one — indistinguishable
  from a payment that never arrived. Every seat is now enumerated and totalled.
- **`join(cwd, absolutePath)` corrupted absolute `--key` paths** by
  concatenating instead of resolving, so `--key /tmp/k.json` looked for
  `<repo>/tmp/k.json`.
- **The `errors` module was imported by a `.js` specifier** Node cannot resolve,
  which broke the client at runtime while typechecking clean.
- **A 32-byte seed key was rejected.** `.keys/payer.json` is a seed while the
  generated keys are 64-byte keypairs; the loader now accepts both.
- **The local rail did not serve `/supported`.** The deployment reaches the
  facilitator through rewrites, so both surfaces share one origin; a loopback
  rail served only the resources, so a client could not read the fee payer and
  could not pay at all. The local entry now mounts the facilitator endpoints on
  the same origin.
- **The client sent the wrong `X-PAYMENT` shape.** The hoisted x402 v2 payload
  nests `scheme`/`network` under `accepted`; the rail reads them top-level, so
  every payment failed with `scheme must be exact-confidential, got undefined`.
  The client now sends Veil's native payload.
- **The hosted resource server never co-signed the fee payer.** It broadcast the
  payer's partially-signed transaction as-is, so the RPC rejected it as *"did not
  pass signature verification"*. Added an optional fee-payer co-signer, wired
  from the deployment's own key. The payer's signed bytes are never altered.
- **The spend cap was global, not per payer.** One buyer could exhaust the cap for
  everyone sharing the rail. It is now keyed per payer identity.

### Changed

- `apply-pending` gained `--read-only` (report the balance, change nothing).

## [0.1.0] — 2026-10-02

### Added

- Initial build: x402 facilitator with two privacy layers (`@veil/x402-core`,
  `@veil/derive` one-time-address pool, `@veil/onchain` Token-2022 confidential
  path, `@veil/server` merchant flip, `@veil/client` agent fetch), the hosted
  rail, the four human surfaces (landing, dashboard, limits, 402), and the
  verification suite.
