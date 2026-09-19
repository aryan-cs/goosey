import { address, blockhash, getAddressEncoder, getBase64Decoder, getProgramDerivedAddress, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegisterSeatInstruction, deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { deriveGooseyMarketTermsAddresses } from "./market-terms-client";
import { prepareMarketSeat } from "./prepare-seat";
import type { PreparedWalletTransaction } from "./wallet-transaction";
const mocks = vi.hoisted(() => ({ read: vi.fn(), account: vi.fn(), genesis: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(), createSolanaRpc: () => ({
  getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.account(args, options) }),
  getGenesisHash: () => ({ send: mocks.genesis }),
  getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }),
}) }));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999/", programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const wallet: Address = address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W");
const seats = address("SysvarRent111111111111111111111111111111111");
const input = () => ({ runtime: { ...runtime }, sender: { address: wallet, signTransactions: mocks.sign }, marketId: 7n });
async function snapshot() {
  const a = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: 7n, wallet });
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, a.market);
  const { terms } = await deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress, marketId: 7n });
  const [resolution] = await getProgramDerivedAddress({ programAddress: runtime.programAddress, seeds: ["resolution", getAddressEncoder().encode(a.market)] });
  const reviewers = { creator: runtime.programAddress, proposer: { wallet, enrollment: a.enrollment }, approver: { wallet: seats, enrollment: seats } };
  return { ...a, seats, wallet, registered: false, seat: null, finalizedSlot: 500n,
    marketState: { marketId: 7n, seats }, resolution: { address: resolution, phase: 0, ...reviewers },
    marketTerms: { address: terms, market: a.market, ...reviewers },
    orderBook: { book, market: a.market, seats, reservesReconciled: true, seatReserves: [] as unknown[] } };
}
async function enrollmentBytes() {
  const a = await snapshot(), data = new Uint8Array(129);
  data.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("account:Enrollment"))).subarray(0,8));
  data.set(getAddressEncoder().encode(a.config),8); data.set(getAddressEncoder().encode(wallet),40); data[128]=a.enrollmentBump;
  return data;
}
const account = (data: Uint8Array) => ({ context: { slot: 501n }, value: { owner: runtime.programAddress, executable: false, data: [getBase64Decoder().decode(data), "base64"] } });
beforeEach(async () => { vi.resetAllMocks(); mocks.read.mockResolvedValue(await snapshot()); mocks.account.mockResolvedValue(account(await enrollmentBytes()));
  mocks.genesis.mockResolvedValue(runtime.genesisHash); mocks.latest.mockResolvedValue({ context: { slot: 502n }, value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 900n } }); });
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());
describe("seat preparation with mocked reader/RPC and shipping instruction builder", () => {
  it("prepares only canonical registration, sole wallet signer, finalized monotonic reads", async () => {
    const i=input(), result=await prepareMarketSeat(i); const contract: PreparedWalletTransaction=result;
    const plan=await buildRegisterSeatInstruction({ programAddress: runtime.programAddress, marketId:7n, wallet:i.sender, seats });
    expect(contract.message.version).toBe(0); expect(result.message.instructions).toEqual([plan.instruction]);
    expect(getSignersFromTransactionMessage(result.message)).toEqual([i.sender]); expect(result.message.feePayer.address).toBe(wallet);
    expect(result).toMatchObject({ observedSlot:500n,enrollmentSlot:501n,blockhashSlot:502n, market:plan.market, locator:plan.locator });
    expect(mocks.read).toHaveBeenCalledWith(runtime,{marketId:7n,wallet},expect.objectContaining({includeResolution:true,includeMarketTerms:true}));
    expect(mocks.account.mock.calls[0][0]).toEqual([plan.enrollment,{encoding:"base64",commitment:"finalized",minContextSlot:500n}]);
    expect(mocks.latest.mock.calls[0][0]).toEqual([{commitment:"finalized",minContextSlot:501n}]);
  });
  it("permits reviewer registration and closed/resolved phases, as RegisterSeat does",async()=>{
    for(const phase of [0,1,2,3,4]){const state=await snapshot();state.resolution.phase=phase;mocks.read.mockResolvedValue(state);await prepareMarketSeat(input());}
  });
  it("rejects existing seats, exhausted capacity, missing verification, and wrong bindings",async()=>{
    for(const patch of [{registered:true},{seat:{}},{registered:undefined},{resolution:null},{marketTerms:null},{wallet:seats},{config:seats},{market:seats},{enrollment:seats},{locator:seats},{vault:seats},{featherMint:seats},{walletTokens:seats},{finalizedSlot:-1n},{finalizedSlot:500}]){
      mocks.read.mockResolvedValue({...await snapshot(),...patch});await expect(prepareMarketSeat(input())).rejects.toThrow();
    }
    for(const patch of [{seats:wallet},{market:seats},{book:seats},{reservesReconciled:false},{seatReserves:Array(256).fill({})}]){
      const state=await snapshot();mocks.read.mockResolvedValue({...state,orderBook:{...state.orderBook,...patch}});await expect(prepareMarketSeat(input())).rejects.toThrow();
    }
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it("requires real correctly encoded and bound enrollment",async()=>{
    const valid=account(await enrollmentBytes());
    for(const value of [null,{...valid.value,owner:seats},{...valid.value,executable:true},{...valid.value,data:["", "base64"]}]){
      mocks.account.mockResolvedValue({...valid,value});await expect(prepareMarketSeat(input())).rejects.toThrow();
    }
    for(const offset of [0,8,40,128]){const bytes=await enrollmentBytes();bytes[offset]^=1;mocks.account.mockResolvedValue(account(bytes));await expect(prepareMarketSeat(input())).rejects.toThrow();}
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs/runtime before reading",async()=>{
    for(const marketId of [-1n,1n<<64n,1 as unknown as bigint])await expect(prepareMarketSeat({...input(),marketId})).rejects.toThrow();
    await expect(prepareMarketSeat({...input(),runtime:{...runtime,cluster:"mainnet" as "localnet"}})).rejects.toThrow();expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects stale enrollment and blockhash slots, wrong genesis, malformed lifetime",async()=>{
    mocks.account.mockResolvedValue({...account(await enrollmentBytes()),context:{slot:499n}});await expect(prepareMarketSeat(input())).rejects.toThrow("context");
    mocks.account.mockResolvedValue(account(await enrollmentBytes()));mocks.genesis.mockResolvedValue("wrong");await expect(prepareMarketSeat(input())).rejects.toThrow("genesis");mocks.genesis.mockResolvedValue(runtime.genesisHash);
    for(const patch of [{context:{slot:500n}},{context:{slot:502}},{value:{blockhash:runtime.genesisHash,lastValidBlockHeight:-1n}}]){
      mocks.latest.mockResolvedValue({context:{slot:502n},value:{blockhash:runtime.genesisHash,lastValidBlockHeight:900n},...patch});await expect(prepareMarketSeat(input())).rejects.toThrow();
    }
  });
  it("propagates reader failures, respects abort and wallet changes",async()=>{
    mocks.read.mockRejectedValueOnce(new Error("RPC down"));await expect(prepareMarketSeat(input())).rejects.toThrow("RPC down");
    const controller=new AbortController();controller.abort();await expect(prepareMarketSeat({...input(),signal:controller.signal})).rejects.toThrow();
    const i=input();mocks.genesis.mockImplementationOnce(()=>{i.sender.address=seats;return runtime.genesisHash;});await expect(prepareMarketSeat(i)).rejects.toThrow("Wallet changed");
  });
});
