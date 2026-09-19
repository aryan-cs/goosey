import { describe, expect, it } from "vitest";
import { address, appendTransactionMessageInstructions, blockhash, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { buildFeatherTransfer } from "./feather-transfer";
import { createTransferReceiptStore } from "./transfer-receipts";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "./runtime";

function storage() {
  const data = new Map<string, string>();
  return { data, get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
async function fixture() {
  const signer = await generateKeyPairSigner(), recipient = await generateKeyPairSigner();
  const domain = { cluster: "localnet" as const, genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",
    programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), walletAddress: signer.address };
  const instructions = await buildFeatherTransfer({ mint: address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw"), sender: signer, recipient: recipient.address, amount: 123n });
  async function receipt(lastValidBlockHeight = 100n, amount = 123n) {
    const plan = amount === 123n ? instructions : await buildFeatherTransfer({ mint: address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw"), sender: signer, recipient: recipient.address, amount });
    const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(signer, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(domain.genesisHash), lastValidBlockHeight }, tx),
      tx => appendTransactionMessageInstructions(plan.instructions, tx));
    const signed = await signTransactionMessageWithSigners(message);
    return { signature: getSignatureFromTransaction(signed), signedWireBase64: getBase64EncodedWireTransaction(signed), lastValidBlockHeight };
  }
  return { domain, recipient, receipt };
}
describe("immutable local transfer recovery journal (real signatures, in-memory storage port)", () => {
  it("recovers across store instances and keeps repeated same-signature writes idempotent", async () => {
    const f = await fixture(), db = storage(), receipt = await f.receipt();
    const first = createTransferReceiptStore(db, f.domain);
    await first.persist(receipt); await first.persist(receipt);
    expect(db.length).toBe(1);
    expect(await createTransferReceiptStore(db, f.domain).list()).toEqual({ receipts: [receipt], unreadableKeys: [] });
  });
  it("separate tabs cannot lose different signature records through list overwrites", async () => {
    const f = await fixture(), db = storage(), a = createTransferReceiptStore(db, f.domain), b = createTransferReceiptStore(db, f.domain);
    await Promise.all([a.persist(await f.receipt()), b.persist(await f.receipt(100n, 456n))]);
    expect((await a.list()).receipts).toHaveLength(2);
  });
  it("isolates wallet and genesis scopes", async () => {
    const f = await fixture(), db = storage(); await createTransferReceiptStore(db, f.domain).persist(await f.receipt());
    for (const domain of [{ ...f.domain, walletAddress: f.recipient.address }, { ...f.domain, genesisHash: "11111111111111111111111111111111" }]) {
      expect((await createTransferReceiptStore(db, domain).list()).receipts).toEqual([]);
    }
  });
  it("rejects another wallet's authentic signed transaction", async () => {
    const f = await fixture(), db = storage();
    await expect(createTransferReceiptStore(db, { ...f.domain, walletAddress: f.recipient.address }).persist(await f.receipt())).rejects.toThrow("wallet");
    expect(db.length).toBe(0);
  });
  it("rejects conflicting lifetime metadata without overwriting original evidence", async () => {
    const f = await fixture(), db = storage(), store = createTransferReceiptStore(db, f.domain), receipt = await f.receipt();
    await store.persist(receipt);
    await expect(store.persist({ ...receipt, lastValidBlockHeight: 99n })).rejects.toThrow("Conflicting");
    expect((await store.list()).receipts).toEqual([receipt]);
  });
  it("rejects wire tampering and trailing bytes", async () => {
    const f = await fixture(), store = createTransferReceiptStore(storage(), f.domain), receipt = await f.receipt();
    const bytes = Buffer.from(receipt.signedWireBase64, "base64"); bytes[bytes.length - 1] ^= 1;
    await expect(store.persist({ ...receipt, signedWireBase64: bytes.toString("base64") })).rejects.toThrow();
    await expect(store.persist({ ...receipt, signedWireBase64: Buffer.concat([Buffer.from(receipt.signedWireBase64, "base64"), Buffer.alloc(1)]).toString("base64") })).rejects.toThrow();
  });
  it("reports corrupted records without deleting or manufacturing a recovery receipt", async () => {
    const f = await fixture(), db = storage(), store = createTransferReceiptStore(db, f.domain); await store.persist(await f.receipt());
    const key = db.key(0)!; db.setItem(key, "broken json");
    expect(await store.list()).toEqual({ receipts: [], unreadableKeys: [key] });
    expect(db.getItem(key)).toBe("broken json");
  });
  it("fails closed on quota errors and silent storage write failures", async () => {
    const f = await fixture(), receipt = await f.receipt();
    const throwing = { ...storage(), setItem() { throw new Error("quota"); } };
    await expect(createTransferReceiptStore(throwing, f.domain).persist(receipt)).rejects.toThrow("quota");
    const dropping = { ...storage(), setItem() {} };
    await expect(createTransferReceiptStore(dropping, f.domain).persist(receipt)).rejects.toThrow("not retained");
  });
  it("rejects unsupported/mainnet contexts", async () => {
    const f = await fixture();
    expect(() => createTransferReceiptStore(storage(), { ...f.domain, genesisHash: MAINNET_GENESIS_HASH })).toThrow("domain");
    expect(() => createTransferReceiptStore(storage(), { ...f.domain, cluster: "devnet" })).toThrow("domain");
  });
  it("accepts full devnet and rejects truncated pins/full mainnet across domain labels", async () => {
    const f = await fixture();
    expect(() => createTransferReceiptStore(storage(), { ...f.domain, cluster: "devnet", genesisHash: DEVNET_GENESIS_HASH })).not.toThrow();
    for (const cluster of ["localnet", "devnet"] as const) {
      for (const genesisHash of [DEVNET_GENESIS_HASH.slice(0, 32), MAINNET_GENESIS_HASH.slice(0, 32), MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH]) {
        expect(() => createTransferReceiptStore(storage(), { ...f.domain, cluster, genesisHash })).toThrow("domain");
      }
    }
  });
});
