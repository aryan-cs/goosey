import { address, createNoopSigner, getAddressEncoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), account: vi.fn(), genesis: vi.fn(), sign: vi.fn() }));
vi.mock("@/lib/solana/configuration", () => ({ readGooseyConfiguration: mocks.read }));
vi.mock("@/lib/solana/sponsored-transaction", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/solana/sponsored-transaction")>()),
  signSponsoredTransaction: mocks.sign,
}));
vi.mock("@solana/kit", async importOriginal => ({
  ...(await importOriginal<typeof import("@solana/kit")>()),
  createSolanaRpc: () => ({
    getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.account(args, options) }),
    getGenesisHash: () => ({ send: mocks.genesis }),
  }),
}));

import { prepareSponsoredFeatherTransfer } from "./sponsored-feather-transfer";

const mint = address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw");
const participant = createNoopSigner(address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"));
const sponsor = createNoopSigner(address("FNWvaKFgtcsc1jbfNyCKWBtT1oFqFSXwz8V8mheqYxED"));
const recipient = address("B65XrNy82H9MeHnxxBihjUnwaRM9fXiMfTsCBuw2GvDo");
const runtime = {
  cluster: "localnet" as const,
  rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",
};
const signed = {
  version: 1 as const,
  cluster: "localnet" as const,
  genesisHash: runtime.genesisHash,
  programAddress: runtime.programAddress,
  participantAddress: participant.address,
  sponsorAddress: sponsor.address,
  signature: "1".repeat(64),
  signedWireBase64: "wire" as never,
  messageSha256: "digest",
  recentBlockhash: sponsor.address,
  lastValidBlockHeight: 200n,
};

function tokenAccount(balance = 1_000_000n) {
  const data = Buffer.alloc(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(participant.address), 32);
  data.writeBigUInt64LE(balance, 64);
  data[108] = 1;
  return {
    context: { slot: 101n },
    value: { owner: TOKEN_PROGRAM_ADDRESS, executable: false, data: [data.toString("base64"), "base64"] },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ featherMint: mint, finalizedSlot: 100n });
  mocks.account.mockResolvedValue(tokenAccount());
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.sign.mockResolvedValue(signed);
});

describe("sponsored managed feather transfer", () => {
  it("uses finalized chain balance and a strict two-program sponsor policy", async () => {
    const result = await prepareSponsoredFeatherTransfer({
      runtime,
      participant,
      sponsor,
      recipient,
      amount: 123_456n,
    });
    expect(result).toMatchObject({ sender: participant.address, recipient, amount: 123_456n,
      finalizedBalance: 1_000_000n, observedSlot: 101n, signed });
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({
      participant,
      sponsor,
      instructions: expect.any(Array),
      allowlist: expect.objectContaining({
        maxInstructions: 2,
        instructionProgramAddresses: expect.arrayContaining([TOKEN_PROGRAM_ADDRESS]),
        requiredInstructionProgramAddresses: expect.arrayContaining([TOKEN_PROGRAM_ADDRESS]),
      }),
    }));
    const signInput = mocks.sign.mock.calls[0][0];
    expect(signInput.instructions).toHaveLength(2);
    expect(signInput.allowlist.instructionProgramAddresses).toHaveLength(2);
  });

  it("never signs against a missing, malformed, or insufficient finalized source", async () => {
    for (const response of [
      { ...tokenAccount(), value: null },
      { ...tokenAccount(), value: { ...tokenAccount().value, owner: mint } },
      tokenAccount(123_455n),
    ]) {
      mocks.account.mockResolvedValueOnce(response);
      await expect(prepareSponsoredFeatherTransfer({ runtime, participant, sponsor, recipient, amount: 123_456n }))
        .rejects.toThrow();
    }
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("fails closed on self-transfer, sponsor collision, and genesis drift", async () => {
    await expect(prepareSponsoredFeatherTransfer({ runtime, participant, sponsor,
      recipient: participant.address, amount: 1n })).rejects.toThrow(/recipient/);
    await expect(prepareSponsoredFeatherTransfer({ runtime, participant, sponsor: participant,
      recipient, amount: 1n })).rejects.toThrow(/distinct/);
    mocks.genesis.mockResolvedValueOnce(recipient);
    await expect(prepareSponsoredFeatherTransfer({ runtime, participant, sponsor,
      recipient, amount: 1n })).rejects.toThrow(/genesis changed/);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
