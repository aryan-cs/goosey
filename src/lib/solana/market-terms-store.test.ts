import { mkdtemp, rm, readdir, readFile, writeFile, chmod, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeMarketTerms, hashMarketTerms, MARKET_TERMS_MAX_BYTES, type MarketTerms } from "./market-terms";
import { retainMarketTerms, readRetainedMarketTerms, MarketTermsRetentionConflict, type RetainedMarketTermsExpectation } from "./market-terms-store";

// Explicitly offline manifest fixtures, retained only in private test directories.
// No live market content, RPC, chain sends, or production retention is fabricated.
let manifest:MarketTerms;
beforeAll(async()=>{
  const program=address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),enc=getAddressEncoder();
  const pda=async(seeds:Parameters<typeof getProgramDerivedAddress>[0]["seeds"])=>(await getProgramDerivedAddress({programAddress:program,seeds}))[0];
  const config=await pda(["config"]),id=new Uint8Array(8);id[0]=7;
  const wallet=(n:number)=>getAddressDecoder().decode(new Uint8Array(32).fill(n));
  const reviewer=async(n:number)=>({wallet:wallet(n),enrollment:await pda(["enrollment",enc.encode(config),enc.encode(wallet(n))])});
  manifest={version:1,binding:{cluster:"localnet",genesisHash:"Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",program,config,
    market:await pda(["market",enc.encode(config),id]),marketId:"7",creator:wallet(1),featherMint:await pda(["feather_mint",enc.encode(config)])},
    question:"Offline storage test: is the specified integer positive?",
    rules:{yes:"YES if the specified test integer is positive.",no:"NO if the specified test integer is nonpositive.",void:"VOID if the integer is absent."},
    observation:{startsAt:"100",endsAt:"200",timezone:"UTC"},sources:[{id:"test",uri:"https://example.invalid/offline",selection:"Offline fixture record only.",snapshotSha256:null}],
    sourcePolicy:{priority:"array-order-first-authoritative",missing:"Apply the explicit VOID rule.",revisions:"Use the record as of timestamp 200."},
    economics:{payoutMilli:"1000",feeBps:"100",closesAt:"150",resolvesAt:"220",decimals:3},
    oracle:{kind:"two-reviewer-no-fallback-v1",proposer:await reviewer(2),approver:await reviewer(3),unavailable:"wait-for-designated-reviewers",replacement:"none",automaticVoid:false}};
});
const owned:string[]=[];
afterEach(async()=>{for(const dir of owned.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(value=structuredClone(manifest)) {
  const root=await mkdtemp(path.join(tmpdir(),"goosey-terms-store-test-"));owned.push(root);await chmod(root,0o700);
  const bytes=encodeMarketTerms(value),expected:RetainedMarketTermsExpectation={digest:await hashMarketTerms(bytes),manifestLength:bytes.length,
    binding:value.binding,economics:value.economics,proposer:value.oracle.proposer,approver:value.oracle.approver};
  return {root,bytes,expected};
}
describe("immutable canonical terms retention (real temporary filesystem; offline content)",()=>{
  it("retains exact UTF8 bytes durably and retrieves verified content",async()=>{
    const f=await fixture();expect(await retainMarketTerms(f.root,f.bytes,f.expected)).toMatchObject({created:true,digest:f.expected.digest});
    const stored=await readRetainedMarketTerms(f.root,f.expected);expect(stored.bytes).toEqual(f.bytes);expect(stored.terms).toEqual(manifest);
    const files=await readdir(f.root);expect(files).toHaveLength(1);expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await stat(path.join(f.root,files[0]))).mode&0o777).toBe(0o444);
    expect(await readFile(path.join(f.root,files[0]))).toEqual(Buffer.from(f.bytes));
  });
  it("is idempotent and creates no leftover staging files",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);
    expect((await retainMarketTerms(f.root,f.bytes,f.expected)).created).toBe(false);expect(await readdir(f.root)).toHaveLength(1);
  });
  it("arbitrates concurrent identical writers without exposing partial final files",async()=>{
    const f=await fixture();const results=await Promise.all(Array.from({length:8},()=>retainMarketTerms(f.root,f.bytes,f.expected)));
    expect(results.filter(r=>r.created)).toHaveLength(1);expect((await readRetainedMarketTerms(f.root,f.expected)).bytes).toEqual(f.bytes);
    expect(await readdir(f.root)).toHaveLength(1);
  });
  it("rejects different valid content for the same market without overwriting",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);
    const changed=structuredClone(manifest);changed.question="Different offline storage test question?";
    const bytes=encodeMarketTerms(changed),expected={...f.expected,digest:await hashMarketTerms(bytes),manifestLength:bytes.length};
    await expect(retainMarketTerms(f.root,bytes,expected)).rejects.toBeInstanceOf(MarketTermsRetentionConflict);
    expect((await readRetainedMarketTerms(f.root,f.expected)).bytes).toEqual(f.bytes);expect(await readdir(f.root)).toHaveLength(1);
  });
  it("captures mutable input and expected bindings before awaiting",async()=>{
    const f=await fixture(),original=new Uint8Array(f.bytes),expected=structuredClone(f.expected);
    const pending=retainMarketTerms(f.root,f.bytes,f.expected);f.bytes.fill(0);f.expected.binding.genesisHash="bad";
    await pending;expect((await readRetainedMarketTerms(f.root,expected)).bytes).toEqual(original);
  });
  it.each(["digest","length","genesis","program","economics","reviewer"])("rejects mismatched expected %s before publishing",async field=>{
    const f=await fixture();
    if(field==="digest")f.expected.digest="ab".repeat(32);
    if(field==="length")f.expected.manifestLength++;
    if(field==="genesis")f.expected.binding.genesisHash="11111111111111111111111111111111";
    if(field==="program")f.expected.binding.program=f.expected.binding.creator;
    if(field==="economics")f.expected.economics.feeBps="101";
    if(field==="reviewer")f.expected.approver.wallet=f.expected.binding.creator;
    await expect(retainMarketTerms(f.root,f.bytes,f.expected)).rejects.toThrow();expect(await readdir(f.root)).toEqual([]);
  });
  it.each([new Uint8Array(),new Uint8Array([0xff]),new Uint8Array(MARKET_TERMS_MAX_BYTES+1)])("rejects empty/invalid/oversized bytes",async bytes=>{
    const f=await fixture();await expect(retainMarketTerms(f.root,bytes,f.expected)).rejects.toThrow();expect(await readdir(f.root)).toEqual([]);
  });
  it("rejects alternate JSON formatting, never silently recanonicalizes storage",async()=>{
    const f=await fixture();const bytes=new TextEncoder().encode(JSON.stringify(manifest,null,2));
    await expect(retainMarketTerms(f.root,bytes,{...f.expected,manifestLength:bytes.length})).rejects.toThrow(/Noncanonical/);
  });
  it("rejects tampered files on reads rather than trusting a filename",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);const file=path.join(f.root,(await readdir(f.root))[0]);
    await chmod(file,0o600);await writeFile(file," "+new TextDecoder().decode(f.bytes));
    await expect(readRetainedMarketTerms(f.root,f.expected)).rejects.toThrow();
  });
  it("bounds disk reads and rejects oversized files",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);const file=path.join(f.root,(await readdir(f.root))[0]);
    await chmod(file,0o600);await writeFile(file,Buffer.alloc(MARKET_TERMS_MAX_BYTES+1));
    await expect(readRetainedMarketTerms(f.root,f.expected)).rejects.toThrow(/size/);
  });
  it("rejects symlink leaves for both retrieval and idempotent writes",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);const file=path.join(f.root,(await readdir(f.root))[0]);
    const other=await fixture();const target=path.join(other.root,"bytes");await writeFile(target,f.bytes);await rm(file);await symlink(target,file);
    await expect(readRetainedMarketTerms(f.root,f.expected)).rejects.toThrow();await expect(retainMarketTerms(f.root,f.bytes,f.expected)).rejects.toThrow();
    expect(await readFile(target)).toEqual(Buffer.from(f.bytes));
  });
  it("rejects symlink/public roots and never creates missing directories",async()=>{
    const f=await fixture(),other=await fixture(),alias=path.join(other.root,"alias");await symlink(f.root,alias);
    for(const root of [alias,"relative",path.join(f.root,"missing"),path.parse(f.root).root])await expect(retainMarketTerms(root,f.bytes,f.expected)).rejects.toThrow();
    await chmod(f.root,0o755);await expect(retainMarketTerms(f.root,f.bytes,f.expected)).rejects.toThrow(/private/);
  });
  it("does not mistake leftover staging data for published content",async()=>{
    const f=await fixture();await writeFile(path.join(f.root,".terms-crash.pending"),f.bytes);
    await expect(readRetainedMarketTerms(f.root,f.expected)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("keeps independent genesis domains separate even for identical market PDA",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);
    const terms=structuredClone(manifest);terms.binding.genesisHash="AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE";
    const bytes=encodeMarketTerms(terms),expected={...f.expected,binding:terms.binding,digest:await hashMarketTerms(bytes),manifestLength:bytes.length};
    expect((await retainMarketTerms(f.root,bytes,expected)).created).toBe(true);expect(await readdir(f.root)).toHaveLength(2);
    expect((await readRetainedMarketTerms(f.root,f.expected)).bytes).toEqual(f.bytes);
    expect((await readRetainedMarketTerms(f.root,expected)).bytes).toEqual(bytes);
  });
  it("revalidates retrieval economics/reviewers/digest against caller chain expectation",async()=>{
    const f=await fixture();await retainMarketTerms(f.root,f.bytes,f.expected);
    for(const expected of [{...f.expected,digest:"ab".repeat(32)},{...f.expected,economics:{...f.expected.economics,feeBps:"102"}},
      {...f.expected,approver:{...f.expected.approver,wallet:f.expected.binding.creator}}]) {
      await expect(readRetainedMarketTerms(f.root,expected)).rejects.toThrow();
    }
  });
  it("allows exactly one concurrent conflicting publication and preserves the winner",async()=>{
    const f=await fixture(),changed=structuredClone(manifest);changed.question="Different competing offline test manifest?";
    const bytes=encodeMarketTerms(changed),expected={...f.expected,digest:await hashMarketTerms(bytes),manifestLength:bytes.length};
    const results=await Promise.allSettled([retainMarketTerms(f.root,f.bytes,f.expected),retainMarketTerms(f.root,bytes,expected)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const loser=results.find(r=>r.status==="rejected");expect(loser && loser.status==="rejected" && loser.reason).toBeInstanceOf(MarketTermsRetentionConflict);
    const won=results[0].status==="fulfilled"?f.expected:expected;
    expect((await readRetainedMarketTerms(f.root,won)).digest).toBe(won.digest);expect(await readdir(f.root)).toHaveLength(1);
  });
});
