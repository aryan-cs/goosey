import React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { address, type Address } from "@solana/kit";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ChainMarketReviewerKeeper, assertReviewerKeeperRecheck, availableReviewerKeeperActions,
  hashExplicitReviewText, type ReviewerKeeperView,
} from "./chain-market-reviewer-keeper";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

const creator = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const proposer = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const approver = address("SysvarRent111111111111111111111111111111111");
const keeper = address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W");
const market = address("Vote111111111111111111111111111111111111111");
const termsAddress = address("Config1111111111111111111111111111111111111");
const resolutionAddress = address("Stake11111111111111111111111111111111111111");

function view(options: { sealed?: boolean; bits?: number; phase?: number | null; wallet?: string;
  active?: bigint | null; next?: bigint; outcome?: number | null } = {}): ReviewerKeeperView {
  const phase = options.phase === undefined ? 1 : options.phase;
  const book = { book: address("SysvarC1ock11111111111111111111111111111111"), revision: phase === null ? 0n : 9n,
    nextSequence: phase === null ? 1n : 3n, orders: [], seatReserves: [], reservesReconciled: true };
  const terms = { address: termsAddress, creator, digest: new Uint8Array(32).fill(4), proposer: { wallet: proposer },
    approver: { wallet: approver }, acceptanceBits: options.bits ?? 3, sealed: options.sealed ?? true };
  const resolution = phase === null ? null : { address: resolutionAddress, proposer: { wallet: proposer },
    approver: { wallet: approver }, phase, activeProposalSequence: options.active ?? (phase === 2 ? 1n : null),
    nextProposalSequence: options.next ?? (phase === 2 ? 2n : 1n), outcome: options.outcome ?? (phase >= 3 ? 0 : null),
    outstandingYes: 0n, outstandingNo: 0n };
  return { snapshot: { wallet: options.wallet ?? keeper, market, finalizedSlot: 80n, orderBook: book,
    marketState: { creator, payoutMilli: 1000n, collateral: 0n, feeRevenue: 0n }, resolution, marketTerms: terms },
    terms, resolution, digestHex: "04".repeat(32), termsSlot: 80n, observedSlot: 80n } as unknown as ReviewerKeeperView;
}

describe("reviewer and keeper role/state gating", () => {
  it("offers only an unaccepted designated reviewer and then only the creator seal", () => {
    const open = view({ sealed: false, bits: 0, phase: null });
    expect(availableReviewerKeeperActions(open, proposer)).toEqual(["accept_terms"]);
    expect(availableReviewerKeeperActions(open, approver)).toEqual(["accept_terms"]);
    expect(availableReviewerKeeperActions(open, creator)).toEqual([]);
    const accepted = view({ sealed: false, bits: 3, phase: null });
    expect(availableReviewerKeeperActions(accepted, creator)).toEqual(["seal_terms"]);
    expect(availableReviewerKeeperActions(accepted, proposer)).toEqual([]);
  });

  it("gates proposal/review by independent roles while close/finalize remain permissionless", () => {
    expect(availableReviewerKeeperActions(view({ phase: 0 }), keeper)).toEqual(["close"]);
    expect(availableReviewerKeeperActions(view({ phase: 1 }), proposer)).toEqual(["propose"]);
    expect(availableReviewerKeeperActions(view({ phase: 1 }), keeper)).toEqual([]);
    expect(availableReviewerKeeperActions(view({ phase: 2 }), approver)).toEqual(["approve", "reject"]);
    expect(availableReviewerKeeperActions(view({ phase: 2 }), proposer)).toEqual([]);
    expect(availableReviewerKeeperActions(view({ phase: 3 }), keeper)).toEqual(["finalize"]);
    expect(availableReviewerKeeperActions(view({ phase: 4 }), keeper)).toEqual([]);
  });

  it("enables no resolution action while sealed terms await real account initialization", () => {
    expect(availableReviewerKeeperActions(view({ phase: null }), keeper)).toEqual([]);
  });
});

describe("explicit resolution material", () => {
  it("hashes exact UTF-8 without trimming or normalization", async () => {
    const left = await hashExplicitReviewText("Evidence", " café\nsource A ");
    const right = await hashExplicitReviewText("Evidence", "café\nsource A");
    expect(left.byteLength).toBe(new TextEncoder().encode(" café\nsource A ").length);
    expect(left.digestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(left.digestHex).not.toBe(right.digestHex);
    expect(left.text).toBe(" café\nsource A ");
  });

  it("requires nonblank bounded evidence and reasons", async () => {
    await expect(hashExplicitReviewText("Reason", " \n ")).rejects.toThrow("required");
    await expect(hashExplicitReviewText("Evidence", "x".repeat(4097))).rejects.toThrow("4096");
  });
});

describe("pre-signing finalized recheck", () => {
  function prepared(operation: "PROPOSE_RESOLUTION" | "APPROVE_RESOLUTION" | "CLOSE_RESOLUTION" | "FINALIZE_RESOLUTION") {
    const base = { operation, sender: operation === "PROPOSE_RESOLUTION" ? proposer : operation === "APPROVE_RESOLUTION" ? approver : keeper,
      market, terms: termsAddress, resolution: resolutionAddress, observedSlot: 70n, blockhashSlot: 71n,
      bookRevision: 9n, expectedBookRevision: 9n, expectedPhase: operation === "CLOSE_RESOLUTION" ? 0 : operation === "FINALIZE_RESOLUTION" ? 3 : operation === "PROPOSE_RESOLUTION" ? 1 : 2,
      expectedNextSequence: operation === "APPROVE_RESOLUTION" ? 2n : 1n, expectedActiveProposalSequence: operation === "APPROVE_RESOLUTION" ? 1n : null };
    return { prepared: base } as never;
  }

  it("accepts unchanged role, phase, sequence, bindings, revision, and finalized slot", () => {
    expect(assertReviewerKeeperRecheck(prepared("PROPOSE_RESOLUTION"), view({ phase: 1 }), proposer)).toBe(true);
    expect(assertReviewerKeeperRecheck(prepared("APPROVE_RESOLUTION"), view({ phase: 2 }), approver)).toBe(true);
    expect(assertReviewerKeeperRecheck(prepared("CLOSE_RESOLUTION"), view({ phase: 0 }), keeper)).toBe(true);
    expect(assertReviewerKeeperRecheck(prepared("FINALIZE_RESOLUTION"), view({ phase: 3 }), keeper)).toBe(true);
  });

  it("fails closed on changed wallet, phase, sequence, revision, or account binding", () => {
    expect(() => assertReviewerKeeperRecheck(prepared("PROPOSE_RESOLUTION"), view({ phase: 1 }), keeper)).toThrow("identity");
    expect(() => assertReviewerKeeperRecheck(prepared("PROPOSE_RESOLUTION"), view({ phase: 2 }), proposer)).toThrow("state changed");
    expect(() => assertReviewerKeeperRecheck(prepared("APPROVE_RESOLUTION"), view({ phase: 2, next: 3n }), approver)).toThrow("state changed");
    const changed = view({ phase: 1 }); (changed.snapshot.orderBook as { revision: bigint }).revision = 10n;
    expect(() => assertReviewerKeeperRecheck(prepared("PROPOSE_RESOLUTION"), changed, proposer)).toThrow("book changed");
    const rebound = view({ phase: 1 }); (rebound.terms as { address: Address }).address = creator;
    expect(() => assertReviewerKeeperRecheck(prepared("PROPOSE_RESOLUTION"), rebound, proposer)).toThrow("binding changed");
  });

  it("refuses finalization while positions, reserves, orders, liabilities, or collateral remain", () => {
    for (const mutate of [
      (value: ReviewerKeeperView) => { (value.snapshot.orderBook.seatReserves as unknown as object[]).push({ yes: 1n, no: 0n, reservedCash: 0n, reservedYes: 0n, reservedNo: 0n }); },
      (value: ReviewerKeeperView) => { (value.snapshot.orderBook.orders as unknown as object[]).push({}); },
      (value: ReviewerKeeperView) => { (value.resolution as { outstandingYes: bigint }).outstandingYes = 1n; },
      (value: ReviewerKeeperView) => { (value.snapshot.marketState as { collateral: bigint }).collateral = 1n; },
    ]) {
      const current = view({ phase: 3, outcome: 0 }); mutate(current);
      expect(() => assertReviewerKeeperRecheck(prepared("FINALIZE_RESOLUTION"), current, keeper)).toThrow("finalization state");
    }
  });
});

describe("standalone surface", () => {
  it("fails closed before wallet initialization for noncanonical market IDs", () => {
    const html = renderToStaticMarkup(createElement(ChainMarketReviewerKeeper, { marketId: "07" }));
    expect(html).toContain("canonical on-chain market ID is invalid");
  });
});
