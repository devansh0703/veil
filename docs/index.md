# Introduction

Veil makes one thing private that x402 leaves public: **the amount**. It is a
conformant x402 facilitator and resource server that settles in Token-2022
Confidential Balances instead of a plain transfer, so a merchant already taking
x402 adds a settlement address and nothing else.

This documentation is for two people — the merchant selling something behind a
paywall, and the agent buying it. Both start from the [Quickstart](quickstart.html)
and are running against the hosted rail in a few minutes.

Everything here runs against `https://veil-devnet.vercel.app`. Nothing runs
on localhost unless you ask for it.

---

## Why this exists

x402 gave agents a way to pay for an API call without a human and without an
account. It left three things on a public ledger: the amount, the counterparty,
and the pattern of who pays whom, how often. On a chain, that is the whole
customer record.

Veil closes that gap with two primitives that already exist, rather than a mixer
or a promise:

- **Confidential Balances** hide the amount. The chain stores ciphertext and a
  zero-knowledge proof that the transfer was in range and non-inflationary.
- **One-time accounts** hide the edge. Each paid call lands in a fresh
  recipient, so two payments from the same agent never sit next to each other.

What stays public is stated plainly on [Honest limits](../limits.html): account
addresses, timing, and the count of transactions.

---

## Who it is for

**Merchants.** You already accept x402, or you want to. Veil is a drop-in
facilitator: the request and response bodies are the standard ones, and the
402 carries a machine-readable refusal when a buyer's account cannot receive
confidential credits. If you cannot check, you do not quote.

**Agents.** You fetch, you get a 402, you pay, you retry. The budget is
enforced *before* anything is signed, so a rail that cannot guarantee
confidentiality is refused rather than quietly paid in the clear.

---

## How it works

A payment is three beats, all standard x402:

1. **Ask.** `GET /resource?nonce=N` with `X-Payer: <name>`. Unpaid, it answers
   `402` with a price and a one-time account.
2. **Pay.** The payer builds a confidential transfer into that account, signs
   its own half, and retries with `X-PAYMENT`.
3. **Settle.** The facilitator verifies, co-signs the fee, broadcasts, and
   records the settlement. The merchant decrypts its own balance with its own
   key.

For the detail behind each beat, read [Concepts](concepts.html). For the exact
bodies on the wire, read the [API reference](api.html).

---

## Where to go next

| If you want to… | Read |
|---|---|
| Move money in five minutes | [Quickstart](quickstart.html) |
| Understand the two layers and the 409 | [Concepts](concepts.html) |
| Call the rail without an SDK | [API reference](api.html) |
| Fix a `VEIL-*` refusal code | [Troubleshooting](troubleshooting.html) |
| Prove the privacy claim yourself | [Verify it yourself](verify-it-yourself.html) |
| See what it deliberately does not hide | [Honest limits](../limits.html) |
