import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getBase64Encoder,
  type Address,
  type Instruction,
  type InstructionWithSigners,
  type TransactionPartialSigner,
} from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { signSponsoredTransaction, type SponsoredTransactionAllowlist } from "./sponsored-transaction";

const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const ACCOUNT = address("SysvarRent111111111111111111111111111111111");
const GENESIS = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const runtime = {
  cluster: "localnet" as const,
  rpcUrl: "http://127.0.0.1:18999/",
  programAddress: PROGRAM,
  genesisHash: GENESIS,
};

function rpcFixture() {
  const genesis = vi.fn().mockResolvedValue(GENESIS);
  const account = vi.fn().mockResolvedValue({
    context: { slot: 40n },
    value: { executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" },
  });
  const latest = vi.fn().mockResolvedValue({
    context: { slot: 41n },
    value: { blockhash: GENESIS, lastValidBlockHeight: 100n },
  });
  return {
    genesis,
    account,
    latest,
    rpc: {
      getGenesisHash: () => ({ send: genesis }),
      getAccountInfo: () => ({ send: account }),
      getLatestBlockhash: () => ({ send: latest }),
    },
  };
}

async function fixture() {
  const participant = await generateKeyPairSigner();
  const sponsor = await generateKeyPairSigner();
  const data = new Uint8Array([7, 4, 1]);
  const instruction = {
    programAddress: PROGRAM,
    accounts: [
      { address: participant.address, role: AccountRole.READONLY_SIGNER, signer: participant },
      { address: ACCOUNT, role: AccountRole.WRITABLE },
    ],
    data,
  } as Instruction & InstructionWithSigners;
  const allowlist: SponsoredTransactionAllowlist = {
    instructionProgramAddresses: [PROGRAM],
    accounts: [
      { address: participant.address, maxRole: AccountRole.READONLY_SIGNER },
      { address: ACCOUNT, maxRole: AccountRole.WRITABLE },
    ],
  };
  return { participant, sponsor, data, instruction, allowlist, controls: rpcFixture() };
}

describe("server-side sponsored transaction signing", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pins the deployment, freezes the exact message, and verifies two distinct signatures", async () => {
    const f = await fixture();
    const signed = await signSponsoredTransaction({
      runtime,
      participant: f.participant,
      sponsor: f.sponsor,
      instructions: [f.instruction],
      allowlist: f.allowlist,
      rpc: f.controls.rpc as never,
    });
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(signed.signedWireBase64));
    expect(Object.isFrozen(signed)).toBe(true);
    expect(signed).toMatchObject({
      version: 1,
      cluster: "localnet",
      genesisHash: GENESIS,
      programAddress: PROGRAM,
      participantAddress: f.participant.address,
      sponsorAddress: f.sponsor.address,
      lastValidBlockHeight: 100n,
      instructionProgramAddresses: [PROGRAM],
    });
    expect(Object.keys(transaction.signatures).sort()).toEqual([f.participant.address, f.sponsor.address].sort());
    expect(getSignatureFromTransaction(transaction)).toBe(signed.signature);
    expect(signed.messageSha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.controls.account).toHaveBeenCalled();
    expect(f.controls.latest).toHaveBeenCalled();
    expect(f.controls.genesis).toHaveBeenCalledTimes(3);
  });

  it("supports an explicit non-Goosey required-program policy without weakening the default", async () => {
    const f = await fixture();
    const externalInstructions = [
      { ...f.instruction, programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
      { ...f.instruction, programAddress: TOKEN_PROGRAM_ADDRESS },
    ];
    const signed = await signSponsoredTransaction({
      runtime,
      participant: f.participant,
      sponsor: f.sponsor,
      instructions: externalInstructions,
      allowlist: {
        ...f.allowlist,
        instructionProgramAddresses: [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        requiredInstructionProgramAddresses: [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
      },
      rpc: f.controls.rpc as never,
    });
    expect(signed.signature).toBeTruthy();
    expect(signed.instructionProgramAddresses).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS].sort());

    await expect(signSponsoredTransaction({
      runtime,
      participant: f.participant,
      sponsor: f.sponsor,
      instructions: externalInstructions,
      allowlist: { ...f.allowlist,
        instructionProgramAddresses: [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS] },
      rpc: f.controls.rpc as never,
    })).rejects.toThrow(/Required instruction program/);
  });

  it("copies instruction bytes and allowlists before the first asynchronous boundary", async () => {
    const f = await fixture();
    let release!: () => void;
    f.controls.account.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({
        context: { slot: 40n },
        value: { executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" },
      });
    }));
    const pending = signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never });
    f.data.fill(255);
    (f.allowlist.accounts as Array<{ address: Address; maxRole: AccountRole }>).length = 0;
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    const signed = await pending;
    expect(signed.signature).toBeTruthy();
  });

  it.each([
    ["program", (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.allowlist, instructionProgramAddresses: [ACCOUNT] })],
    ["account", (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.allowlist,
      accounts: [{ address: f.participant.address, maxRole: AccountRole.READONLY_SIGNER }] })],
  ])("rejects an instruction outside the %s allowlist before RPC", async (_name, mutate) => {
    const f = await fixture();
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: mutate(f), rpc: f.controls.rpc as never })).rejects.toThrow(/allowlist/);
    expect(f.controls.genesis).not.toHaveBeenCalled();
  });

  it("rejects writable or signer privilege escalation beyond the account allowance", async () => {
    const f = await fixture();
    const underPrivileged = { ...f.allowlist, accounts: f.allowlist.accounts.map(value =>
      value.address === ACCOUNT ? { ...value, maxRole: AccountRole.READONLY } : value) };
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: underPrivileged, rpc: f.controls.rpc as never }))
      .rejects.toThrow(/privileges outside/);
    expect(f.controls.genesis).not.toHaveBeenCalled();
  });

  it("requires one pinned-program instruction and the participant as an exact signer", async () => {
    const f = await fixture();
    const wrongSigner = await generateKeyPairSigner();
    const wrongObject = { ...f.instruction, accounts: [
      { address: f.participant.address, role: AccountRole.READONLY_SIGNER, signer: wrongSigner },
      { address: ACCOUNT, role: AccountRole.WRITABLE },
    ] } as Instruction & InstructionWithSigners;
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [wrongObject], allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow(/signer/);
    const noParticipant = { ...f.instruction, accounts: [{ address: ACCOUNT, role: AccountRole.WRITABLE }] } satisfies Instruction;
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [noParticipant], allowlist: { ...f.allowlist,
        accounts: [{ address: ACCOUNT, maxRole: AccountRole.WRITABLE }] },
      rpc: f.controls.rpc as never })).rejects.toThrow(/participant signature/);
  });

  it("rejects identical identities and non-partial or unauthorized signers", async () => {
    const f = await fixture();
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.participant,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow(/distinct/);
    const sendingOnly = { address: f.sponsor.address, signAndSendTransactions: vi.fn() };
    await expect(signSponsoredTransaction({ runtime, participant: f.participant,
      sponsor: sendingOnly as unknown as TransactionPartialSigner, instructions: [f.instruction],
      allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow();
    const composite = { ...f.participant, modifyAndSignTransactions: vi.fn() };
    await expect(signSponsoredTransaction({ runtime, participant: composite, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never }))
      .rejects.toThrow(/non-modifying/);
  });

  it("fails closed on genesis, program deployment, or finalized lifetime mismatch", async () => {
    const f = await fixture();
    f.controls.genesis.mockResolvedValueOnce(ACCOUNT);
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow(/genesis/);
    f.controls.genesis.mockResolvedValue(GENESIS);
    f.controls.account.mockResolvedValueOnce({ context: { slot: 40n }, value: { executable: false, owner: PROGRAM } });
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow(/not deployed/);
    f.controls.account.mockResolvedValue({ context: { slot: 40n }, value: { executable: true,
      owner: "BPFLoaderUpgradeab1e11111111111111111111111" } });
    f.controls.latest.mockResolvedValueOnce({ context: { slot: 39n }, value: { blockhash: GENESIS, lastValidBlockHeight: 100n } });
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow(/lifetime/);
  });

  it("re-pins genesis after signing", async () => {
    const f = await fixture();
    f.controls.genesis.mockResolvedValueOnce(GENESIS).mockResolvedValueOnce(GENESIS).mockResolvedValueOnce(ACCOUNT);
    await expect(signSponsoredTransaction({ runtime, participant: f.participant, sponsor: f.sponsor,
      instructions: [f.instruction], allowlist: f.allowlist, rpc: f.controls.rpc as never })).rejects.toThrow(/genesis changed/);
  });
});
