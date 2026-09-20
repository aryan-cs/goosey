import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { canonicalSettlementAttestation } from "./settlement-attestation";

const runtime = {
  cluster: "devnet" as const,
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
};

function input() {
  return {
    runtime,
    databaseDomainHex: "b".repeat(64),
    actorUserId: "system-worker",
    marketId: "market-1",
    settlementRunId: "run-1",
    proposalId: "proposal-1",
    outcome: "YES" as const,
    approvalRequestHash: "a".repeat(64),
    reason: "Official result",
    evidence: "https://example.invalid/result",
    totalPositions: 2,
    processedCount: 2,
    settlementCount: 2,
    totalPayoutMilli: 1_500n,
    collateralReturnMilli: 500n,
    resolvedAt: new Date("2026-09-19T12:34:56.789Z"),
    settlements: [
      { id: "settlement-b", userId: "user-b", payoutMilli: 500n, journalEntryId: "journal-b" },
      { id: "settlement-a", userId: "user-a", payoutMilli: 1_000n, journalEntryId: "journal-a" },
    ],
  };
}

describe("canonical database settlement attestation", () => {
  it("is deterministic across settlement row ordering and exposes no participant data", () => {
    const first = canonicalSettlementAttestation(input());
    const second = canonicalSettlementAttestation({ ...input(), settlements: [...input().settlements].reverse() });

    expect(second).toEqual(first);
    expect(JSON.stringify(first.request)).not.toMatch(/user-a|journal-a|Official result|example\.invalid/);
    expect(first.marketDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.settlementDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when any committed accounting fact changes", () => {
    const baseline = canonicalSettlementAttestation(input()).settlementDigest;
    const mutations = [
      { outcome: "NO" as const },
      { totalPayoutMilli: 1_501n },
      { collateralReturnMilli: 499n },
      { reason: "Different reason" },
      { evidence: "Different evidence" },
      { resolvedAt: new Date("2026-09-19T12:34:57.000Z") },
      { settlements: [{ ...input().settlements[0], payoutMilli: 501n }, input().settlements[1]] },
    ];
    for (const mutation of mutations) {
      expect(canonicalSettlementAttestation({ ...input(), ...mutation }).settlementDigest).not.toBe(baseline);
    }
  });

  it("rejects incomplete accounting and out-of-range on-chain values", () => {
    expect(() => canonicalSettlementAttestation({ ...input(), processedCount: 1 })).toThrow("counts do not agree");
    expect(() => canonicalSettlementAttestation({ ...input(), totalPayoutMilli: -1n })).toThrow("u64 range");
    expect(() => canonicalSettlementAttestation({ ...input(), approvalRequestHash: "not-a-hash" })).toThrow("approval request hash");
  });
});
