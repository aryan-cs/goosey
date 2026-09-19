/** Actual standalone matcher CU measurements, NEVER the Goosey foundation.
 * Requires explicitly pinned disposable validator, fresh benchmark deployment,
 * and disposable payer path. All book contents are admitted by real instructions.
 * No wallet keys or signed transaction bytes are printed. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccountRole, address, appendTransactionMessageInstructions, blockhash,
  createKeyPairSignerFromBytes, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Instruction, type Address,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";

async function main() {
  const endpoint = process.env.MATCHER_RPC!;
  const genesis = process.env.MATCHER_GENESIS!;
  const keyPath = process.env.MATCHER_PAYER!;
  const program = address(process.env.MATCHER_PROGRAM!);
  const output = process.env.MATCHER_REPORT!;
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert(!["18999", "24999"].includes(url.port), "Never target shared validators");
  assert(genesis && keyPath.startsWith("/tmp/goosey-matcher-cu.") && output.startsWith("/tmp/goosey-matcher-cu."));
  assert.notEqual(program, "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
  let id = 0;
  async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await response.json();
    assert(!body.error, JSON.stringify(body.error));
    return body.result as T;
  }
  assert.equal(await rpc("getGenesisHash"), genesis);
  const raw = Uint8Array.from(JSON.parse(await readFile(keyPath, "utf8")));
  const payer = await createKeyPairSignerFromBytes(raw); raw.fill(0);
  const deployed = (await rpc<{ value: { executable: boolean; data: [string, string] } | null }>("getAccountInfo", [program, { encoding: "base64" }])).value;
  assert(deployed?.executable, "Separate benchmark must already be deployed");
  type TransactionResult = { slot: number; meta: { err: unknown; computeUnitsConsumed?: number; logMessages?: string[] } };
  const receipts: Array<{name: string; signature: string; slot: number; cu: number | undefined; error: unknown; logs: string[] | undefined}> = [];
  let serial = 0;
  async function execute(name: string, instructions: Instruction[], failure = false, measure = true) {
    assert.equal(await rpc("getGenesisHash"), genesis);
    const latest = (await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const budget = Buffer.alloc(5); budget[0] = 2; budget.writeUInt32LE(1_400_000 - ++serial, 1);
    const message = pipe(createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayerSigner(payer, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(latest.blockhash), lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) }, tx),
      tx => appendTransactionMessageInstructions([{ programAddress: address("ComputeBudget111111111111111111111111111111"), data: budget }, ...instructions], tx));
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    assert.equal(await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]), signature);
    const deadline = Date.now() + 45_000;
    let lastResend = Date.now(), tx: TransactionResult | null = null;
    while (Date.now() < deadline) {
      tx = await rpc<TransactionResult | null>("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (tx) break;
      if (Date.now() - lastResend > 1_000) { await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]); lastResend = Date.now(); }
      await delay(80);
    }
    assert(tx, `Transaction timeout ${name}`);
    assert.equal(tx.meta.err !== null, failure, JSON.stringify({ name, meta: tx.meta }));
    assert(Number.isInteger(tx.meta.computeUnitsConsumed));
    if (measure) {
      const receipt = { name, signature, slot: tx.slot, cu: tx.meta.computeUnitsConsumed, error: tx.meta.err, logs: tx.meta.logMessages };
      receipts.push(receipt);
      await writeFile(output, JSON.stringify({ endpoint, genesis, program, receipts }, null, 2));
      console.log(JSON.stringify({ name, cu: receipt.cu, error: receipt.error, signature }));
    }
    return tx;
  }
  type Options = { owner?: number; price?: number; qty?: number; action?: number; tif?: number;
    expiry?: number; now?: number; stp?: number; post?: boolean; touches?: number; outcome?: number };
  function order(book: Address, opts: Options = {}): Instruction {
    const b = Buffer.alloc(47); b[0] = 1;
    b.writeBigUInt64LE(BigInt(opts.owner ?? 9_999), 1);
    b.writeBigUInt64LE(BigInt(opts.price ?? 99_999), 9);
    b.writeBigUInt64LE(BigInt(opts.qty ?? 16), 17);
    b[25] = opts.action ?? 0; b[26] = opts.tif ?? 1;
    b.writeBigInt64LE(BigInt(opts.expiry ?? -1), 27); b.writeBigInt64LE(BigInt(opts.now ?? 0), 35);
    b[43] = opts.stp ?? 0; b[44] = Number(opts.post ?? false); b[45] = opts.touches ?? 16; b[46] = opts.outcome ?? 0;
    return { programAddress: program, accounts: [{ address: book, role: AccountRole.WRITABLE },
      { address: payer.address, role: AccountRole.READONLY_SIGNER }], data: b };
  }
  async function state(book: Address) {
    const account = (await rpc<{ value: { executable: boolean; data: [string, string] } | null }>("getAccountInfo", [book, { encoding: "base64", commitment: "confirmed" }])).value;
    assert(account, "Benchmark book account missing");
    return Buffer.from(account.data[0], "base64");
  }
  const rent = BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [69_712]));
  async function populated(n: number, mode: "fills" | "expiry" | "stp" = "fills", overrides: Options = {}) {
    const book = await generateKeyPairSigner();
    await execute(`initialize-${n}-${mode}`, [getCreateAccountInstruction({ payer, newAccount: book, lamports: rent,
      space: 69_712n, programAddress: program }), { programAddress: program, accounts: [
        { address: book.address, role: AccountRole.WRITABLE }, { address: payer.address, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([0]) }], false, false);
    for (let i = 0; i < n; i += 16) {
      const batch: Instruction[] = [];
      for (let k = i; k < Math.min(n, i + 16); k++) batch.push(order(book.address, {
        owner: mode === "stp" ? 9_999 : k + 1, price: 20_000 + ((k + 1) * 37 % 97) * 100,
        qty: 1, action: 1, tif: 0, expiry: mode === "expiry" ? 10 : -1, ...overrides,
      }));
      await execute(`populate-${n}-${mode}-${i}`, batch, false, false);
    }
    const bytes = await state(book.address);
    assert.equal(bytes.readUInt16LE(70), n, "Active orders must reflect actual admissions");
    console.log(`Populated ${n} actual resting orders (${mode})`);
    return book.address;
  }
  for (const n of process.env.MATCHER_CASES === "economics" ? [] : [16, 128, 1_024]) {
    const book = await populated(n);
    const before = await state(book);
    await execute(`n=${n}:FOK17-${n === 16 ? "not-fillable" : "touch-limit"}`, [order(book, { tif: 2, qty: 17 })], n !== 16);
    assert.deepEqual(await state(book), before, "FOK rejection must preserve account bytes");
    await execute(`n=${n}:post-only-cross`, [order(book, { tif: 0, post: true })]);
    assert.deepEqual(await state(book), before);
    if (n === 1_024) {
      await execute("n=1024:full-capacity-reject", [order(book, { tif: 0, action: 1, price: 99_999, qty: 1 })], true);
      assert.deepEqual(await state(book), before);
    }
    // Simulation is supplementary: the following measured fills are committed
    // transactions, with each depleted book replenished through real admissions.
    for (const touches of [1, 8, 16]) {
      await execute(`n=${n}:FOK${touches}-fill`, [order(book, { tif: 2, qty: touches, touches })]);
      const replenishment = Array.from({ length: touches }, (_, k) => order(book, {
        owner: 20_000 + k, price: 20_000 + ((k + 1) * 37 % 97) * 100, qty: 1, action: 1, tif: 0,
      }));
      await execute("replenish", replenishment, false, false);
    }
  }
  for (const mode of process.env.MATCHER_CASES === "economics" ? [] : ["expiry", "stp"] as const) {
    const book = await populated(1_024, mode);
    const before = await state(book);
    await execute(`n=1024:${mode}-FOK-rollback`, [order(book, { tif: 2, qty: 1, now: 10, stp: 1 })], true);
    assert.deepEqual(await state(book), before);
    await execute(`n=1024:${mode}-IOC16`, [order(book, { tif: 1, qty: 1, now: 10, stp: 1 })]);
    assert.equal((await state(book)).readUInt16LE(70), 1_008);
  }
  for (const kind of ["transfer-yes", "mint", "burn", "transfer-no"] as const) {
    const makerNoBuy = kind === "mint" || kind === "transfer-no";
    const book = await populated(16, "fills", { qty: 625_000,
      action: makerNoBuy ? 0 : 1, outcome: makerNoBuy ? 1 : 0, price: makerNoBuy ? 80_000 : 20_000 });
    const takerNoSell = kind === "burn" || kind === "transfer-no";
    await execute(`max-quantity-16:${kind}`, [order(book, { qty: 10_000_000, tif: 2,
      action: takerNoSell ? 1 : 0, outcome: takerNoSell ? 1 : 0, price: takerNoSell ? 1 : 99_999 })]);
    assert.equal((await state(book)).readUInt16LE(70), 0);
  }
  console.log(`Completed ${receipts.length} actual validator CU measurements; report: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
