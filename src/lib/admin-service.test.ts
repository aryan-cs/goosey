import { describe, expect, it, vi } from "vitest";

import { assertNoResolutionTradingExposure } from "./admin-service";

const USER_ID = "admin_12345678";
const MARKET_ID = "market_12345678";

function exposureReader(legacyTradeCount: number, orderFillCount: number) {
  const tradeCount = vi.fn().mockResolvedValue(legacyTradeCount);
  const orderFillCountFn = vi.fn().mockResolvedValue(orderFillCount);
  return {
    tx: {
      trade: { count: tradeCount },
      orderFill: { count: orderFillCountFn },
    },
    tradeCount,
    orderFillCount: orderFillCountFn,
  };
}

describe("resolution conflict-of-interest exposure", () => {
  it("allows an administrator with neither legacy trades nor CLOB fills", async () => {
    const { tx, tradeCount, orderFillCount } = exposureReader(0, 0);

    await expect(
      assertNoResolutionTradingExposure(tx as never, USER_ID, MARKET_ID, "PROPOSER_CONFLICT"),
    ).resolves.toBeUndefined();

    expect(tradeCount).toHaveBeenCalledWith({ where: { userId: USER_ID, marketId: MARKET_ID } });
    expect(orderFillCount).toHaveBeenCalledWith({
      where: {
        marketId: MARKET_ID,
        OR: [
          { makerOrder: { is: { userId: USER_ID } } },
          { takerOrder: { is: { userId: USER_ID } } },
        ],
      },
    });
  });

  it.each([
    { label: "a legacy LMSR trade", legacyTradeCount: 1, orderFillCount: 0 },
    { label: "a maker or taker CLOB fill", legacyTradeCount: 0, orderFillCount: 1 },
    { label: "both legacy and CLOB activity", legacyTradeCount: 2, orderFillCount: 3 },
  ])("rejects a proposer with $label", async ({ legacyTradeCount, orderFillCount }) => {
    const { tx } = exposureReader(legacyTradeCount, orderFillCount);

    await expect(
      assertNoResolutionTradingExposure(tx as never, USER_ID, MARKET_ID, "PROPOSER_CONFLICT"),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROPOSER_CONFLICT",
      message: "An administrator who traded this market cannot propose its result.",
    });
  });

  it("rejects an approver with maker or taker CLOB exposure using the resolver error contract", async () => {
    const { tx } = exposureReader(0, 1);

    await expect(
      assertNoResolutionTradingExposure(tx as never, USER_ID, MARKET_ID, "RESOLVER_CONFLICT"),
    ).rejects.toMatchObject({
      status: 403,
      code: "RESOLVER_CONFLICT",
      message: "An administrator who traded this market cannot resolve it.",
    });
  });
});
