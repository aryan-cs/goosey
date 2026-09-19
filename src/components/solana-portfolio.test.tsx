import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MAX_PORTFOLIO_PAGES, PortfolioReadError, SolanaPortfolioView, formatFeatherAmount,
  mergePortfolioItems, parsePortfolioResponse, requestPortfolioPage, type SolanaPortfolioData } from "./solana-portfolio";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

const wallet = { address: "SysvarRent111111111111111111111111111111111",
  balance: { status: "available" as const, amount: "9007199254740993", decimals: 3 as const,
    accountStatus: "present" as const, finalizedSlot: "9007199254740994" } };
const market = (marketId = "7", marketAddress = `market-${marketId}`) => ({ marketId, marketAddress,
  title: `Verified market ${marketId}`, slug: `verified-${marketId}`, href: `/chain/markets/${marketId}`,
  status: "available" as const, finalizedSlot: "9007199254740995", registered: true,
  seat: { availableCash: "18446744073709551615", reservedCash: "1000", yes: "20", no: "10", reservedYes: "2", reservedNo: "1" } });
type LinkedPortfolio = Extract<SolanaPortfolioData, { status: "linked" }>;
const linked = (items: LinkedPortfolio["items"] = [market()]): LinkedPortfolio => ({ status: "linked", wallet, items, hasMore: false, nextCursor: null });
const view = (data: SolanaPortfolioData | null, patch: Partial<React.ComponentProps<typeof SolanaPortfolioView>> = {}) => renderToStaticMarkup(<SolanaPortfolioView
  data={data} loading={false} loadingMore={false} error={null} capped={false} onRetry={() => undefined} onLoadMore={() => undefined} {...patch} />);

describe("SolanaPortfolio", () => {
  it("formats full-range feather strings at exactly three decimals without precision loss", () => {
    expect(formatFeatherAmount("0")).toBe("0.000 🪶");
    expect(formatFeatherAmount("1")).toBe("0.001 🪶");
    expect(formatFeatherAmount("18446744073709551615")).toBe("18,446,744,073,709,551.615 🪶");
    expect(() => formatFeatherAmount("1.5")).toThrow();
  });

  it("renders wallet-held and each market escrow separately with slots and no estimate language", () => {
    const html = view(linked());
    expect(html).toContain("Wallet-held");
    expect(html).toContain("9,007,199,254,740.993 🪶");
    expect(html).toContain("Finalized at slot 9007199254740994");
    expect(html).toContain("Available feathers");
    expect(html).toContain("18,446,744,073,709,551.615 🪶");
    expect(html).toContain("Reserved YES"); expect(html).toContain("Reserved NO");
    expect(html).toContain("Finalized at slot 9007199254740995");
    expect(html).not.toMatch(/net worth|profit|loss|p&l|estimated value/i);
    expect(html).not.toContain("genesis"); expect(html).not.toContain("rpc");
  });

  it("distinguishes not linked, wallet unavailable, empty catalog, market unavailable and no seat", () => {
    expect(view({ status: "not-linked", wallet: null, items: [], hasMore: false, nextCursor: null })).toContain("Link a Solana wallet");
    expect(view({ ...linked(), wallet: { ...wallet, balance: { status: "unavailable", code: "WALLET_BALANCE_UNAVAILABLE" } } })).toContain("Wallet balance unavailable");
    expect(view(linked([]))).toContain("No published on-chain markets");
    const unavailable: LinkedPortfolio["items"][number] = { marketId: "7", marketAddress: "market-7",
      title: "Verified market 7", slug: "verified-7", href: "/chain/markets/7",
      status: "unavailable", code: "MARKET_STATE_UNAVAILABLE" };
    expect(view(linked([unavailable]))).toContain("Market state unavailable");
    expect(view(linked([{ ...market(), registered: false, seat: null }]))).toContain("No market seat");
  });

  it("renders accessible loading, unavailable, retry and bounded pagination states", () => {
    const loading = view(null, { loading: true });
    expect(loading).toContain('aria-busy="true"'); expect(loading).toContain('role="status"');
    const error = view(null, { error: "unavailable" });
    expect(error).toContain('role="alert"'); expect(error).toContain("catalog is disabled or its verified data source is unavailable");
    expect(error).toContain(">Retry</button>");
    const more = view({ ...linked(), hasMore: true, nextCursor: "opaque" });
    expect(more).toContain("Load more markets");
    expect(view({ ...linked(), hasMore: true, nextCursor: "opaque" }, { capped: true })).toContain("Showing the first");
    expect(MAX_PORTFOLIO_PAGES).toBe(10);
  });

  it("uses a private abortable no-store request and treats cursors as opaque", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(linked()), { status: 200 }));
    await expect(requestPortfolioPage("opaque+/=cursor", controller.signal, fetcher as typeof fetch)).resolves.toEqual(linked());
    expect(fetcher).toHaveBeenCalledWith("/api/solana/portfolio?limit=10&cursor=opaque%2B%2F%3Dcursor", expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
    }));
    controller.abort(); expect(controller.signal.aborted).toBe(true);
  });

  it.each([[401, "signed-out"], [429, "rate-limited"], [503, "unavailable"], [500, "failed"]] as const)("sanitizes HTTP %i as %s", async (status, kind) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: "private RPC secret" } }), { status }));
    await expect(requestPortfolioPage(null, new AbortController().signal, fetcher as typeof fetch)).rejects.toMatchObject({ kind });
  });

  it("rejects malformed amounts, hrefs, seat invariants and pagination", () => {
    for (const value of [
      { ...linked(), items: [{ ...market(), href: "https://evil.invalid" }] },
      { ...linked(), wallet: { ...wallet, balance: { ...wallet.balance, amount: "9007199254740993.0" } } },
      { ...linked(), items: [{ ...market(), registered: false }] },
      { ...linked(), items: [{ ...market(), seat: { ...market().seat, reservedYes: "21" } }] },
      { ...linked(), hasMore: true, nextCursor: null },
      { ...linked([]), hasMore: true, nextCursor: "opaque" },
    ]) expect(() => parsePortfolioResponse(value)).toThrow(PortfolioReadError);
  });

  it("deduplicates overlapping pages by canonical market address while preserving first-seen order", () => {
    const first = { ...linked([market("7"), market("8")]), hasMore: true, nextCursor: "one" } as SolanaPortfolioData;
    const second = linked([market("8"), market("9")]);
    const merged = mergePortfolioItems(first, second);
    expect(merged.status).toBe("linked");
    if (merged.status === "linked") expect(merged.items.map(item => item.marketId)).toEqual(["7", "8", "9"]);
    const firstPage = mergePortfolioItems(null, linked([market("7"), market("7")]));
    if (firstPage.status === "linked") expect(firstPage.items).toHaveLength(1);
  });
});
