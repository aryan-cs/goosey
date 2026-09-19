import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), runtime: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/solana/catalog-read", async original => ({ ...await original<typeof import("@/lib/solana/catalog-read")>(), readSolanaCatalog: mocks.read }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.runtime }));
import Directory from "./page";
const render = async (query: Record<string, string | string[]> = {}) => renderToStaticMarkup(await Directory({ searchParams: Promise.resolve(query) }));
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.runtime.mockReturnValue({ cluster: "localnet" });
  mocks.read.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("chain directory rendering with mocked catalog boundary", () => {
  it("does not read disabled catalog and explains separation without fake cards", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "false");
    const html = await render(); expect(html).toContain("Directory unavailable");
    expect(html).toContain("not enabled yet"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("shows a genuine empty state for an enabled empty result", async () => {
    const html = await render(); expect(html).toContain("No published on-chain markets");
    expect(html).toContain("Local network"); expect(html).not.toContain("View verified market");
  });
  it("sanitizes load failures without displaying provider details", async () => {
    mocks.read.mockRejectedValue(new Error("private-rpc-token")); const html = await render();
    expect(html).toContain("could not be loaded"); expect(html).not.toContain("private-rpc-token");
  });
  it("rejects duplicate or unrecognized queries before querying storage", async () => {
    expect(await render({ cursor: ["a", "b"] })).toContain("Invalid directory link");
    expect(await render({ rpcUrl: "injected" })).toContain("Invalid directory link");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("renders the canonical market link and exact large payout without invented prices", async () => {
    // Explicit rendering fixture, never inserted into shared data.
    mocks.read.mockResolvedValue({ items: [{ category: "Test", title: "Isolated rendering fixture?",
      description: "Rendering fixture, not a real published market.", payoutMilli: 18446744073709551615n,
      closesAt: new Date("2026-10-01T12:00:00Z"), href: "/chain/markets/7",
      chain: { genesisHash: "fixture", marketAddress: "fixture", marketId: "7" } }], nextCursor: "opaque_cursor", hasMore: true });
    const html = await render();
    expect(html).toContain('href="/chain/markets/7"'); expect(html).toContain("18,446,744,073,709,551.615");
    expect(html).toContain('href="/chain?cursor=opaque_cursor"'); expect(html).not.toContain("50%");
    expect(html).toContain("Winning contract payout");
  });
});
