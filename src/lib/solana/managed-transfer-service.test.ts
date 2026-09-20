import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { acceptManagedFeatherTransfer } from "./managed-transfer-service";

const senderWallet = address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W");
const recipientWallet = address("B65XrNy82H9MeHnxxBihjUnwaRM9fXiMfTsCBuw2GvDo");
const sponsor = address("FNWvaKFgtcsc1jbfNyCKWBtT1oFqFSXwz8V8mheqYxED");
const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
  GOOSEY_SOLANA_SPONSOR_ADDRESS: sponsor,
};

function database(recipient: { id: string } | null = { id: "recipient_12345678" }) {
  const stored = new Map<string, Record<string, unknown>>();
  const result = {
    user: { findFirst: vi.fn(async () => recipient) },
    chainCommand: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("id" in where) return stored.get(String(where.id)) ?? null;
        return [...stored.values()][0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date("2026-09-20T00:00:00Z");
        const value = { id: "cmd_transfer_123", status: "ACCEPTED", revision: 0, attemptCount: 0, leaseEpoch: 0,
          leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorMessage: null,
          acceptedAt: now, preparedAt: null, signedAt: null, submittedAt: null, confirmedAt: null,
          finalizedAt: null, projectedAt: null, unknownSince: null, createdAt: now, updatedAt: now, ...data };
        stored.set(String(value.id), value);
        return value;
      }),
    },
    $transaction: async (operation: (tx: unknown) => unknown) => operation(result),
  };
  return result as never;
}

function identity(userId: string) {
  return {
    id: `identity_${userId}`,
    userId,
    chainId: "solana:localnet" as const,
    genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH,
    walletAddress: userId.startsWith("recipient") ? recipientWallet : senderWallet,
    createdAt: new Date(),
  };
}

describe("managed feather transfer acceptance", () => {
  it("freezes sender, recipient, sponsor, and base-unit amount in an idempotent command", async () => {
    const db = database();
    const ensureIdentity = vi.fn(async (userId: string) => identity(userId));
    const result = await acceptManagedFeatherTransfer({
      senderUserId: "sender_12345678",
      idempotencyKey: "transfer-request-123",
      request: { recipientUserId: "recipient_12345678", amount: "12.345" },
    }, { database: db, env, ensureIdentity, provider: "postgresql" });
    expect(result).toMatchObject({ accepted: true, pending: true,
      command: { id: "cmd_transfer_123", operation: "TRANSFER_FEATHERS", status: "ACCEPTED" } });
    const create = (db as never as { chainCommand: { create: ReturnType<typeof vi.fn> } }).chainCommand.create;
    const command = create.mock.calls[0][0].data;
    expect(JSON.parse(command.requestJson)).toEqual({
      operation: "TRANSFER_FEATHERS",
      request: {
        amount: "12345",
        recipientUserId: "recipient_12345678",
        recipientWalletAddress: recipientWallet,
        senderWalletAddress: senderWallet,
        sponsorAddress: sponsor,
        transferPolicyVersion: "managed-sponsored-spl-v1",
      },
      version: 1,
    });
    expect(ensureIdentity.mock.calls.map(call => call[0])).toEqual(["sender_12345678", "recipient_12345678"]);
  });

  it("rejects an immutable replay that changes transfer amount", async () => {
    const db = database();
    const dependencies = { database: db, env, ensureIdentity: vi.fn(async (userId: string) => identity(userId)),
      provider: "postgresql" as const };
    const base = { senderUserId: "sender_12345678", idempotencyKey: "transfer-request-123" };
    await acceptManagedFeatherTransfer({ ...base,
      request: { recipientUserId: "recipient_12345678", amount: "1" } }, dependencies);
    await expect(acceptManagedFeatherTransfer({ ...base,
      request: { recipientUserId: "recipient_12345678", amount: "2" } }, dependencies))
      .rejects.toThrow(/immutable request/);
  });

  it("rejects invalid amount, self-transfer, and unavailable recipient before custody signing", async () => {
    const ensureIdentity = vi.fn();
    const db = database();
    await expect(acceptManagedFeatherTransfer({ senderUserId: "sender_12345678", idempotencyKey: "request-123456789",
      request: { recipientUserId: "recipient_12345678", amount: "0" } },
    { database: db, env, ensureIdentity })).rejects.toThrow();
    await expect(acceptManagedFeatherTransfer({ senderUserId: "sender_12345678", idempotencyKey: "request-123456789",
      request: { recipientUserId: "sender_12345678", amount: "1" } },
    { database: db, env, ensureIdentity })).rejects.toMatchObject({ code: "TRANSFER_SELF_RECIPIENT" });
    await expect(acceptManagedFeatherTransfer({ senderUserId: "sender_12345678", idempotencyKey: "request-123456789",
      request: { recipientUserId: "recipient_12345678", amount: "1" } },
    { database: database(null), env, ensureIdentity })).rejects.toMatchObject({ code: "TRANSFER_RECIPIENT_NOT_FOUND" });
    expect(ensureIdentity).not.toHaveBeenCalled();
  });
});
