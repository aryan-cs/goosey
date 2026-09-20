import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { acceptManagedResolutionProposal } from "./managed-resolution-service";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const WALLET = address("SysvarRent111111111111111111111111111111111");
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };

function database() {
  const commands = new Map<string, Record<string, unknown>>();
  const proposals = new Map<string, Record<string, unknown>>();
  const market = { id: "market_1", slug: "market-one", createdById: "creator_1", executionBackend: "SOLANA",
    collateralAccountId: null, solanaBinding: { cluster: "localnet", genesisHash: GENESIS,
      programAddress: PROGRAM, chainMarketId: "7" } };
  const result = {
    market: { findUnique: vi.fn(async () => market) },
    user: { findUnique: vi.fn(async () => ({ role: "ADMIN", status: "ACTIVE" })) },
    marketResolutionProposal: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("proposerId_idempotencyKey" in where) return proposals.get("proposal") ?? null;
        return proposals.get(String((where as { id?: string }).id)) ?? null;
      }),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const proposal = { id: "proposal_1", status: "PENDING", reviewNote: "", approverId: null,
          approvalIdempotencyKey: null, approvalRequestHash: null, decidedAt: null, createdAt: new Date(), ...data };
        proposals.set("proposal", proposal); proposals.set("proposal_1", proposal); return proposal;
      }),
    },
    chainCommand: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("id" in where) return commands.get(String(where.id)) ?? null;
        return [...commands.values()][0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date("2026-09-20T00:00:00Z");
        const command = { id: "cmd_proposal_1", status: "ACCEPTED", revision: 0, attemptCount: 0, leaseEpoch: 0,
          leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorMessage: null,
          acceptedAt: now, preparedAt: null, signedAt: null, submittedAt: null, confirmedAt: null,
          finalizedAt: null, projectedAt: null, unknownSince: null, createdAt: now, updatedAt: now, ...data };
        commands.set(String(command.id), command); return command;
      }),
    },
    $transaction: async (operation: (tx: unknown) => unknown) => operation(result),
  };
  return result as never;
}

describe("managed resolution proposal lifecycle", () => {
  it("replays the durable command after chain phase advancement without re-reading stale phase", async () => {
    const db = database();
    const readEscrow = vi.fn(async () => ({ wallet: WALLET, marketState: { marketId: 7n },
      resolution: { phase: 1, activeProposalSequence: null, nextProposalSequence: 3n,
        proposer: { wallet: WALLET }, approver: { wallet: PROGRAM } },
      marketTerms: { sealed: true }, orderBook: { reservesReconciled: true } } as never));
    const dependencies = { database: db, env, provider: "postgresql" as const, readEscrow,
      ensureIdentity: vi.fn(async () => ({ id: "identity", userId: "admin_proposer", chainId: "solana:localnet" as const,
        genesisHash: GENESIS, walletAddress: WALLET, createdAt: new Date() })) };
    const input = { actorUserId: "admin_proposer", marketId: "market_1", idempotencyKey: "proposal-request-12345",
      resolution: { outcome: "YES" as const, reason: "Official final result", evidence: "Official result page" } };
    const first = await acceptManagedResolutionProposal(input, dependencies);
    expect(first).toMatchObject({ replayed: false, proposal: { id: "proposal_1" },
      command: { id: "cmd_proposal_1", operation: "PROPOSE_RESOLUTION" } });
    const second = await acceptManagedResolutionProposal(input, dependencies);
    expect(second).toMatchObject({ replayed: true, command: { id: "cmd_proposal_1" } });
    expect(readEscrow).toHaveBeenCalledOnce();
    expect((db as never as { chainCommand: { create: ReturnType<typeof vi.fn> } }).chainCommand.create).toHaveBeenCalledOnce();
  });

  it("rejects a changed proposal under the same idempotency key", async () => {
    const db = database();
    const dependencies = { database: db, env, provider: "postgresql" as const,
      readEscrow: vi.fn(async () => ({ wallet: WALLET, marketState: { marketId: 7n },
        resolution: { phase: 1, activeProposalSequence: null, nextProposalSequence: 3n,
          proposer: { wallet: WALLET }, approver: { wallet: PROGRAM } },
        marketTerms: {}, orderBook: { reservesReconciled: true } } as never)),
      ensureIdentity: vi.fn(async () => ({ id: "identity", userId: "admin_proposer", chainId: "solana:localnet" as const,
        genesisHash: GENESIS, walletAddress: WALLET, createdAt: new Date() })) };
    const base = { actorUserId: "admin_proposer", marketId: "market_1", idempotencyKey: "proposal-request-12345",
      resolution: { outcome: "YES" as const, reason: "Official final result", evidence: "Official result page" } };
    await acceptManagedResolutionProposal(base, dependencies);
    await expect(acceptManagedResolutionProposal({ ...base,
      resolution: { ...base.resolution, outcome: "NO" } }, dependencies))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
