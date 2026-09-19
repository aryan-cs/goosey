import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buildPublicBrowserRuntime, parsePublicBrowserRuntime } from "./browser-runtime";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, type SolanaRuntime } from "./runtime";
const runtime:SolanaRuntime={cluster:"localnet",rpcUrl:"https://private.example/SECRET?api-key=SECRET",
  programAddress:address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),genesisHash:"Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm"};
const env={GOOSEY_SOLANA_BROWSER_ENABLED:"true",GOOSEY_SOLANA_PUBLIC_RPC_URL:"http://127.0.0.1:18999"};
// Public JSON contract fixtures only; not live deployment/account evidence.
function payload() {
  return {status:"foundation_verified",financialBackend:"database",exchangeVerified:false,cluster:runtime.cluster,
    genesisHash:runtime.genesisHash,programAddress:runtime.programAddress,configAddress:runtime.programAddress,featherMint:runtime.programAddress,
    decimals:3,finalizedSlot:"9007199254740993",checkedAt:"2026-09-19T12:00:00.000Z",supplyBaseUnits:"9",lifetimeMintedBaseUnits:"10",
    lifetimeAuthorizedBaseUnits:"11",campaignCapBaseUnits:"12",currency:{name:"feathers",purchasable:false,cashRedeemable:false},
    browserRuntime:buildPublicBrowserRuntime(runtime,env)};
}
describe("public browser runtime contract (pure JSON/config tests)",()=>{
  it("publishes only an explicit public URL and bound chain fields",()=>{
    const capability=buildPublicBrowserRuntime(runtime,env);
    expect(capability).toEqual({version:1,enabled:true,cluster:"localnet",genesisHash:runtime.genesisHash,programAddress:runtime.programAddress,
      publicRpcUrl:"http://127.0.0.1:18999/",endpointVerified:false});
    expect(JSON.stringify(capability)).not.toContain("SECRET");expect(Object.isFrozen(capability)).toBe(true);
  });
  it("never accesses the private RPC, even through a getter",()=>{
    const guarded={...runtime,get rpcUrl():string {throw new Error("private URL accessed");}};
    expect(buildPublicBrowserRuntime(guarded,env).enabled).toBe(true);
    expect(buildPublicBrowserRuntime(guarded,{})).toEqual({version:1,enabled:false});
  });
  it("disabled is default even when a public URL exists",()=>{
    expect(buildPublicBrowserRuntime(runtime,{GOOSEY_SOLANA_PUBLIC_RPC_URL:env.GOOSEY_SOLANA_PUBLIC_RPC_URL})).toEqual({version:1,enabled:false});
    expect(buildPublicBrowserRuntime(runtime,{...env,GOOSEY_SOLANA_BROWSER_ENABLED:"false"})).toEqual({version:1,enabled:false});
  });
  it.each([undefined,"", "http://user:SECRET@localhost:18999", "http://localhost:18999/?key=SECRET", "http://localhost:18999/#SECRET",
    "http://localhost:18999/?", "http://localhost:18999/#", "http://evil.example/", "http://localhost.evil.example/", "file:///tmp/rpc",
    " http://localhost:18999", "http://local\nhost:18999", "http://localhost:18999/%0aSECRET", "http:\\localhost:18999", "x".repeat(2049)])("rejects missing/unsafe public endpoint without secret-bearing errors",url=>{
    try {buildPublicBrowserRuntime(runtime,{...env,GOOSEY_SOLANA_PUBLIC_RPC_URL:url});throw new Error("unexpected success");}
    catch(error){expect((error as Error).message).toBe("Invalid public Solana runtime configuration");}
  });
  it.each(["1","TRUE","", "yes"])("requires exact explicit capability flag %s",flag=>{
    expect(()=>buildPublicBrowserRuntime(runtime,{...env,GOOSEY_SOLANA_BROWSER_ENABLED:flag})).toThrow();
  });
  it.each(["http://localhost:18999/public/path", "https://127.0.0.1:18999/", "http://[::1]:18999/"])("allows local loopback and operator-declared public path %s",url=>{
    expect(buildPublicBrowserRuntime(runtime,{...env,GOOSEY_SOLANA_PUBLIC_RPC_URL:url})).toMatchObject({publicRpcUrl:url,endpointVerified:false});
  });
  it("accepts full devnet pin with explicitly public HTTPS path, not HTTP",()=>{
    const devnet={...runtime,cluster:"devnet" as const,genesisHash:DEVNET_GENESIS_HASH};
    expect(buildPublicBrowserRuntime(devnet,{...env,GOOSEY_SOLANA_PUBLIC_RPC_URL:"https://rpc.example/public-routing"})).toMatchObject({cluster:"devnet",endpointVerified:false});
    expect(()=>buildPublicBrowserRuntime(devnet,{...env,GOOSEY_SOLANA_PUBLIC_RPC_URL:"http://rpc.example/"})).toThrow();
  });
  it.each([MAINNET_GENESIS_HASH,TESTNET_GENESIS_HASH,DEVNET_GENESIS_HASH,"EtWTRABZaYq6iMfeYKouRu166VU2xqa1","bad"])("rejects wrong/truncated local chain domain %s",genesisHash=>{
    expect(()=>buildPublicBrowserRuntime({...runtime,genesisHash},env)).toThrow();
  });
  it("parses only explicitly enabled matching foundation status into public runtime",()=>{
    const result=parsePublicBrowserRuntime(payload());expect(result).toEqual({...runtime,rpcUrl:"http://127.0.0.1:18999/"});expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it.each(["disabled","unavailable","foundation_verified"])("returns null for absent/disabled capability (%s)",status=>{
    const base={status,financialBackend:"database",exchangeVerified:false};
    expect(parsePublicBrowserRuntime(base)).toBeNull();expect(parsePublicBrowserRuntime({...base,browserRuntime:{version:1,enabled:false}})).toBeNull();
  });
  it.each([
    ["status","disabled"],["status","unavailable"],["status","ready"],["financialBackend","solana"],["exchangeVerified",true],
    ["cluster","devnet"],["genesisHash",DEVNET_GENESIS_HASH],["programAddress","11111111111111111111111111111111"],
    ["decimals",6],["configAddress","bad"],["featherMint","bad"],["finalizedSlot",1],["finalizedSlot","01"],["finalizedSlot",(1n<<64n).toString()],
    ["checkedAt","yesterday"],["checkedAt","2026-02-30T12:00:00.000Z"],["supplyBaseUnits","11"],["lifetimeMintedBaseUnits","12"],
    ["lifetimeAuthorizedBaseUnits","13"],["campaignCapBaseUnits","0"],["currency",{name:"feathers",purchasable:true,cashRedeemable:false}],
  ])("rejects contradictory/malformed public status %s",(field,value)=>{
    expect(()=>parsePublicBrowserRuntime({...payload(),[field]:value})).toThrow();
  });
  it.each([{version:2},{enabled:"true"},{endpointVerified:true},{publicRpcUrl:runtime.rpcUrl},{rpcUrl:runtime.rpcUrl},
    {genesisHash:DEVNET_GENESIS_HASH},{programAddress:"bad"},{cluster:"mainnet"}])("rejects malformed or unbound capability",patch=>{
    const data=payload();expect(()=>parsePublicBrowserRuntime({...data,browserRuntime:{...data.browserRuntime,...patch}})).toThrow();
  });
  it("does not use an injected top-level private rpcUrl",()=>{
    expect(parsePublicBrowserRuntime({...payload(),rpcUrl:runtime.rpcUrl})?.rpcUrl).toBe("http://127.0.0.1:18999/");
    expect(parsePublicBrowserRuntime({...payload(),browserRuntime:undefined,rpcUrl:runtime.rpcUrl})).toBeNull();
  });
  it("rejects hidden fields even in a disabled capability",()=>{
    expect(()=>parsePublicBrowserRuntime({...payload(),browserRuntime:{version:1,enabled:false,publicRpcUrl:runtime.rpcUrl}})).toThrow();
  });
  it.each([null,[],1,"bad"])("rejects malformed payload %s",input=>{expect(()=>parsePublicBrowserRuntime(input)).toThrow();});
});
