import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, appendTransactionMessageInstructions, blockhash, createTransactionMessage, generateKeyPairSigner,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Transaction } from "@solana/kit";
import { buildFeatherTransfer } from "./feather-transfer";
import { submitSignedFeatherTransfer, submitSignedWalletTransaction } from "./submit-transfer";
import { buildCancelOrderInstruction } from "./exchange-client";

const mock = vi.hoisted(() => ({ genesis: vi.fn(), height: vi.fn(), send: vi.fn(), options: vi.fn() }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({
    getGenesisHash: () => ({ send: mock.genesis }), getBlockHeight: () => ({ send: mock.height }),
    sendTransaction: (...args: unknown[]) => { mock.options(...args); return { send: mock.send }; },
  }),
}));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
async function fixture() {
  const sender = await generateKeyPairSigner(), recipient = (await generateKeyPairSigner()).address;
  const mint = address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw");
  const plan = await buildFeatherTransfer({ mint, sender, recipient, amount: 1n });
  const lifetime = { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 100n };
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions(plan.instructions, tx));
  const signed = await signTransactionMessageWithSigners(message);
  const prepared = { ...plan, message, mint, sender: sender.address, recipient, finalizedBalance: 2n, observedSlot: 1n,
    lifetime, cluster: runtime.cluster, genesisHash: runtime.genesisHash };
  mock.send.mockResolvedValue(getSignatureFromTransaction(signed));
  return { runtime, prepared, signed, onPrepared: vi.fn() };
}
beforeEach(() => { vi.resetAllMocks(); mock.genesis.mockResolvedValue(runtime.genesisHash); mock.height.mockResolvedValue(50n); });
describe("signed transfer submission (real Ed25519, mocked RPC)", () => {
  it("supports a real signed program instruction without transfer-specific fabricated fields", async () => {
    const sender = await generateKeyPairSigner();
    const plan = await buildCancelOrderInstruction({ programAddress: runtime.programAddress, marketId: 1n, wallet: sender,
      seats: address("SysvarRent111111111111111111111111111111111"), expectedNonce: 7n,
      target: { orderId: 42n, side: "BID", heapIndex: 0 } });
    const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(sender, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 100n }, tx),
      tx => appendTransactionMessageInstructions([plan.instruction], tx));
    const signed = await signTransactionMessageWithSigners(message);
    mock.send.mockResolvedValue(getSignatureFromTransaction(signed));
    const prepared = { message, sender: sender.address, cluster: runtime.cluster, genesisHash: runtime.genesisHash };
    const onPrepared = vi.fn();
    const result = await submitSignedWalletTransaction({ runtime, prepared, signed, onPrepared });
    expect(result.status).toBe("submitted"); expect(result.signature).toBe(getSignatureFromTransaction(signed));
    expect(onPrepared).toHaveBeenCalledOnce(); expect(mock.send).toHaveBeenCalledOnce();
    expect(submitSignedFeatherTransfer).toBe(submitSignedWalletTransaction);
  });
  it("persists exact signed receipt before a single preflight-enabled send, never claims finality", async () => {
    const f = await fixture(), order: string[] = [];
    f.onPrepared.mockImplementation(receipt => { order.push("persist"); expect(Object.isFrozen(receipt)).toBe(true); });
    mock.send.mockImplementation(async () => { order.push("send"); return getSignatureFromTransaction(f.signed); });
    const result = await submitSignedFeatherTransfer(f);
    expect(result.status).toBe("submitted"); expect(order).toEqual(["persist", "send"]);
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.options).toHaveBeenCalledWith(result.signedWireBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0n });
  });
  it("rejects changed instruction bytes before RPC", async () => {
    const f = await fixture(), bytes = new Uint8Array(f.signed.messageBytes); bytes[bytes.length - 1] ^= 1;
    await expect(submitSignedFeatherTransfer({ ...f, signed: { ...f.signed, messageBytes: bytes as unknown as Transaction["messageBytes"] } })).rejects.toThrow("altered");
    expect(mock.genesis).not.toHaveBeenCalled();
  });
  it("rejects cryptographically invalid and missing signatures", async () => {
    const f = await fixture();
    for (const signature of [null, new Uint8Array(64)]) {
      const signed = { ...f.signed, signatures: { [f.prepared.sender]: signature } } as Transaction;
      await expect(submitSignedFeatherTransfer({ ...f, signed })).rejects.toThrow();
    }
    expect(mock.genesis).not.toHaveBeenCalled();
  });
  it("rejects an additional signer entry", async () => {
    const f = await fixture();
    await expect(submitSignedFeatherTransfer({ ...f, signed: { ...f.signed, signatures: { ...f.signed.signatures, [f.prepared.recipient]: null } } })).rejects.toThrow("signer set");
  });
  it("rejects configured or actual network mismatch without sending", async () => {
    const f = await fixture();
    await expect(submitSignedFeatherTransfer({ ...f, runtime: { ...runtime, genesisHash: "other" } })).rejects.toThrow("network");
    mock.genesis.mockResolvedValue("other");
    await expect(submitSignedFeatherTransfer(f)).rejects.toThrow("genesis mismatch");
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("refuses expired messages and ignores mutable duplicate lifetime metadata", async () => {
    const f = await fixture(); f.prepared.lifetime = { ...f.prepared.lifetime, lastValidBlockHeight: 99999n };
    mock.height.mockResolvedValue(101n);
    await expect(submitSignedFeatherTransfer(f)).rejects.toThrow("expired");
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("never sends if durable receipt recording fails", async () => {
    const f = await fixture(); f.onPrepared.mockRejectedValue(new Error("storage full"));
    await expect(submitSignedFeatherTransfer(f)).rejects.toThrow("storage full");
    expect(mock.send).not.toHaveBeenCalled();
  });
  it.each(["transport", "mismatch"])("returns unknown for %s and does not retry or re-sign", async cause => {
    const f = await fixture();
    if (cause === "transport") mock.send.mockRejectedValue(new Error("connection lost")); else mock.send.mockResolvedValue("another-signature");
    const result = await submitSignedFeatherTransfer(f);
    expect(result).toMatchObject({ status: "unknown", signature: getSignatureFromTransaction(f.signed), lastValidBlockHeight: 100n });
    expect(mock.send).toHaveBeenCalledTimes(1); expect(f.onPrepared).toHaveBeenCalledTimes(1);
  });
  it("does not submit after cancellation during receipt persistence", async () => {
    const f = await fixture(), controller = new AbortController(); f.onPrepared.mockImplementation(() => controller.abort());
    await expect(submitSignedFeatherTransfer({ ...f, signal: controller.signal })).rejects.toThrow();
    expect(mock.send).not.toHaveBeenCalled();
  });
});
