import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { matchedTradeBootstrapHelp, parseMatchedTradeArguments, validateMatchedTradePlan,
  validateMatchedTradePrimaryState } from "./solana-local-matched-trade-bootstrap";

const operator = "/private/tmp/goosey-retained-localnet";
const marketState = "/private/tmp/goosey-market-bootstrap";
const tradeState = "/private/tmp/goosey-matched-trade";
const args = ["run", "--operator-directory", operator, "--market-state", marketState, "--trade-state", tradeState];
const primary = {
  version: 1, genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",
  programAddress: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q", marketId: "7", closesAt: "1821286000", allowance: "100000",
  proposer: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", approver: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  participant: "SysvarC1ock11111111111111111111111111111111",
} as const;
const plan = {
  version: 1, genesisHash: primary.genesisHash, programAddress: primary.programAddress, marketId: "7",
  seats: "Vote111111111111111111111111111111111111111", maker: primary.participant,
  taker: "SysvarRent111111111111111111111111111111111", makerNonce: "1", takerNonce: "1",
  quantity: "10", yesPrice: "400", noPrice: "600",
} as const;

describe("retained-localnet matched-trade bootstrap", () => {
  it("parses only three distinct absolute non-nested directories", () => {
    expect(parseMatchedTradeArguments(args)).toEqual({ mode: "run", operatorDirectory: operator,
      marketStateDirectory: marketState, tradeStateDirectory: tradeState });
    expect(parseMatchedTradeArguments(["--help"])).toEqual({ mode: "help" });
    for (const unsafe of [args.slice(0, -1), [...args, "--trade-state", "/private/tmp/other"],
      ["run", "--operator-directory", "relative", "--market-state", marketState, "--trade-state", tradeState],
      ["run", "--operator-directory", operator, "--market-state", `${operator}/market`, "--trade-state", tradeState]]) {
      expect(() => parseMatchedTradeArguments(unsafe)).toThrow();
    }
  });

  it("validates the exact pinned primary market domain", () => {
    expect(validateMatchedTradePrimaryState(primary)).toMatchObject(primary);
    for (const patch of [{ version: 2 }, { programAddress: primary.proposer }, { allowance: "9999" },
      { participant: primary.proposer }, { marketId: "01" }]) {
      expect(() => validateMatchedTradePrimaryState({ ...primary, ...patch })).toThrow();
    }
  });

  it("freezes complementary prices, quantity, participants, nonces and bindings", () => {
    expect(validateMatchedTradePlan(plan, validateMatchedTradePrimaryState(primary))).toEqual(plan);
    for (const patch of [{ quantity: "11" }, { yesPrice: "401" }, { noPrice: "599" }, { maker: plan.taker },
      { taker: plan.maker }, { makerNonce: "01" }, { marketId: "8" }, { genesisHash: plan.seats }, { extra: "x" }]) {
      expect(() => validateMatchedTradePlan({ ...plan, ...patch }, validateMatchedTradePrimaryState(primary))).toThrow();
    }
  });

  it("documents the no-reset, no-public-cluster, no-financial-SQL contract", () => {
    expect(matchedTradeBootstrapHelp).toContain("never starts/resets a validator");
    expect(matchedTradeBootstrapHelp).toContain("financial SQL rows");
    expect(matchedTradeBootstrapHelp).toContain("Exact signed wire receipts");
    expect(matchedTradeBootstrapHelp).toContain("internal operator/custody");
    expect(matchedTradeBootstrapHelp).toContain("requires no Phantom connection");
  });

  it("has no import-time CLI or network side effects", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "-e",
      "import('./scripts/solana-local-matched-trade-bootstrap.ts').then(()=>process.stdout.write('imported'))"],
    { cwd: process.cwd(), encoding: "utf8" });
    expect(output).toBe("imported");
  });
});
