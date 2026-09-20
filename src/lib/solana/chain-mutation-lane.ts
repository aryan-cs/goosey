import { createHash } from "node:crypto";

import { Prisma, type SolanaChainMutationLane } from "@prisma/client";
import { address } from "@solana/kit";

import { db } from "@/lib/db";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import {
  databaseProviderFromUrl,
  runSerializableTransaction,
  type DatabaseProvider,
  type TransactionRunner,
} from "@/lib/serializable-transaction";

const MAX_COUNTER = 2_147_483_647;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_LEASE_MS = 5 * 60_000;

export type ChainMutationLaneKey = Readonly<{
  genesisHash: string;
  programAddress: string;
  walletAddress: string;
  chainMarketId: string;
}>;

export type ChainMutationLane = Readonly<{
  id: string;
  key: ChainMutationLaneKey;
  revision: number;
  leaseEpoch: number;
  lease: null | Readonly<{ owner: string; epoch: number; expiresAt: Date }>;
  createdAt: Date;
  updatedAt: Date;
}>;

export class ChainMutationLaneConflictError extends Error {
  constructor(message = "Solana mutation lane compare-and-swap conflict") {
    super(message);
    this.name = "ChainMutationLaneConflictError";
  }
}

export class ChainMutationLaneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainMutationLaneValidationError";
  }
}

type LaneDatabase = TransactionRunner & Pick<typeof db, "solanaChainMutationLane">;
type StoreOptions = Readonly<{ provider?: DatabaseProvider }>;
type Fence = Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  epoch: number;
  now: Date;
}>;

function canonicalKey(input: ChainMutationLaneKey): ChainMutationLaneKey {
  const chainMarketId = input.chainMarketId;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(chainMarketId) || BigInt(chainMarketId) > MAX_U64) {
    throw new ChainMutationLaneValidationError("Chain market id must be a canonical u64 decimal string");
  }
  try {
    return Object.freeze({
      genesisHash: address(input.genesisHash).toString(),
      programAddress: address(input.programAddress).toString(),
      walletAddress: address(input.walletAddress).toString(),
      chainMarketId,
    });
  } catch {
    throw new ChainMutationLaneValidationError("Mutation lane identity contains an invalid Solana address");
  }
}

function owner(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value)) {
    throw new ChainMutationLaneValidationError("Mutation lane owner is invalid");
  }
  return value;
}

export function hashChainMutationLaneToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new ChainMutationLaneValidationError("Mutation lane token is invalid");
  }
  return createHash("sha256").update(value).digest("hex");
}

function instant(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ChainMutationLaneValidationError(`Mutation lane ${label} is invalid`);
  }
  return new Date(value);
}

function leaseWindow(nowValue: Date, expiresAtValue: Date): { now: Date; expiresAt: Date } {
  const now = instant(nowValue, "clock"), expiresAt = instant(expiresAtValue, "expiry");
  if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() - now.getTime() > MAX_LEASE_MS) {
    throw new ChainMutationLaneValidationError("Mutation lane lease must be greater than zero and at most five minutes");
  }
  return { now, expiresAt };
}

function validateRow(row: SolanaChainMutationLane): SolanaChainMutationLane {
  canonicalKey(row);
  if (!Number.isInteger(row.revision) || row.revision < 0 || row.revision > MAX_COUNTER
    || !Number.isInteger(row.leaseEpoch) || row.leaseEpoch < 0 || row.leaseEpoch > MAX_COUNTER) {
    throw new ChainMutationLaneConflictError("Stored mutation lane counters are invalid");
  }
  const fields = [row.leaseOwner, row.leaseTokenHash, row.leaseExpiresAt];
  if (fields.some(value => value === null) && fields.some(value => value !== null)) {
    throw new ChainMutationLaneConflictError("Stored mutation lane lease is inconsistent");
  }
  if (row.leaseOwner !== null && (row.leaseEpoch < 1 || !/^[0-9a-f]{64}$/.test(row.leaseTokenHash!))) {
    throw new ChainMutationLaneConflictError("Stored mutation lane fence is invalid");
  }
  return row;
}

function publicLane(row: SolanaChainMutationLane): ChainMutationLane {
  validateRow(row);
  return Object.freeze({
    id: row.id,
    key: Object.freeze({ genesisHash: row.genesisHash, programAddress: row.programAddress,
      walletAddress: row.walletAddress, chainMarketId: row.chainMarketId }),
    revision: row.revision,
    leaseEpoch: row.leaseEpoch,
    lease: row.leaseOwner === null ? null : Object.freeze({
      owner: row.leaseOwner,
      epoch: row.leaseEpoch,
      expiresAt: new Date(row.leaseExpiresAt!),
    }),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

function identityWhere(key: ChainMutationLaneKey): Prisma.SolanaChainMutationLaneWhereUniqueInput {
  return { genesisHash_programAddress_walletAddress_chainMarketId: key };
}

function casWhere(row: SolanaChainMutationLane): Prisma.SolanaChainMutationLaneWhereInput {
  return {
    id: row.id,
    revision: row.revision,
    leaseEpoch: row.leaseEpoch,
    leaseOwner: row.leaseOwner,
    leaseTokenHash: row.leaseTokenHash,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

function assertRevision(row: SolanaChainMutationLane, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || row.revision !== expectedRevision) {
    throw new ChainMutationLaneConflictError("Mutation lane revision fence is stale");
  }
  if (row.revision >= MAX_COUNTER) throw new ChainMutationLaneConflictError("Mutation lane revision is exhausted");
}

function assertFence(row: SolanaChainMutationLane, input: Fence) {
  assertRevision(row, input.expectedRevision);
  const now = instant(input.now, "clock");
  const tokenHash = hashChainMutationLaneToken(input.token);
  if (row.leaseOwner !== owner(input.owner) || row.leaseTokenHash !== tokenHash
    || row.leaseEpoch !== input.epoch || !row.leaseExpiresAt
    || row.leaseExpiresAt.getTime() <= now.getTime()) {
    throw new ChainMutationLaneConflictError("Mutation lane lease fence is stale or expired");
  }
  return { now, tokenHash };
}

export class PrismaChainMutationLaneStore {
  private readonly provider: DatabaseProvider;

  constructor(private readonly database: LaneDatabase = db, options: StoreOptions = {}) {
    this.provider = options.provider ?? databaseProviderFromUrl();
  }

  private transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runSerializableTransaction(this.database, operation, { provider: this.provider });
  }

  async loadOrCreate(input: ChainMutationLaneKey): Promise<ChainMutationLane> {
    const key = canonicalKey(input);
    const operation = async (tx: Prisma.TransactionClient) => {
      const existing = await tx.solanaChainMutationLane.findUnique({ where: identityWhere(key) });
      if (existing) return publicLane(existing);
      return publicLane(await tx.solanaChainMutationLane.create({ data: key }));
    };
    try {
      return await this.transaction(operation);
    } catch (error) {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      return this.transaction(async tx => {
        const existing = await tx.solanaChainMutationLane.findUnique({ where: identityWhere(key) });
        if (!existing) throw new ChainMutationLaneConflictError("Concurrent mutation lane creation was not observable");
        return publicLane(existing);
      });
    }
  }

  async load(input: ChainMutationLaneKey): Promise<ChainMutationLane | null> {
    const key = canonicalKey(input);
    return this.transaction(async tx => {
      const row = await tx.solanaChainMutationLane.findUnique({ where: identityWhere(key) });
      return row ? publicLane(row) : null;
    });
  }

  async acquire(input: ChainMutationLaneKey & Readonly<{
    expectedRevision: number;
    owner: string;
    token: string;
    now: Date;
    expiresAt: Date;
  }>): Promise<ChainMutationLane> {
    const key = canonicalKey(input), laneOwner = owner(input.owner);
    const tokenHash = hashChainMutationLaneToken(input.token);
    const { now, expiresAt } = leaseWindow(input.now, input.expiresAt);
    return this.transaction(async tx => {
      const row = validateRow(await tx.solanaChainMutationLane.findUniqueOrThrow({ where: identityWhere(key) }));
      assertRevision(row, input.expectedRevision);
      if (row.leaseOwner !== null && row.leaseExpiresAt!.getTime() > now.getTime()) {
        throw new ChainMutationLaneConflictError("Mutation lane already has an active lease");
      }
      if (row.leaseTokenHash === tokenHash) {
        throw new ChainMutationLaneConflictError("Mutation lane reacquisition requires a fresh token");
      }
      if (row.leaseEpoch >= MAX_COUNTER) throw new ChainMutationLaneConflictError("Mutation lane epoch is exhausted");
      const changed = await tx.solanaChainMutationLane.updateMany({
        where: casWhere(row),
        data: { revision: row.revision + 1, leaseOwner: laneOwner, leaseTokenHash: tokenHash,
          leaseEpoch: row.leaseEpoch + 1, leaseExpiresAt: expiresAt, updatedAt: now },
      });
      if (changed.count !== 1) throw new ChainMutationLaneConflictError();
      return publicLane(await tx.solanaChainMutationLane.findUniqueOrThrow({ where: { id: row.id } }));
    });
  }

  async renew(input: ChainMutationLaneKey & Fence & Readonly<{ expiresAt: Date }>): Promise<ChainMutationLane> {
    const key = canonicalKey(input);
    const window = leaseWindow(input.now, input.expiresAt);
    return this.transaction(async tx => {
      const row = validateRow(await tx.solanaChainMutationLane.findUniqueOrThrow({ where: identityWhere(key) }));
      assertFence(row, input);
      if (window.expiresAt.getTime() <= row.leaseExpiresAt!.getTime()) {
        throw new ChainMutationLaneValidationError("Mutation lane renewal must extend the lease");
      }
      const changed = await tx.solanaChainMutationLane.updateMany({
        where: casWhere(row),
        data: { revision: row.revision + 1, leaseExpiresAt: window.expiresAt, updatedAt: window.now },
      });
      if (changed.count !== 1) throw new ChainMutationLaneConflictError();
      return publicLane(await tx.solanaChainMutationLane.findUniqueOrThrow({ where: { id: row.id } }));
    });
  }

  async release(input: ChainMutationLaneKey & Fence): Promise<ChainMutationLane> {
    const key = canonicalKey(input);
    const now = instant(input.now, "clock");
    return this.transaction(async tx => {
      const row = validateRow(await tx.solanaChainMutationLane.findUniqueOrThrow({ where: identityWhere(key) }));
      assertFence(row, input);
      const changed = await tx.solanaChainMutationLane.updateMany({
        where: casWhere(row),
        data: { revision: row.revision + 1, leaseOwner: null, leaseTokenHash: null,
          leaseExpiresAt: null, updatedAt: now },
      });
      if (changed.count !== 1) throw new ChainMutationLaneConflictError();
      return publicLane(await tx.solanaChainMutationLane.findUniqueOrThrow({ where: { id: row.id } }));
    });
  }
}
