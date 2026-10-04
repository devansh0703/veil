# Troubleshooting

Every error Veil raises carries a code, a `fix`, and a link to this page. Find
your code below. The `fix` on the error object is the authoritative one; this
page explains *why*.

---

## `VEIL-ACC-001` — destination cannot receive confidential credits

`type: veil_refusal`

The account the rail offered as the destination is not configured for
confidential transfers, or is not approved. Token-2022 confidential accounts
need a real ceremony before they can hold anything: a configuration proof signed
by the *owner's* key, plus an approval from the mint authority if
`autoApproveNewAccounts` is off on the mint.

**Fix.** If you are the payer and the rail is hosted, this is a rail-side seat
problem — the rail has a pool of pre-armed accounts and one of them was not
armed. If you are running the rail, arm the seat, or give the payer dollars:

```bash
npm run sandbox -- --key .keys/agent.json
```

**Why it is a refusal, not a retry.** Retrying cannot make an unconfigured
account configured. A retry loop here would burn your nonce for nothing.

---

## `VEIL-BUDGET-002` — would exceed your budget

`type: veil_budget_error`

Checked **before** anything is signed. If you set `--budget 0.10` and the rail
asks for more than the remaining headroom, the call stops.

**Fix.** Raise the budget, or spend less before this call. If you are running
more than one call, thread the `spent` value the previous result returned —
`createVeilAgent` does this for you.

**The important non-fix.** Do not work around this by removing the budget. Veil
will not fall back to a public payment, and a caller that disables its own cap
has removed the property that makes an autonomous agent safe to run.

---

## `VEIL-CONF-003` — confidentiality cannot be guaranteed — refusing to pay

`type: veil_refusal`

**Load-bearing, and deliberate.** The rail's precondition probe returned an
answer that is not "yes". A confidential payment that cannot be demonstrated to
be confidential is a public payment with extra steps, and this product refuses to
make one.

**Fix.** Fix the configuration the refusal names (it is on the 402 body's `veil`
field), or point at a rail configured for the mint. The privacy probe's answer is
the thing to read — Veil reports *declared* versus *read* separately, so a rail
that claims confidentiality it cannot demonstrate shows up here rather than
silently paying in the clear.

---

## `VEIL-OFFER-004` — the 402 is not a usable Veil offer

`type: veil_rail_error`

Three causes, in order of likelihood:

1. **The URL is not a Veil resource.** Check it: `curl -i <url>?nonce=1` — a Veil
   rail answers `402` with an `accepts[0].scheme` of `exact-confidential`.
2. **The scheme is wrong.** A stock x402 endpoint answers `exact`, not
   `exact-confidential`.
3. **The identity is already settled.** The rail sent `409`, not `402`. Use a
   fresh nonce — `createVeilAgent` does this per call.

**Fix.** `npm run veil -- doctor` prints whether the rail is reachable and what it
quotes.

---

## `VEIL-POOL-005` — no unconsumed one-time account left

`type: veil_refusal`

The merchant's pool of one-time accounts is exhausted. This is a **feature, not a
leak**: a settled account is never re-armed, because re-arming would put a second
payment into an account that already holds a settled one, and the public graph
would link them. So the pool grows instead, and exhaustion is named.

**Fix.** Grow the pool (`poolSize` when creating the merchant, or
`npm run setup:devnet -- --apply` for a cluster that already has one). Retrying
the *same* payment identity returns its own account rather than spending another
one, but it cannot free a seat: reservations are never recycled, so the alias
stays exhausted until the pool grows. On a hosted rail with the durable ledger
configured the answer is the same on every instance (`/v1/health` reports
`ledger: durable-store`); without those credentials the ledger is per-instance
in `/tmp` and this refusal can differ between instances.

---

## `VEIL-CONTEND-008` — no address could be claimed for this payment

`type: veil_refusal`

On a hosted rail the same product answers on several instances, and an offer is a
claim on a one-time address: it only exists once the shared ledger says so. Two
instances can pick the same free seat for two different payments, and the ledger
keeps whichever claim was written first — so the loser has already named an
address it does not own. Paying into it would take the payer's money into an
account that belongs to another payment, and the settle would then be refused:
money moved, nothing credited.

So the rail re-picks rather than answering with a seat it lost. `VEIL-CONF-006`
is that losing several times in a row — the rail could not claim *any* seat for
this payment within its retry budget, so the offer is refused instead of one it
cannot honour. This is a property of the rail under contention, not of the payer,
and it is **safe to retry** — the next attempt starts from the newest shared
state.

**Fix.** Retry the request. If it keeps happening, reservations are being recorded
slower than quotes are being answered: grow the pool
(`npm run setup:devnet -- --apply`), or run fewer instances against one store.

The server-side code for this is `VEIL-CONF-006`; the client maps it here because
"retry" is the whole remedy and the rail's own name for it says nothing about what
the caller should do.

---

## `VEIL-PAY-006` — built but did not settle

`type: veil_rail_error`

The proofs verified and the transfer was signed, but the rail did not settle it.
The `cause` field carries the rail's `detail`, unswallowed. The three real causes:

- **Signature verification failed.** The fee payer did not co-sign. The rail
  co-signs the network fee; if you are running your own rail and skipped
  `feePayer`, the RPC rejects the transaction because one required signature is
  absent. Configure a co-signer.
- **Not enough SOL.** The payer pays for its own proof transactions. Fund it.
- **Simulation failure.** Read `detail`; it is the program's own error, not a
  summary.

---

## `VEIL-RAIL-007` — the rail could not be reached

`type: veil_rail_error`

You passed a path where an origin was expected, or the network dropped. The
`--rail` value must be an origin (`https://host`), not a URL with a path.

**Fix.** `curl <rail>/v1/health`. If that fails, nothing else will work.

---

## Symptoms without a code

**`scheme must be exact-confidential, got undefined`**
You sent the *hoisted* x402 v2 payload, which nests `scheme` under `accepted`.
The rail reads `scheme` top-level. Send the rail's native payload (see
[API reference · HTTP protocol](./api.md#http-protocol)).

**`Transaction did not pass signature verification`**
The fee payer is missing its signature. See `VEIL-PAY-006` above.

**`decryption failed` / a balance that reads as garbage**
The confidential keys do not match the account. Confidential keys are derived
from the owner's keypair via a deterministic signature — if you load the wrong
key file, or a key file whose first 32 bytes are not the seed, the ciphertext
will not decrypt. The key format every script here expects is a JSON array of 64
bytes: `seed ‖ publicKey`.**`429` from the RPC**
The public devnet/testnet RPC is rate-limited. Set `VEIL_RPC_URL` to a dedicated
endpoint, or put `HELIUS_API_KEY` in the environment: with no `VEIL_RPC_URL`,
devnet runs then resolve to Helius automatically (Helius has no testnet cluster,
so testnet always needs an explicit `VEIL_RPC_URL`). Explorer links can also be
slow to resolve for the same reason — the transaction is on chain even when the
explorer page lags.

**`postinstall` / `npx` says the package does not exist**
`veil-x402` is not published to the registry yet. The scaffold points at a
working copy with a `file:` dependency; see the `README.md` it generates.
