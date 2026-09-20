import { describe, expect, it, vi } from "vitest";
import { AccountRole, address, generateKeyPairSigner, type Instruction, type InstructionWithSigners } from "@solana/kit";

import { submitSponsoredTransaction } from "./sponsored-submission";
import { signSponsoredTransaction } from "./sponsored-transaction";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const ACCOUNT = address("SysvarRent111111111111111111111111111111111");
const GENESIS = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999/", programAddress: PROGRAM, genesisHash: GENESIS };

function signingRpc() {
  return {
    getGenesisHash: () => ({ send: vi.fn().mockResolvedValue(GENESIS) }),
    getAccountInfo: () => ({ send: vi.fn().mockResolvedValue({ context: { slot: 40n },
      value: { executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" } }) }),
    getLatestBlockhash: () => ({ send: vi.fn().mockResolvedValue({ context: { slot: 41n },
      value: { blockhash: GENESIS, lastValidBlockHeight: 100n } }) }),
  };
}

function submissionRpc(signature: string) {
  const order: string[] = [];
  const send = vi.fn().mockImplementation(async () => { order.push("send"); return signature; });
  const height = vi.fn().mockResolvedValue(50n);
  const valid = vi.fn().mockResolvedValue({ context: { slot: 46n }, value: true });
  const genesis = vi.fn().mockResolvedValue(GENESIS);
  return {
    order,
    send,
    height,
    valid,
    genesis,
    rpc: {
      getGenesisHash: () => ({ send: genesis }),
      getAccountInfo: () => ({ send: vi.fn().mockResolvedValue({ context: { slot: 45n },
        value: { executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" } }) }),
      getBlockHeight: () => ({ send: height }),
      isBlockhashValid: () => ({ send: valid }),
      sendTransaction: () => ({ send }),
    },
  };
}

async function fixture() {
  const participant = await generateKeyPairSigner(), sponsor = await generateKeyPairSigner();
  const instruction = { programAddress: PROGRAM, accounts: [
    { address: participant.address, role: AccountRole.READONLY_SIGNER, signer: participant },
    { address: ACCOUNT, role: AccountRole.WRITABLE },
  ], data: new Uint8Array([1, 2, 3]) } as Instruction & InstructionWithSigners;
  const signed = await signSponsoredTransaction({ runtime, participant, sponsor, instructions: [instruction],
    allowlist: { instructionProgramAddresses: [PROGRAM], accounts: [
      { address: participant.address, maxRole: AccountRole.READONLY_SIGNER },
      { address: ACCOUNT, maxRole: AccountRole.WRITABLE },
    ] },
    rpc: signingRpc() as never });
  return { participant, sponsor, signed };
}

describe("sponsored transaction submission", () => {
  it("records the exact immutable wire before one preflight-enabled send", async () => {
    const f = await fixture(), controls = submissionRpc(f.signed.signature);
    const onPrepared = vi.fn().mockImplementation(receipt => {
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(receipt.signedWireBase64).toBe(f.signed.signedWireBase64);
      controls.order.push("persist");
    });
    const result = await submitSponsoredTransaction({ runtime, signed: f.signed, onPrepared, rpc: controls.rpc as never });
    expect(result).toEqual({ status: "submitted", signature: f.signed.signature,
      lastValidBlockHeight: 100n, signedWireBase64: f.signed.signedWireBase64 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(controls.order).toEqual(["persist", "send"]);
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it("does not send if the caller's durability hook fails", async () => {
    const f = await fixture(), controls = submissionRpc(f.signed.signature);
    await expect(submitSponsoredTransaction({ runtime, signed: f.signed,
      onPrepared: () => { throw new Error("storage unavailable"); }, rpc: controls.rpc as never })).rejects.toThrow("storage unavailable");
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("rejects expired, wrong-domain, and tampered receipts before send", async () => {
    const f = await fixture();
    const expired = submissionRpc(f.signed.signature); expired.height.mockResolvedValue(101n);
    await expect(submitSponsoredTransaction({ runtime, signed: f.signed, onPrepared: vi.fn(),
      rpc: expired.rpc as never })).rejects.toThrow(/expired/);
    expect(expired.send).not.toHaveBeenCalled();

    const invalidBlockhash = submissionRpc(f.signed.signature);
    invalidBlockhash.valid.mockResolvedValue({ context: { slot: 46n }, value: false });
    await expect(submitSponsoredTransaction({ runtime, signed: { ...f.signed, lastValidBlockHeight: 1_000_000n },
      onPrepared: vi.fn(), rpc: invalidBlockhash.rpc as never })).rejects.toThrow(/blockhash expired/);
    expect(invalidBlockhash.send).not.toHaveBeenCalled();

    const wrong = submissionRpc(f.signed.signature);
    await expect(submitSponsoredTransaction({ runtime, signed: { ...f.signed, genesisHash: ACCOUNT },
      onPrepared: vi.fn(), rpc: wrong.rpc as never })).rejects.toThrow(/pinned runtime/);
    expect(wrong.send).not.toHaveBeenCalled();

    const tampered = submissionRpc(f.signed.signature);
    const wire = Buffer.from(f.signed.signedWireBase64, "base64"); wire[wire.length - 1] ^= 1;
    await expect(submitSponsoredTransaction({ runtime, signed: { ...f.signed,
      signedWireBase64: wire.toString("base64") as typeof f.signed.signedWireBase64 },
      onPrepared: vi.fn(), rpc: tampered.rpc as never })).rejects.toThrow();
    expect(tampered.send).not.toHaveBeenCalled();

    const rebound = submissionRpc(f.signed.signature);
    await expect(submitSponsoredTransaction({ runtime, signed: { ...f.signed, recentBlockhash: ACCOUNT },
      onPrepared: vi.fn(), rpc: rebound.rpc as never })).rejects.toThrow(/message binding/);
    expect(rebound.send).not.toHaveBeenCalled();

    const changedPrograms = submissionRpc(f.signed.signature);
    await expect(submitSponsoredTransaction({ runtime, signed: { ...f.signed,
      instructionProgramAddresses: [ACCOUNT] }, onPrepared: vi.fn(), rpc: changedPrograms.rpc as never }))
      .rejects.toThrow(/program set changed/);
    expect(changedPrograms.send).not.toHaveBeenCalled();
  });

  it("re-pins genesis after durable preparation and rejects malformed block heights", async () => {
    const f = await fixture(), drift = submissionRpc(f.signed.signature);
    drift.genesis.mockResolvedValueOnce(GENESIS).mockResolvedValueOnce(ACCOUNT);
    const onPrepared = vi.fn();
    await expect(submitSponsoredTransaction({ runtime, signed: f.signed, onPrepared,
      rpc: drift.rpc as never })).rejects.toThrow(/genesis/);
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(drift.send).not.toHaveBeenCalled();

    const malformed = submissionRpc(f.signed.signature);
    malformed.height.mockResolvedValue(-1n);
    await expect(submitSponsoredTransaction({ runtime, signed: f.signed, onPrepared: vi.fn(),
      rpc: malformed.rpc as never })).rejects.toThrow(/Invalid block height/);
    expect(malformed.send).not.toHaveBeenCalled();
  });

  it.each(["transport", "signature mismatch"])("returns unknown for %s without retrying", async failure => {
    const f = await fixture(), controls = submissionRpc(f.signed.signature);
    if (failure === "transport") controls.send.mockRejectedValue(new Error("lost response"));
    else controls.send.mockResolvedValue(ACCOUNT);
    const result = await submitSponsoredTransaction({ runtime, signed: f.signed, onPrepared: vi.fn(), rpc: controls.rpc as never });
    expect(result.status).toBe("unknown");
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it("honors cancellation after receipt persistence", async () => {
    const f = await fixture(), controls = submissionRpc(f.signed.signature), controller = new AbortController();
    await expect(submitSponsoredTransaction({ runtime, signed: f.signed,
      onPrepared: () => controller.abort(), signal: controller.signal, rpc: controls.rpc as never })).rejects.toThrow();
    expect(controls.send).not.toHaveBeenCalled();
  });
});
