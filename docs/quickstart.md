# Quickstart

Two sides, one product. You are either **selling** something behind a paywall or
**an agent buying** it. Both start in under five minutes.

Everything here runs against the hosted rail at
`https://veil-devnet.vercel.app`. Nothing runs on localhost unless you ask it
to.

---

## If you are an agent (buy something)

You need a keypair and some test dollars. One command does both.

```bash
npm run sandbox -- --key .keys/agent.json
```

That command, in order:

1. creates the key file if it does not exist,
2. funds it with a little SOL (it pays for its own proof transactions — the rail
   only covers the settlement fee),
3. creates its Token-2022 account, configures it with the agent's own derived
   confidential keys, and has the mint authority approve it,
4. mints test dollars and deposits them as a confidential balance,
5. applies the pending credit so the balance is spendable *now*.

It prints the account, the balance and explorer links. Then pay something:

```bash
npm run pay:agent -- --key .keys/agent.json \
  --url https://veil-devnet.vercel.app/v1/payee/test \
  --budget 0.10
```

You should see:

```
  ok    price accepted against budget  1000 atomic → 6yLQjQH13ko6GxRCP5QCkuc7PMmZiKwGZ6bZ8N38JKXD
  ok    the rail named its fee payer   <fee payer>
  paid  1000 atomic → 6yLQjQH…
        https://explorer.solana.com/tx/…?cluster=testnet
  http 200  {"paid":true}
  served 1/1 · agent spent 1000 atomic units
```

Open the explorer link. The transaction is real and the **amount is not
readable** — that is the product.

### Spending limits

`--budget` is enforced *before* anything is signed. If the rail asks for more
than the budget allows, the agent stops with `VEIL-BUDGET-002` and never falls
back to a public payment. That last part is the whole point: a client that
quietly paid in the clear when confidentiality failed would be worse than no
client at all.

Run several calls in one command to see the budget and the payment identity
thread across them:

```bash
npm run pay:agent -- --key .keys/agent.json \
  --url <resource-1> --url <resource-2> --budget 0.10
```

---

## If you are a merchant (sell something)

```bash
node scripts/create-merchant.mjs my-api
cd my-api
npm install
export VEIL_PAY_TO=<your wallet>
npm run dev
```

The generated `server.ts` is an ordinary Express app with one wrapped handler:

```ts
const merchant = await veil({
  payTo: process.env.VEIL_PAY_TO,
  price: '0.01',
  path: '/api/insight',
  produce: ({ paid }) => ({ insight: 'the thing you paid for', paid }),
});

app.get('/api/insight', merchant.handler);
```

That is the entire integration. An unpaid request gets a `402` naming the price,
the mint and a one-time account; a paid one reaches `produce`.

Pay it from the agent side:

```bash
npm run pay -- --url http://localhost:4021/api/insight --budget 0.10
```

---

## What you just proved

- A payment settled through the rail, on chain, with a real signature.
- The amount is ciphertext on the public explorer.
- The agent could not exceed its budget.
- The merchant's handler did not change shape — it is still `(req, res)`.

## Where to go next

- [Concepts](./concepts.md) — why amounts are hidden and addresses are not, and
  what the honest limit of that is.
- [API reference](./api.md) — every function, option and return value.
- [Troubleshooting](./troubleshooting.md) — the error codes, keyed to their fix.
- [Verify it yourself](./verify-it-yourself.md) — go from an explorer link to the
  CLI check that reads the ciphertext back.
