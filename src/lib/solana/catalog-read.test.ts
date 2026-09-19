import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { db as Database } from "@/lib/db";
import type { SolanaRuntime } from "./runtime";

const mocks = vi.hoisted(() => ({ startup: vi.fn(), findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { market: { findMany: mocks.findMany } }, requireDatabaseStartup: mocks.startup }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));

import { deriveGooseyMarketAddresses } from "./escrow-client";
import { parseSolanaCatalogQuery, readSolanaCatalog } from "./catalog-read";

const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesisHash = "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE";
const runtime: SolanaRuntime = { cluster: "localnet", rpcUrl: "http://127.0.0.1:20999",
  genesisHash, programAddress };
const timestamp = new Date("2026-09-19T12:00:00.000Z");

async function row(id = "cmcatalog000000000000001", chainMarketId = "7") {
  const canonical = await deriveGooseyMarketAddresses({ programAddress, marketId: BigInt(chainMarketId) });
  return {
    id, executionBackend: "SOLANA", collateralAccountId: null, acceptingOrders: false,
    slug: `chain-market-${chainMarketId}`, title: "Will the real chain assertion pass?", shortTitle: "Chain assertion",
    description: "Public editorial metadata for an actual canonical chain market.",
    rules: "YES: assertion passes.\n\nNO: assertion fails.\n\nVOID: evidence unavailable.",
    resolutionSource: "https://example.invalid/terms", category: "Hackathon", status: "OPEN",
    featured: false, color: "gold", icon: "goose", closesAt: new Date("2026-09-20T12:00:00.000Z"),
    resolvesAt: new Date("2026-09-20T13:00:00.000Z"), payoutMilli: 1_000n, feeBps: 25,
    createdAt: timestamp, updatedAt: timestamp,
    solanaBinding: { cluster: runtime.cluster, genesisHash, programAddress, marketAddress: canonical.market, chainMarketId },
  };
}

function client() {
  return { market: { findMany: mocks.findMany } } as unknown as Pick<typeof Database, "market">;
}

beforeEach(() => { vi.resetAllMocks(); });

describe("Solana catalog query and cursor contract", () => {
  it("applies a bounded default and accepts canonical scalar limits", () => {
    expect(parseSolanaCatalogQuery({})).toEqual({ limit: 25 });
    expect(parseSolanaCatalogQuery({ limit: "50" })).toEqual({ limit: 50 });
  });

  it.each([
    { unknown: "x" }, { limit: 0 }, { limit: 51 }, { limit: "01" }, { limit: "1.5" },
    { limit: ["5"] }, { cursor: ["x"] }, { cursor: "x".repeat(513) },
  ])("rejects invalid, array, or unknown query input %j", (input) => {
    expect(() => parseSolanaCatalogQuery(input)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it.each(["!", "e30", Buffer.from("not-json").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 2, createdAt: timestamp.toISOString(), id: "cmcatalog000000000000001" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: "yesterday", id: "cmcatalog000000000000001" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: timestamp.toISOString(), id: "bad id" })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: timestamp.toISOString(), id: "cmcatalog000000000000001", extra: true })).toString("base64url"),
  ])("rejects malformed/noncanonical cursor %s", (cursor) => {
    expect(() => parseSolanaCatalogQuery({ cursor })).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });
});

describe("mocked database boundary: public Solana catalog", () => {
  it("queries only exact discoverable deployment rows and explicitly omits financial fields", async () => {
    mocks.findMany.mockResolvedValue([await row()]);
    const result = await readSolanaCatalog(runtime, { limit: 25 }, client());
    expect(result).toMatchObject({ hasMore: false, nextCursor: null, items: [{
      slug: "chain-market-7", status: "OPEN", href: "/chain/markets/7", payoutMilli: 1_000n,
      chain: { cluster: "localnet", genesisHash, programAddress, marketId: "7" },
    }] });
    const query = mocks.findMany.mock.calls[0][0];
    expect(query).toMatchObject({ take: 26, orderBy: [{ createdAt: "desc" }, { id: "desc" }], where: {
      executionBackend: "SOLANA", collateralAccountId: null, acceptingOrders: false, status: "OPEN",
      solanaBinding: { is: { cluster: "localnet", genesisHash, programAddress } },
    } });
    for (const forbidden of ["volumeMilli", "yesShares", "noShares", "traderCount", "commentCount",
      "positions", "orders", "collateralAccount", "balanceMilli", "priceHistory"]) {
      expect(query.select).not.toHaveProperty(forbidden);
      expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(forbidden);
    }
    expect(result.items[0]).not.toHaveProperty("id");
    expect(result.items[0]).not.toHaveProperty("executionBackend");
    expect(result.items[0]).not.toHaveProperty("collateralAccountId");
    expect(result.items[0]).not.toHaveProperty("acceptingOrders");
    expect(mocks.startup).not.toHaveBeenCalled();
  });

  it("uses limit+1 and a stable non-row-dependent tie cursor", async () => {
    const first = await row("cmcatalog000000000000002", "7");
    const second = await row("cmcatalog000000000000001", "8");
    mocks.findMany.mockResolvedValue([first, second]);
    const page = await readSolanaCatalog(runtime, { limit: 1 }, client());
    expect(page.items).toHaveLength(1); expect(page.hasMore).toBe(true); expect(page.nextCursor).toEqual(expect.any(String));
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    expect(decoded).toEqual({ v: 1, createdAt: timestamp.toISOString(), id: first.id });
    mocks.findMany.mockResolvedValue([second]);
    await readSolanaCatalog(runtime, parseSolanaCatalogQuery({ limit: 1, cursor: page.nextCursor }), client());
    expect(mocks.findMany.mock.lastCall?.[0].where.AND).toEqual([{ OR: [
      { createdAt: { lt: timestamp } }, { createdAt: timestamp, id: { lt: first.id } },
    ] }]);
    expect(mocks.findMany.mock.lastCall?.[0]).not.toHaveProperty("cursor");
  });

  it("runs the shipping database startup guard for the default client", async () => {
    mocks.startup.mockRejectedValue(new Error("Database startup refused"));
    await expect(readSolanaCatalog(runtime, { limit: 25 })).rejects.toThrow("startup refused");
    expect(mocks.startup).toHaveBeenCalledOnce(); expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong backend", { executionBackend: "DATABASE" }],
    ["non-null collateral", { collateralAccountId: "ledger-account" }],
    ["SQL order acceptance enabled", { acceptingOrders: true }],
    ["draft status", { status: "DRAFT" }],
    ["wrong cluster", { solanaBinding: { cluster: "devnet" } }],
    ["wrong genesis", { solanaBinding: { genesisHash: programAddress } }],
    ["wrong program", { solanaBinding: { programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } }],
    ["missing binding", { solanaBinding: null }],
  ] as const)("fails closed on a mocked row with %s", async (_label, patch) => {
    const valid = await row();
    const patchRecord = patch as Record<string, unknown>;
    const suppliedBinding = patchRecord.solanaBinding;
    const bindingPatch = suppliedBinding && typeof suppliedBinding === "object"
      ? { ...valid.solanaBinding, ...suppliedBinding } : suppliedBinding;
    mocks.findMany.mockResolvedValue([{ ...valid, ...patchRecord,
      ...(Object.hasOwn(patchRecord, "solanaBinding") ? { solanaBinding: bindingPatch } : {}) }]);
    await expect(readSolanaCatalog(runtime, { limit: 25 }, client())).rejects.toThrow();
  });

  it.each(["01", "18446744073709551616", "1e3", "-1"])("rejects stored invalid u64 market ID %s", async (chainMarketId) => {
    const valid = await row(); mocks.findMany.mockResolvedValue([{ ...valid, solanaBinding: { ...valid.solanaBinding, chainMarketId } }]);
    await expect(readSolanaCatalog(runtime, { limit: 25 }, client())).rejects.toThrow("chain market ID");
  });

  it("rejects a valid address that is not the canonical market PDA", async () => {
    const valid = await row(); mocks.findMany.mockResolvedValue([{ ...valid,
      solanaBinding: { ...valid.solanaBinding, marketAddress: programAddress } }]);
    await expect(readSolanaCatalog(runtime, { limit: 25 }, client())).rejects.toThrow("not canonical");
  });

  it("rejects a malformed stored market address", async () => {
    const valid = await row(); mocks.findMany.mockResolvedValue([{ ...valid,
      solanaBinding: { ...valid.solanaBinding, marketAddress: "not-an-address" } }]);
    await expect(readSolanaCatalog(runtime, { limit: 25 }, client())).rejects.toThrow("market address");
  });
});
