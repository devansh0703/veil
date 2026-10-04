// scripts/facilitator-app.ts
import { readFile as readFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes as createKeyPairSignerFromPrivateKeyBytes2 } from "@solana/kit";
import { toFacilitatorSvmSigner } from "@x402/svm";
import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema
} from "@x402/core/schemas";

// packages/server/src/scheme.ts
import { x402Facilitator } from "@x402/core/facilitator";
import {
  SettlementCache,
  decodeTransactionFromPayload,
  transactionMessageHash
} from "@x402/svm";
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder
} from "@solana/kit";

// packages/x402-core/src/index.ts
var VEIL_SCHEME = "exact-confidential";
var TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
var SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
var SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
var SOLANA_TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
var NETWORK_ALIASES = {
  devnet: SOLANA_DEVNET,
  testnet: SOLANA_TESTNET,
  "mainnet-beta": SOLANA_MAINNET,
  mainnet: SOLANA_MAINNET,
  "solana:devnet": SOLANA_DEVNET,
  "solana:testnet": SOLANA_TESTNET,
  "solana:mainnet": SOLANA_MAINNET,
  "solana-devnet": SOLANA_DEVNET,
  "solana-testnet": SOLANA_TESTNET
};
var CANONICAL_NETWORKS = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET];
function normalizeNetwork(network) {
  if (CANONICAL_NETWORKS.includes(network)) {
    return network;
  }
  const alias = NETWORK_ALIASES[network];
  if (alias) return alias;
  throw new RangeError(
    `unsupported network ${JSON.stringify(network)}; use one of ${CANONICAL_NETWORKS.join(
      ", "
    )}, or a friendly name such as testnet`
  );
}
var DEVNET = SOLANA_DEVNET;
function networkFromRpc(rpcUrl) {
  const host = (() => {
    try {
      return new URL(rpcUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!host) return void 0;
  if (host.includes("devnet")) return SOLANA_DEVNET;
  if (host.includes("testnet")) return SOLANA_TESTNET;
  if (host.includes("mainnet")) return SOLANA_MAINNET;
  return void 0;
}
var PLACEHOLDER_MINT = "6pFkZndusKGifrKLXgaQJFjUT3Gi9n1uXcwkG7Jef3ur";

// packages/server/src/scheme.ts
var CONFIDENTIAL_TRANSFER_IX = 27;
var CONFIDENTIAL_TRANSFER_OP = 7;
function addressOf(value) {
  if (value === void 0) return null;
  return typeof value === "string" ? value : value.address;
}
function invalid(reason, message, payer) {
  return { isValid: false, invalidReason: reason, invalidMessage: message, ...payer ? { payer } : {} };
}
var ConfidentialSvmScheme = class {
  scheme = VEIL_SCHEME;
  caipFamily = "solana:*";
  #signer;
  #owner;
  #simulate;
  #settlements;
  constructor(options) {
    this.#signer = options.signer;
    this.#owner = options.owner;
    this.#simulate = options.simulate ?? true;
    this.#settlements = options.settlements ?? new SettlementCache();
  }
  /**
   * What a client needs to build a payment: the fee payer, and the two facts that
   * make this scheme different from `exact` — the token program, and the privacy
   * model. Advertising `privacy` here is the same claim the 402 body makes, and it
   * is the field an SDK reads to decide whether to attempt a confidential
   * transfer at all.
   */
  getExtra(_network) {
    const [feePayer] = this.#signer.getAddresses();
    return {
      ...feePayer ? { feePayer } : {},
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      privacy: "confidential-balances"
    };
  }
  getSigners(_network) {
    return [...this.#signer.getAddresses()];
  }
  async verify(payload, requirements) {
    const raw = payload.payload?.transaction;
    if (typeof raw !== "string" || raw.length === 0) {
      return invalid(
        "invalid_payload",
        "payload.payload.transaction must be a base64 signed Solana transaction"
      );
    }
    const wire = raw;
    let decoded;
    let message;
    try {
      decoded = decodeTransactionFromPayload({ transaction: wire });
      const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
      message = decompileTransactionMessage(compiled);
    } catch (error) {
      return invalid(
        "invalid_transaction",
        `the transaction could not be decoded: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const feePayer = addressOf(message.feePayer);
    const signers = this.#signer.getAddresses().map(String);
    if (feePayer === null || !signers.includes(feePayer)) {
      return invalid(
        "fee_payer_not_facilitator",
        `the transaction's fee payer (${feePayer ?? "missing"}) is not one of this facilitator's signers (${signers.join(
          ", "
        )}). Build the payment with the feePayer from /supported.`
      );
    }
    const transfers = message.instructions.filter(
      (instruction) => instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS && instruction.data?.[0] === CONFIDENTIAL_TRANSFER_IX && instruction.data?.[1] === CONFIDENTIAL_TRANSFER_OP
    );
    if (transfers.length === 0) {
      return invalid(
        "no_confidential_transfer",
        "the transaction contains no Token-2022 confidential transfer instruction, so it cannot settle an exact-confidential payment"
      );
    }
    if (transfers.length > 1) {
      return invalid(
        "ambiguous_confidential_transfer",
        `the transaction contains ${transfers.length} confidential transfers; a payment must contain exactly one`
      );
    }
    const transfer = transfers[0];
    const accounts = (transfer.accounts ?? []).map((account) => account.address);
    const [source, mint, destination] = accounts;
    if (!source || !mint || !destination) {
      return invalid(
        "malformed_transfer",
        `a confidential transfer needs at least source, mint and destination accounts; got ${accounts.length}`
      );
    }
    if (destination !== requirements.payTo) {
      return invalid(
        "wrong_destination",
        `the transfer pays ${destination}, but the requirements name ${requirements.payTo}`
      );
    }
    if (mint !== requirements.asset) {
      return invalid(
        "wrong_mint",
        `the transfer moves ${mint}, but the requirements are denominated in ${requirements.asset}`
      );
    }
    if (!requirements.network.includes(":")) {
      return invalid(
        "wrong_network",
        `network must be CAIP-2 (e.g. solana:testnet), got ${String(requirements.network)}`
      );
    }
    const authority = accounts[accounts.length - 1] ?? null;
    if (this.#simulate) {
      try {
        await this.#signer.simulateTransaction(wire, requirements.network);
      } catch (error) {
        return invalid(
          "simulation_failed",
          `the transfer would not settle: ${error instanceof Error ? error.message : String(error)}`,
          authority ?? void 0
        );
      }
    }
    if (this.#owner) {
      const owner = this.#owner(requirements.payTo);
      if (owner === void 0) {
        return invalid(
          "unowned_destination",
          `${requirements.payTo} is not a payment account this facilitator can attribute to a merchant`,
          authority ?? void 0
        );
      }
    }
    return { isValid: true, ...authority ? { payer: authority } : {} };
  }
  async settle(payload, requirements) {
    const network = requirements.network;
    const wireValue = payload.payload?.transaction;
    const wire = typeof wireValue === "string" ? wireValue : "";
    let key = null;
    if (wire.length > 0) {
      try {
        key = transactionMessageHash(
          decodeTransactionFromPayload({ transaction: wire })
        );
        if (this.#settlements.isDuplicate(key)) {
          return {
            success: false,
            errorReason: "duplicate_settlement",
            errorMessage: "this payment is already being settled",
            transaction: "",
            network
          };
        }
      } catch {
        key = null;
      }
    }
    try {
      const verdict = await this.verify(payload, requirements);
      if (!verdict.isValid) {
        return {
          success: false,
          errorReason: verdict.invalidReason ?? "invalid_payment",
          errorMessage: verdict.invalidMessage ?? "payment verification failed",
          ...verdict.payer ? { payer: verdict.payer } : {},
          transaction: "",
          network
        };
      }
      const [feePayer] = this.#signer.getAddresses();
      if (!feePayer) {
        return {
          success: false,
          errorReason: "no_fee_payer",
          errorMessage: "this facilitator has no signer configured",
          transaction: "",
          network
        };
      }
      const signed = await this.#signer.signTransaction(wire, feePayer, network);
      const signature = await this.#signer.sendTransaction(signed, network);
      await this.#signer.confirmTransaction(signature, network);
      return {
        success: true,
        transaction: signature,
        network,
        ...verdict.payer ? { payer: verdict.payer } : {},
        extra: {
          // Enough for a merchant to reconcile without trusting our word.
          privacy: "confidential-balances",
          program: TOKEN_2022_PROGRAM_ADDRESS,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
        }
      };
    } catch (error) {
      if (key !== null) this.#settlements.delete(key);
      return {
        success: false,
        errorReason: "settlement_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        transaction: "",
        network
      };
    }
  }
};
function createVeilFacilitator(input) {
  const scheme = new ConfidentialSvmScheme({
    signer: input.signer,
    ...input.owner ? { owner: input.owner } : {},
    ...input.simulate !== void 0 ? { simulate: input.simulate } : {},
    ...input.settlements ? { settlements: input.settlements } : {}
  });
  const networks = (Array.isArray(input.networks) ? input.networks : [input.networks]).map((network) => normalizeNetwork(network));
  const facilitator = new x402Facilitator();
  facilitator.register(networks, scheme);
  return { facilitator, scheme };
}

// scripts/hosted.ts
import { rename, stat, writeFile } from "node:fs/promises";

// data/pool-ledger.devnet.json
var pool_ledger_devnet_default = [
  {
    slot: 0,
    address: "8NzXxVqLGMnVxtG7iXQGs9rMe3W6xCVjBaAV1kiV4cV9",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "1ce05607c8e8c4456403f35e0068c7503c9727899a12a84d30322f17f60a3c27",
    settledAt: "2026-10-04T09:13:27.944Z"
  },
  {
    slot: 0,
    address: "H6Hm6TXydvh6aMW5QSpa3cggkSfEgKS6ooquRxuRkuX5",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 0,
    address: "4sCsYfcmkYjVLj2JPN66L5XftTS5uGsWwdYmptPyivuX",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "AaTNzTNPnRMohvcjjqEgkteoE2cDhCDE2xvvXdJpUH5u",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "38d238316390d70159c0f9e976a1403111e96bba4c63045a9110d567bfb30bde",
    settledAt: "2026-10-04T09:19:08.756Z"
  },
  {
    slot: 2,
    address: "5XfDZjeYf6AV4zFp41GJNU7yR2wovnVHNf6MSzLFBeXA",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "fd7e0424564fa8369a6c87f565d8d34e94342173dee997f1bfb0e7c7e7c11d65"
  },
  {
    slot: 3,
    address: "CNDJKfBkYJxPESHgKRnygrojwCh3wD5c5EfCCoRhdY5H",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "dbeb0069c1a3528e91a4bfaef99e7ad5c8613041be895ab7fd26a401421fda65",
    settledAt: "2026-10-04T11:07:55.377Z"
  },
  {
    slot: 4,
    address: "8q3Mbg1tmEieqTr6nCTs9hdM7tzpjaKMj1DCJF86sGWJ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "6UoZb2ea6jNNGZucW9GQCdHjXkqeJYJvvPFuBDKc44Hy",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "B4kMvqdAvSswhkPYidze9jvU2mzUccfcfN4W3TD9QR2w",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "7GT198ojf9tCFWSmsgaDmxwErACzAZzJrSEoSKV4AhnQ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 8,
    address: "6Q6twVqvzYNqYGzewwZbKTvL31tGR3ehWsGKV3rSKsXB",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 9,
    address: "6ADy1qAGpEVEKFJrT3SNPi3Cj1gp4658izJtCSnQJEe7",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 10,
    address: "6r91HEgozuzsgt2s3ntb4nTiFuAbtTirB6U7SnYxoR4m",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 11,
    address: "AQjSU7qHwYYY5eVDxtR1oHwjVhuwui45g52UfGY3jAAC",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 12,
    address: "9WWMcgQSbqAVr9KcnooJLrxNVNYsEofH1jDUfx3P3qWV",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 13,
    address: "EzbXGy38BD7LzrF5Mdd6rH3WrePQdzq9CxR3CtqxZfAp",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "BMXy7hwSdojLkGti7KQmcWToioKG8wRCFRQ5N1GVSnMx",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "FiG3C4ELa33w2U9rGoYbgnWwkEdK1wLc5Rp9ueVfMuQF",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "DQcGPhXD4GUBKdQTeYEohAr9SMrGuRBYViUn3hdxdWrE",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "CzpwP4eGuQNtR8nvupDQ1G2r4JNcFHWDovxwToRuwsSZ",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "Azn8mwKHDMJbS9whEs7bHe3RQYXX2ZBFNLjZH887H3ep",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "CfzJds2bi3VCDhJHkHANNkgghVzRKm1GiUQRyWxRjTS",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "4MghHqZrhHMq8qh7ywCoqgPqzS6jaTBgpLfvQSttDxNk",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 8,
    address: "BsFSriDW73fcGdyAcYJETwTch73LbfNEbbCFBmqyxeJW",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "9Sb1hejfYMLfvevp6dqxKC8cfRGcf3earv2z7FDkxASK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "66VxvNyFHaR6ERiZQWeVd8ZYjSk9uhy79UFjkhpMVE3Y",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "3s7AdiB1qSaFiJnq91Gy8EVBg5tr8GuS4eb7jiDVNuZp",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "Cm3thHfw95i7gan6NSzynt5uwFNZTD9jjXwqYnVKphUx",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "22TrV3411W6nhmLK9Qjuxu2hepZv7c5uvm5oZTgX9s95",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "Et6nFAa8fBUVY3RNncLdt8L6gTACrmKsxBadVC2yRSoK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "DAofYHJ2UpWdAvmMeRnxPmGs7RSbPwYMoXFUh7fRs9LK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 8,
    address: "4eQJRr2tUxgRKB13Sab5s5sHx1VDZQ78NRQsswcAXbSv",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 0,
    address: "3NhhiRKrSpPMPXwos5dYtjh9NBSdTg6bwPPQBKxH6XUX",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "3rxAW3sNNyfPHyvcyUU6aoQsPA7AsbR1kuJT87MAdJdz",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "2JFkw7e3FuGfHHoHUpr9wqGAS5g2h8hWZNKY41GSLKBe",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "7WGEJJCcCv27QJBd9vz9jkzbZ2dDBqDhrjcCtwbp3rhv",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "Bp6TmuGuJMkFK4y8DPEytdkWT9SJ5Qxz5a7Nwoo2PHaX",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "BUesXPV2AZmhZV8aX82bMKRYpzkTsQHtVh8BKVmV4DBK",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "Cj955UDqpGtBxxup7YckvjtbWWLDvnct37coymxZ4928",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "HPStuBWAaxzmLLDh3SgfejfW9KA9rgwpNExAMfeMRWq2",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 14,
    address: "8irsAjMM5xDMLS9s12PNDJyj27PNbKTFcBYfX8aF5Nmf",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 15,
    address: "6bRNsSe1cMpbvLHAihZCmHHaEkdPx4QVH7bpV63vFkYi",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 16,
    address: "8i3sJRscRaD2q21N8QtmYAqJvQTk3kt6SydPZh5keSt8",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 17,
    address: "6bK5NNRKaPuXQnUgX8ZnvrQDLpnYAhRY15qYFfymFMRh",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 18,
    address: "GvNPuAZmyFadXrf2nZhYzLfmh62FdWxb5rJiov9AhVmu",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 19,
    address: "3FEZzRK4y3L7kxwxMgB2cyXUknfVMKTA3a5ZTLhCDHTz",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 20,
    address: "HTG9zq3fK4bfaPe2f7XhtHzgeg5nKnNfNzHTrUECC9Hu",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 21,
    address: "4vTgWq1d3kvAraY7iUnJ3PmoVLsp26EP9HtZNzKogvZa",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 22,
    address: "9zQZZcvkbx6xk48FaDWnU7ry2msqQGsDh6ESPbiNpFEQ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 23,
    address: "5tr1h1ZWfpcVwHCF4vvRaZ3fDDFoGGG1XjpHe2zneHiV",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 24,
    address: "H3wcdaaiEHRSjHgNipVQB8164fKMryxLyBfmmKugBw88",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 25,
    address: "CNRoRZWy2NmSxF4pt3cEvE7XXsHto7ibgwLNGJzkXb9X",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 26,
    address: "7J5REEdMUFcj1eZMRGnhY93mCYjRdhu9XJt4Pz6pWWoh",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 27,
    address: "5anDU1RXBWginSsir4L7GfCGHmCBsjU7rApNPfJQexTf",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 28,
    address: "CNf9yt6SmSYTe55YA6MjF6sQcs6uG6j7yaVuT5GEX6ze",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 29,
    address: "82FtQABHUt1NgNjs1RL5BCk8195TFwQJ8JzCPEGWHFnu",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 30,
    address: "GEErmEdZCzWrvdDETBQVMJSS4pSjF7KTowF2vRB8JXVm",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 31,
    address: "2N2Tc1WC8vtbka4Y8fiHYBuUdxtQgfNbFxricpoobw8D",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 32,
    address: "2k66kfCaK8RckTr6yHNdueFfRUew6UdNHJrU7z5DhGrw",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 33,
    address: "8g3QuCpLJ2cJQ4KmaGXYGo3HT647n5bjhZsrE6bu7DvZ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 34,
    address: "FamRFeNaoF9PS3J84Ncp6zfbkkMUrQBin2ks4s6cNJa2",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 35,
    address: "7EGVyn9vjPbLbrzjgeGP9ApkyADwCfhduVNAQ5WxMZiF",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 36,
    address: "p7nDVJUfwtD6utHs1nLEzxsjHAHSShyUehzqzy2Unuq",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 37,
    address: "FPuNZbjHMwK1KDDoYD5U63HKnfUm32V4qdywTPiggN1P",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 38,
    address: "C38nEdEYaknbQqG64L9ytEsHzvz2EA3eqNoRwFvpmg36",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 39,
    address: "5UDSrDZN8gv23iwxjYDjXiP5eGW7346neuUi6xU7nP6M",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 40,
    address: "CNnnQK6boKAV2puv1jeYpps4oViRDfsffwjSuZ4RRGdQ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 41,
    address: "Fd2gqCWxztMGQU71TVaqWUvFr28mtp8EcyhQQjKEwu7q",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 42,
    address: "GrzdqSfBaT61fkcehHsYiH2Nr2FysVU2c8F5aQo2wm5T",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 43,
    address: "JAAigeRZtFV12jWxyesCfWCfF4QuvC6m7gVJBgr1iXzy",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 44,
    address: "5CBY9voxD8HyUEdtoz3DWbSeQvSuth8mv9tQCw3J12ZS",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 45,
    address: "G9XH3N99ntySTDJZLdu2sCMDiWCDtUMqyMdufQJ2g7uF",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 46,
    address: "5xkKhpg1sFYM7A19cCwgHxHqSyCmHWMrHA71JeR7xix9",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 47,
    address: "5durQvjoaNzWuZPmHhZJiLoMNWHTqWuveNHB8mnhkge4",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 48,
    address: "CzdnYusT4p6YCPRn1whmpP5TNWbLQz7yQA9v2fgqVL75",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 49,
    address: "F7c9JRPgL57xqxvMyFRgcog15fpTixQyjaCPovp5uaCo",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 50,
    address: "6KLUNoUg62hbNWiKaCbSBwaRYfcDzwLw9ua2MyiUwUms",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 51,
    address: "6vahoUd2nyEkxYQ2tSuuCnTD6GuqiRFiHEKB81716wJz",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 52,
    address: "EPGHVyt5jGiUqtH2BBSeKCxc5uzukb4y2KQBxtJdJsT6",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 53,
    address: "8imfHYzZHHzeb3PNU9NTPhjjotpYK9W35WEj4P7z2hnk",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 54,
    address: "GTqaJUJZAb6pSrEbaQUG31UxZJRTevgNUzTG9DdkNc1i",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 55,
    address: "FdMVSmiAVY6VjrnMn4qtdZkWr6ZqH59AsCZJGhdxgV2L",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 56,
    address: "DjhbPM9xugu3pNfbmkYgjtueFKTMcng1pkBVTEx41Mk2",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 57,
    address: "G8qDpMNAbmqK6fF3UYqaX81cVJutezZ1kYFnBo1VEf5x",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 58,
    address: "2mVUQ8jU5S9FSNXvrSBUjTSyrs6P9knwzdR6hQMwSF9P",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 59,
    address: "AAb7NAssANnyYFoip5RjDh6bR9bT9X47WAFdtN9UKXRR",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 60,
    address: "XQWsv9YvwV2ryDK5bhJxTMAzEuLDPZ6hBTifZcRD2jd",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 61,
    address: "AWjarMTFzYiZTfZe9z4UWKirRVT41XZEpAbjVpEA1rpH",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 62,
    address: "9mMh819YSfr5itR98Z6s6PrMNMa4rokAjkFRNSiEsPhT",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 63,
    address: "3cuBygU3FhbPdUtzXjtjNa6i5ggTqWjwT8TdMHQ4R8gQ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 9,
    address: "g1DSSA3BLA7eHHvV6cG492hbFgCrsPBY9errRZLFNib",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 10,
    address: "8CvejeptRGSoo4iUktp6ushoC25xpKK6R5nQcDnhnL8D",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 11,
    address: "Ca8wPSEdFzL3tcsMHS6RZ559hmza1AuR554DWXLjuFuv",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 12,
    address: "2NRfCyXHKN2beLmR9S8vuBuAA7Q5NvZZqVukJ61QBkx8",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 13,
    address: "5PYV3ET2qnk87VTy9kzkaLDLEkCKeviSgLUsQff1AU2R",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 14,
    address: "CdnqcETxhGt2RQzPiqnsaiaj3EFboX55SJLHZjwZUJNK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 15,
    address: "3qKxTpdtrYLWMUVp5bFj5GiX2bNwv79jwQrz5VR4cTkK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 16,
    address: "Cse4NgAhf5xgpSmxQAHugdf2oRkRrTBsTZKegNVLa786",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 17,
    address: "Gqa7HBok2x2vsTSu4Qti7B7ma7B1KhYR9QXGT7Dzwx8s",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 18,
    address: "EXgvoEpJhW7996YZGmFRaJPonvr9FZbGuu3anzpSNWRW",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 19,
    address: "2e54eiNhH4wTUrzqTDSHNUW62Ae11wWGacgf7dhKU56H",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 20,
    address: "Eh2h2CQfMKwFWttT4F78EpxFK9GnF4GqdwRcGwsR7d8b",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 21,
    address: "7MjwiLa5vWaWoiDfD6eCLHkx9uiewwjJFSqndjDm1jeT",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 22,
    address: "4SfGixktdB7fBm78PfigSNKYFd6afmtwKw4nKewopJEC",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 23,
    address: "9b9bBAVGUFJ9epv5PWBj3nhjewfP4eLe9io1KT8cA9L",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 24,
    address: "D8hmp96xe7wSJfW9UJyZFBLZUEHk5CuphaFm9xotMM9B",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 25,
    address: "6i9kM6AEbLaP8YSpn9n4ePPxU6YY9QRKr6GtXQzjuXbc",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 26,
    address: "d8vn5GwJGiFzYoMjFgxYa5hQRCeexcVLFkSQJceKVGc",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 27,
    address: "J1MiPMiofucpW5qrdEY6BUEmUwY9tBWZzzR2EtsaC7ec",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 28,
    address: "2dyPoQHwBKiWr59micfeqXHgLnBZd4XK2VoTz4QTCaii",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 29,
    address: "7VZUY89gFpEgxySLTKjLFHxQ344tnWM92HMoaafTWZqe",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 30,
    address: "6ss4bQfL3F83jYc3yY87RaAjouvp1TLeHVEeFsjk3ZET",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 31,
    address: "8524QNEWYHy4gPYwAJZXBHBhv3dJ3uGfFHA53yCg6k4K",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 32,
    address: "AH2jFTZNUqVYnDmgA5ouNHh7BZfkin2PPuBd97sLNX5A",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 33,
    address: "C88rYde7v6HBokwqujGZCxnqaHqeZn5Zd9EEK5tAfYEj",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 34,
    address: "8LmXRAJJ8dqLHvRerhEhWoKcQTRPf631Gfb2SQMHxTUF",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 35,
    address: "8nBT1cwAMRzZF1yERaWYuv5QKjUeBipG7TPZPnxY8Tpj",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 36,
    address: "7m1sp9KtPHfUAz2CLudhCN167tajnCU62Y3DtNiYPwj6",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 37,
    address: "48Kp36XGy6gNhYbiDjxpRDn1aejMMwdKuc8JTsdPjdyP",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 38,
    address: "3DozA9NxsevsE7DV8LiyeuuN4XH18tjf3PDqouPAmCYh",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 39,
    address: "8WezsuLMH9UDMoEnaksm9smMwpL4az8PMzxQBftY12NZ",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 40,
    address: "4Zz4HmTMg5cijtxAdsntFqEJgdhgsLp18ZFxGFTXkXfw",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 41,
    address: "DJvhRcLBvnfJGfQwv3SBdHgzKZu6z7RwLkuYttjJbjr8",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 42,
    address: "FT9bkXvqrMJyierk1CDZADNZxCmTK1toMWSs5AQDF8Hz",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 43,
    address: "J6Hw2gbTAErdVihS33bhZQVJ9W97TQeWBH3te98xofpX",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 44,
    address: "AuNuXZ5EHYKZsg353wSaG82dR3y6qtEzJZrMoL1daVCp",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 45,
    address: "A7GNDNLttwwRNxKJReHzDG7SR8j8iHfvUcEj47zDroSr",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 46,
    address: "8zNBccnPdZ1T2uThUPVz75Ugwq62uG6ebZbxVJ3xDEMs",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 47,
    address: "F3xq69UQi54ZQ9QqbWzFPc1yB164LbnGWDEycAXjqNGL",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 48,
    address: "EX5AeySKh4ngXNTSFCgbsWp7RYfoxU2t2AyGf3jkXzKG",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 49,
    address: "EyVRigfQDAYby9527tbRQPgeu6Sd5inHMmvQVnFtQRfD",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 50,
    address: "FDX8RjRqyQvTXCGfcJSU44Afks4sg9uKb2ttuj3cTgWs",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 51,
    address: "AYsU6u3XMjPDoAgXzVkSN1HsT7gFoELAyfzmDLFQWeJB",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 52,
    address: "F2yswT1DLToxCkXoUATCk7vz9DeGvhofb7BTanezqxrt",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 53,
    address: "CV6bJgTyzeMCBQPnc9F5R7CfEapujAWgMNJ47cJNtb7P",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 54,
    address: "AeKUGL6WKAajSiFzVFBF7dEcMqDee7AKtCWKxk8ev5m2",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 55,
    address: "95YdgdfDCn46E4VqA6b6nUNhngLjYgZKBNDtSFgz3wxW",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 56,
    address: "CUmZiGNMYi7iKpUzX6XNDCpura1wrj7LezsySVauQyAp",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 57,
    address: "FahbEmMZ5noXsM15U3Fy6jBpWAT5sJA5qSQNDH4joRqZ",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 58,
    address: "121TKeao8a5yDgPs3ECnSDCDsjjpudPFDgyaeMHV721N",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 59,
    address: "HZjY1jghYkPhTikAnttzLmsuHGyUyWzzfPjiZQQMEqLz",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 60,
    address: "8oSnzJutjYVHd2yLUmMLy7DruxuW4RqUSEZBTSoH5TNM",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 61,
    address: "HkbsD9XgYP2HDkqgecB7zq5NjX1BfWnb3QBQfF3kta3w",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 62,
    address: "CEZMzeX3RRnq42rLkowVR219iLgV2Q5xZQLWy9JmQbA7",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 63,
    address: "Jfrb4HuQBjAaw6Sr6jUkewgUwjxLWxd1CLBvQfenXCV",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 9,
    address: "3XLvrhMoZv4vZWiDkqXfsQxp8jLGaXhFCoh7Dm95dRma",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 10,
    address: "4iXn3apku1rw73HiZLbftCohTdrjbtjxiR2ng2pxc1Np",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 11,
    address: "DoTrwr3WQU3BidSAUZSJuoZbi8BeLJVrv5a5Fduwn4hK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 12,
    address: "DpbDy8HezR94Jm3wtYBazHpneaSmkrvowZhyanP6W7Yw",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 13,
    address: "2rP2siP4gxMtejfSmWAXQvtPk2UP5pHFb6rzFgnHf6rN",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 14,
    address: "GmddhKvSBCnsFiN5kiuv3RUJaQGL5quSFibCZ32tLCyP",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 15,
    address: "5m5R9Thz8SFm6hqNvCEFYsm99jVQqk9NHiMHpDHDbLGa",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 16,
    address: "2WtbJiWEFZpohig1Ghm95i6Ccdhmy2ADfWNg3RebLNyZ",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 17,
    address: "BdniEV8kgoW93btEpxEFLKDGQyV2b9tTn5rrznEedKcd",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 18,
    address: "5fDPczQnS2Wj2iZP4dPEdBwaJkSMrUoEBpgegaXC6y7T",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 19,
    address: "76tT1YHBqim4ZWikR7giFErFk2q1AcuAgJa4bAkupU3u",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 20,
    address: "b6UbNnZmyBS3F4oPvEovfGf87m4BDfnzSGBiVYhb5Jq",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 21,
    address: "3QHEKpShiNBH8MtMLfdTGqUVVGZeu8Y46P41aAknjdq3",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 22,
    address: "GaH9Mb51RZg9XAwdH54BszBXgjXtmTKRCsNi8aZCJEB2",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 23,
    address: "G7CriebUfbC54K5y9P3LRAtdvNzBNLnnrWc8TkuBJcpx",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 24,
    address: "88w9DYJq75FtbHbJcEPNCPHLpAG9MthLpve8sowWfW5t",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 25,
    address: "HfxPSoSdrRzeHuNJuhDvpam6pJiwwNdEajFuzPMv94xE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 26,
    address: "9Em1V6wh4MFVBKtY56423VVBTXdh4gCTNJ6Y6wQhF8Sf",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 27,
    address: "3BiAjjsCjAadMD9wLAMy7MRruQ8JxiVodbkxerrABxDK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 28,
    address: "4VdzmoD8gnrsYX44s3erepRRQvnWs4Dse1NoLEeKHXB8",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 29,
    address: "1KvQfPtDrUS8AbkshwCAuwxa4w3cpiMHAwKrT5R6H6E",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 30,
    address: "3W7Qsuwgp35StwQbZzvz7ukVofoMhQHHHAQezgETC4yQ",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 31,
    address: "HzfrM1MDppTAR3VTyK4YTVyUy569YPmJJzYKg1D3tNB8",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 32,
    address: "Cyq9WEXewZfBWLibc9HewKd5WkX57CcuTzh6ThLgBNQT",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 33,
    address: "F5VQ4DyXhDCaLKWuT8fCrCFEZqkjPpqrb6cgd9M75hnM",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 34,
    address: "CYPUqpZPZKzrHgqGhvVXDN6GeDkL5RATAwTQmfyLmz99",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 35,
    address: "EyCB2rcYJDFdbgbgPewJPR9NeiQahKtjEdBVXejcuJxE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 36,
    address: "6yU56E55Reeqvj3BVkqrHSwr32eC3xKgmV72CBHe5HDz",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 37,
    address: "AFMACoZYw2E7WZxrGwjHRvri87tbWtg3vZvqbdTyZtnY",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 38,
    address: "G3RTJs5WKz21uQYUqjophwkbjXWRszeFb4QvjURMpWvZ",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 39,
    address: "DZXehdKf7Y4RxmD6CwCvQJ3WwGxewrfuiqbmhTZMGr7T",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 40,
    address: "PjF3RyXkjPLc8iDrrwigEvC84Y9CvUw6dHVmd51yj3B",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 41,
    address: "2RQFeA3uj8qJ9AJ2abn9TMgaAQZVLFpSP2ZRGVmWFTQU",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 42,
    address: "9MEPYbSCZXdkKdsVJVqn2fSKRviQaed4GukWXaekFxMq",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 43,
    address: "GSB9WNbJG6Ww9VnSj4MTQDqLKsjECUwbPPcMtyruECjb",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 44,
    address: "Ajn5qgEWczjjd8GB5xy5vr7TWo5VW63HZWrfQrTBPEe7",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 45,
    address: "E5EU3S9JyuBd9QP73hWXb6EyYr2t1dtZ1sadwjJ2bsuo",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 46,
    address: "WyfwiSrHjfXHH7Lv5fyWRoAynKgagg2KnFYwMqFGjbU",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 47,
    address: "CyYGNB6EqLpTdW3N5cYNegETmj66xi76QJf7Dad1j1Pm",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 48,
    address: "5pAfsMx7kUjk2Dj4YUcjMiJ7upraPYCqs7LRN7yGBxSP",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 49,
    address: "DEdhgmQpRZYGfy4BbA8xiGnGQPXToPYnoZ4nUd5xkjLN",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 50,
    address: "AVu5ttB9cDr4kn5ZHyyW9wuM9jQdQn9aasY5CQAmrUAj",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 51,
    address: "GcdcRBZyNnwbuHVpHRzwGsUHgoCun9YGCqnux5Zbt98h",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 52,
    address: "CxpJPRLqAurjFUeSvToHLLYyeqkJGYHPm2z6mdpPrgrt",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 53,
    address: "94n4oBwSnSVQBU8kuYUX28U6jk8rWcUjMq8Ts2oHMYZK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 54,
    address: "Du1JdBBfnemDW6TjfgYEC78bjLMgcfLpf4mSSLnpxcUc",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 55,
    address: "CAkg3ezreh1HV5kg5dXYY7uWUdAUT2d6xSquDEJyiG9q",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 56,
    address: "HbCCrEvzvst9AZtUjzcAjLxH8A2dMWhE8KTqCbpAJiRE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 57,
    address: "75iy5vmbWVusTeaGynrxMjpc2dt9PFDed87RZ3s2jnCH",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 58,
    address: "6ST8XVwc4Tp7BCVQHfcHfiDec6Ty47q27BDLnVdg2GNJ",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 59,
    address: "BSrGp9ACa5dt5yEcsKnmCXjFmePvx5S19s17REyNZy2J",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 60,
    address: "HGAYKW3d9d1AHt7tYAGeUtfkERcX25MstPP1Fx8HTge3",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 61,
    address: "xkswaKEonGZ4i3ZcqBeYeR8HNNmUhXNEFGZWU97wxQb",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 62,
    address: "u18B5iMznFcdoykk5ZYP1dmbGn9cm2wCsSCqDdDWekM",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 63,
    address: "EWVEKc62BwSXygd8PLPXZSY2fK5JaFMeq2WTtWrJFyhW",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    consumedBy: null,
    slot: 8,
    address: "Emyfr8TtsqAEFrbDYznVu84QLeK2UhLY4dGvbszs1xeK",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 9,
    address: "FbhP3fLRTRLbar6Et6sf7MJd4ZGx9jfmcfx3ohaJSdKD",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 10,
    address: "J2bBS56XTLNMHGrfxfWu1aWJYjkJ1qu73MohQJSvksy5",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 11,
    address: "AdTwCeHp9H1dPqJbWkmqsstjERmkgXKfiMvSfK41BSVZ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 12,
    address: "1V1ZBYtitnLjVSC8rVeRrrR6MYzseHmuE9hds6Cz8UR",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 13,
    address: "HQRqWoErLJGXu5rL1jqyy5GbXPZ6qBa5x9cWmqzqcdEE",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 14,
    address: "Dm2RSr68RFwo464jSf9qmMEJzWNjGtPCXpGgYctXb36T",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 15,
    address: "7uheXP4gSbAogecDqeT3WMZiovbCwLQLPgQrBMZte4ne",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 16,
    address: "GBr9tR8raYUreFqUvSyhvGMGCxcVz5SP5ErCvB2yKD9q",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 17,
    address: "96ovd92jqPLNXvvqijV9XxYrEB2qoJ5atBQG8THnKybv",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 18,
    address: "DnUKU1gGsMCn4hcP2Vh5FXJ2fVipFWP2MVvoMotfAejG",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 19,
    address: "oQvqjmQvSZxMYjWDBJ66JoSPyGjTwNubCgq2o5QSGoA",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 20,
    address: "HRx418bDyHt6DTaEXJtXXkNmZCLBwuC8v21FwJXcVwVy",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 21,
    address: "6tdZjuM57GF2ggKdu6yLmghmD2ZHmap8KtU86WmmDfiK",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 22,
    address: "9CgHbShzBfiqrNcvuXHESCy1Lxq9yA5u4FxZtD8eEYLG",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 23,
    address: "62oLvHCY3fNt2ydKXuGTroyMLXCveEmadapJyPpZzLiT",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 24,
    address: "2Nu14VqUUrq7oZerKsqvgpVCB9kLdGYXPRhVHUYU8CEb",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 25,
    address: "AYDzZuzJNh7E3JBdykbVi5eZ4m1ZE6ZS9MdBHN9pDPGS",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 26,
    address: "9zyhDRUKrRGtNyE1n6U9x2zaQS4YBuAzjcEACdVvii2j",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 27,
    address: "4xsUusaJotgKbKFeXi9FsDnBTXrLaHWQeNhohq2Z9b1K",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 28,
    address: "JAWHKnGZWCbzU8wsYUwaWXtgGi5Ns3XwzYtCym2K5PK7",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 29,
    address: "2wQW5mWEKDPoMTvbrgbAMuKHgbxMs4kheunWHDse3PSG",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 30,
    address: "2K6aiBKiL7g5X8vpFkgYB69ZNyFgAqS9k7fgks3PbBLt",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 31,
    address: "28LKk4rJSvVFRAMJ9XHEUWH1uznwU7d6fDjqStSLUEJz",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 32,
    address: "CTfYjmwGV9wbSxw5dWCxzwmiPvj8NMjVLfkqnKWpLfRZ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 33,
    address: "DXrMugzwZDw1qsC7R8yW71aBFwRv3cSHsPLfxAvStRiV",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 34,
    address: "ESPFk15CtCR3rxFUVB3yWxakkT8LzYBpoCgS7s9eDjiT",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 35,
    address: "DL6qtuhQ8uav7pNg3Qt8nPp4jhhuVj8preNL8PorGJKv",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 36,
    address: "2KQNAXcijsNftX2VxtrQ3kBTkVUiY5tGX4qt99USuuEF",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 37,
    address: "8JCXQnsoMuG68n9uZxkuDbThvFwsdf9Y1ShfPfHjN6EJ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 38,
    address: "5HAmmmQEdAQKfV7WVhiLQvFvvb2cH3o9JhJn9XRB7Dui",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 39,
    address: "FWg8U4Zb52oiXdE51VNx91UTm1aXpY4sDeFKJZHPL9JG",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 40,
    address: "ACw6BcGRN7T5ZdK59XEfMQNCU4zynwseVQuTmLJRJjLR",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 41,
    address: "GHTMwjCJZZii5QGr67cZ8Mtb7yhwG9BHXvSGD9X3Eh3s",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 42,
    address: "6A8GrxnsG4BWTrWCBRAtBKWVA9UDTbE3Nmg75C46vXof",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 43,
    address: "6G7MndpqsQD4FCMEK3datjjDHV4MuVMu9ikYmhbzahze",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 44,
    address: "3nLHsWfoxX9F4U3PuQQVk2bc3hovmRpPxNpooH2SRUSH",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 45,
    address: "kS1M6Jc6anXRoLoC1QGQy3HnZZ7KbYpcw9m8hi1qEeZ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 46,
    address: "KTQzNMGK74iRef1CnRRBYo9iaqxPYKsuqnK9HstRj5A",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 47,
    address: "EcKPExvDQ2QJD8fgiGxy96zXZr69AmPM44A7Y661ANM6",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 48,
    address: "HmHPSymDx6iLXNRYzbATinekeTpvko8mVeXQZjsu5qk5",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 49,
    address: "EwVrZN7PDmNjwH8TjnXmgEcwLySuWYN5SkBPK9MgjxLB",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 50,
    address: "5zMuLCn3y1XxXNET6TDnwmnTYV6A1Nsgqqsbk9z1TGkC",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 51,
    address: "HGNe22PUkw9hjwCNr9rvc4n9AJdXLMNg5mHDFYeNjYhJ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 52,
    address: "CPVoYB137mr5nZTkMemDuqn7UcEXGCwmoe1WrdJC1U9G",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 53,
    address: "G1PfjUuHZokoWksjC4gyKuNU8ibmeN7rb51aBNrt5PgA",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 54,
    address: "3WDwy8HLFhvPhKdw51eEHeTwYWRbnz8NkNYrnJJXdxbV",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 55,
    address: "5y7fmEnvjD7NXkuiwYVMiDLJ1uFqVZ1YuT9S9wG8mDtE",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 56,
    address: "9borj5ipfiZNYENmKWKpYhVqnQfQVKPC5uneomhby9w",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 57,
    address: "8aVRRzxUCyT9bfyhB18zz4J1DdHp8EZ17mo1YRQF2XL4",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 58,
    address: "6H5K4CxqiqCZe37iH1hKF2p1bfUfgTohhfForhC2bAGU",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 59,
    address: "2UJ9twtn8ew4NhVnQxKxN7MrWUFUQWerveDKe5PU8qYR",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 60,
    address: "FBFBJu45qXUs4RWqJGDXJ49Ui8bCn6E7gYeWhTb12TEb",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 61,
    address: "7nPPGNTqqtLoC49237G8qoneALBid7nBAkHRKhbekdn1",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 62,
    address: "5MDe6AEwRaoNVPUskB43qEe2bhwWVmf1rwaKgMH48PXy",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 63,
    address: "5iwxrFsZ36KoEtEz7BPck6FRgG7UB3o95Ba6zietRkN6",
    alias: "payee.test",
    armed: true
  }
];

// data/pool-ledger.json
var pool_ledger_default = [
  {
    slot: 0,
    address: "HYLLJkNr7LpEGa8Eck8EP9vqNxHv1y8z71A7FLKUiHgc",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "ef33d126291d65d68483867bf86ef09eac42db306b077af66b7b4a13f9984b46"
  },
  {
    slot: 1,
    address: "8V561rigpmqDT2JgbeXywg56rdTsxcL2r3bkhiUwnB21",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "d733abde776047e14195968a70b3bbd8a28eb91e28a210366689f6a4a173f912"
  },
  {
    slot: 2,
    address: "5QU2gN1M3cQTSQr5xRcSJWyo669s71Wco3ZFjFHMkgKX",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "06de71ea2af4e0bd3c598f9dc0616c701e7ab4bb1e9ffd68ac9976b52f5d28a6"
  },
  {
    slot: 3,
    address: "Hrso3sCDYjWoPgyLxn3wmabGX1SWMUE9XPSkKZoao9Tv",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "2c559c05dcb464b7bc0a9996feb390261b6316f1e2f0e6571d56752a1dc1d7ba"
  },
  {
    slot: 4,
    address: "DKxzFxrLgCQnaAhrUWyCieDqpnydkTi7Mg3ugkvH1Mvf",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "fd7e0424564fa8369a6c87f565d8d34e94342173dee997f1bfb0e7c7e7c11d65"
  },
  {
    slot: 5,
    address: "7BVQaurz8VSxw8MVHmwruCEq8sSHhww3XKZTmxQSaQJi",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "784112d535ba944ecc2f291636fceb1af4f88d04ae1665f7cdc63cc6ab96fe63",
    settledAt: "2026-10-04T11:17:06.353Z"
  },
  {
    slot: 6,
    address: "J1pqGAewEEKAP5umysRcTpNEitprcHMGZoGjzRBHeyrM",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "5137a666243804dcf4bbf5e860040c3961091569af6bed679f49f9fda53b4b39"
  },
  {
    slot: 7,
    address: "5qCxeApYmJzF1bK46TBqXgwixzVY52EdPrsLGPEDQsF5",
    alias: "oracle.tide",
    armed: true,
    consumedBy: "c0598ed28f0ed9d00c7c0e482176b567bf8cb4fec013d4a821338f77af3b7650"
  },
  {
    slot: 0,
    address: "EU5kSbk1Gdz2KXoRQ294A9yTSoxuWBr4pCu3kt4AmMbo",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "HxDViXQTdsU2M9p9NyoHqsXeeUYswSh8zyTiagFACi83",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "EwL7AqhRTBFXs4V4PcDYAe678e7Aj89hU9ALdM9etZrK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "H9RmhDhdWMzFG9a8YXfWe76dK4B95N7DqpbMLUvCUMsb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "BpJ87GXAevi87cRqB2spDtUTEgP1SDRStN7uzafXNwYA",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "GmDpZNBh73AQ9DaevFDtxhYasKfAmvC9HjiSKowrixhU",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "5vtrXpeAkJWnr4XDbJ26STbvLYhwGmVRLVxNxvvR3ycK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "9UQPMVXFEmNvcTbkUKeakBiH5K7Ca3i1StUJ7yt1pgN",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 0,
    address: "5L5AS47hbYmfTdpt6M4R7mG9LzV8Lnf9jpwNJqxnungo",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "36pT9X5vNLx3kvU87s32nkhrbCWoTeioTsxdzRw7BDCP",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "82GQCuBG2kaZg6irZsFSSxkrcBMT4d3YXiCt5SyDLWfp",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "CxcrAztrHnFGg96yJ4j8VGfVdDUXutZyw8zuvyqXm7KN",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "3Yfz8YLhR4ehwSmwo4awtXbRFzCVMnQ3LYJUdoph5zmq",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "abFQZESM3MaX7SnydD66pNibgHFXj2V5HgnGJV226BE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "8N7ynV8FVWBxv7DajbDo8QVtDKCR9Du8BcCxSYtQsUHq",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "BLrTv22TCL5Jj8VrmmwU3kNQBbdyRh2UPkSjzA2GvMVA",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 0,
    address: "6yLQjQH13ko6GxRCP5QCkuc7PMmZiKwGZ6bZ8N38JKXD",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 1,
    address: "7eXqASoyRn3SQZzp44fZEKMD2HXfxHHGKVWNUkaxQtJH",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 2,
    address: "Dbv7UiuJSZpxGm44UNGUzVun6gJNtjdXfncy5Xxi8bDS",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 3,
    address: "5KULj895DrfDyfkY7HLjVvUjpWkj8QqKMaWFzJEsv7Qa",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 8,
    address: "9b98UPTJdugqCFz1CJmY19zdnpARm1TUSbdpehgvgitS",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 9,
    address: "67YHTLRfM8rjpomSeB22BD7dtzH1vkcfPUTLE45xvXUr",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 10,
    address: "BFRhDN92R4M61ukCEwEu4zDJ3ePjjpKDAe8xnbkmBAJv",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 11,
    address: "EKs8dLWSvuNkfL4xTVXUSohE64ykDbiQpyzCg7SWZ17j",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 12,
    address: "3QJ8PYhtuQbZpVsCCqsQSpUqe59iX6jxdDhWQd4eT9Sf",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 13,
    address: "3FaFqRnuX91o1Q2kZbfSViqwA4ivvFSgCmdsZ7D9Mxmo",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 14,
    address: "HMP76WkARsPNtP8pBePSNDWJWe7zm8akXto2hq3NpiPV",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 15,
    address: "B3nAmWoy2kHYhGgwJkbjLkvsEZ5PoMVAQ6yyAjZQ2Rgq",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 8,
    address: "HFA5Pm4zmk9W7TRiTMJewjSvHch1jhcbp5MeZEFUMkeu",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 9,
    address: "6qV5ZEiT3EKg4u7F6hWWnVnd8VBJEK4nuUwtpqGBjJsZ",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 10,
    address: "CyqL9y6xbtzY9L4mTcxzPWBpDq2iCQTFZE1bHSvHfMvs",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 11,
    address: "EvuZexVwRQTg8G384HQJB6zxEx8AA9NdqqguqYAHEZSp",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 4,
    address: "5Wymf5kd6jyTPfLKzNQU7qXU2cFyVD3zBDcujn4ySrvf",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 5,
    address: "B1R93UPBMNTZS7GRwtUvcrW7sZcP5hDbZfHbKbhZGf2r",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 6,
    address: "HwtN2cSRppH5o249DBwAbVJK7aou9ZLavdpNTBzDHNi7",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 7,
    address: "GDcDS5g2EemFDsUgtnTifD1sCmHtSZRNTVaKSuyGnqnD",
    alias: "payee.test",
    armed: true,
    consumedBy: null
  },
  {
    slot: 16,
    address: "o1whDEuRa4A4SJBm9RY3gny5pgVwv5LJjz9j6zHtqnv",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 17,
    address: "fCse7FahdPStMpjEwqUFBQvDfYekwso8kaGRi61Y9Qd",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 18,
    address: "CbbfyzJf9F1KEJzCfDBBc4emJDd4voJ164VPX12ppKy7",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 19,
    address: "Cv26FFgUBjUyHKiF9Xvr13AsQNp6RWjqED8zziHdCfyx",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 20,
    address: "A1iPYDspMYv1YJ6xWMe484zzrJTv7yJw9iUvXUycdiyc",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 21,
    address: "fxUGC89MFS98qEsFvK4JYD1kzaPh5DEi6iv8mKZosmz",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 22,
    address: "Cn3Kk51hufnWUE5BatnXmvigLnvVq6ZXW8F8gY4VP8Bo",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 23,
    address: "6iBeY25ExHjtkeia8z3NS6tpp8xoet1ob3xsGbA1h1M9",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 24,
    address: "7ps2Ba5KAN4gus7GC9ZVgQfNi77qdBzFh6PpQa7dVAHS",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 25,
    address: "9LDeeAodJcuBpTxpTnyXXFM91kUzf8ZTUg2xGff8KzFW",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 26,
    address: "DU6Tyrj4P4hS5cPiWBGQpHjVMiYbC2DRV2Yiip5LLD2g",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 27,
    address: "4bxttPi8ivbN3TkSBePm6Ea9ix7zTWeE2rh6KV6Yxjby",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 12,
    address: "BgwC3Ak6Lui7BgPuhLC5oTfs4zEZSgFinuZ5oxFMn2sb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 13,
    address: "12WLVJpXhhbdxkhDr1TLbsBBzwW3k8ZjnHzBW2nga6fy",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 14,
    address: "HiibcCd7C1B13GpkDYM4A7D5cVByiRsFHkdmLnFNFFXR",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 15,
    address: "EPieLiFnnjvjui95ydLuwwRqrNn7Ux3rkNQzB7rMBnNb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 16,
    address: "GZQJiK45tnjt9Y9q28ZAoVNWpvhDTjw8xUSg81SGoC2S",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 17,
    address: "92yDbGctzjp25fhSU3WUPB2DMCNfKw5zRXieBXFmyw68",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 18,
    address: "B8DzXEsNv6Vpo3MQBteziEqk48LphWJ5bVvRXSaEczBr",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 19,
    address: "4wUm4psYNRMNRut13vvXZexUL5F1TnC3MDLWoBnNeQUb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 20,
    address: "8TDcCqYKHjk4mHVu5WVKLS9xnuSouEVGrdtHu6v1vxsA",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 21,
    address: "FHWpRc2iaXH69U23AVJpQXnA8s5xXY4VnjtxF8j7zbyc",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 22,
    address: "EKjDfz6SNf8ksQmcabHiqvApPMxQ4cczCFjKrSe4xPBd",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 23,
    address: "8V9do94VmPZpLyCgDAo5DYqbSvoA7Z8QGneUMDbeyjSb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 24,
    address: "F1F1oFJBUKuMNGDXYkmNTrtx1uZa5nTER29kEtMSUhmq",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 25,
    address: "9K23sMmtGtxixFgv9ss9wQNPHTt3GG14HuEWEtuQPshc",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 26,
    address: "D6wZKArJdVWtu9FrYQp2XdVzNxyYXuw76nnHfqjegYGo",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 27,
    address: "C8NJ5DX9dw3R2pcPUTzGkW2d6Y8LbKZFbomJ4NrSUsnt",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 28,
    address: "EgBZ1FJAqxbZpV37TNyEoFWnyY5XnsAhgr5SW6XYrPxH",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 29,
    address: "JLH371nXe14yJPqXg5jdJ1ZXVozpbuPraCZm9JJrLLB",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 30,
    address: "G6Y4bsTkNJ2N4ReFPP4yn2fuoWcJ4dbQRcANdhRY7eFs",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 31,
    address: "HsZcnTywHa2CfL9ivTQ296yvQnMKpnpLHstY8Drw3Z4p",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 28,
    address: "LTy2afjBahs3ksBGsgnsNUQkVZF5EcLCB5PxxDJtWh3",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 29,
    address: "CMouJScAHn31KJvpi2C74K49qbrfR2FpNGANnYxunfmm",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 30,
    address: "CQ52z3AP775NXi1mnLbpPS3xMKwA7mvFk3Zh7WRmyhTH",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 31,
    address: "3BLaUsF3cwNSwLX7MMwB79ouwwsdSUVjmoSZcWZJKTLY",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 32,
    address: "G5vRLfeBud5eJYxramz4zbekV8R3xFc6QaL7ZE8WuPp6",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 33,
    address: "EdiUdA1rUq9UqMmqDxuyo7jKhiuoS5wJDAA4MSwwK6mA",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 34,
    address: "CUxjjhEhrdHxsTsyXciivJCK92xwa8Se1mffTB55fySz",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 35,
    address: "5ApSMn3dnv29yH8L6JZewqPMQXTNVFcWw8K8mF7gR9BV",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 36,
    address: "61aC4Vgh1PsxamEdWbidDfHcSEH3ChqqrHuoodzNAeSd",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 37,
    address: "A99Y8mFmL58Tt56XH8W6FJVxMxBfdFMcbj9oert1ZT3f",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 38,
    address: "85zBm6Axw5wx95LJndJ2b9c5BDqLwtg6hSkyrAVAKw2v",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 39,
    address: "4fzPgmVS9RNVDqitKuh2Zv34D1PiTDnL3tF2S11cSGXb",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 40,
    address: "FKzoVXiVo2XsmQFoAFuQv48wwSnMFxjxu3FPGezszH96",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 41,
    address: "3CMAwhvJcmrF8JdRhAPwMUwVxNS1Ezyk7Bs9Dtv7dp3d",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 42,
    address: "J99CS7pGzME9ci4Vcu7BzQvdtChQYHyEF2dV5azcRJBk",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 43,
    address: "FXrrYrxPYJs4w5SMTGneRaLEbxS4b45bSGY9UnH8GucH",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 44,
    address: "CcBDZu87F3FoHwc7XFXEMuCnMcV3BwAAbYsTYxbnFzH",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 45,
    address: "CGEbtbUZgLwrhGZnMMYaLAnFgjomXooaMjdYRvMMXGkt",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 46,
    address: "G3qS6bKQadAGN8jfRZuvRVxQ2zd6HF8fsNRWbFr2ALK4",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 47,
    address: "FiDqdnbyiGBVK3wfXfdGskD7AfEKZp7c8yXjWjJMESp3",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 48,
    address: "EHSmXAB6nogjd23cubprQU9e4XWvGYDqdAadmP7tw4zz",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 49,
    address: "AahxdXvkrMA2fmhTE9fsg77kixfCPTjvCdF8yMjgWAgV",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 50,
    address: "7jk7RopRbwdz4xphCn3tKX7Cgxe74GBSAPtHqjbRRKrA",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 51,
    address: "5sBQ2P9eU18kqzXme5zSQQrNSR3uJz7uwMcJw5KowCxQ",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 52,
    address: "DLcPRR3QMXfURKw69iZmmnM6abRvw9FmYBaqtgqTGRgC",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 53,
    address: "5xnKaX9SBgweEKhj7yfPmYb32xMBLMUwkYbvUEuuLujA",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 54,
    address: "Air8AuUGRBLpWTRRY6BqorzHRKe4wDrRLjZWqfdhtaDr",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 55,
    address: "9WeFvHW6VJqrJ7WvHgVWd3yVojm71iuHtTPixxd2srH7",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 56,
    address: "66gp8hBY2FBLJtCy1KAcFJtXf56t5LAYmtepW9wWjQ1F",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 57,
    address: "Hpcx4nYcBPMLJWMFU8F73d5uSk9KK3t3hf2rrkmUZMZ4",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 58,
    address: "Hu2m7L9W9HtU1yKwSudQQ9Xx24jFGrvRfFzZKJ6V7Cqz",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 59,
    address: "5cQ8Pu74Sj7h1MhnFx7gwYN3ya1XhUwYDXp6pisyQTtH",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 60,
    address: "8tS2LTmyNWkXpEe1ook5utSQfFW5R3qJVqN5ekabqWkS",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 61,
    address: "92EfiKF1srr7XMJqNuGGV2Z4hN2YYoygfexTBjhJQntd",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 62,
    address: "S6dJtF8K9dFrZ1mFpsAB3mU8WuwnwBnswqTzT6xWNxC",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 63,
    address: "FiiXbJzqGiNcVgi4oRjL8QrPx5vTYcLa9zFjFtiwjaM8",
    alias: "oracle.tide",
    armed: true,
    consumedBy: null
  },
  {
    slot: 32,
    address: "2dk6BN16q3qQb7brecTw4EC8vi1nVs5xjr6fc2icBVvg",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 33,
    address: "A9cudiF1V1R4pifK6XMT66M2scU3pN9USCmAZyEEWwKi",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 34,
    address: "2BdpamJQtYFmL1GhQmpHc17YowpzqHq1hdVib5Rex4kh",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 35,
    address: "5NehebZ8c1SdF1cUptYttxHqUPavhPBUhaBuXS3A2EWV",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 36,
    address: "HDPvHtakPYpqg1riUKSV76Fy7cvmhdsmWqHFHWCL7hee",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 37,
    address: "JAoxuvjjyNzCY2vrEAtB37DyFQNZPobfnuVDFfv69VHD",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 38,
    address: "4fNTUzGZpxS1UfsQDKbgT3FtcUHuRLh5h2iyaqyXW9BP",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 39,
    address: "7u5MEz2omhungCn2QvLnmxtqc1EwJKWLG1XMC97XgWVb",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 40,
    address: "EXQFD74qPAfZfiHHtV3gwiR8H3Aid2SxEoewLUtcavjd",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 41,
    address: "3zv4qBQm2PA6PYDGVAbShXFbp334GyVgCs8L2czNbTrd",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 42,
    address: "CfPHhYvdw7D9weJxF2FgL6bSMZ6esePs7wB2Wgyn8TmW",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 43,
    address: "DG5gzzAEY6UboX6G21735vo62FUXDWxzFhQxECKzRp9B",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 44,
    address: "GTvuJtJaPwXXEKARJm8WCpXhys6PKHzuxWbxScB1LcEr",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 45,
    address: "D9DdLmhqYy12sbvcpfKwDASzT2kAZgtwh24uifTwGYg",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 46,
    address: "9gmK5J67vyFJHvxUGx3E4PyZwtmWqBY9y3CwfZ7kue18",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 47,
    address: "BbB4zvKuJ9wxKxQxU8osiq5ZqDVcfyFqoDAi6avSaLxE",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 48,
    address: "9sjM9ZWN5fMGvK6fuDcaSdyh6sa6DwxwJe5a9vqM6gXU",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 49,
    address: "2TT2s5A7dXy6tyvaEGWFFZjpdhUppbbh7acHByjNgFvn",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 50,
    address: "3PU3tp3n7UUcEK1EWqzntK9UEPqXrGDCmXWtnQWCdHXE",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 51,
    address: "4PpQEG8sVHurkHCHEkvwjjuDAYJip32CMQz4B5QAF1nK",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 52,
    address: "Fi19aZTJXa2xaQKXLEJ9uhRkQeSyhfJ1spYAbrrVcPa6",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 53,
    address: "CjVyTeRKEX298aCtP8Ybcn73W4Capmstv2JfVYVdRqiA",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 54,
    address: "5pLuakRLaxqMCvvuR9hfXWvTJJeNLpu957nkJrK2Jwp8",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 55,
    address: "8wsgbb78VQDwf7mBCDaVbMeTUKxz9fLSkHWA9uHHHMnq",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 56,
    address: "8fShqQV83Nv85xgAPE4DvEnBSaWDWzGT6FQ6efvKguNM",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 57,
    address: "FqmhX2QGWVYuavLsXLLM2xDvjRX72FbrqGdm3TtKfrSP",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 58,
    address: "7ExeYZ4PpdBsSGkENEHyWcedosBBQpgg4RvZ3aURVj4V",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 59,
    address: "5JBot9jgwSCKSm79MyFBtPC7kWKf5HVyBEfCByU9oJtZ",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 60,
    address: "CkvRaK6MtXTkSDYc45Tnh4XLehejPNzndyWruKxKXDbk",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 61,
    address: "HmG4Yyei9SBu7PfPxvZrtZNYdAfKMtRuQ7rcq4jekmZx",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 62,
    address: "BVbiqw38yKs8sND6BDMhEDJg1QryZCPXBZo59nHzC5Zi",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 63,
    address: "3Ypws25QCHoTPVMpK3rJVjaobMQEfNfB4vEVGk2cFXGr",
    alias: "feedmarket",
    armed: true,
    consumedBy: null
  },
  {
    slot: 8,
    address: "2r4qVBZfcXJvx36bTXUFiTok3S9E1QbpYbJxTTBBNoKo",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 9,
    address: "8dAMcYPLnhU1UQ39RpfaWqxSn7f3ZRVULiZfTm9V3mQe",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 10,
    address: "7g95LrUM3ZTW8HrwQpJmQzdwr2vVJwqrtDv5ofrxbUup",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 11,
    address: "5uePdZVhjSwzX8aY8gUQEjfEPWbLDy3v2bjFXjHbxdbE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 12,
    address: "J3fdaRWPij1RRyeV2kQDZ2tw7M57omeAgNHAnEVrzHxf",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 13,
    address: "BbArqdEx1MgKGQbjfdjjiosb2FeN4Nb33cCSL4GkWNKw",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 14,
    address: "FRmkCHX7zPVNVTDrCLgANxCcUFjT3oUSfcxRKVXHh6Ly",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 15,
    address: "76tewmdbQyBmZMp1J6j2nQTPf1a3Gdm5Ddb6EfNHTARW",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 16,
    address: "GY9UMSJyP5fxeAJ9Q25rwRLDyzAi7ArU1A2mr2TDKoVh",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 17,
    address: "4ksVB6eFZjVbEX88zxq73P2UVYhxUfz8qBP9wdARhqzF",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 18,
    address: "CMpNKkG6vBqovznPikiErtcXxz5hPUgTSSHs3pJbDkN3",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 19,
    address: "Djii837VrdgpfaUqbA4y1hjwFPYSmw6UjfHC4zsoFhTg",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 20,
    address: "F8trJ8m3n4G4Mzu6CJuYSqNXDu2aAHm1Z1Rxvwe46wkz",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 21,
    address: "2UnfjNQc7oqBTrkp7aNko2M2ZY3FQvaTUns7hXMZtDLc",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 22,
    address: "6jxSixgCTBiQsonMNibxU5ywQaL2Y4J9PdabPAGi74mk",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 23,
    address: "4VdqR2kr5TBdMFkJLHtB1RUc8tZ4CVGqePFZUo6dyxmi",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 24,
    address: "3kmKgVj6tbp2NokUEosGkPwsZMBktoKPrkvbCDxDWff5",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 25,
    address: "ABXRkfSAMYsaFAB9NuywR4bUYzTxBPFEwczhQHoubJvM",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 26,
    address: "6AKhPeNXKdEWDu4iCUx5FeMEXf4LhbhERWrQjhHgkt6x",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 27,
    address: "3BsznvzD8UdTaRhot1ZhjVpLw1h1So4wkxyPFNbRnhQK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 28,
    address: "5r7x64foPdp5ey2Q8KTZJfbfHsZLw5XRBNUA5ZqWhAn7",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 29,
    address: "DXd4k8bQ2T7CNJoWpGGiqsuRCzN1JHdkqwrxcRWsNxg",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 30,
    address: "H4X15zWK6ECpFpx4kwm5rnUj4UoCwGqRsm2wQNBEq6kw",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 31,
    address: "B8zhW5D7zxSReRaiTHFY5dBjSERiVJDd9Rk3XWcNqZhb",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 32,
    address: "6ScVtoEfuVkH6C8xn4ZXG9pSetA7Fz2hAWzSrfzkovfX",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 33,
    address: "7tzDVraj6Cz67hY5xAX1ktYybc3LJ6yJa8pfd76Ko4sU",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 34,
    address: "GA3gK8SKkXGpLB8HiShj7unJjMThvtSGRwaV3ynBDu1T",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 35,
    address: "xYcY8w9CV3urW1gWoNZEFdZEQWpennJi3s8Lur4tgwH",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 36,
    address: "Az8WFjFHsgBqmwiHBBGxK3MYz8sG2yzV4Z8G6qMSwQaz",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 37,
    address: "G5RrvJFjuZeW4CqPL1cTfeUcAYijXueww5M12KgLSWW7",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 38,
    address: "CUEdLgrww8zrUru8SesnYBVKVQ4SS6Um1CYx1ZxCD8kE",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 39,
    address: "AaPxABzEXcedGt3K6Lz5As5VGHxQ6NJEg6aMfCkPaTcu",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 40,
    address: "ADbTSzcuefmmWvu8bG2njd99xi13muHrqFrK5Z2P2z29",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 41,
    address: "9K4RtZbeFAJk2umVRo2ETb45bWzQDNrKFMWmj8Wyx9QQ",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 42,
    address: "6nwMR1JGFEN8PKhVXYXyxx6y6V7Pb8aWTLJbqRyVVazp",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 43,
    address: "HqVf17YWhGEjqMZc5vGeSfDLGr93QgVKwLbKcY8ZSqxw",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 44,
    address: "GWxK6Un8mwHUtP3mtbp8vLm3pDqv1mmTcHLMXVWahfeS",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 45,
    address: "CfEsfnAXmUf4KnKGB2JqUvrVFv2oS3BwTw9fXutUkQ47",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 46,
    address: "GXE7MbSvQnJu5ojwj9wffXirEM2UTMdnd5VgBCy1Fize",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 47,
    address: "2MMdH9dRuHHE1AMm1pzDuLMDMfdxCAh3Hm35xBrdqrvz",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 48,
    address: "BMBbnssiYDPHHn2f7mdd6GDLvPQMSkKCiLBuTTL8rgDV",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 49,
    address: "HNt5j56n5s7QhAhpKeBvfknTreGGEx3qQsDKKjpCuHpb",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 50,
    address: "3aaRHEdDytfFXSsrucW6F8ctfKFDM5HusWyNAJecUDhg",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 51,
    address: "8JS7ENym39mRRGdzCnR8fui2RkAS8XBXkRTdEwPTfhHQ",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 52,
    address: "78y4s5o5Dsqizu9rXYWePrPKLCuDkVvzBodTB8sYst3j",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 53,
    address: "8LQQLxSSerGKgud9MFoz5Jvo9kFBFttVBZNpFd4mdPis",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 54,
    address: "E53hB7gEwieikqtPjrPCKxYbxfZmDq2Fdg5boBigwqJb",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 55,
    address: "FR7KnrbkUPjjpUULyG97ebh28uhaUK9bQCVeL8hSvrGK",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 56,
    address: "FmDcxD1Nsr3sv285H6sSdemxJaPksftsFu9Yt57Mza3G",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 57,
    address: "GfsTmPn5EcP4vVm4tjhkV3R4FexBCWquK2YvnYvx2M4Q",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 58,
    address: "CGve63J3sPKjXFQjZuQ1pmA8k3QMYe7CmzxxynFT6Bgn",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 59,
    address: "EPL3FZJPykaTgnPEEEQKVnstd1zrJCthjp8QBe9qj1gm",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 60,
    address: "8DWj6Eeb4JN1DhMQ4V9y5zhM3NHxCwFBz7vaaqBd2tRU",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 61,
    address: "4qixjvgL1yGQamTWqPRjj6A6FxWVFrLRptwdCFgxvjzi",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 62,
    address: "Hj4wiAwwPcZ7dDzh3LeU6AwN3vE8yLzA5odcYiiBtvYS",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    slot: 63,
    address: "8wHLnZZSHTQBFa6bu41RxUQuauAVKY7SY3uyYu1mazd",
    alias: "sensor.attest",
    armed: true,
    consumedBy: null
  },
  {
    consumedBy: null,
    slot: 8,
    address: "5DTVQNHxmuLYmaqv7VsGDVJUGPXT1zwSScgcjTBXZF6x",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 9,
    address: "AzYexAmUtBuxx1xWWNA8APyHfXr36df6hwQTxQtKMr4p",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 10,
    address: "76pQTgvw9D6LPV4fqSGdCwyEDn3c4vrx6Qqsp9Qm7pGi",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 11,
    address: "BGKhy41pM39c7oGPNUmkqcTG2DiUBczDQhBwSByX7B1d",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 12,
    address: "2XhuAw8qvYucUBw62b8wY91pWkZdGRtfgMeL2M5uyms9",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 13,
    address: "4C2S7nSDnk2VqBqTzTLXMGnugeAKadJe9A5ma8cHJuSc",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 14,
    address: "BE3EkF6x5X2CxYBiiF9fsriYo7oiu1Fd9kUkz843obiH",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 15,
    address: "65ytMTS4ph7jJPmDwWgSTicMSnkQi3WSa8N9QUkdYTc2",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 16,
    address: "2pxY1p3K7y9Xmu7SwhhBwEDT619NM5TtPHJ1yBYWA91C",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 17,
    address: "CdHqtynDHoxx54ucX3VhJTkcHhH7gcHDwpxsWiLgcFcB",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 18,
    address: "EqxvhdceXQrSyU8T6g312SUG5boGQSppwJ6jHQSbdvJ4",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 19,
    address: "3z9v2PGAEDL9oNeJfBGiUYLxddiB4VMXYUiZTWkhuXnk",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 20,
    address: "3TapFtLF4ZCSWSusLbZWGLhpScSiZJFGEmfkQzhZSbyo",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 21,
    address: "HQVSUnq4qnzw2ZiCsC88iuGpgzbiXUqMuAjfNvqyq1Nf",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 22,
    address: "GMUdY8rE3i9hze7wbHuCa5yGCQAB1SwNLhVaRoHN91Th",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 23,
    address: "ATnMwphgtZwottXfkPN3eS88TUZcdZxCNAESgqvr63w4",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 24,
    address: "2pqN55KUg6xEn86pqu5MyS877XSdtAEDsGx9MhCwJpTt",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 25,
    address: "FETMGVEhBfgRNx4tu1mpxYXK2EpHF9pzeSynjDnCZ3TJ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 26,
    address: "7qcM3FGFQuda3eefspnW8N6YeGbRMuYELyZhDM4qSs4u",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 27,
    address: "FfkRDUkpYo7bYvynkV2RQboibh93itL18mVRy5eQaTXa",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 28,
    address: "HDUM8qZxq6fMfYHJ5xCuPatjkMvUEjnEDMg1sPor6D5K",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 29,
    address: "6XkspMNiT3J67wq4Pu2EfEpurFdCURKi9JhUKxi7Pt1B",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 30,
    address: "CxnRtQVv9BEH1eHNwMbkCWAzS7y8ZymbtBGFEVHjh16g",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 31,
    address: "7Q5yuBtMqteqdZqcbzJDWfBjA5H2Q1FacNwSZeXoTFiw",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 32,
    address: "Hbo2sfyRfEGssWnRR4uZWBxmDWCc9o5wqAsT9Kht6Rd2",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 33,
    address: "9m3KhMd9rQmHEiE5FggNDk4ybbyPywM5G14962ao1Umz",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 34,
    address: "Eo7qmpDoDvFrAW2CnZDaTuKWuWr8WFhrxCUKwd8QUH1u",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 35,
    address: "FtXcFoH9o93TRgZr9qoTNQdqpShKqzd28hfB3jAdx8Zt",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 36,
    address: "E5YoQRsUamDZyeMcRkjtkzTTddLXqK88HuMBgUGenEbW",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 37,
    address: "3pogPAdzFpbG7eiuFMx7khabgr3d2UfMUfLt6dYz9aY2",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 38,
    address: "9t5e8uxnfpeefFLEFLAbTBb9VX3Prj3zbWpBoFNX6eem",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 39,
    address: "5hH63hjjS6cawskjUDUkNgGYLerpvrxgtZ4dtwtKFZpY",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 40,
    address: "1kHFSqrgVDCydFG3mdAMgTiqJBk3v4KrxeKU29MESZ2",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 41,
    address: "8FU1WmNSUCuWczTmmcQ39saCjBzJ8VYtQVUdJDXj4ApJ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 42,
    address: "7snF6c5Bsnj484EQnYtJXBJm1zdY2izBGSvyAiMuGmd3",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 43,
    address: "9GHsvAKqamdLPYCi2JWvSxnyWotURTB7xfNM6guP9piQ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 44,
    address: "2RommUYc8e4Z2Mp9FRG7SLWDAHPNMjBPdUGtMcNN3AHz",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 45,
    address: "6cxrkBfKNBmUejP1ZY53NrsKrskUtQdCzjBsdkW2bJNi",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 46,
    address: "2bDSCoTArAXsHqsy27WC9fSWxTLnqNUtNTtUi1m8NRYn",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 47,
    address: "HzEQGvSuL6ex1nq76ayLMSdrrxfHW94wb5f7KWPkwCDG",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 48,
    address: "3xtodnGoHJMoMvpHGkoMteEw61WMxEHwcfr4efV5UCWN",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 49,
    address: "6afUxPeB87UhA5kxGVwqXdqCphAmdcGoNXYi3p3wWTj8",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 50,
    address: "9wiQymc5MwZREakFVgBYaNYVuHKxiAcvzF4XePFqFKv8",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 51,
    address: "5Kd4r3ge27kkgHYMNGXci4hBCmYYjcdQmhoT3aMJdvJJ",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 52,
    address: "ETpugmjDFHBrW8mKgabR1MJd6f3SvhqifBbUdor6ozEb",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 53,
    address: "5nevjYaR3S1U4P6turFmUgY4pFLaRskdoFcr4jV1EpA4",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 54,
    address: "CqfcqKmnR7dX6w5QjgyYRutesYYNVQykx9W5TWGciXZi",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 55,
    address: "Apuw3SU2Ac2dXfUHiAQzj2GvjqcPjDoz7ebKRmwPKPe1",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 56,
    address: "E23J4XGFqgZNVvbnqP1sBmhMrk1TxJR5mLz7BvbbVqRn",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 57,
    address: "rTdQ1fWEKGZWdL7YTxSRD4mQy1MNh7bp1KPaReazzKp",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 58,
    address: "DnrNfex83hF5DN1KLhA3PvWthqHrgvCLcuRyVyki4ftb",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 59,
    address: "57LS7TW5J9x7grRAnbGid6ioPddVxiUwbhRL4QeVjg8m",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 60,
    address: "FqcDkLNDHtdpn2YBg65osBsYjgNe6VCHC3MfiLXCSaG1",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 61,
    address: "Hg9bAww81LYFjC4QyqtFKUFq9MRZnf5j6tck52UnF8SP",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 62,
    address: "BQcu62FUy478P1gzLEvQHZj48kjdjPGtKMTVJPBJAbv2",
    alias: "payee.test",
    armed: true
  },
  {
    consumedBy: null,
    slot: 63,
    address: "C1JYaVh4nWunNhFYe5nC3yuePe6f2QPjPCV8Ds9zyYvz",
    alias: "payee.test",
    armed: true
  }
];

// scripts/hosted.ts
function clusterTagForEnv() {
  const resolve = () => {
    const rpc = process.env.VEIL_RPC_URL;
    if (rpc) {
      try {
        const fromRpc = networkFromRpc(rpc);
        if (fromRpc) return fromRpc;
      } catch {
      }
    }
    const network = process.env.VEIL_NETWORK;
    if (!network) return void 0;
    try {
      return normalizeNetwork(network);
    } catch {
      return void 0;
    }
  };
  const resolved = resolve();
  if (resolved === SOLANA_DEVNET) return ".devnet";
  if (resolved === SOLANA_MAINNET) return ".mainnet";
  return "";
}
function seedFor(env) {
  if (env === ".mainnet") return [];
  return env === ".devnet" ? pool_ledger_devnet_default : pool_ledger_default;
}
var HOSTED_LEDGER = `/tmp/veil-pool-ledger${clusterTagForEnv()}.json`;
var HOSTED_LEDGER_KEY = `veil:pool-ledger:v1${clusterTagForEnv()}`;
var HOSTED_SETTLEMENTS_KEY = `veil:settlements:v1${clusterTagForEnv()}`;
async function seedHostedLedger() {
  try {
    await stat(HOSTED_LEDGER);
  } catch {
    const staging = `${HOSTED_LEDGER}.seed-${process.pid}`;
    const body = JSON.stringify(seedFor(clusterTagForEnv()), null, 2);
    await writeFile(staging, `${body}
`, "utf8");
    await rename(staging, HOSTED_LEDGER);
  }
  return HOSTED_LEDGER;
}
function rewriteRoute(reqUrl) {
  try {
    const url = new URL(reqUrl ?? "/", "http://localhost");
    const route = url.searchParams.get("route");
    if (route === null || route.length === 0) return null;
    url.searchParams.delete("route");
    const rest = url.searchParams.toString();
    if (rest.length === 0) return route;
    return `${route}${route.includes("?") ? "&" : "?"}${rest}`;
  } catch {
    return null;
  }
}

// packages/derive/src/index.ts
import { createHash } from "node:crypto";
function derivePaymentId(id) {
  const h = createHash("sha256");
  const parts = [id.resource, id.payer, String(id.nonce)];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    h.update(len);
    h.update(bytes);
  }
  return h.digest("hex");
}
function deriveSlot(id, poolSize) {
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new RangeError(`poolSize must be a positive integer, got ${poolSize}`);
  }
  if ((poolSize & poolSize - 1) !== 0) {
    throw new RangeError(
      `poolSize must be a power of two so slot assignment is unbiased, got ${poolSize}`
    );
  }
  const digest = Buffer.from(derivePaymentId(id), "hex");
  return digest.readUInt32BE(0) % poolSize;
}
var PoolExhaustedError = class extends Error {
  code = "VEIL-CONF-005";
  constructor(alias, size) {
    super(
      `no armed one-time account left for alias ${alias} (pool size ${size})`
    );
    this.name = "PoolExhaustedError";
  }
};
var SlotConflictError = class extends Error {
  constructor(slot, alias) {
    super(`slot ${slot} is already occupied by alias ${alias}`);
    this.name = "SlotConflictError";
  }
};
var PoolLedger = class _PoolLedger {
  #entries = [];
  constructor(entries) {
    this.#entries = entries;
  }
  static empty() {
    return new _PoolLedger([]);
  }
  static fromJSON(json) {
    if (!Array.isArray(json)) {
      throw new TypeError("pool ledger must be a JSON array");
    }
    const entries = json.map((raw, i) => {
      if (typeof raw !== "object" || raw === null) {
        throw new TypeError(`entry ${i} must be an object`);
      }
      const e = raw;
      if (typeof e.slot !== "number" || !Number.isInteger(e.slot) || e.slot < 0) {
        throw new TypeError(`entry ${i}.slot must be a non-negative integer`);
      }
      if (typeof e.address !== "string" || e.address.length === 0) {
        throw new TypeError(`entry ${i}.address must be a non-empty string`);
      }
      if (typeof e.alias !== "string" || e.alias.length === 0) {
        throw new TypeError(`entry ${i}.alias must be a non-empty string`);
      }
      if (typeof e.armed !== "boolean") {
        throw new TypeError(`entry ${i}.armed must be a boolean`);
      }
      const consumedBy = e.consumedBy ?? null;
      if (consumedBy !== null && typeof consumedBy !== "string") {
        throw new TypeError(`entry ${i}.consumedBy must be a string or null`);
      }
      return {
        slot: e.slot,
        address: e.address,
        alias: e.alias,
        armed: e.armed,
        consumedBy,
        ...typeof e.settledAt === "string" ? { settledAt: e.settledAt } : {}
      };
    });
    const ledger = new _PoolLedger(entries);
    ledger.assertInvariants();
    return ledger;
  }
  toJSON() {
    return this.#entries.map((e) => ({ ...e }));
  }
  get size() {
    return this.#entries.length;
  }
  /**
   * Register a pool account. Slots are addressed explicitly, never inferred.
   *
   * Slot numbers are scoped to an alias: every merchant's pool starts at slot 0,
   * because `deriveSlot` partitions against that merchant's own pool size. Only
   * addresses must be globally unique — a shared address is what would make two
   * merchants linkable.
   */
  register(entry) {
    if (this.#entries.some(
      (e) => e.slot === entry.slot && e.alias === entry.alias
    )) {
      throw new SlotConflictError(entry.slot, entry.alias);
    }
    if (this.#entries.some((e) => e.address === entry.address)) {
      throw new Error(`address ${entry.address} is already registered`);
    }
    this.#entries.push({ consumedBy: null, ...entry });
  }
  /**
   * Reserve the next free armed slot for an alias.
   *
   * Tries the deterministic slot first, then falls through to the next free one
   * that is free. Every failure mode the caller cares about is a named error
   * rather than a null, because a null here becomes a public transfer later.
   */
  reserve(alias, id, poolSize = this.#capacityFor(alias)) {
    const preferred = deriveSlot(id, poolSize);
    const paymentId = derivePaymentId(id);
    const held = this.#entries.find(
      (e) => e.alias === alias && e.consumedBy === paymentId
    );
    if (held) return { ...held };
    const free = this.#entries.filter(
      (e) => e.alias === alias && e.armed && !e.consumedBy
    );
    if (free.length === 0) throw new PoolExhaustedError(alias, poolSize);
    const chosen = free.find((e) => e.slot === preferred) ?? free[0];
    if (!chosen) throw new PoolExhaustedError(alias, poolSize);
    chosen.consumedBy = paymentId;
    return { ...chosen };
  }
  /**
   * The seat a payment identity holds, if it holds one — spent or not.
   *
   * Read-only, and deliberately not a reservation: the caller uses it to notice
   * that an identity is already *settled*, which is a different answer from the
   * pool being empty. `reserve()` stays the only thing that consumes a seat.
   */
  entryFor(alias, id) {
    const paymentId = derivePaymentId(id);
    const entry = this.#entries.find(
      (e) => e.alias === alias && e.consumedBy === paymentId
    );
    return entry ? { ...entry } : null;
  }
  /** Resolve an incoming payment's destination address back to its alias. */
  resolve(address) {
    const entry = this.#entries.find((e) => e.address === address);
    return entry ? { ...entry } : void 0;
  }
  /** An alias's alias — i.e. which merchant owns this destination. */
  aliasFor(address) {
    return this.#entries.find((e) => e.address === address)?.alias;
  }
  /**
   * Slots that are ready to take a payment.
   *
   * Returns copies. An earlier version returned the internal objects straight out
   * of `filter`, which let a caller silently re-arm or consume a slot by mutating
   * what it was handed.
   */
  armedFor(alias) {
    return this.#entries.filter((e) => e.alias === alias && e.armed && !e.consumedBy).map((e) => ({ ...e }));
  }
  allFor(alias) {
    return this.#entries.filter((e) => alias === void 0 || e.alias === alias).map((e) => ({ ...e }));
  }
  /**
   * Would `settle` accept this? Checked *before* anything irreversible happens.
   *
   * This exists because settlement is two steps with a broadcast in the middle,
   * and the broadcast cannot be undone. If the accounting check ran only after
   * the broadcast, a rejected settlement would leave money on chain that the
   * ledger had no record of — the payer paid, the merchant was paid, and the
   * merchant's own books said nothing had happened. Splitting the check from the
   * mutation lets the caller validate first, broadcast second, commit third.
   */
  settleable(address, consumedBy) {
    this.#findSettleable(address, consumedBy);
  }
  /**
   * Take a seat for a payment that is being settled now rather than quoted.
   *
   * On a single process, `reserve` at quote time and `settle` at payment time
   * are the same pool, so a seat is always already claimed by the time it is
   * paid. A hosted rail breaks that assumption: the instance that answers the
   * unpaid request and the instance that answers the paid one are not
   * guaranteed to be the same, and the second one has never heard of the
   * reservation.
   *
   * Refusing in that case is the worst possible answer, because the money has
   * already moved into the merchant's own account — the rail would be taking
   * the payment and recording nothing. So a payment may claim a seat that is
   * still free, and this is idempotent for the seat's current owner.
   *
   * What it deliberately does *not* do is take a seat claimed by a different
   * payment. That is the one case where refusing is right: two payments into one
   * one-time address is exactly the relinking the pool exists to prevent, and
   * the second payer must be told to use a new offer rather than be counted into
   * an address someone else is already using.
   */
  claim(address, consumedBy) {
    const entry = this.#entries.find((e) => e.address === address);
    if (!entry) throw new Error(`unknown payment account ${address}`);
    if (entry.consumedBy === consumedBy) return;
    if (entry.consumedBy !== null) {
      throw new Error(
        `account ${address} was consumed by ${entry.consumedBy}, not ${consumedBy}`
      );
    }
    if (!entry.armed) {
      throw new Error(`account ${address} is not armed, so it cannot take a payment`);
    }
    entry.consumedBy = consumedBy;
  }
  #findSettleable(address, consumedBy) {
    const entry = this.#entries.find((e) => e.address === address);
    if (!entry) throw new Error(`unknown payment account ${address}`);
    if (entry.consumedBy === null) {
      throw new Error(
        `account ${address} was never reserved, so nothing could have settled into it`
      );
    }
    if (entry.consumedBy !== consumedBy) {
      throw new Error(
        `account ${address} was consumed by ${entry.consumedBy}, not ${consumedBy}`
      );
    }
    if (entry.settledAt !== void 0) {
      throw new Error(
        `account ${address} already settled at ${entry.settledAt} \u2014 settling twice would double-count one payment`
      );
    }
    return entry;
  }
  /**
   * Record that a payment settled into this account.
   *
   * Deliberately does NOT free the account for reuse.
   *
   * An earlier version re-armed the slot here, which quietly turned the one-time
   * address back into a reusable one: the next payment would have landed in an
   * account that already held a settled payment, and the public graph would link
   * the two. That is precisely the leak the pool exists to close, so a consumed
   * account stays consumed and the pool is grown instead (see PoolExhaustedError
   * and VEIL-CONF-005).
   *
   * Settling the same account twice is rejected rather than re-stamped: a payer
   * that retries a settle it already got a 200 for must not be counted twice.
   */
  settle(address, consumedBy, settledAt) {
    const entry = this.#findSettleable(address, consumedBy);
    entry.settledAt = settledAt;
  }
  #capacityFor(alias) {
    const total = this.#entries.filter((e) => e.alias === alias).length;
    if (total === 0) {
      throw new Error(`no pool accounts registered for alias ${alias}`);
    }
    return 2 ** Math.floor(Math.log2(total));
  }
  /**
   * Invariants that must hold for the privacy claim to be true.
   *
   * These are checked on load, not just on write, because the ledger is a file
   * on disk and a hand-edit is a realistic way for a duplicate address to appear.
   */
  assertInvariants() {
    const seenSlots = /* @__PURE__ */ new Set();
    const seenAddresses = /* @__PURE__ */ new Set();
    for (const e of this.#entries) {
      const slotKey = `${e.alias}#${e.slot}`;
      if (seenSlots.has(slotKey)) {
        throw new Error(`duplicate slot ${e.slot} for alias ${e.alias}`);
      }
      seenSlots.add(slotKey);
      if (seenAddresses.has(e.address)) {
        throw new Error(
          `duplicate address ${e.address} in pool ledger \u2014 two aliases would be linkable`
        );
      }
      seenAddresses.add(e.address);
      if (e.consumedBy !== null && !e.armed) {
        throw new Error(
          `slot ${e.slot} is consumed by a payment but not armed \u2014 it could not have settled`
        );
      }
    }
  }
};
function mergeLedgers(stored, seed) {
  if (!stored) return seed;
  const storedByAddress = /* @__PURE__ */ new Map();
  for (const entry of stored.allFor()) storedByAddress.set(entry.address, entry);
  const merged = PoolLedger.empty();
  const seen = /* @__PURE__ */ new Set();
  for (const entry of seed.allFor()) {
    const storedEntry = storedByAddress.get(entry.address);
    const settledAt = storedEntry?.settledAt ?? entry.settledAt;
    merged.register({
      slot: entry.slot,
      address: entry.address,
      alias: entry.alias,
      armed: entry.armed,
      consumedBy: storedEntry?.consumedBy ?? entry.consumedBy,
      ...settledAt === void 0 ? {} : { settledAt }
    });
    seen.add(entry.address);
  }
  for (const entry of stored.allFor()) {
    if (seen.has(entry.address)) continue;
    merged.register({
      slot: entry.slot,
      address: entry.address,
      alias: entry.alias,
      armed: entry.armed,
      consumedBy: entry.consumedBy,
      ...entry.settledAt === void 0 ? {} : { settledAt: entry.settledAt }
    });
  }
  return merged;
}

// scripts/ledger-store.ts
var CAS = [
  "local current = redis.call('GET', KEYS[1])",
  "if current == false then current = '' end",
  "if current ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1"
].join("\n");
var ABSENT = "";
function redisLedgerStore(options) {
  const url = options?.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = options?.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const key = options?.key ?? "veil:pool-ledger:v1";
  const settlementKey = options?.settlementKey ?? `${key}:settlements`;
  const call = options?.fetchImpl ?? fetch;
  const maxAttempts = options?.maxAttempts ?? 5;
  const settlementLimit = options?.settlementLimit ?? 500;
  const endpoint = url.replace(/\/$/, "");
  async function command(args) {
    const response = await call(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args)
    });
    const body = await response.json();
    if (body.error) throw new Error(`upstash: ${body.error}`);
    if (!response.ok) throw new Error(`upstash: ${response.status} ${response.statusText}`);
    return body.result;
  }
  async function read(redisKey) {
    const result = await command(["GET", redisKey]);
    return typeof result === "string" ? result : ABSENT;
  }
  return {
    async load() {
      const raw = await read(key);
      if (raw === ABSENT) return null;
      return PoolLedger.fromJSON(JSON.parse(raw));
    },
    async loadSettlements() {
      const raw = await read(settlementKey);
      if (raw === ABSENT) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("upstash: the settlement record is not an array");
      }
      return parsed;
    },
    async appendSettlement(settlement) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const previous = await read(settlementKey);
        const current = previous === ABSENT ? [] : JSON.parse(previous);
        if (current.some((row) => row.address === settlement.address)) return;
        const appended = [...current, settlement];
        const next = appended.length > settlementLimit ? appended.slice(-settlementLimit) : appended;
        const wrote = await command([
          "EVAL",
          CAS,
          1,
          settlementKey,
          previous,
          JSON.stringify(next)
        ]);
        if (wrote === 1) return;
      }
      throw new Error(
        `upstash: could not record the settlement after ${maxAttempts} attempts \u2014 another instance is writing faster than this one can merge`
      );
    },
    async save(ledger) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const previous = await read(key);
        const remote = previous === ABSENT ? null : PoolLedger.fromJSON(JSON.parse(previous));
        const next = mergeLedgers(remote, ledger);
        const wrote = await command([
          "EVAL",
          CAS,
          1,
          key,
          previous,
          JSON.stringify(next.toJSON())
        ]);
        if (wrote === 1) return;
      }
      throw new Error(
        `upstash: could not persist the ledger after ${maxAttempts} attempts \u2014 another instance is writing faster than this one can merge`
      );
    }
  };
}

// scripts/lib.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile as writeFile2 } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes
} from "@solana/kit";
var PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
var DATA_DIR = join(PROJECT_ROOT, "data");
var LEDGER_PATH = join(DATA_DIR, "pool-ledger.json");
var SETTLEMENTS_PATH = join(DATA_DIR, "settlements.json");
var KEYS_DIR = join(PROJECT_ROOT, ".keys");
var MINT_PATH = join(DATA_DIR, "mint.json");
var DEMO_DIR = join(DATA_DIR, "demo");
var DEMO_LEDGER_PATH = join(DEMO_DIR, "pool-ledger.json");
var DEMO_RUN_PATH = join(DEMO_DIR, "run.json");
var FIXTURES_DIR = join(DATA_DIR, "fixtures");
function relative(path) {
  return path.replace(`${PROJECT_ROOT}/`, "");
}
function clusterTag(rpcUrl, network) {
  const resolved = (rpcUrl ? networkFromRpc(rpcUrl) : void 0) ?? (() => {
    try {
      return normalizeNetwork(network);
    } catch {
      return void 0;
    }
  })();
  if (resolved === SOLANA_DEVNET) return ".devnet";
  if (resolved === SOLANA_MAINNET) return ".mainnet";
  return "";
}
var SOLAMI_RPC_HOST = "https://rpc.solami.dev";
function solamiRpcUrl(network, apiKey = process.env.SOLAMI_API_KEY) {
  if (!apiKey) return void 0;
  let resolved;
  try {
    resolved = normalizeNetwork(network);
  } catch {
    return void 0;
  }
  if (resolved !== SOLANA_MAINNET) return void 0;
  return `${SOLAMI_RPC_HOST}/solana?api-key=${encodeURIComponent(apiKey)}`;
}
var HELIUS_DEVNET_RPC_HOST = "https://devnet.helius-rpc.com";
var HELIUS_MAINNET_RPC_HOST = "https://mainnet.helius-rpc.com";
function heliusRpcUrl(network, apiKey = process.env.HELIUS_API_KEY) {
  if (!apiKey) return void 0;
  let resolved;
  try {
    resolved = normalizeNetwork(network);
  } catch {
    return void 0;
  }
  if (resolved === SOLANA_DEVNET) {
    return `${HELIUS_DEVNET_RPC_HOST}/?api-key=${encodeURIComponent(apiKey)}`;
  }
  if (resolved === SOLANA_MAINNET) {
    return `${HELIUS_MAINNET_RPC_HOST}/?api-key=${encodeURIComponent(apiKey)}`;
  }
  return void 0;
}
async function loadLedger(path = LEDGER_PATH) {
  try {
    const raw = await readFile(path, "utf8");
    return PoolLedger.fromJSON(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") return PoolLedger.empty();
    throw error;
  }
}
function optionsFromEnv(argv = []) {
  const flag = (name) => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0) return argv[index + 1];
    return void 0;
  };
  const network = flag("network") ?? process.env.VEIL_NETWORK ?? DEVNET;
  return {
    mint: flag("mint") ?? process.env.VEIL_MINT ?? PLACEHOLDER_MINT,
    decimals: Number(flag("decimals") ?? process.env.VEIL_DECIMALS ?? "6"),
    network,
    spendCap: flag("spend-cap") ?? process.env.VEIL_SPEND_CAP ?? "5.00",
    rpcUrl: flag("rpc") ?? process.env.VEIL_RPC_URL ?? // A configured endpoint always wins, because it names the cluster the
    // deployment is really on. Solami is the default only where it can serve
    // the cluster — mainnet — and undefined everywhere else. Helius runs
    // behind it and picks up devnet (and mainnet when no Solami key is set);
    // neither provider runs a testnet node, so testnet falls through to
    // undefined rather than being pointed at a cluster the provider does not
    // serve — the caller names one with --rpc or VEIL_RPC_URL, as always.
    solamiRpcUrl(network) ?? heliusRpcUrl(network),
    allowLocalSettlement: flag("local-settlement") === "true" || process.env.VEIL_LOCAL_SETTLEMENT === "true",
    poolSize: Number(flag("pool-size") ?? process.env.VEIL_POOL_SIZE ?? "8"),
    port: Number(flag("port") ?? process.env.VEIL_PORT ?? "4021"),
    ledgerPath: flag("ledger") ?? process.env.VEIL_LEDGER ?? defaultLedgerFor(network, flag("rpc") ?? process.env.VEIL_RPC_URL),
    mintConfidential: parseMintConfidential(
      flag("mint-confidential") ?? process.env.VEIL_MINT_CONFIDENTIAL
    )
  };
}
function defaultLedgerFor(network, rpcUrl) {
  const tagged = join(DATA_DIR, `pool-ledger${clusterTag(rpcUrl, network)}.json`);
  return existsSync(tagged) ? tagged : LEDGER_PATH;
}
function decodeSecret(raw) {
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      const bytes2 = Uint8Array.from(parsed);
      return bytes2.length >= 32 ? bytes2 : null;
    } catch {
      return null;
    }
  }
  const bytes = base58Decode(text);
  return bytes && bytes.length >= 32 ? bytes : null;
}
function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (value.length === 0) return null;
  const bytes = [0];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit === -1) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
function parseMintConfidential(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "unknown";
}

// scripts/facilitator-app.ts
var cached = null;
async function sharedLedger(ledger, store) {
  if (!store) return ledger;
  const stored = await store.load();
  return stored ? mergeLedgers(stored, ledger) : ledger;
}
function settleRefusal(ledger, payTo) {
  const entry = ledger.resolve(payTo);
  if (entry?.settledAt === void 0) return null;
  return `payment-already-settled: this one-time address settled at ${entry.settledAt}; paying it again would link two payments to one public account \u2014 request a fresh offer`;
}
async function recordSettlement(input) {
  const { ledger, store, requirements, signature } = input;
  const at = input.at ?? (/* @__PURE__ */ new Date()).toISOString();
  const address = requirements.payTo;
  const entry = ledger.resolve(address);
  const paymentId = entry?.consumedBy ?? `settle:${signature}`;
  const source = requirements;
  const field = (...names) => {
    for (const name of names) {
      const value = source[name];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return "";
  };
  const amount = field("maxAmountRequired", "amount");
  const resource = field("resource");
  let stamped = false;
  let stampNote = "";
  try {
    ledger.claim(address, paymentId);
    ledger.settle(address, paymentId, at);
    stamped = true;
  } catch (error) {
    stampNote = `; seat not stamped: ${error.message}`;
  }
  try {
    if (!store) {
      return `no durable store configured; the record stays in this process${stampNote}`;
    }
    if (stamped) await store.save(ledger);
    await store.appendSettlement({
      paymentId,
      alias: entry?.alias ?? "",
      address,
      amount,
      // The offer publishes the resource absolute when it knew its origin;
      // every other row on the dashboard is a path.
      resource: resource.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ""),
      at,
      signature
    });
    return `recorded ${signature} \u2192 ${address}${stampNote}`;
  } catch (error) {
    return `RECORD FAILED for ${signature}: ${error.message}${stampNote}`;
  }
}
function getFacilitatorApp(options) {
  cached ??= build(options);
  return cached;
}
async function build(options) {
  const PAYER_PATH = join2(KEYS_DIR, "payer.json");
  const fromEnv = process.env.VEIL_PAYER_SECRET;
  const seed = fromEnv ? decodeSecret(fromEnv) : await readFile2(PAYER_PATH, "utf8").then((raw) => decodeSecret(raw)).catch(() => null);
  if (!seed) {
    throw new Error(
      fromEnv ? "VEIL_PAYER_SECRET is set but is not a usable keypair (JSON byte array or base58)." : [
        `No usable keypair at ${relative(PAYER_PATH)}.`,
        "",
        "A facilitator needs one key: the fee payer that signs and broadcasts settlements.",
        "Run `npm run setup:devnet -- --apply` once to create and fund it."
      ].join("\n")
    );
  }
  const feePayer = await createKeyPairSignerFromPrivateKeyBytes2(seed);
  const ledgerStore = redisLedgerStore({
    key: HOSTED_LEDGER_KEY,
    settlementKey: HOSTED_SETTLEMENTS_KEY
  }) ?? void 0;
  const ledger = await sharedLedger(
    await loadLedger(options.ledgerPath),
    ledgerStore
  );
  const { facilitator } = createVeilFacilitator({
    signer: toFacilitatorSvmSigner(feePayer, {
      ...options.rpcUrl ? { defaultRpcUrl: options.rpcUrl } : {}
    }),
    networks: [options.network],
    // Attribution: without it the facilitator would settle any destination. With
    // it, a payment to an account that is not one of this pool's is refused with a
    // reason instead of being broadcast and then disputed.
    owner: (address) => ledger.resolve(address)?.alias,
    simulate: process.env.VEIL_SKIP_SIMULATE !== "true"
  });
  function json(res, status, body) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      // Paying agents may call /verify and /settle from a browser on another
      // origin; nothing here accepts credentials, so `*` carries no risk.
      "access-control-allow-origin": "*"
    });
    res.end(payload);
  }
  async function readBody(req) {
    const preParsed = req.body;
    if (preParsed !== void 0 && preParsed !== null) return preParsed;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1e6) throw new Error("request body too large");
      chunks.push(chunk);
    }
    if (size === 0) return void 0;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function parseRequest(raw) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "body must be a JSON object" };
    const body = raw;
    if (typeof body.x402Version !== "number") {
      return { ok: false, error: "x402Version is required" };
    }
    const payload = PaymentPayloadSchema.safeParse(body.paymentPayload);
    if (!payload.success) {
      return {
        ok: false,
        error: `paymentPayload is not a valid x402 payload: ${payload.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      };
    }
    const requirements = PaymentRequirementsSchema.safeParse(body.paymentRequirements);
    if (!requirements.success) {
      return {
        ok: false,
        error: `paymentRequirements is not a valid x402 requirement: ${requirements.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
      };
    }
    return {
      ok: true,
      payload: payload.data,
      requirements: requirements.data
    };
  }
  function out(lines) {
    process.stdout.write(`${lines.join("\n")}
`);
  }
  const handler2 = async (req, res) => {
    const query = req.query?.route;
    if (typeof query === "string" && query.length > 0) {
      const rest = new URL(req.url ?? "/", "http://localhost").searchParams;
      rest.delete("route");
      const tail = rest.toString();
      req.url = tail.length === 0 ? query : `${query}${query.includes("?") ? "&" : "?"}${tail}`;
    }
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const pathOnly = parsedUrl.pathname;
    const { search } = parsedUrl;
    const known = ["/verify", "/settle", "/supported", "/health"].find(
      (route) => pathOnly === route || pathOnly.endsWith(route)
    );
    if (known !== void 0) req.url = `${known}${search}`;
    else if (pathOnly.endsWith("/facilitator") || pathOnly.endsWith("/api/facilitator")) {
      req.url = `/${search}`;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      json(res, 200, {
        service: "veil-facilitator",
        scheme: VEIL_SCHEME,
        // Which chains? The ones the registered scheme was registered for.
        supported: ["GET /supported", "POST /verify", "POST /settle"],
        feePayers: facilitator.getSupported().signers,
        poolAccounts: ledger.allFor().length,
        ledger: relative(options.ledgerPath),
        network: options.network,
        rpc: options.rpcUrl ?? "default",
        honest: [
          "This service verifies destinations, mints and proofs, and simulates before settling.",
          "It cannot verify the transferred AMOUNT: a confidential transfer carries an encrypted value.",
          "The merchant verifies the amount by decrypting its own balance; see README.md."
        ]
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/supported") {
      json(res, 200, facilitator.getSupported());
      return;
    }
    if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : "unreadable body" });
        return;
      }
      const parsed = parseRequest(raw);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return;
      }
      const started = Date.now();
      if (url.pathname === "/verify") {
        const verdict = await facilitator.verify(parsed.payload, parsed.requirements);
        out([
          `verify  ${verdict.isValid ? "valid  " : "invalid"}  ${verdict.invalidReason ?? ""}  ${Date.now() - started}ms`.trimEnd()
        ]);
        json(res, 200, verdict);
        return;
      }
      const current = await sharedLedger(ledger, ledgerStore);
      const refusal2 = settleRefusal(current, parsed.requirements.payTo);
      if (refusal2 !== null) {
        out([
          `settle  refused ${parsed.requirements.payTo}  ${Date.now() - started}ms`.trimEnd()
        ]);
        json(res, 200, {
          success: false,
          // From the requirements, which name the network on both of x402's
          // shapes; the payload nests it differently per version.
          network: parsed.requirements.network,
          transaction: "",
          errorReason: refusal2,
          payer: ""
        });
        return;
      }
      const result = await facilitator.settle(parsed.payload, parsed.requirements);
      out([
        `settle  ${result.success ? `confirmed ${result.transaction}` : `failed ${result.errorReason ?? ""}`}  ${Date.now() - started}ms`.trimEnd()
      ]);
      if (result.success) {
        out([
          `record  ${await recordSettlement({
            ledger: current,
            ...ledgerStore ? { store: ledgerStore } : {},
            requirements: parsed.requirements,
            signature: result.transaction
          })}`
        ]);
      }
      json(res, 200, result);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400"
      });
      res.end();
      return;
    }
    json(res, 404, {
      error: "not found",
      // Echo of what arrived: when a hosted rewrite loses the original path,
      // this is the difference between a five-second fix and a blind one.
      seen: url.pathname,
      endpoints: ["GET /", "GET /health", "GET /supported", "POST /verify", "POST /settle"]
    });
  };
  const supported = facilitator.getSupported();
  return {
    handler: handler2,
    feePayerAddress: feePayer.address,
    poolAccounts: ledger.allFor().length,
    network: String(options.network),
    rpc: options.rpcUrl ?? "default",
    ledgerDisplay: relative(options.ledgerPath),
    kinds: supported.kinds.map((k) => `${k.scheme}@${k.network}`)
  };
}

// api-src/facilitator.ts
var ready = null;
async function ensureReady() {
  ready ??= (async () => {
    process.env.VEIL_LEDGER = await seedHostedLedger();
  })();
  return ready;
}
async function handler(req, res) {
  try {
    await ensureReady();
    const route = rewriteRoute(req.url);
    if (route !== null) req.url = route;
    const app = await getFacilitatorApp(optionsFromEnv([]));
    await app.handler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      const detail = error instanceof Error ? error.message : "unknown error";
      res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*"
      });
      res.end(JSON.stringify({ error: "facilitator-unavailable", detail }, null, 2));
    }
  }
}
export {
  handler as default
};
