import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { address, getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptChainCommand, type AcceptedChainCommandIdentity } from "@/lib/solana/chain-command";
import { ChainCommandConflictError } from "@/lib/solana/chain-command-state";
import {
  ChainCommandNotFoundError,
  PrismaChainCommandStore,
} from "@/lib/solana/chain-command-store";
import type { SolanaRuntime } from "@/lib/solana/runtime";

const directory = mkdtempSync(join(tmpdir(), "goosey-chain-command-store-"));
const databasePath = join(directory, "commands.db");
const database = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
const store = new PrismaChainCommandStore(database, { provider: "sqlite" });
const decoder = getBase58Decoder();
const feePayer = decoder.decode(new Uint8Array(32).fill(3));
const blockhash = decoder.decode(new Uint8Array(32).fill(4));
const transactionSignature = decoder.decode(new Uint8Array(64).fill(5));
const token = "lease_token_abcdefghijklmnopqrstuvwxyz0123456789";
const runtime: SolanaRuntime = {
  cluster: "localnet",
  rpcUrl: "http://127.0.0.1:20999/",
  genesisHash: "11111111111111111111111111111111",
  programAddress: address("BPFLoaderUpgradeab1e11111111111111111111111"),
};

function wireBase64(): string {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.from(new Uint8Array(64).fill(5)),
    Buffer.from([1, 0, 0]),
    Buffer.from([1]),
    Buffer.from(new Uint8Array(32).fill(3)),
    Buffer.from(new Uint8Array(32).fill(4)),
    Buffer.from([0]),
  ]).toString("base64");
}

let sequence = 0;
function identity(overrides: Partial<AcceptedChainCommandIdentity> = {}): AcceptedChainCommandIdentity {
  sequence += 1;
  return {
    ...acceptChainCommand({
      runtime,
      scope: "USER",
      scopeId: `user_${sequence}`,
      actorId: `user_${sequence}`,
      operation: "PLACE_ORDER",
      idempotencyKey: `request_${sequence}`,
      request: { marketId: "market_12345678", quantity: "2", side: "YES" },
    }),
    ...overrides,
  };
}

beforeAll(async () => {
  const sql = readFileSync("prisma/sqlite-upgrades/20260920000000_chain_commands.sql", "utf8");
  execFileSync("sqlite3", [databasePath], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  await database.$connect();
});

afterAll(async () => {
  await database.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("Prisma chain command store acceptance", () => {
  it("atomically creates or replays only an identical immutable request", async () => {
    const accepted = identity();
    const first = await store.createOrReplay(accepted);
    const replay = await store.createOrReplay({ ...accepted });

    expect(replay).toEqual(first);
    expect(first.state).toMatchObject({ status: "ACCEPTED", revision: 0, lease: null });
    expect(await database.chainCommand.count()).toBe(1);

    await expect(store.createOrReplay({ ...accepted, actorId: "different_actor" }))
      .rejects.toThrow(/immutable actorId/);
    expect(await database.chainCommand.count()).toBe(1);
  });

  it("loads durable state and rejects unknown command ids", async () => {
    const created = await store.createOrReplay(identity());
    expect(await store.load(created.state.id)).toEqual(created);
    await expect(store.load("missing_command_12345678")).rejects.toThrow(ChainCommandNotFoundError);
  });
});

describe("Prisma chain command store fencing", () => {
  it("acquires and renews leases with revision CAS and hashed tokens", async () => {
    const command = await store.createOrReplay(identity());
    const now = new Date();
    const leased = await store.acquireLease(command.state.id, {
      expectedRevision: 0,
      owner: "worker_12345678",
      token,
      now,
      expiresAt: new Date(now.getTime() + 120_000),
    });
    expect(leased.state).toMatchObject({ revision: 1, leaseEpoch: 1, attemptCount: 1,
      lease: { owner: "worker_12345678", epoch: 1 } });
    expect(leased.state.lease?.tokenHash).not.toBe(token);

    await expect(store.acquireLease(command.state.id, {
      expectedRevision: 0,
      owner: "stale_worker",
      token: `${token}x`,
      now,
      expiresAt: new Date(now.getTime() + 120_000),
    })).rejects.toThrow(ChainCommandConflictError);

    const renewed = await store.renewLease(command.state.id, {
      expectedRevision: 1,
      owner: "worker_12345678",
      token,
      epoch: 1,
      now: new Date(now.getTime() + 1_000),
      expiresAt: new Date(now.getTime() + 180_000),
    });
    expect(renewed.state).toMatchObject({ revision: 2, leaseEpoch: 1, attemptCount: 1 });
    expect(renewed.state.lease?.expiresAt).toEqual(new Date(now.getTime() + 180_000));
  });

  it("persists fenced transitions and never returns internal failure details publicly", async () => {
    const command = await store.createOrReplay(identity());
    const now = new Date();
    const leased = await store.acquireLease(command.state.id, {
      expectedRevision: 0, owner: "worker_12345678", token, now,
      expiresAt: new Date(now.getTime() + 120_000),
    });
    const failed = await store.transition(command.state.id, {
      expectedRevision: leased.state.revision,
      owner: "worker_12345678",
      token,
      epoch: leased.state.leaseEpoch,
      now: new Date(now.getTime() + 1_000),
      to: "FAILED_RETRYABLE",
      errorCode: "RPC_TIMEOUT",
      errorMessage: "private validator diagnostic",
    });
    expect(failed.state).toMatchObject({ status: "FAILED_RETRYABLE", lease: null,
      lastErrorCode: "RPC_TIMEOUT", lastErrorMessage: "private validator diagnostic" });

    const publicStatus = await store.publicStatus(command.state.id);
    const publicJson = JSON.stringify(publicStatus);
    expect(Object.keys(publicStatus).sort()).toEqual([
      "acceptedAt", "attemptCount", "confirmedAt", "finalizedAt", "id", "operation", "preparedAt",
      "projectedAt", "revision", "signedAt", "status", "submittedAt", "unknownSince", "updatedAt",
    ]);
    expect(publicJson).not.toContain("private validator diagnostic");
    expect(publicJson).not.toContain("RPC_TIMEOUT");
    expect(publicJson).not.toContain(token);
    expect(publicJson).not.toContain(command.identity.requestJson);
  });
});

describe("signed wire write-before-send transaction", () => {
  it("atomically appends exact wire evidence before advancing PREPARED to SIGNED", async () => {
    const command = await store.createOrReplay(identity());
    const now = new Date();
    const leased = await store.acquireLease(command.state.id, {
      expectedRevision: 0, owner: "worker_12345678", token, now,
      expiresAt: new Date(now.getTime() + 120_000),
    });
    const prepared = await store.transition(command.state.id, {
      expectedRevision: leased.state.revision,
      owner: "worker_12345678",
      token,
      epoch: leased.state.leaseEpoch,
      now: new Date(now.getTime() + 1_000),
      to: "PREPARED",
    });

    const result = await store.appendSignedWireBeforeSend({
      owner: "worker_12345678",
      token,
      epoch: prepared.state.leaseEpoch,
      now: new Date(now.getTime() + 2_000),
      wire: {
        commandId: command.state.id,
        sequence: 0,
        leaseEpoch: prepared.state.leaseEpoch,
        commandRevision: prepared.state.revision,
        signedWireBase64: wireBase64(),
        transactionSignature,
        recentBlockhash: blockhash,
        lastValidBlockHeight: 123n,
        durableNonceAddress: null,
        feePayerAddress: feePayer,
        signerAddresses: [feePayer],
      },
    });

    expect(result.command.state).toMatchObject({ status: "SIGNED", revision: prepared.state.revision + 1 });
    const storedWire = await database.chainCommandSignedWire.findUniqueOrThrow({
      where: { commandId_sequence: { commandId: command.state.id, sequence: 0 } },
    });
    expect(storedWire.signedWireBase64).toBe(wireBase64());
    expect(storedWire.signedWireSha256).toBe(result.journal.signedWireSha256);
    expect(storedWire.commandRevision).toBe(prepared.state.revision);
  });

  it("rolls back the journal when the command fence or lifecycle is stale", async () => {
    const command = await store.createOrReplay(identity());
    const now = new Date();
    const leased = await store.acquireLease(command.state.id, {
      expectedRevision: 0, owner: "worker_12345678", token, now,
      expiresAt: new Date(now.getTime() + 120_000),
    });
    const staleWire = {
      commandId: command.state.id,
      sequence: 0,
      leaseEpoch: leased.state.leaseEpoch,
      commandRevision: leased.state.revision,
      signedWireBase64: wireBase64(),
      transactionSignature,
      recentBlockhash: blockhash,
      lastValidBlockHeight: 123n,
      durableNonceAddress: null,
      feePayerAddress: feePayer,
      signerAddresses: [feePayer],
    } as const;
    await expect(store.appendSignedWireBeforeSend({
      owner: "worker_12345678", token, epoch: 1, now: new Date(now.getTime() + 1_000), wire: staleWire,
    })).rejects.toThrow(/Illegal chain command transition/);
    expect(await database.chainCommandSignedWire.count({ where: { commandId: command.state.id } })).toBe(0);
    expect((await store.load(command.state.id)).state.status).toBe("ACCEPTED");
  });
});
