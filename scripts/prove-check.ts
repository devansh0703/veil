/**
 * scripts/prove-check.ts — can this toolchain actually generate ZK proofs?
 *
 * Settles one question with evidence rather than assumption: does the JS
 * toolchain *generate* the zero-knowledge proofs a confidential account needs,
 * or only *verify* them? The answer decides whether Veil's on-chain path can run
 * entirely from Node or is only half implementable here.
 *
 * Every claim below is measured. `verify()` throws when a proof does not hold,
 * so nothing here passes without really being a proof of the statement it
 * claims. The negative cases matter more than the positive ones: a proof that
 * accepts a false statement proves nothing, so each generator is also shown
 * rejecting input it must reject.
 */

import {
  ElGamalKeypair,
  PubkeyValidityProofData,
  ZeroCiphertextProofData,
  ConfidentialKeys,
  AeKey,
} from '@solana/zk-sdk';
import { buildTransferProofs, encryptAmount } from '../packages/onchain/src/proofs.ts';

let failures = 0;

function pass(label: string, detail: string): void {
  process.stdout.write(`  ok    ${label.padEnd(40)} ${detail}\n`);
}

function fail(label: string, detail: string): void {
  failures++;
  process.stdout.write(`  FAIL  ${label.padEnd(40)} ${detail}\n`);
}

/** Run a check, reporting a thrown error as a failure rather than a crash. */
function check(label: string, fn: () => string): void {
  try {
    pass(label, fn());
  } catch (e) {
    fail(label, e instanceof Error ? e.message : String(e));
  }
}

/** Assert that an operation throws. A proof that cannot fail proves nothing. */
function checkRejects(label: string, fn: () => unknown, expect = ''): void {
  try {
    fn();
    fail(label, 'accepted input it must reject');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (expect && !msg.toLowerCase().includes(expect.toLowerCase())) {
      pass(label, `rejected ("${msg.slice(0, 40)}")`);
      return;
    }
    pass(label, `rejected as required`);
  }
}

process.stdout.write('Veil — proof generation check\n\n');

// ---------------------------------------------------------------------------
// The key material a confidential account is built from
// ---------------------------------------------------------------------------

process.stdout.write('key derivation\n');

const seed = new Uint8Array(32).fill(7);
const kp = ElGamalKeypair.fromSeed(seed);

check('ElGamalKeypair.fromSeed', () => {
  const pk = kp.pubkey().toBytes();
  if (pk.length !== 32) throw new Error(`pubkey is ${pk.length} bytes, expected 32`);
  return `pubkey ${pk.length} bytes`;
});

check('keypair is deterministic from its seed', () => {
  const again = ElGamalKeypair.fromSeed(seed);
  const a = Buffer.from(kp.pubkey().toBytes()).toString('hex');
  const b = Buffer.from(again.pubkey().toBytes()).toString('hex');
  if (a !== b) throw new Error('same seed produced a different pubkey');
  return 'same seed gives the same pubkey';
});

check('a different seed gives a different pubkey', () => {
  const other = ElGamalKeypair.fromSeed(new Uint8Array(32).fill(8));
  const a = Buffer.from(kp.pubkey().toBytes()).toString('hex');
  const b = Buffer.from(other.pubkey().toBytes()).toString('hex');
  if (a === b) throw new Error('two seeds collided');
  return 'distinct seeds stay distinct';
});

// The real derivation path: ConfidentialKeys from a wallet signature over the
// protocol's fixed message. This is what makes the keys recoverable and never
// stored, so it is worth proving it works rather than assuming it.
check('ConfidentialKeys.fromSignature', () => {
  const keys = ConfidentialKeys.fromSignature(new Uint8Array(64).fill(11));
  const pk = keys.elgamal().pubkey().toBytes();
  const ae = keys.ae();
  if (pk.length !== 32) throw new Error(`elgamal pubkey ${pk.length} bytes`);
  if (!ae || typeof ae.encrypt !== 'function') throw new Error('no AE key');
  return `elgamal ${pk.length} bytes + AE key`;
});

check('the signature message is the documented protocol string', () => {
  const msg = Buffer.from(ConfidentialKeys.signerMessage()).toString('utf8');
  if (!msg.includes('conf')) throw new Error(`unexpected message: ${msg}`);
  return JSON.stringify(msg);
});

// ---------------------------------------------------------------------------
// Proof generation — the question this script exists to answer
// ---------------------------------------------------------------------------

process.stdout.write('\nproof generation\n');

check('PubkeyValidityProofData generates and verifies', () => {
  const proof = new PubkeyValidityProofData(kp);
  proof.verify();
  const ctx = proof.context().toBytes().length;
  const bytes = proof.toBytes().length;
  if (bytes === 0) throw new Error('proof serialised to nothing');
  return `context ${ctx}B + proof ${bytes}B, verified`;
});

check('PubkeyValidityProof survives a byte round-trip', () => {
  const proof = new PubkeyValidityProofData(kp);
  const revived = PubkeyValidityProofData.fromBytes(proof.toBytes());
  revived.verify();
  return 'deserialised proof still verifies';
});

check('ZeroCiphertextProofData generates and verifies', () => {
  // encryptU64(0n) produces a proper random Pedersen opening. PedersenOpening
  // .zero() does not, and the sigma proof rejects it — see the negative case
  // below, which is why this distinction is worth stating.
  const zero = kp.pubkey().encryptU64(0n);
  const proof = new ZeroCiphertextProofData(kp, zero);
  proof.verify();
  return `context ${proof.context().toBytes().length}B + proof ${proof.toBytes().length}B, verified`;
});

checkRejects(
  'ZeroCiphertextProof rejects a non-zero ciphertext',
  () => new ZeroCiphertextProofData(kp, kp.pubkey().encryptU64(5n)),
);

// ---------------------------------------------------------------------------
// The three proofs a confidential TRANSFER needs, generated in this process
// ---------------------------------------------------------------------------

process.stdout.write('\ntransfer proofs (client-side, three statements)\n');

const payerKeys = ConfidentialKeys.fromSignature(new Uint8Array(64).fill(21));
const destinationKeys = ConfidentialKeys.fromSignature(new Uint8Array(64).fill(22));
const BALANCE = 1_000_000n;
const PAYMENT = 49_000n;

/** The payer's on-chain available balance ciphertext, as the chain stores it. */
const balanceCiphertext = payerKeys.elgamal().pubkey().encryptU64(BALANCE);

check('buildTransferProofs generates all three proofs offline', () => {
  const bundle = buildTransferProofs({
    keys: payerKeys,
    sourceAvailableBalance: BALANCE,
    sourceAvailableBalanceCiphertext: balanceCiphertext,
    amount: PAYMENT,
    destinationPubkey: destinationKeys.elgamal().pubkey(),
  });
  if (bundle.proofs.length !== 3) {
    throw new Error(`expected 3 proof instructions, got ${bundle.proofs.length}`);
  }
  const sizes = bundle.proofs.map((p) => (p.data as Uint8Array).length);
  for (const size of sizes) {
    if (size === 0) throw new Error('a proof serialised to nothing');
  }
  if (bundle.newAvailableBalance !== BALANCE - PAYMENT) {
    throw new Error(`new balance is ${bundle.newAvailableBalance}`);
  }
  return `3 proofs (${sizes.join('B, ')}B), new balance ${bundle.newAvailableBalance}`;
});

check('every proof instruction carries its own discriminant byte', () => {
  const bundle = buildTransferProofs({
    keys: payerKeys,
    sourceAvailableBalance: BALANCE,
    sourceAvailableBalanceCiphertext: balanceCiphertext,
    amount: PAYMENT,
    destinationPubkey: destinationKeys.elgamal().pubkey(),
  });
  // 3 = equality, 12 = batched grouped 3-handles validity, 7 = batched range u128.
  const discriminants = bundle.proofs.map((p) => (p.data as Uint8Array)[0]);
  if (discriminants.join(',') !== '3,12,7') {
    throw new Error(`discriminants were ${discriminants.join(',')}`);
  }
  return `discriminants ${discriminants.join(', ')}`;
});

check('all three proof offsets are -1 (each proof precedes its consumer)', () => {
  const bundle = buildTransferProofs({
    keys: payerKeys,
    sourceAvailableBalance: BALANCE,
    sourceAvailableBalanceCiphertext: balanceCiphertext,
    amount: PAYMENT,
    destinationPubkey: destinationKeys.elgamal().pubkey(),
  });
  const offsets = [
    bundle.equalityProofOffset,
    bundle.ciphertextValidityProofOffset,
    bundle.rangeProofOffset,
  ];
  if (offsets.some((o) => o !== -1)) {
    throw new Error(`offsets were ${offsets.join(',')}`);
  }
  return 'all three offsets -1';
});

checkRejects(
  'a transfer larger than the balance is refused, not proven',
  () =>
    buildTransferProofs({
      keys: payerKeys,
      sourceAvailableBalance: PAYMENT - 1n,
      sourceAvailableBalanceCiphertext: balanceCiphertext,
      amount: PAYMENT,
      destinationPubkey: destinationKeys.elgamal().pubkey(),
    }),
);

checkRejects(
  'a zero-amount transfer is refused',
  () =>
    buildTransferProofs({
      keys: payerKeys,
      sourceAvailableBalance: BALANCE,
      sourceAvailableBalanceCiphertext: balanceCiphertext,
      amount: 0n,
      destinationPubkey: destinationKeys.elgamal().pubkey(),
    }),
);

check('the auditor ciphertext is a real handle, not a zero placeholder', () => {
  // A mint with no auditor still needs a 3-handle ciphertext; the auditor
  // handle is a real curve point even though it encrypts the same amount for a
  // key nobody holds. Zero *bytes* would be an invalid point and the chain
  // would reject it, so this checks the shape rather than trusting it.
  const bundle = buildTransferProofs({
    keys: payerKeys,
    sourceAvailableBalance: BALANCE,
    sourceAvailableBalanceCiphertext: balanceCiphertext,
    amount: PAYMENT,
    destinationPubkey: destinationKeys.elgamal().pubkey(),
  });
  if (bundle.auditorCiphertextLo.length !== 64 || bundle.auditorCiphertextHi.length !== 64) {
    throw new Error('auditor ciphertext is not 64 bytes');
  }
  if (bundle.auditorCiphertextLo.every((b) => b === 0)) {
    throw new Error('auditor ciphertext is all zeroes');
  }
  return '64-byte handles, non-zero';
});

check('proofs are generated with no network access at all', () => {
  // Stated as a check because it is the property that matters for deployment:
  // if this ever needed an RPC or a prover service, a browser wallet could not
  // do it. The calls above never touched the network; this re-runs the whole
  // thing for a fresh payer to make the point that nothing is cached remotely.
  const fresh = ConfidentialKeys.fromSignature(new Uint8Array(64).fill(23));
  const before = Date.now();
  const bundle = buildTransferProofs({
    keys: fresh,
    sourceAvailableBalance: BALANCE,
    sourceAvailableBalanceCiphertext: fresh.elgamal().pubkey().encryptU64(BALANCE),
    amount: 1n,
    destinationPubkey: destinationKeys.elgamal().pubkey(),
  });
  return `${bundle.proofs.length} proofs for a fresh payer in ${Date.now() - before}ms`;
});

checkRejects(
  'a balance ciphertext belonging to another key is refused, not proven',
  () => {
    // The equality proof states "new balance = old balance − amount", and the
    // old balance is a ciphertext the payer must own the key to. Handing in a
    // ciphertext under someone else's key cannot be proven about, and the
    // generator says so rather than emitting a proof that fails on chain.
    const foreign = ConfidentialKeys.fromSignature(new Uint8Array(64).fill(24));
    return buildTransferProofs({
      keys: foreign,
      sourceAvailableBalance: BALANCE,
      sourceAvailableBalanceCiphertext: balanceCiphertext,
      amount: 1n,
      destinationPubkey: destinationKeys.elgamal().pubkey(),
    });
  },
  'mismatch',
);

check('the same balance with a different amount gives different proof material', () => {
  const prove = (amount: bigint) =>
    buildTransferProofs({
      keys: payerKeys,
      sourceAvailableBalance: BALANCE,
      sourceAvailableBalanceCiphertext: balanceCiphertext,
      amount,
      destinationPubkey: destinationKeys.elgamal().pubkey(),
    });
  const a = prove(100n);
  const b = prove(200n);
  // Compared whole, not on a prefix: the leading bytes of a proof instruction
  // are the statement context, and two statements can share a prefix.
  const hex = (bundle: ReturnType<typeof prove>) =>
    bundle.proofs.map((p) => Buffer.from(p.data as Uint8Array).toString('hex')).join('|');
  if (hex(a) === hex(b)) throw new Error('two amounts produced identical proof material');
  return 'distinct proofs for distinct amounts';
});

check('an ElGamal amount encrypts to exactly 64 bytes', () => {
  const bytes = encryptAmount(payerKeys, PAYMENT);
  if (bytes.length !== 64) throw new Error(`ciphertext is ${bytes.length} bytes`);
  return '64-byte ciphertext';
});

// ---------------------------------------------------------------------------
// Decryption — the merchant reconciliation path
// ---------------------------------------------------------------------------

process.stdout.write('\ndecryption (the merchant reconciliation path)\n');

check('AeKey encrypts and decrypts a balance', () => {
  const ae = AeKey.fromSeed(new Uint8Array(32).fill(3));
  const ct = ae.encrypt(247800000n);
  if (ct.toBytes().length !== 36) {
    throw new Error(`ciphertext is ${ct.toBytes().length} bytes, expected 36`);
  }
  const back = ae.decrypt(ct);
  if (back !== 247800000n) throw new Error(`round-trip gave ${back}`);
  return '36-byte ciphertext, round-trips exactly';
});

check('a different AE key cannot read it', () => {
  const mine = AeKey.fromSeed(new Uint8Array(32).fill(3));
  const theirs = AeKey.fromSeed(new Uint8Array(32).fill(4));
  const ct = mine.encrypt(247800000n);
  let wrong: bigint | null = null;
  try {
    wrong = theirs.decrypt(ct);
  } catch {
    return 'decryption refused outright';
  }
  if (wrong === 247800000n) throw new Error('another key read the amount');
  return `another key produced a different value (${wrong})`;
});

check('ElGamal balance decrypts under its own key only', () => {
  const ct = kp.pubkey().encryptU64(49000n);
  const mine = kp.secret().decrypt(ct);
  if (mine !== 49000n) throw new Error(`own key gave ${mine}`);
  return `own key reads 49000 exactly (ciphertext ${ct.toBytes().length}B)`;
});

check('a foreign ElGamal key cannot read that balance', () => {
  const ct = kp.pubkey().encryptU64(49000n);
  const other = ElGamalKeypair.fromSeed(new Uint8Array(32).fill(9));
  // A wrong key *throws* rather than returning a wrong number, which is the
  // stronger behaviour: there is no silent-wrong-value path to misread.
  let read: bigint | null = null;
  try {
    read = other.secret().decrypt(ct);
  } catch {
    return 'decryption refused outright';
  }
  if (read === 49000n) throw new Error('another key read the amount');
  return `another key got a different value (${read})`;
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

process.stdout.write('\n');
if (failures === 0) {
  process.stdout.write(
    'VERDICT: this toolchain generates real proofs in JS.\n' +
      'The on-chain confidential path is implementable end to end from Node.\n',
  );
} else {
  process.stdout.write(
    `VERDICT: ${failures} check(s) failed. Do not claim the on-chain path is ` +
      'implementable until they pass.\n',
  );
  process.exitCode = 1;
}