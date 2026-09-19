import { Prisma, type ChainCommand } from "@prisma/client";

import {
  CHAIN_COMMAND_STATUSES,
  assertChainCommandReplay,
  createSignedWireJournal,
  type AcceptedChainCommandIdentity,
  type ChainCommandScope,
  type ChainCommandSignedWireRecord,
  type ChainCommandStatus,
  type SignedWireInput,
} from "@/lib/solana/chain-command";
import {
  ChainCommandConflictError,
  acquireChainCommandLease,
  assertChainCommandCasApplied,
  renewChainCommandLease,
  transitionChainCommand,
  type ChainCommandCasPlan,
  type ChainCommandState,
} from "@/lib/solana/chain-command-state";
import {
  runSerializableTransaction,
  databaseProviderFromUrl,
  type DatabaseProvider,
  type TransactionRunner,
} from "@/lib/serializable-transaction";

export class ChainCommandNotFoundError extends Error {
  constructor() {
    super("Chain command was not found");
    this.name = "ChainCommandNotFoundError";
  }
}

export type StoredChainCommand = Readonly<{
  identity: AcceptedChainCommandIdentity;
  state: ChainCommandState;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Deliberately omits request data, actors, idempotency keys, lease data, wire
 * bytes, and internal failure diagnostics. */
export type PublicChainCommandStatus = Readonly<{
  id: string;
  operation: string;
  status: ChainCommandStatus;
  revision: number;
  attemptCount: number;
  acceptedAt: Date;
  preparedAt: Date | null;
  signedAt: Date | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  finalizedAt: Date | null;
  projectedAt: Date | null;
  unknownSince: Date | null;
  updatedAt: Date;
}>;

type StoreOptions = Readonly<{ provider?: DatabaseProvider }>;
type LeaseInput = Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  now: Date;
  expiresAt: Date;
}>;
type FencedInput = Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  epoch: number;
  now: Date;
}>;

const statusSet = new Set<string>(CHAIN_COMMAND_STATUSES);
const scopeSet = new Set<string>(["USER", "MARKET", "SYSTEM"] satisfies ChainCommandScope[]);

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function identityFromRow(row: ChainCommand): AcceptedChainCommandIdentity {
  if ((row.cluster !== "localnet" && row.cluster !== "devnet") || !scopeSet.has(row.scope)) {
    throw new ChainCommandConflictError("Stored chain command identity is invalid");
  }
  return {
    cluster: row.cluster,
    genesisHash: row.genesisHash,
    programAddress: row.programAddress,
    scope: row.scope as ChainCommandScope,
    scopeId: row.scopeId,
    actorId: row.actorId,
    operation: row.operation,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    requestJson: row.requestJson,
  };
}

function stateFromRow(row: ChainCommand): ChainCommandState {
  if (!statusSet.has(row.status)) throw new ChainCommandConflictError("Stored chain command status is invalid");
  const leaseFields = [row.leaseOwner, row.leaseTokenHash, row.leaseExpiresAt];
  if (leaseFields.some(value => value === null) && leaseFields.some(value => value !== null)) {
    throw new ChainCommandConflictError("Stored chain command lease is inconsistent");
  }
  return {
    id: row.id,
    status: row.status as ChainCommandStatus,
    revision: row.revision,
    attemptCount: row.attemptCount,
    leaseEpoch: row.leaseEpoch,
    lease: row.leaseOwner === null ? null : {
      owner: row.leaseOwner,
      tokenHash: row.leaseTokenHash!,
      epoch: row.leaseEpoch,
      expiresAt: row.leaseExpiresAt!,
    },
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    acceptedAt: row.acceptedAt,
    preparedAt: row.preparedAt,
    signedAt: row.signedAt,
    submittedAt: row.submittedAt,
    confirmedAt: row.confirmedAt,
    finalizedAt: row.finalizedAt,
    projectedAt: row.projectedAt,
    unknownSince: row.unknownSince,
  };
}

function storedFromRow(row: ChainCommand): StoredChainCommand {
  return { identity: identityFromRow(row), state: stateFromRow(row), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function mutableData(state: ChainCommandState): Prisma.ChainCommandUpdateManyMutationInput {
  return {
    status: state.status,
    revision: state.revision,
    attemptCount: state.attemptCount,
    leaseEpoch: state.leaseEpoch,
    leaseOwner: state.lease?.owner ?? null,
    leaseTokenHash: state.lease?.tokenHash ?? null,
    leaseExpiresAt: state.lease?.expiresAt ?? null,
    lastErrorCode: state.lastErrorCode,
    lastErrorMessage: state.lastErrorMessage,
    preparedAt: state.preparedAt,
    signedAt: state.signedAt,
    submittedAt: state.submittedAt,
    confirmedAt: state.confirmedAt,
    finalizedAt: state.finalizedAt,
    projectedAt: state.projectedAt,
    unknownSince: state.unknownSince,
  };
}

function casWhere(plan: ChainCommandCasPlan): Prisma.ChainCommandWhereInput {
  const expectedLeaseEpoch = plan.expectedLease?.epoch
    ?? (plan.next.lease === null ? plan.next.leaseEpoch : plan.next.leaseEpoch - 1);
  return {
    id: plan.commandId,
    revision: plan.expectedRevision,
    leaseEpoch: expectedLeaseEpoch,
    leaseOwner: plan.expectedLease?.owner ?? null,
    leaseTokenHash: plan.expectedLease?.tokenHash ?? null,
    leaseExpiresAt: plan.expectedLease?.expiresAt ?? null,
  };
}

function sqliteDate(value: Date | null): string | null {
  return value?.toISOString().replace("T", " ").replace("Z", "") ?? null;
}

function parsedSqliteDate(value: unknown, label: string): Date {
  const text = String(value);
  const date = typeof value === "number" || value instanceof Date || /^[0-9]+$/.test(text)
    ? new Date(value instanceof Date ? value : Number(value))
    : new Date(`${text.replace(" ", "T").replace(/Z$/, "")}Z`);
  if (!Number.isFinite(date.getTime())) throw new ChainCommandConflictError(`Stored ${label} is invalid`);
  return date;
}

const SQLITE_COMMAND_COLUMNS = Prisma.raw(`
  "id", "cluster", "genesisHash", "programAddress", "scope", "scopeId", "actorId", "operation",
  "idempotencyKey", "requestHash", "requestJson", "status", "revision", "leaseOwner", "leaseTokenHash",
  "leaseEpoch", CAST("leaseExpiresAt" AS TEXT) AS "leaseExpiresAt", "attemptCount", "lastErrorCode",
  "lastErrorMessage", CAST("acceptedAt" AS TEXT) AS "acceptedAt", CAST("preparedAt" AS TEXT) AS "preparedAt",
  CAST("signedAt" AS TEXT) AS "signedAt", CAST("submittedAt" AS TEXT) AS "submittedAt",
  CAST("confirmedAt" AS TEXT) AS "confirmedAt", CAST("finalizedAt" AS TEXT) AS "finalizedAt",
  CAST("projectedAt" AS TEXT) AS "projectedAt", CAST("unknownSince" AS TEXT) AS "unknownSince",
  CAST("createdAt" AS TEXT) AS "createdAt", CAST("updatedAt" AS TEXT) AS "updatedAt"
`);

function nullableSqliteDate(value: unknown, label: string): Date | null {
  return value === null ? null : parsedSqliteDate(value, label);
}

function sqliteCommandRow(value: unknown): ChainCommand {
  if (!value || typeof value !== "object") throw new ChainCommandConflictError("Stored chain command row is invalid");
  const row = value as Record<string, unknown>;
  return {
    ...row,
    acceptedAt: parsedSqliteDate(row.acceptedAt, "acceptedAt"),
    preparedAt: nullableSqliteDate(row.preparedAt, "preparedAt"),
    signedAt: nullableSqliteDate(row.signedAt, "signedAt"),
    submittedAt: nullableSqliteDate(row.submittedAt, "submittedAt"),
    confirmedAt: nullableSqliteDate(row.confirmedAt, "confirmedAt"),
    finalizedAt: nullableSqliteDate(row.finalizedAt, "finalizedAt"),
    projectedAt: nullableSqliteDate(row.projectedAt, "projectedAt"),
    unknownSince: nullableSqliteDate(row.unknownSince, "unknownSince"),
    leaseExpiresAt: nullableSqliteDate(row.leaseExpiresAt, "leaseExpiresAt"),
    createdAt: parsedSqliteDate(row.createdAt, "createdAt"),
    updatedAt: parsedSqliteDate(row.updatedAt, "updatedAt"),
  } as ChainCommand;
}

async function loadRow(
  tx: Prisma.TransactionClient,
  commandId: string,
  provider: DatabaseProvider,
): Promise<ChainCommand> {
  const row = provider === "postgresql"
    ? await tx.chainCommand.findUnique({ where: { id: commandId } })
    : (await tx.$queryRaw<unknown[]>(Prisma.sql`
        SELECT ${SQLITE_COMMAND_COLUMNS} FROM "ChainCommand" WHERE "id"=${commandId} LIMIT 1
      `)).map(sqliteCommandRow)[0] ?? null;
  if (!row) throw new ChainCommandNotFoundError();
  return row;
}

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: ChainCommandCasPlan,
  provider: DatabaseProvider,
): Promise<ChainCommand> {
  let count: number;
  if (provider === "sqlite") {
    // Prisma's SQLite adapter normally encodes DateTime as epoch milliseconds,
    // while the migration's write-before-send fence compares against SQLite's
    // text CURRENT_TIMESTAMP. Persist canonical UTC text so the database fence
    // remains meaningful as well as the application-level fence.
    const next = plan.next;
    const expected = plan.expectedLease;
    count = await tx.$executeRaw(Prisma.sql`
      UPDATE "ChainCommand" SET
        "status"=${next.status}, "revision"=${next.revision}, "attemptCount"=${next.attemptCount},
        "leaseEpoch"=${next.leaseEpoch}, "leaseOwner"=${next.lease?.owner ?? null},
        "leaseTokenHash"=${next.lease?.tokenHash ?? null}, "leaseExpiresAt"=${sqliteDate(next.lease?.expiresAt ?? null)},
        "lastErrorCode"=${next.lastErrorCode}, "lastErrorMessage"=${next.lastErrorMessage},
        "preparedAt"=${sqliteDate(next.preparedAt)}, "signedAt"=${sqliteDate(next.signedAt)},
        "submittedAt"=${sqliteDate(next.submittedAt)}, "confirmedAt"=${sqliteDate(next.confirmedAt)},
        "finalizedAt"=${sqliteDate(next.finalizedAt)}, "projectedAt"=${sqliteDate(next.projectedAt)},
        "unknownSince"=${sqliteDate(next.unknownSince)}, "updatedAt"=${sqliteDate(new Date())}
      WHERE "id"=${plan.commandId} AND "revision"=${plan.expectedRevision}
        AND "leaseEpoch"=${expected?.epoch ?? (next.lease === null ? next.leaseEpoch : next.leaseEpoch - 1)}
        AND "leaseOwner" IS ${expected?.owner ?? null}
        AND "leaseTokenHash" IS ${expected?.tokenHash ?? null}
        AND "leaseExpiresAt" IS ${sqliteDate(expected?.expiresAt ?? null)}
    `);
  } else {
    const updated = await tx.chainCommand.updateMany({ where: casWhere(plan), data: mutableData(plan.next) });
    count = updated.count;
  }
  if (count !== 1) throw new ChainCommandConflictError();
  const row = await loadRow(tx, plan.commandId, provider);
  assertChainCommandCasApplied(plan, stateFromRow(row));
  return row;
}

function idempotencyWhere(identity: AcceptedChainCommandIdentity): Prisma.ChainCommandWhereUniqueInput {
  return {
    genesisHash_programAddress_scope_scopeId_operation_idempotencyKey: {
      genesisHash: identity.genesisHash,
      programAddress: identity.programAddress,
      scope: identity.scope,
      scopeId: identity.scopeId,
      operation: identity.operation,
      idempotencyKey: identity.idempotencyKey,
    },
  };
}

async function findIdempotentRow(
  tx: Prisma.TransactionClient,
  identity: AcceptedChainCommandIdentity,
  provider: DatabaseProvider,
): Promise<ChainCommand | null> {
  if (provider === "postgresql") {
    return tx.chainCommand.findUnique({ where: idempotencyWhere(identity) });
  }
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
    SELECT ${SQLITE_COMMAND_COLUMNS} FROM "ChainCommand" WHERE "genesisHash"=${identity.genesisHash}
      AND "programAddress"=${identity.programAddress} AND "scope"=${identity.scope}
      AND "scopeId"=${identity.scopeId} AND "operation"=${identity.operation}
      AND "idempotencyKey"=${identity.idempotencyKey} LIMIT 1
  `);
  return rows.length === 0 ? null : sqliteCommandRow(rows[0]);
}

export class PrismaChainCommandStore {
  private readonly provider: DatabaseProvider;

  constructor(private readonly database: TransactionRunner, private readonly options: StoreOptions = {}) {
    this.provider = options.provider ?? databaseProviderFromUrl();
  }

  private transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runSerializableTransaction(this.database, operation, { provider: this.provider });
  }

  async createOrReplay(identity: AcceptedChainCommandIdentity): Promise<StoredChainCommand> {
    const operation = async (tx: Prisma.TransactionClient) => {
      const existing = await findIdempotentRow(tx, identity, this.provider);
      if (existing) {
        assertChainCommandReplay(identityFromRow(existing), identity);
        return storedFromRow(existing);
      }
      const created = await tx.chainCommand.create({ data: identity });
      return storedFromRow(created);
    };
    try {
      return await this.transaction(operation);
    } catch (error) {
      // A concurrent creator can win the unique key after our initial read. Its
      // transaction is complete before this replay transaction observes it.
      if (!isUniqueConstraintError(error)) throw error;
      return this.transaction(async tx => {
        const existing = await findIdempotentRow(tx, identity, this.provider);
        if (!existing) throw new ChainCommandConflictError("Concurrent chain command creation was not observable");
        assertChainCommandReplay(identityFromRow(existing), identity);
        return storedFromRow(existing);
      });
    }
  }

  async load(commandId: string): Promise<StoredChainCommand> {
    return this.transaction(async tx => storedFromRow(await loadRow(tx, commandId, this.provider)));
  }

  async acquireLease(commandId: string, input: LeaseInput): Promise<StoredChainCommand> {
    return this.transaction(async tx => {
      const current = stateFromRow(await loadRow(tx, commandId, this.provider));
      return storedFromRow(await applyPlan(tx, acquireChainCommandLease(current, input), this.provider));
    });
  }

  async renewLease(commandId: string, input: FencedInput & Readonly<{ expiresAt: Date }>): Promise<StoredChainCommand> {
    return this.transaction(async tx => {
      const current = stateFromRow(await loadRow(tx, commandId, this.provider));
      return storedFromRow(await applyPlan(tx, renewChainCommandLease(current, input), this.provider));
    });
  }

  async transition(commandId: string, input: FencedInput & Readonly<{
    to: ChainCommandStatus;
    errorCode?: string;
    errorMessage?: string;
  }>): Promise<StoredChainCommand> {
    return this.transaction(async tx => {
      const current = stateFromRow(await loadRow(tx, commandId, this.provider));
      return storedFromRow(await applyPlan(tx, transitionChainCommand(current, input), this.provider));
    });
  }

  /** Atomically persists the exact signed wire and marks the command SIGNED.
   * The caller must complete this transaction before attempting RPC submission. */
  async appendSignedWireBeforeSend(input: Readonly<{
    wire: SignedWireInput;
    owner: string;
    token: string;
    epoch: number;
    now: Date;
  }>): Promise<Readonly<{ command: StoredChainCommand; journal: ChainCommandSignedWireRecord }>> {
    const journal = createSignedWireJournal(input.wire);
    return this.transaction(async tx => {
      const current = stateFromRow(await loadRow(tx, journal.commandId, this.provider));
      if (journal.commandRevision !== current.revision || journal.leaseEpoch !== current.leaseEpoch) {
        throw new ChainCommandConflictError("Signed wire was prepared against a stale command fence");
      }
      const plan = transitionChainCommand(current, {
        expectedRevision: journal.commandRevision,
        owner: input.owner,
        token: input.token,
        epoch: input.epoch,
        now: input.now,
        to: "SIGNED",
      });
      await tx.chainCommandSignedWire.create({ data: journal });
      const row = await applyPlan(tx, plan, this.provider);
      return { command: storedFromRow(row), journal };
    });
  }

  async publicStatus(commandId: string): Promise<PublicChainCommandStatus> {
    const command = await this.load(commandId);
    const state = command.state;
    return {
      id: state.id,
      operation: command.identity.operation,
      status: state.status,
      revision: state.revision,
      attemptCount: state.attemptCount,
      acceptedAt: state.acceptedAt,
      preparedAt: state.preparedAt,
      signedAt: state.signedAt,
      submittedAt: state.submittedAt,
      confirmedAt: state.confirmedAt,
      finalizedAt: state.finalizedAt,
      projectedAt: state.projectedAt,
      unknownSince: state.unknownSince,
      updatedAt: command.updatedAt,
    };
  }
}
