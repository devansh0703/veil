# Concepts

Veil makes one specific thing private: **the amount of an agent payment**. It
does not pretend to hide anything else, and knowing which is which is the whole
of using it well.

## The two layers

### Layer 1 — confidential balances (the amount)

The payment moves a Token-2022 balance between two *confidential* accounts. The
account state on chain holds an ElGamal ciphertext and an AES ciphertext of the
balance, not a number. A confidential transfer carries the ciphertexts, a
zero-knowledge proof that the transferred amount was in range, and a proof that
the sender's remaining balance did not go negative.

The practical consequence: you can read the explorer link and see that a
transfer happened, but not how much moved. The recipient — and an auditor key set
on the mint, if one is — can decrypt it.

### Layer 2 — one-time accounts (the graph)

Confidential balances hide amounts. They do not hide *that an account exists*. If
a merchant received every payment into one token account, you could still count
the transactions and correlate them with the merchant's public identity: amount
privacy with a fully public graph wrapped around it.

So every payment lands in a different pre-created account. Two payments to the
same merchant never sit next to each other on the account graph.

These accounts **cannot be derived**, and the design notes say so explicitly
rather than shipping a derivation that would silently disagree with itself.
There is exactly one deterministic address form per `(owner, mint)` — the
associated token account — so a pool of N accounts is created once and its
addresses recorded. What *is* deterministic is which slot a payment is assigned:
`deriveSlot(identity, poolSize)` is pure, so the merchant can reconcile an
incoming payment without the payer telling it anything extra.

## What a payment actually does

```
agent                          rail (facilitator)              merchant
  |  GET /resource?nonce=N  ────────►  |
  |  ◄──── 402 + offer (price, seat)   |
  |  generate 3 proofs, write them,    |
  |  verify them into context accounts |
  |  sign the transfer (own half) ───► |
  |                    co-sign fee → broadcast ──► chain ──► merchant seat
  |  ◄──── 200 { paid: true }          |
```

Three proofs precede the transfer, each in its own transaction:

- **equality** — the new balance ciphertext encrypts the same value the
  instruction actually subtracts,
- **ciphertext-validity** — the sender's ciphertexts are well-formed,
- **range via record** — the sender's remaining balance is at least the amount,
  which is the negative-balance guard.

The payer signs the money movement. The rail co-signs only the network fee, so a
reasonably-funded buyer is not the rail's problem, and the rail never holds the
payer's keys.

## The identity, and the 409

A payment identity is `(resource, payer, nonce)`. It is deterministic, so the
same identity always maps to the same seat — a client that retries a `402` after
a network blip does not burn a second seat. Once it settles, that identity is
spent: asking again returns **`409 payment-already-settled`** naming the time.
Nonces must be fresh per payment, which is why the agent SDK generates one per
call rather than letting you set it.

## The honest limits

Stated plainly, because a privacy claim that overreaches is worse than a modest
one:

- **Amounts are hidden. Existence is not.** An observer sees that a transfer
  happened, which accounts were involved, and when. Veil does not claim
  unlinkability; the defensible claim is **"not trivially correlatable"**.
- **Timing analysis is not defeated.** At low volume, one payment shortly after
  one request is a correlation. Batching and cover traffic would help; they are
  not built.
- **The auditor key is global per mint.** If one mint is shared between
  merchants, one auditor secret decrypts every merchant's transfers. The
  per-merchant topology is an open decision (`TODOS.md` T-4), not a solved
  problem.
- **The hosted rail's ledger is durable only when it is configured.** With
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set, one shared ledger
  answers "already settled" and "which seats are spent" the same way on every
  instance. Without them each warm instance re-seeds its seat map and those
  answers can differ. Chain balances are unaffected either way — this is
  accounting memory, not money. `/v1/health` reports which mode is in use.
- **An unpaid offer already holds a seat.** The rail reserves the one-time
  account before it answers a `402`, which is what stops two instances selling
  the same address to two payers. That reservation is never released: a retry of
  the *same* identity reuses its seat, but a *new* nonce — or a new payer — takes
  a fresh one. Unpaid requests therefore consume capacity, so a crawler walking
  fresh nonces can exhaust a pool without paying anything, and the rail then
  refuses honestly (`VEIL-CONF-005`) rather than reuse an address.
- **A consumed seat is never re-armed.** Re-arming would put a second payment in
  an account that already holds a settled one, linking them. Instead the pool is
  grown, and exhaustion is a named refusal (`VEIL-CONF-005`) rather than a silent
  reuse.

## Where defensibility actually lives

Not in the cryptography. The confidential-transfer primitives are Solana's. Veil's
position is the facilitator, the one-line merchant integration, the auditor
workflow, and the dashboard — and if the x402 spec absorbs confidential
settlement, that is the part that survives.

## See also

- [Quickstart](./quickstart.md) — run one.
- [Verify it yourself](./verify-it-yourself.md) — read the ciphertext back.
- `docs/designs/veil-agent-payments.md` — the original design and its reasoning.
