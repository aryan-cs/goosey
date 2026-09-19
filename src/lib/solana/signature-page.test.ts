import { address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { readFinalizedSignaturePage, SignatureHistoryGapError, type SignaturePageInput, type SignaturePageRpc } from "./signature-page";
const runtime = { cluster:"localnet" as const,rpcUrl:"http://127.0.0.1:18999",
  programAddress:address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),genesisHash:"Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
// Mocked RPC discovery fixtures only. These encoded identifiers are not signed
// transactions or evidence of live/finalized chain history.
const sig = (n:number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
const row = (n:number,slot=BigInt(100-n)) => ({signature:sig(n),slot,confirmationStatus:"finalized",blockTime:1n,memo:null,err:null});
function fixture(page:unknown = [row(1),row(2),row(3)]) {
  const sends={genesis:vi.fn().mockResolvedValue(runtime.genesisHash),root:vi.fn().mockResolvedValue(100n),page:vi.fn().mockResolvedValue(page)};
  const rpc={getGenesisHash:vi.fn(()=>({send:sends.genesis})),getSlot:vi.fn(()=>({send:sends.root})),getSignaturesForAddress:vi.fn(()=>({send:sends.page}))};
  const client=rpc as unknown as SignaturePageRpc;
  const input:SignaturePageInput={targetSignature:sig(3),includeTarget:false};
  return {sends,rpc,client,input,run:(overrides:Partial<SignaturePageInput>={})=>readFinalizedSignaturePage(runtime,{...input,...overrides},{rpc:client})};
}
describe("finalized signature pagination (mocked RPC only)",()=>{
  it("requests exact finalized/default25 page without hiding target using until",async()=>{
    const f=fixture();const result=await f.run();
    expect(f.rpc.getSignaturesForAddress).toHaveBeenCalledWith(runtime.programAddress,{commitment:"finalized",limit:25,minContextSlot:100n});
    expect(f.rpc.getSlot).toHaveBeenCalledTimes(2);expect(f.rpc.getSlot).toHaveBeenCalledWith({commitment:"finalized"});
    expect(f.sends.genesis).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({entries:[{signature:sig(1),slot:99n},{signature:sig(2),slot:98n}],firstPageNewestSignature:sig(1),nextBefore:null,reachedTarget:true,finalizedRoot:100n});
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.entries)).toBe(true);expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
  it("includes explicit initial coverage boundary and excludes entries older than it",async()=>{
    const f=fixture([row(1),row(2),row(3),row(4)]);
    expect((await f.run({includeTarget:true})).entries.map(e=>e.signature)).toEqual([sig(1),sig(2),sig(3)]);
  });
  it("handles target at newest entry without losing the frozen head",async()=>{
    const f=fixture([row(3)]);expect(await f.run()).toMatchObject({entries:[],firstPageNewestSignature:sig(3),nextBefore:null,reachedTarget:true});
    expect((await f.run({includeTarget:true})).entries).toHaveLength(1);
  });
  it("returns continuation cursor only for a full unterminated page",async()=>{
    const f=fixture([row(1),row(2)]);
    expect(await f.run({limit:2})).toMatchObject({reachedTarget:false,nextBefore:sig(2),firstPageNewestSignature:sig(1)});
  });
  it("does not replace frozen first-page head on continuation",async()=>{
    const f=fixture([row(2),row(3)]);
    expect(await f.run({before:sig(1),beforeSlot:99n,minContextSlot:90n})).toMatchObject({firstPageNewestSignature:null,reachedTarget:true});
    expect(f.rpc.getSignaturesForAddress).toHaveBeenCalledWith(runtime.programAddress,expect.objectContaining({before:sig(1),minContextSlot:100n}));
  });
  it("preserves RPC traversal order within a slot, without claiming execution order",async()=>{
    const f=fixture([row(2,90n),row(1,90n),row(3,90n)]);
    expect((await f.run()).entries.map(e=>e.signature)).toEqual([sig(2),sig(1)]);
  });
  it.each([[],[row(1)]].map(page=>({page})))("reports short/empty history as typed gap, not completion",async({page})=>{
    const f=fixture(page);await expect(f.run()).rejects.toBeInstanceOf(SignatureHistoryGapError);
    await expect(f.run()).rejects.toMatchObject({code:"SIGNATURE_HISTORY_GAP",targetSignature:sig(3)});
  });
  it("supports bounded limit100 and target at full-page last position",async()=>{
    const f=fixture(Array.from({length:100},(_,i)=>row(i+1,1n)));
    expect((await f.run({limit:100,targetSignature:sig(100),includeTarget:true})).entries).toHaveLength(100);
  });
  it.each([0,101,-1,1.5,NaN,Infinity])("rejects invalid limit %s before network",async limit=>{
    const f=fixture();await expect(f.run({limit})).rejects.toThrow();expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it.each([{targetSignature:"bad"},{before:"bad"},{before:sig(3)},{includeTarget:undefined},{minContextSlot:-1n},{beforeSlot:99n}])("rejects invalid boundary/cursor",async overrides=>{
    const f=fixture();await expect(f.run(overrides)).rejects.toThrow();expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it.each([
    [row(1),row(1),row(3)], [row(1,80n),row(2,81n),row(3)],
    [row(1),row(3),row(3)], // Even invalid rows beyond the target cannot be ignored.
  ].map(page=>({page})))("rejects duplicates and increasing slots",async({page})=>{await expect(fixture(page).run()).rejects.toThrow();});
  it("rejects a repeated before cursor anywhere in page",async()=>{
    await expect(fixture([row(2),row(1,97n),row(3,96n)]).run({before:sig(1)})).rejects.toThrow(/cursor/);
  });
  it("enforces optional previous-page oldest slot",async()=>{
    await expect(fixture().run({before:sig(4),beforeSlot:98n})).rejects.toThrow(/nonincreasing/);
  });
  it.each([
    ["signature","bad"],["slot",1],["slot",-1n],["slot",1n<<64n],["confirmationStatus","confirmed"],
    ["confirmationStatus",null],["blockTime",undefined],["blockTime",1],["memo","é".repeat(600)],
    ["memo",1],["err",undefined],["err",false],["err","x".repeat(257)],["err",{a:{a:{a:{a:{a:1}}}}}],
  ])("rejects malformed row %s",async(field,value)=>{
    const first={...row(1),[field as string]:value};await expect(fixture([first,row(3)]).run()).rejects.toThrow();
  });
  it("does not filter failed signatures or trust status as receipt evidence",async()=>{
    const f=fixture([{...row(1),err:{InstructionError:[0,{Custom:6001}]},memo:"test"},row(3)]);
    expect((await f.run()).entries).toEqual([{signature:sig(1),slot:99n}]);
  });
  it.each([null,{},[...Array.from({length:26},(_,i)=>row(i+1,1n))]].map(page=>({page})))("rejects invalid or excessive response",async({page})=>{
    await expect(fixture(page).run()).rejects.toThrow();
  });
  it("allows root advancement during fetch but never slots beyond the post root",async()=>{
    const f=fixture([row(1,101n),row(3,100n)]);f.sends.root.mockResolvedValueOnce(100n).mockResolvedValueOnce(101n);
    expect((await f.run()).finalizedRoot).toBe(101n);
    await expect(f.run()).rejects.toThrow(/root/);
  });
  it.each([99n,-1n,100,1n<<64n])("rejects regressing/malformed post root %s",async root=>{
    const f=fixture();f.sends.root.mockResolvedValueOnce(100n).mockResolvedValueOnce(root);await expect(f.run()).rejects.toThrow();
  });
  it("refuses a node behind the previous page context floor",async()=>{
    const f=fixture();await expect(f.run({minContextSlot:101n})).rejects.toThrow(/floor/);expect(f.rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it("checks genesis before and after page read",async()=>{
    const f=fixture();f.sends.genesis.mockResolvedValueOnce("wrong");await expect(f.run()).rejects.toThrow(/genesis/);expect(f.rpc.getSignaturesForAddress).not.toHaveBeenCalled();
    f.sends.genesis.mockResolvedValueOnce(runtime.genesisHash).mockResolvedValueOnce("changed");await expect(f.run()).rejects.toThrow(/genesis changed/);
  });
  it("captures runtime and inputs before awaiting",async()=>{
    const f=fixture(),mutable={...runtime},input={...f.input};const pending=readFinalizedSignaturePage(mutable,input,{rpc:f.client});
    mutable.genesisHash="wrong";input.targetSignature=sig(1);input.includeTarget=true;
    expect((await pending).entries).toHaveLength(2);
  });
  it("propagates cancellation/timeouts without returning a cursor",async()=>{
    const f=fixture(),controller=new AbortController();controller.abort();
    await expect(readFinalizedSignaturePage(runtime,f.input,{rpc:f.client,signal:controller.signal})).rejects.toThrow();
    expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
    f.sends.page.mockRejectedValue(new Error("timeout"));await expect(f.run()).rejects.toThrow(/timeout/);
  });
  it("requires an explicit pin even when devnet has a shared default",async()=>{
    const f=fixture();await expect(readFinalizedSignaturePage({...runtime,cluster:"devnet",rpcUrl:"https://api.devnet.solana.com",genesisHash:""},f.input,{rpc:f.client})).rejects.toThrow(/pin/);
    expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it("rejects runtime null limit instead of silently selecting the default",async()=>{
    await expect(fixture().run({limit:null as unknown as number})).rejects.toThrow(/limit/);
  });
});
