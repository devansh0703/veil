# Verify it yourself

The claim is narrow and checkable: **a payment settled, and its amount is not
readable on the public chain.** Here is the walk from a link to the check, with no
step that asks you to trust the project's own summary.

You need Node 20+ and a clone of this repo. Nothing else — no wallet, no faucet,
no account.

---

## 1. Look at a real settlement

A payment that already happened, testnet:

```
https://explorer.solana.com/tx/g9McSTZdxaucb1qDwNXG8UnwtMYXnhcc3MfnkkHzDMFXuc5FY8iMWiDvRBQ64rNrp8R1WvoBHdCRB23G4PU4RVk?cluster=testnet
```

What to look for, and what each thing means:

- **The transaction succeeded.** `err: null`, status success.
- **Two signatures.** The payer signed the money movement; the rail signed only
  the network fee. The rail never held the payer's key.
- **A `ConfidentialTransfer` instruction.** A transfer happened.
- **No readable number.** The account state it touched holds ElGamal and AES
  ciphertexts. This is the whole point — the explorer shows *that* money moved,
  not *how much*.

If the explorer rate-limits you, read it from the RPC instead:

```bash
curl -s https://api.testnet.solana.com -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction",
       "params":["g9McSTZdxaucb1qDwNXG8UnwtMYXnhcc3MfnkkHzDMFXuc5FY8iMWiDvRBQ64rNrp8R1WvoBHdCRB23G4PU4RVk",
                 {"encoding":"json","maxSupportedTransactionVersion":0}]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;console.log("slot",r.slot,"err",r.meta.err,"sigs",r.transaction.signatures.length);console.log(r.meta.logMessages.filter(l=>l.includes("Confidential")));})'
```

That prints the slot, `err null`, the signature count and the confidential
instruction logs — from the chain, not from us.

---

## 2. Read the amount back with the right key

Now prove the ciphertext is real *and* that the merchant can read it. The payee's
key is in `.keys/test-payee.json` in a full clone:

```bash
npm run cli -- balance --key .keys/test-payee.json --mint H1WQvSNbaRrJrfRME8vrRdMgCvQGEpfzDwUYZmApCA7p
```

```
  owner     4R6xftHQu5P7BLa2eLxN6MjgbEk5ffdnETZMSYz5vQSq
  account   6yLQjQH13ko6GxRCP5QCkuc7PMmZiKwGZ6bZ8N38JKXD
  before    available 1000, pending 0
```

That `1000` is the amount that the explorer could not show you. The merchant's
own key decrypts it. **A different key does not** — that is the other half of the
claim, and you can check it by running the same command with any other key file
and watching the decryption refuse.

---

## 3. Make a fresh payment yourself

Do not take the recorded transaction as the only evidence. Make a new one.

```bash
# one command: key, SOL, confidential account, test dollars
npm run sandbox -- --key .keys/verify.json

# pay a real resource through the hosted rail
npm run pay:agent -- --key .keys/verify.json \
  --url https://veil-devnet.vercel.app/v1/payee/test \
  --budget 0.10
```

You get an explorer link for a transaction that did not exist before you ran it.

Then ask the same payment identity again, and watch it be refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://veil-devnet.vercel.app/v1/payee/test?nonce=<the nonce the pay command printed>" \
  -H 'X-Payer: <its payer name>'
```

`409`, with `payment-already-settled` and the time. A settled identity is spent,
not resold.

---

## 4. Check the budget actually stops the agent

Set a budget below the price and confirm the agent refuses rather than paying:

```bash
npm run pay:agent -- --key .keys/verify.json \
  --url https://veil-devnet.vercel.app/v1/payee/test \
  --budget 0.00001
```

You should get `VEIL-BUDGET-002`, **no signature**, and no transaction on chain.
Check the explorer for the wallet's recent transactions — there should be none
from this call. If the agent had "fallen back to a public payment", you would see
one, and that would be the bug worth reporting. It does not fall back.

---

## 5. Run the whole suite

```bash
npm run verify
```

This runs typecheck, the unit and protocol tests, and the hosted-rail tests
against a locally-served instance of the same handler the deployment uses. It also
fails if the committed `api/*.js` bundles drift from their sources, so a deployment
that does not match the repo cannot pass.

---

## What this does not prove

Listed so the check is honest rather than complete-sounding:

- **Not unlinkability.** The graph is not correlated in these checks; at low
  volume, timing still correlates. See [Concepts · the honest limits](./concepts.md#the-honest-limits).
- **Not the hosted ledger's durability.** `/v1/health` reports a `ledger` field
  (`durable-store` or `local-file`) and a `settled` count. With the store
  configured that count is read from the shared seat map, so it is the same on
  every instance; without it, it is per-instance and a `settled: 0` may just
  mean a different instance answered. The chain settlement is real either way.
- **Not a browser wallet flow.** The client is browser-safe and shares this code
  path, but the checks above drive it from Node.
