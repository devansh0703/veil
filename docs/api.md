# API reference

Every export is TypeScript-typed and every failure is a structured `VeilError`
(see [Errors](#errors)). There are three surfaces: the **merchant** flip, the
**agent** fetch, and the raw **HTTP** protocol for developers who will not take
an SDK.

---

## Merchant — `veil(options)`

```ts
import { veil } from 'veil-x402';

const merchant = await veil({
  payTo: 'YourWalletAddress',   // required
  price: '0.05',                // decimal units, default '0.05'
  path: '/',                    // default '/'
  description: 'Paid resource at /',
  produce: ({ paid }) => ({ ... }),
  // network, asset, decimals   → default to the hosted rail's mint
  ledgerPath: 'data/pool-ledger.<slug>.json',
  spendCap: '5.00',             // per-session; null disables
  privacy: PrivacyProbe,        // precondition probe; defaults to the pool ledger
  poolSize: 8,                  // one-time accounts provisioned on first run
});
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `payTo` | `string` | — | **Required.** The wallet you are paid at. Used as the alias. |
| `price` | `string` | `'0.05'` | Flat price per call, decimal units. |
| `path` | `string` | `'/'` | The path you serve. |
| `description` | `string` | `Paid resource at <path>` | Human label for the resource, shown in the 402 offer. |
| `produce` | `(ctx) => unknown` | `{ paid: true }` | Runs only for a paid caller. |
| `network` | `Network` | hosted rail's network | The cluster (`solana:testnet` by default). |
| `asset` | `string` | hosted rail's mint | The payment mint. Must carry the confidential extension. |
| `decimals` | `number` | `6` | Must match the mint. |
| `ledgerPath` | `string` | `data/pool-ledger.<slug>.json` | Where this merchant's pool is persisted. |
| `spendCap` | `string \| null` | `'5.00'` | Enforced **per payer**. `null` disables. |
| `privacy` | `PrivacyProbe` | the pool ledger this call wrote | Answers the confidential preconditions; `'unknown'` is not a pass. |
| `poolSize` | `number` | `8` | Provisioned on first run, then loaded from disk. |

Returns `VeilMerchant`: `{ server, handler, config, facilitator, ledger, provisioned }`.

- `handler` is a `(req, res)` function — assign it to any route.
- `server` is a `createServer(handler)` for `server.listen(port)`.
- `ledger.allFor(alias)` is what a dashboard reads: seats, which are consumed.
- `provisioned` is how many accounts this call created (`0` on later runs).

**Errors.** `veil()` throws `TypeError` if `payTo` is missing. A resource the rail
will not serve is a refusal, not a throw: the response carries
`veil: { refused, message, remedy }`.

---

## Agent — `veilFetch(url, input)`

```ts
import { veilFetch } from 'veil-x402/client';

const result = await veilFetch('https://rail/v1/resource', {
  payerSigner,        // required — signs proofs and the payment
  keys,               // required — the payer's ConfidentialKeys
  rpcUrl,             // required
  budget: '0.10',     // decimal units; enforced before signing
  nonce: 1,
  payer: 'my-agent',  // X-Payer; defaults to the signer address
  decimals: 6,
  maxRetries: 1,      // retries a non-final 402, never a refusal
  onStep, onPayment,
});
```

Returns `VeilFetchResult`:

```ts
{ status: 200, data, paid: true, spent: 1000n, payment: { signature, amount, payTo } }
```

- `spent` is atomic units **including this call** — thread it into the next call
  to enforce a cumulative budget.
- `paid` is `false` when the resource was already free or already served.

**The budget is checked before anything is signed.** A price that does not fit
raises `VEIL-BUDGET-002` and no payment is attempted. There is deliberately no
fallback to a public payment.

## Agent — `createVeilAgent(options)`

A stateful wrapper for an agent that makes many calls.

```ts
const agent = createVeilAgent({ payerSigner, keys, rpcUrl, budget: '1.00' });
await agent.fetch(url1);
await agent.fetch(url2);
agent.spent; // running total
```

It owns the nonce (a fresh one per call — reusing a nonce is a
`409`), and the running spend.

---

## Low-level helpers

| Export | Signature | Use |
|---|---|---|
| `payVeilResource` | `(input) => Promise<PayVeilResult>` | The payment itself, without the fetch loop. |
| `feePayerOf` | `(rail, fetchImpl?) => Promise<Address>` | Reads `/supported` for `kinds[0].extra.feePayer`. |
| `readTokenAccount` | `(rpc, address, keys) => Promise<VeilTokenAccount>` | Decrypts `{ available, pending }`. |
| `findTokenAccount` | `(rpc, owner, mint) => Promise<Address \| null>` | Locates the owner's account for a mint. |
| `applyPending` | `(rpc, account, owner, keys) => Promise<signature>` | Pending → spendable. |

`VeilTokenAccount` is `{ available, pending, expectedPending, publicBalance }` (all
`bigint`) plus the raw `decoded` token account and the still-encrypted
`balanceCiphertext`. `available` is spendable now; `pending` needs `applyPending`.
The account address is the argument you passed in, not a field.

A merchant's money is spread across its one-time seats, so read *all* of them
rather than "the" account for a mint — the one-shot lookup returns whichever
account the RPC lists first, which after a few payments is often an empty seat.

---

## Errors

Every failure is a `VeilError` whose `toEnvelope()` gives the DX spec's shape:

```ts
{ type, code, message, param?, cause?, fix, doc_url }
```

`type` is one of `veil_refusal` (the rail declined by policy — final),
`veil_client_error`, `veil_rail_error`, `veil_budget_error` (your own limit).

| Code | Type | Meaning |
|---|---|---|
| `VEIL-ACC-001` | refusal | Destination cannot receive confidential credits. |
| `VEIL-BUDGET-002` | budget | Would exceed your budget. Nothing is signed. |
| `VEIL-CONF-003` | refusal | Confidentiality cannot be guaranteed — **refuses to pay**. |
| `VEIL-OFFER-004` | rail | The 402 was not a usable Veil offer. |
| `VEIL-POOL-005` | refusal | Merchant has no unconsumed seat left. |
| `VEIL-PAY-006` | rail | Built but did not settle; `cause` carries the detail. |
| `VEIL-CONTEND-008` | refusal | The rail could not claim an address before another instance took the ones it could offer. Retry. |
| `VEIL-RAIL-007` | rail | The rail could not be reached. |

`isVeilError(value)` narrows. `VEIL-CONF-003` is load-bearing: a downgrade to a
public payment is the worst bug this product could ship, so it is an error the
caller cannot swallow by accident.

---

## HTTP protocol

For a client that will not take an SDK.

**Ask.** `GET <resource>?nonce=<n>` with `X-Payer: <name>`. An unpaid ask gets
`402`:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact-confidential",
    "network": "solana:testnet",
    "asset": "<mint>", "amount": "1000", "payTo": "<one-time account>",
    "resource": "https://<host>/<resource>",
    "extra": { "tokenProgram": "…", "decimals": 6, "poolIndex": 0, "privacy": "…" }
  }]
}
```

**Pay.** Send `X-PAYMENT: base64(JSON)` where the JSON carries **top-level**
`x402Version`, `scheme`, `network` and the signed transaction. This is the rail's
native payload — the hoisted x402 v2 form, which nests `scheme`/`network` under
`accepted`, will be rejected with `scheme must be exact-confidential`.

**Answers.** `200` with the resource · `402` re-offer (retry) · `409`
`payment-already-settled` with `settledAt` · `5xx` structured refusal.

**Preflight.** The rail answers `OPTIONS` for `content-type, x-payer, x-payment`.

### Rail endpoints

| Path | What |
|---|---|
| `GET /` · `/dashboard.html` · `/limits.html` · `/402.html` | Human surfaces. |
| `GET /.well-known/veil` | Discovery. |
| `GET /v1/health` | Pool size, settled count, RPC. |
| `GET /supported` | x402 `kinds[]`, including the fee payer. |
| `GET /facilitator/health` | The facilitator's own health. |
