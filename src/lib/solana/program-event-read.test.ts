import { createHash } from "node:crypto";
import { AccountRole, address, appendTransactionMessageInstructions, blockhash, createTransactionMessage, generateKeyPairSigner,
  getAddressEncoder, getBase64EncodedWireTransaction, getProgramDerivedAddress, getSignatureFromTransaction, pipe, type Address,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";
import { deriveGooseyProgramAddresses } from "./program-client";
import { readFinalizedProgramEvents, type ProgramEventReadRpc } from "./program-event-read";

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
const sha = (s: string) => createHash("sha256").update(s).digest();
// Unit RPC/account/event fixtures only. Signatures use real ephemeral Ed25519
// keys, but no fixture is sent, deployed or claimed to be finalized on a chain.
async function fixture(version: "legacy" | 0 = 0, cpi = false) {
  const signer = await generateKeyPairSigner();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version }),
    m => setTransactionMessageFeePayerSigner(signer,m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 100n },m),
    m => appendTransactionMessageInstructions([{ programAddress: cpi ? TOKEN_PROGRAM_ADDRESS : runtime.programAddress,
      accounts: cpi ? [{ address:runtime.programAddress,role:AccountRole.READONLY }] : [], data: new Uint8Array([1]) }],m)));
  const sig = getSignatureFromTransaction(tx);
  const p = await deriveGooseyProgramAddresses(runtime.programAddress);
  const config = Buffer.alloc(172), mint = Buffer.alloc(82), deployed = Buffer.alloc(36);
  config.set(sha("account:Config").subarray(0,8)); config.set([1,1,p.configBump,p.mintAuthorityBump],8);
  config.set(sha(runtime.genesisHash),12);
  for (const offset of [44,76]) config.set(getAddressEncoder().encode(signer.address),offset);
  config.set(getAddressEncoder().encode(p.featherMint),108);
  for (const offset of [140,148,156,164]) config.writeBigUInt64LE(1000n,offset);
  mint.writeUInt32LE(1); mint.set(getAddressEncoder().encode(p.mintAuthority),4); mint.writeBigUInt64LE(1000n,36); mint[44]=3; mint[45]=1;
  const [programData] = await getProgramDerivedAddress({programAddress:loader,seeds:[getAddressEncoder().encode(runtime.programAddress)]});
  deployed[0]=2; deployed.set(getAddressEncoder().encode(programData),4);
  const account = (bytes: Buffer, owner: Address = runtime.programAddress, executable = false) => ({ owner, executable, data: [bytes.toString("base64"),"base64"] });
  const payload = Buffer.concat([sha("event:ResolutionFinalized").subarray(0,8), Buffer.from(getAddressEncoder().encode(signer.address)), Buffer.from("0100000000000000","hex")]);
  const receipt = { slot: 50n, version, blockTime: 123n as bigint | null, transaction: [getBase64EncodedWireTransaction(tx),"base64"],
    meta: { err: null, fee: 5000n, loadedAddresses: { writable: [], readonly: [] }, preBalances: [10000n,1n], postBalances: [5000n,1n],
      logMessages: [`Program ${runtime.programAddress} invoke [1]`,`Program data: ${payload.toString("base64")}`,`Program ${runtime.programAddress} success`] } };
  const snapshot = { context: { slot: 70n }, value: [account(deployed,loader,true),account(config),account(mint,TOKEN_PROGRAM_ADDRESS)] };
  if (cpi) {
    receipt.meta.preBalances.push(1n); receipt.meta.postBalances.push(1n);
    receipt.meta.logMessages[0]=`Program ${runtime.programAddress} invoke [2]`;
    receipt.meta.logMessages.unshift(`Program ${TOKEN_PROGRAM_ADDRESS} invoke [1]`);
    receipt.meta.logMessages.push(`Program ${TOKEN_PROGRAM_ADDRESS} success`);
  }
  const sends = { genesis: vi.fn().mockResolvedValue(runtime.genesisHash), transaction: vi.fn().mockResolvedValue(receipt),
    slot: vi.fn().mockResolvedValue(60n), accounts: vi.fn().mockResolvedValue(snapshot) };
  const rpc = { getGenesisHash: vi.fn(() => ({ send: sends.genesis })), getTransaction: vi.fn(() => ({ send: sends.transaction })),
    getSlot: vi.fn(() => ({ send: sends.slot })), getMultipleAccounts: vi.fn(() => ({ send: sends.accounts })) };
  const client = rpc as unknown as ProgramEventReadRpc;
  return { receipt, snapshot, p, sig, rpc, client, sends, config, mint,
    run: () => readFinalizedProgramEvents(runtime,sig,{ rpc: client }) };
}
function setPath(target: unknown, path: string, value: unknown) {
  const parts = path.split("."); let parent = target as Record<string,unknown>;
  for (const key of parts.slice(0,-1)) parent = parent[key] as Record<string,unknown>;
  parent[parts.at(-1)!] = value;
}

describe("finalized RPC event ingestion (unit RPC fixtures, not runtime proof)", () => {
  it.each([0,"legacy"] as const)("reads version %s with pinned finalized requests and stable event identity", async version => {
    const f = await fixture(version); const result = await f.run();
    expect(f.rpc.getTransaction).toHaveBeenCalledWith(f.sig,{ commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 });
    expect(f.rpc.getSlot).toHaveBeenCalledWith({ commitment: "finalized" });
    expect(f.rpc.getMultipleAccounts).toHaveBeenCalledWith([runtime.programAddress,f.p.config,f.p.featherMint],{
      encoding: "base64", commitment: "finalized", minContextSlot: 60n });
    expect(result).toMatchObject({ signature:f.sig,slot:50n,configurationSlot:70n,config:f.p.config,
      records:[{ status:"known",event:{ kind:"ResolutionFinalized",residualMilli:1n },eventKey:`${runtime.genesisHash}:${runtime.programAddress}:${f.sig}:1` }] });
    expect((await f.run()).records).toEqual(result.records);
  });
  it("does not treat missing/pruned receipts as success",async () => {
    const f=await fixture(); f.sends.transaction.mockResolvedValue(null); await expect(f.run()).rejects.toThrow(/unavailable/);
    expect(f.rpc.getMultipleAccounts).not.toHaveBeenCalled();
  });
  it.each([
    ["slot",-1n],["slot",50],["slot",1n<<64n],["version",1],["version",undefined],
    ["blockTime",undefined],["blockTime",1n<<63n],["meta",null],["meta.err",{ InstructionError:[0,"failure"] }],
    ["meta.err",undefined],["meta.fee",-1n],["meta.fee",1],["meta.preBalances",[]],["meta.postBalances.0",-1n],
    ["meta.loadedAddresses",null],["meta.loadedAddresses.writable",[TOKEN_PROGRAM_ADDRESS]],
    ["meta.logMessages",null],["meta.logMessages",[]],["meta.logMessages.1","Program data: ???"],
    ["meta.logMessages.2","Log truncated"],["meta.logMessages.1","Program data: //////////8="],
    ["meta.logMessages.2",`Program ${runtime.programAddress} failed: error`],
    ["transaction",null],["transaction.1","json"],["transaction.0","!"],["transaction.0","A".repeat(1648)],
  ])("rejects malformed/failed receipt %s = %s",async (path,value) => {
    const f=await fixture(); setPath(f.receipt,path as string,value); await expect(f.run()).rejects.toThrow();
  });
  it("rejects a valid wire transaction returned under another signature",async () => {
    const f=await fixture(), other=await fixture(); f.receipt.transaction=other.receipt.transaction;
    await expect(f.run()).rejects.toThrow(/signature\/message/);
  });
  it("rejects trailing wire bytes and version mismatch",async () => {
    const f=await fixture(); const original=f.receipt.transaction[0];
    f.receipt.transaction[0]=Buffer.concat([Buffer.from(original,"base64"),Buffer.from([0])]).toString("base64");
    await expect(f.run()).rejects.toThrow(); f.receipt.transaction[0]=original; f.receipt.version="legacy";
    await expect(f.run()).rejects.toThrow(/signature\/message/);
  });
  it.each([49n,-1n,60,1n<<64n])("rejects invalid/stale finalized root %s",async root => {
    const f=await fixture(); f.sends.slot.mockResolvedValue(root); await expect(f.run()).rejects.toThrow();
  });
  it.each([
    ["context.slot",59n],["context.slot",70],["context.slot",1n<<64n],["value",[]],["value.0",null],
    ["value.0.executable",false],["value.0.owner",TOKEN_PROGRAM_ADDRESS],["value.0.data.0","AAAA"],
    ["value.1",null],["value.1.owner",TOKEN_PROGRAM_ADDRESS],["value.1.executable",true],
    ["value.1.data.1","base58"],["value.1.data.0","A".repeat(1000)],["value.2",null],
  ])("rejects snapshot binding/envelope %s",async (path,value) => {
    const f=await fixture(); setPath(f.snapshot,path as string,value); await expect(f.run()).rejects.toThrow();
  });
  it.each([0,8,9,10,11,12,108,156])("uses the real configuration verifier: rejects corruption at %i",async offset => {
    const f=await fixture(); f.config[offset]^=1; f.snapshot.value[1].data[0]=f.config.toString("base64");
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects wrong mint decimals and authority",async () => {
    const f=await fixture(); f.mint[44]=4; f.snapshot.value[2].data[0]=f.mint.toString("base64");
    await expect(f.run()).rejects.toThrow(/mint/);
  });
  it("rejects a noncanonical ProgramData pointer despite a valid loader/discriminant",async () => {
    const f=await fixture(); const bytes=Buffer.from(f.snapshot.value[0].data[0],"base64"); bytes[4]^=1;
    f.snapshot.value[0].data[0]=bytes.toString("base64"); await expect(f.run()).rejects.toThrow(/program-data binding/);
  });
  it("rejects message tampering even when the first signature still matches the request",async () => {
    const f=await fixture(); const wire=Buffer.from(f.receipt.transaction[0],"base64");
    // Final byte is the empty v0 lookup count; preceding byte is instruction data.
    wire[wire.length-2]^=1; f.receipt.transaction[0]=wire.toString("base64");
    await expect(f.run()).rejects.toThrow(/Ed25519/);
  });
  it("accepts a configured-program CPI and ignores other-program data",async () => {
    const f=await fixture(0,true); f.receipt.meta.logMessages.splice(1,0,"Program data: malformed but foreign");
    expect((await f.run()).records).toMatchObject([{ invocationDepth:2,event:{kind:"ResolutionFinalized"} }]);
  });
  it("accepts successful own instructions with no emitted events",async () => {
    const f=await fixture(); f.receipt.meta.logMessages.splice(1,1); f.receipt.blockTime=null;
    expect((await f.run()).records).toEqual([]);
  });
  it("does not turn spoofed application logs into configured-program invocations",async () => {
    const f=await fixture(0,true); f.receipt.meta.logMessages=f.receipt.meta.logMessages.map(line =>
      line.includes(runtime.programAddress) || line.startsWith("Program data:") ? `Program log: ${line}` : line);
    expect(await f.run()).toMatchObject({outcome:"no-program-invocation",records:[]});
  });
  it("rejects oversized logs rather than returning a prefix",async () => {
    const f=await fixture(); f.receipt.meta.logMessages.splice(1,0,"Program log: "+"x".repeat(8192));
    await expect(f.run()).rejects.toThrow(/log/);
  });
  it("honors an abort during RPC even if the injected transport ignores its signal",async () => {
    const f=await fixture(),controller=new AbortController();
    f.sends.transaction.mockImplementation(async () => { controller.abort(); return f.receipt; });
    await expect(readFinalizedProgramEvents(runtime,f.sig,{rpc:f.client,signal:controller.signal})).rejects.toThrow();
    expect(f.rpc.getMultipleAccounts).not.toHaveBeenCalled();
  });
  it("checks the genesis both before and after the read",async () => {
    const f=await fixture(); f.sends.genesis.mockResolvedValueOnce("wrong"); await expect(f.run()).rejects.toThrow(/genesis/);
    expect(f.rpc.getTransaction).not.toHaveBeenCalled();
    f.sends.genesis.mockResolvedValueOnce(runtime.genesisHash).mockResolvedValueOnce("changed");
    await expect(f.run()).rejects.toThrow(/genesis changed/);
  });
  it("captures runtime before RPC awaits and honors abort",async () => {
    const f=await fixture(); const mutable={ ...runtime,programAddress:runtime.programAddress as Address }; const reading=readFinalizedProgramEvents(mutable,f.sig,{rpc:f.client});
    mutable.programAddress=TOKEN_PROGRAM_ADDRESS; mutable.genesisHash="wrong";
    expect((await reading).programAddress).toBe(runtime.programAddress);
    const controller=new AbortController(); controller.abort();
    await expect(readFinalizedProgramEvents(runtime,f.sig,{rpc:f.client,signal:controller.signal})).rejects.toThrow();
  });
  it("propagates RPC timeout/failure without returning partial records",async () => {
    const f=await fixture(); f.sends.accounts.mockRejectedValue(new Error("RPC timeout")); await expect(f.run()).rejects.toThrow(/timeout/);
  });
  it("rejects invalid runtime/signature before network calls",async () => {
    const f=await fixture();
    await expect(readFinalizedProgramEvents({...runtime,rpcUrl:"https://example.com"},f.sig,{rpc:f.client})).rejects.toThrow();
    await expect(readFinalizedProgramEvents(runtime,"bad",{rpc:f.client})).rejects.toThrow();
    expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it("returns a typed failed receipt with zero rolled-back events and stable identity",async () => {
    const f=await fixture(); setPath(f.receipt,"meta.err",{InstructionError:[0,{Custom:6001}]});
    f.receipt.meta.logMessages[2]=`Program ${runtime.programAddress} failed: custom program error: 0x1771`;
    const result=await f.run();
    expect(result).toMatchObject({outcome:"failed",records:[],signature:f.sig,slot:50n,configurationSlot:70n});
    expect(f.rpc.getMultipleAccounts).toHaveBeenCalledTimes(1); expect(f.sends.genesis).toHaveBeenCalledTimes(2);
    expect(await f.run()).toEqual(result);
  });
  it("returns no-program-invocation for a loaded but unused program",async () => {
    const f=await fixture(0,true); f.receipt.meta.logMessages=[`Program ${TOKEN_PROGRAM_ADDRESS} invoke [1]`,`Program ${TOKEN_PROGRAM_ADDRESS} success`];
    expect(await f.run()).toMatchObject({outcome:"no-program-invocation",records:[]});
    expect(f.rpc.getMultipleAccounts).toHaveBeenCalledTimes(1); expect(f.sends.genesis).toHaveBeenCalledTimes(2);
  });
  it("distinguishes successful zero-event invocation from no invocation",async () => {
    const f=await fixture(); f.receipt.meta.logMessages.splice(1,1);
    expect(await f.run()).toMatchObject({outcome:"success",records:[]});
  });
  it.each(["failed","no-program-invocation"] as const)("retains all domain/finality/signature checks for %s",async outcome => {
    for (const corruption of ["signature","root","config","genesis"] as const) {
      const f=await fixture(0,true);
      if(outcome==="failed") {
        setPath(f.receipt,"meta.err",{InstructionError:[0,"InvalidArgument"]});
        f.receipt.meta.logMessages=[`Program ${TOKEN_PROGRAM_ADDRESS} invoke [1]`,`Program ${TOKEN_PROGRAM_ADDRESS} failed: invalid argument`];
      } else f.receipt.meta.logMessages=[`Program ${TOKEN_PROGRAM_ADDRESS} invoke [1]`,`Program ${TOKEN_PROGRAM_ADDRESS} success`];
      if(corruption==="signature") {const bytes=Buffer.from(f.receipt.transaction[0],"base64");bytes[bytes.length-2]^=1;f.receipt.transaction[0]=bytes.toString("base64");}
      if(corruption==="root") f.sends.slot.mockResolvedValue(49n);
      if(corruption==="config") f.snapshot.value[1].executable=true;
      if(corruption==="genesis") f.sends.genesis.mockResolvedValueOnce(runtime.genesisHash).mockResolvedValueOnce("wrong");
      await expect(f.run()).rejects.toThrow();
    }
  });
  it.each([null,[],["Log truncated"],[`Program ${runtime.programAddress} invoke [1]`],
    [`Program ${runtime.programAddress} invoke [1]`,"Program data: ???",`Program ${runtime.programAddress} failed: error`]])("failed malformed/incomplete logs remain nonterminal %j",async logs => {
    const f=await fixture();setPath(f.receipt,"meta.err",{InstructionError:[0,{Custom:6001}]});setPath(f.receipt,"meta.logMessages",logs);
    await expect(f.run()).rejects.toThrow();
  });
  it.each([false,{},"UnknownFutureError",{InstructionError:[1,"InvalidArgument"]},{InstructionError:[0,{Custom:-1}]},
    {InstructionError:[0,"invented"]},{InstructionError:[0,{Custom:2**32}]},{InstructionError:[0,{Custom:1,extra:1}]}])("rejects malformed or unsupported error variant %j",async err => {
    const f=await fixture();setPath(f.receipt,"meta.err",err);f.receipt.meta.logMessages[2]=`Program ${runtime.programAddress} failed: error`;
    await expect(f.run()).rejects.toThrow(/status/);
  });
  it("supports known pre-execution failure without manufacturing invocation logs",async () => {
    const f=await fixture();setPath(f.receipt,"meta.err","InsufficientFundsForFee");f.receipt.meta.logMessages=[];
    expect(await f.run()).toMatchObject({outcome:"failed",records:[]});
  });
});
