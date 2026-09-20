import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ChainMutationLaneConflictError,
  PrismaChainMutationLaneStore,
  hashChainMutationLaneToken,
  type ChainMutationLaneKey,
} from "./chain-mutation-lane";

const directory = mkdtempSync(join(tmpdir(), "goosey-mutation-lane-"));
const databasePath = join(directory, "lane.db");
const database = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
const store = new PrismaChainMutationLaneStore(database, { provider: "sqlite" });
const token = "lane_token_abcdefghijklmnopqrstuvwxyz0123456789";
const otherToken = "other_token_abcdefghijklmnopqrstuvwxyz0123456789";
const now = new Date("2026-09-20T01:00:00.000Z");
const at = (milliseconds: number) => new Date(now.getTime() + milliseconds);
let market = 0n;

function key(): ChainMutationLaneKey {
  market += 1n;
  return {
    genesisHash: "11111111111111111111111111111111",
    programAddress: "BPFLoaderUpgradeab1e11111111111111111111111",
    walletAddress: "SysvarRent111111111111111111111111111111111",
    chainMarketId: market.toString(),
  };
}

beforeAll(async () => {
  execFileSync("sqlite3", [databasePath], {
    input: readFileSync("prisma/sqlite-upgrades/20260920004000_solana_chain_mutation_lanes.sql", "utf8"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  await database.$connect();
});

afterAll(async () => {
  await database.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable Solana chain mutation lane", () => {
  it("creates one stable row for the exact deployment, wallet, and market identity", async () => {
    const identity = key();
    const first = await store.loadOrCreate(identity);
    const replay = await store.loadOrCreate({ ...identity });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ key: identity, revision: 0, leaseEpoch: 0, lease: null });
    expect(await database.solanaChainMutationLane.count()).toBe(1);
  });

  it("acquires with a hashed token and rejects active theft or stale revisions", async () => {
    const identity = key();
    await store.loadOrCreate(identity);
    const leased = await store.acquire({ ...identity, expectedRevision: 0, owner: "seat-worker", token,
      now, expiresAt: at(60_000) });
    expect(leased).toMatchObject({ revision: 1, leaseEpoch: 1,
      lease: { owner: "seat-worker", epoch: 1, expiresAt: at(60_000) } });
    const raw = await database.solanaChainMutationLane.findUniqueOrThrow({
      where: { genesisHash_programAddress_walletAddress_chainMarketId: identity },
    });
    expect(raw.leaseTokenHash).toBe(hashChainMutationLaneToken(token));
    expect(JSON.stringify(raw)).not.toContain(token);
    await expect(store.acquire({ ...identity, expectedRevision: 1, owner: "order-worker", token: otherToken,
      now: at(1), expiresAt: at(60_001) })).rejects.toThrow(/active lease/);
    await expect(store.acquire({ ...identity, expectedRevision: 0, owner: "order-worker", token: otherToken,
      now: at(1), expiresAt: at(60_001) })).rejects.toThrow(ChainMutationLaneConflictError);
  });

  it("serializes concurrent acquisition so exactly one worker crosses the CAS fence", async () => {
    const identity = key();
    await store.loadOrCreate(identity);
    const attempts = await Promise.allSettled([
      store.acquire({ ...identity, expectedRevision: 0, owner: "seat-worker", token,
        now, expiresAt: at(60_000) }),
      store.acquire({ ...identity, expectedRevision: 0, owner: "order-worker", token: otherToken,
        now, expiresAt: at(60_000) }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await store.load(identity))?.revision).toBe(1);
  });

  it("renews and releases only under the exact revision, token, owner, and epoch fence", async () => {
    const identity = key();
    await store.loadOrCreate(identity);
    const leased = await store.acquire({ ...identity, expectedRevision: 0, owner: "funding-worker", token,
      now, expiresAt: at(60_000) });
    await expect(store.renew({ ...identity, expectedRevision: leased.revision, owner: "funding-worker",
      token: otherToken, epoch: leased.leaseEpoch, now: at(1), expiresAt: at(90_000) })).rejects.toThrow(/fence/);
    const renewed = await store.renew({ ...identity, expectedRevision: leased.revision, owner: "funding-worker",
      token, epoch: leased.leaseEpoch, now: at(1), expiresAt: at(90_000) });
    expect(renewed).toMatchObject({ revision: 2, leaseEpoch: 1,
      lease: { owner: "funding-worker", epoch: 1, expiresAt: at(90_000) } });
    await expect(store.release({ ...identity, expectedRevision: leased.revision, owner: "funding-worker",
      token, epoch: leased.leaseEpoch, now: at(2) })).rejects.toThrow(/revision/);
    const released = await store.release({ ...identity, expectedRevision: renewed.revision, owner: "funding-worker",
      token, epoch: renewed.leaseEpoch, now: at(2) });
    expect(released).toMatchObject({ revision: 3, leaseEpoch: 1, lease: null });
  });

  it("allows takeover only after expiry and permanently fences the prior worker", async () => {
    const identity = key();
    await store.loadOrCreate(identity);
    const first = await store.acquire({ ...identity, expectedRevision: 0, owner: "seat-worker", token,
      now, expiresAt: at(10_000) });
    await expect(store.renew({ ...identity, expectedRevision: first.revision, owner: "seat-worker", token,
      epoch: first.leaseEpoch, now: at(10_000), expiresAt: at(20_000) })).rejects.toThrow(/expired/);
    await expect(store.acquire({ ...identity, expectedRevision: first.revision, owner: "seat-worker", token,
      now: at(10_000), expiresAt: at(30_000) })).rejects.toThrow(/fresh token/);
    const second = await store.acquire({ ...identity, expectedRevision: first.revision, owner: "order-worker",
      token: otherToken, now: at(10_000), expiresAt: at(30_000) });
    expect(second).toMatchObject({ revision: 2, leaseEpoch: 2,
      lease: { owner: "order-worker", epoch: 2 } });
    await expect(store.release({ ...identity, expectedRevision: second.revision, owner: "seat-worker",
      token, epoch: first.leaseEpoch, now: at(10_001) })).rejects.toThrow(/fence/);
  });

  it("enforces identity immutability and monotonic revisions in the SQLite migration", async () => {
    const identity = key();
    const lane = await store.loadOrCreate(identity);
    expect(() => execFileSync("sqlite3", [databasePath,
      `UPDATE "SolanaChainMutationLane" SET "walletAddress"='11111111111111111111111111111111', "revision"=1 WHERE "id"='${lane.id}';`],
    { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("sqlite3", [databasePath,
      `UPDATE "SolanaChainMutationLane" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "id"='${lane.id}';`],
    { stdio: "pipe" })).toThrow();
  });

  it("ships equivalent PostgreSQL constraints and CAS trigger", () => {
    const sql = readFileSync("prisma/postgresql/migrations/20260920004000_solana_chain_mutation_lanes/migration.sql", "utf8");
    expect(sql).toMatch(/SolanaMutationLane_identity_key/);
    expect(sql).toMatch(/revision must increment exactly once/);
    expect(sql).toMatch(/acquisition must advance its epoch/);
    expect(sql).not.toMatch(/\bPRAGMA\b|AUTOINCREMENT/i);
  });
});
