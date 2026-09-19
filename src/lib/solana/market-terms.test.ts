import { createHash } from "node:crypto";
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "./runtime";
import { decodeMarketTerms, encodeMarketTerms, hashMarketTerms, verifyMarketTerms,
  MARKET_TERMS_HASH_DOMAIN, MARKET_TERMS_MAX_BYTES, type MarketTerms } from "./market-terms";

// Offline codec fixtures only. No deployment, wallet funding, RPC, or live content.
let fixture: MarketTerms;
const utf8 = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
beforeAll(async () => {
  const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), enc = getAddressEncoder();
  const pda = async (seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
  const config = await pda(["config"]), id = new Uint8Array(8); id[0] = 7;
  const wallet = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
  const reviewer = async (n: number) => ({ wallet: wallet(n), enrollment: await pda(["enrollment", enc.encode(config), enc.encode(wallet(n))]) });
  fixture = { version: 1, binding: { cluster: "localnet", genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm", program, config,
    market: await pda(["market", enc.encode(config), id]), marketId: "7", creator: wallet(1), featherMint: await pda(["feather_mint", enc.encode(config)]) },
    question: "Offline codec test: is the published integer at least 10?",
    rules: { yes: "YES if the selected record is an integer greater than or equal to 10.",
      no: "NO if the selected record is an integer less than 10.", void: "VOID if no valid integer is available by the resolution deadline." },
    observation: { startsAt: "100", endsAt: "200", timezone: "UTC" },
    sources: [{ id: "primary", uri: "https://example.invalid/record", selection: "Select the record timestamped 200; this is an offline test specification.", snapshotSha256: null }],
    sourcePolicy: { priority: "array-order-first-authoritative", missing: "Absent records are unavailable; apply the stated VOID criterion.", revisions: "Use the latest revision published no later than 220." },
    economics: { payoutMilli: "1000", feeBps: "100", closesAt: "150", resolvesAt: "220", decimals: 3 },
    oracle: { kind: "two-reviewer-no-fallback-v1", proposer: await reviewer(2), approver: await reviewer(3),
      unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false } };
});
const fresh = () => structuredClone(fixture);
const expected = async (value = fixture) => ({ digest: await hashMarketTerms(encodeMarketTerms(value)), binding: value.binding,
  economics: value.economics, proposer: value.oracle.proposer, approver: value.oracle.approver });

describe("canonical market terms (offline unit proof only)", () => {
  it("accepts full devnet and rejects truncated pins/full mainnet for either cluster", async () => {
    const value = fresh(); value.binding.cluster = "devnet"; value.binding.genesisHash = DEVNET_GENESIS_HASH;
    await expect(verifyMarketTerms(encodeMarketTerms(value), await expected(value))).resolves.toEqual(value);
    for (const cluster of ["localnet", "devnet"] as const) {
      for (const genesisHash of [DEVNET_GENESIS_HASH.slice(0, 32), MAINNET_GENESIS_HASH.slice(0, 32), MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH]) {
        const bad = fresh(); bad.binding = { ...bad.binding, cluster, genesisHash };
        expect(() => encodeMarketTerms(bad)).toThrow();
      }
    }
  });
  it("roundtrips and verifies all PDA/economic/reviewer bindings", async () => {
    const bytes = encodeMarketTerms(fixture);
    expect(decodeMarketTerms(bytes)).toEqual(fixture);
    expect(await verifyMarketTerms(bytes, await expected())).toEqual(fixture);
  });
  it("is independent of input object key insertion order", () => {
    expect(encodeMarketTerms(Object.fromEntries(Object.entries(fixture).reverse()))).toEqual(encodeMarketTerms(fixture));
  });
  it("matches independent Node SHA-256 with an exact NUL-terminated domain", async () => {
    const bytes = encodeMarketTerms(fixture);
    expect(MARKET_TERMS_HASH_DOMAIN).toBe("goosey:market-terms:sha256:v1\0");
    expect(await hashMarketTerms(bytes)).toBe(createHash("sha256").update("goosey:market-terms:sha256:v1\0", "utf8").update(bytes).digest("hex"));
    expect(await hashMarketTerms(bytes)).not.toBe(createHash("sha256").update(bytes).digest("hex"));
  });
  it.each(["", " ", "\ufeff", "\n"])("rejects noncanonical prefix %j", prefix => {
    const bytes = encodeMarketTerms(fixture);
    if (!prefix) expect(() => decodeMarketTerms(bytes.slice(0, -1))).toThrow();
    else expect(() => decodeMarketTerms(utf8(prefix + str(bytes)))).toThrow();
  });
  it.each([
    (s: string) => s + "\n", (s: string) => s.replace('"version":1', '"version":1,"version":1'),
    (s: string) => s.replace('"version":1', '"version":1.0'), (s: string) => s.replace('"question"', '"\\u0071uestion"'),
    (s: string) => JSON.stringify(JSON.parse(s), null, 2),
    (s: string) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s)).reverse())),
  ])("rejects alternate JSON serialization %#", mutate => expect(() => decodeMarketTerms(utf8(mutate(str(encodeMarketTerms(fixture)))))).toThrow());
  it.each(["01", "+1", "-0", "-1", "1.0", "1e2", " 1", "1 ", "", "١", "18446744073709551616"])("rejects integer spelling %j", n => {
    const v = fresh(); v.binding.marketId = n; expect(() => encodeMarketTerms(v)).toThrow();
  });
  it.each(["", " leading", "trailing ", "e\u0301", "bad\ud800", "bad\udfff", "bad\u0000", "bad\r\nline", "bad\u202e", "bad\u061c", "bad\u00ad", "bad\u{e0001}"])("rejects noncanonical text %j", s => {
    const v = fresh(); v.question = s; expect(() => encodeMarketTerms(v)).toThrow();
  });
  it("allows NFC non-ASCII, emoji and internal LF with byte-based limits", () => {
    const v = fresh(); v.question = "Café 🪿\nSecond line"; expect(decodeMarketTerms(encodeMarketTerms(v))).toEqual(v);
    v.question = "é".repeat(256); expect(() => encodeMarketTerms(v)).not.toThrow();
    v.question += "é"; expect(() => encodeMarketTerms(v)).toThrow();
  });
  it("rejects malformed UTF-8, oversized and empty bytes", () => {
    for (const b of [new Uint8Array(), new Uint8Array([0xc0, 0xaf]), new Uint8Array(MARKET_TERMS_MAX_BYTES + 1)]) expect(() => decodeMarketTerms(b)).toThrow();
  });
  it.each([
    (v: MarketTerms) => { v.economics.payoutMilli = "1"; },
    (v: MarketTerms) => { v.economics.payoutMilli = "1000001"; },
    (v: MarketTerms) => { v.economics.feeBps = "10001"; },
    (v: MarketTerms) => { v.economics.resolvesAt = "149"; },
    (v: MarketTerms) => { v.observation.startsAt = "201"; },
    (v: MarketTerms) => { v.observation.endsAt = "221"; },
    (v: MarketTerms) => { v.observation.startsAt = "9223372036854775808"; },
    (v: MarketTerms) => { v.oracle.approver = v.oracle.proposer; },
    (v: MarketTerms) => { v.oracle.proposer.wallet = v.binding.creator; },
    (v: MarketTerms) => { v.sources = []; },
    (v: MarketTerms) => { v.sources.push(v.sources[0]); },
    (v: MarketTerms) => { v.binding.program = "11111111111111111111111111111111"; },
    (v: MarketTerms) => { v.binding.genesisHash = MAINNET_GENESIS_HASH; },
  ])("rejects invalid semantic boundary %#", change => { const v = fresh(); change(v); expect(() => encodeMarketTerms(v)).toThrow(); });
  it.each(["http://example.invalid/", "https://user:pass@example.invalid/", "https://example.invalid/#fragment", "https://EXAMPLE.invalid/", "https://example.invalid", "javascript:alert(1)"])("rejects source locator %s", uri => {
    const v = fresh(); v.sources[0].uri = uri; expect(() => encodeMarketTerms(v)).toThrow();
  });
  it.each(["https://example.invalid/", "A".repeat(64), "0".repeat(64), "ab", "g".repeat(64)])("does not accept URI or invalid digest as snapshot hash %s", hash => {
    const v = fresh(); v.sources[0].snapshotSha256 = hash; expect(() => encodeMarketTerms(v)).toThrow();
  });
  it("bounds total manifest size in addition to individual fields", () => {
    const v = fresh(); v.rules = { yes: "y".repeat(2048), no: "n".repeat(2048), void: "v".repeat(2048) };
    v.sourcePolicy.missing = "m".repeat(2048); v.sourcePolicy.revisions = "r".repeat(2048);
    v.sources = Array.from({ length: 8 }, (_, i) => ({ id: `source-${i}`, uri: `https://example.invalid/${i}/${"a".repeat(480)}`, selection: "s".repeat(1024), snapshotSha256: "a".repeat(64) }));
    expect(() => encodeMarketTerms(v)).toThrow();
  });
  it("rejects missing/extra fields, wrong literals/types and getters", () => {
    const v = fresh();
    for (const change of [{ ...v, unknown: 1 }, { ...v, version: 2 }, { ...v, question: null }, { ...v, economics: { ...v.economics, feeBps: 100 } },
      { ...v, oracle: { ...v.oracle, automaticVoid: true } }, { ...v, observation: { ...v.observation, timezone: "America/Toronto" } }]) expect(() => encodeMarketTerms(change)).toThrow();
    const missing: Record<string, unknown> = { ...v }; delete missing.question; expect(() => encodeMarketTerms(missing)).toThrow();
    Object.defineProperty(v, "question", { get: () => { throw new Error("getter executed"); } });
    expect(() => encodeMarketTerms(v)).toThrow("data properties");
  });
  it("rejects sparse, decorated and accessor source arrays", () => {
    const v = fresh(); v.sources = new Array(1);
    Object.assign(v.sources, { extra: fixture.sources[0] });
    expect(() => encodeMarketTerms(v)).toThrow();
    const w = fresh(); Object.defineProperty(w.sources, "0", { get: () => { throw new Error("getter executed"); } });
    expect(() => encodeMarketTerms(w)).toThrow("data entries");
    const x = fresh(); Object.defineProperty(x.sources, Symbol("extra"), { value: 1 });
    expect(() => encodeMarketTerms(x)).toThrow();
  });
  it("preserves maximum u64 integer strings without precision loss", () => {
    const v = fresh(); v.binding.marketId = "18446744073709551615";
    expect(decodeMarketTerms(encodeMarketTerms(v)).binding.marketId).toBe(v.binding.marketId);
  });
  it("preserves explicit snapshot hashes separately from locators", () => {
    const v = fresh(); v.sources[0].snapshotSha256 = createHash("sha256").update("offline test source bytes").digest("hex");
    expect(decodeMarketTerms(encodeMarketTerms(v)).sources[0]).toEqual(v.sources[0]);
  });
  it("hashes content/source priority/policy changes differently", async () => {
    const v = fresh(), original = await hashMarketTerms(encodeMarketTerms(v));
    v.rules.yes += " Additional criterion."; expect(await hashMarketTerms(encodeMarketTerms(v))).not.toBe(original);
    v.sources.push({ ...v.sources[0], id: "secondary", uri: "https://example.invalid/secondary" });
    const ordered = await hashMarketTerms(encodeMarketTerms(v)); v.sources.reverse(); expect(await hashMarketTerms(encodeMarketTerms(v))).not.toBe(ordered);
  });
  it("rejects tampered digest, trusted binding, economics and reviewers", async () => {
    const bytes = encodeMarketTerms(fixture), e = await expected();
    await expect(verifyMarketTerms(bytes, { ...e, digest: "a".repeat(64) })).rejects.toThrow("digest mismatch");
    for (const changed of [{ ...e, binding: { ...e.binding, marketId: "8" } }, { ...e, economics: { ...e.economics, feeBps: "101" } },
      { ...e, proposer: e.approver, approver: e.proposer }]) await expect(verifyMarketTerms(bytes, changed)).rejects.toThrow("mismatch");
  });
  it("rejects self-consistent hashes with noncanonical market or enrollment PDAs", async () => {
    const v = fresh(); v.binding.market = v.binding.creator;
    await expect(verifyMarketTerms(encodeMarketTerms(v), await expected(v))).rejects.toThrow("PDAs");
    const w = fresh(); w.oracle.proposer.enrollment = w.binding.creator;
    await expect(verifyMarketTerms(encodeMarketTerms(w), await expected(w))).rejects.toThrow("enrollment PDA");
  });
  it("snapshots bytes/expectations before asynchronous hashing", async () => {
    const bytes = encodeMarketTerms(fixture), e = await expected(), pending = verifyMarketTerms(bytes, e);
    bytes.fill(0); e.binding = { ...e.binding, marketId: "8" };
    expect(await pending).toEqual(fixture);
  });
});
