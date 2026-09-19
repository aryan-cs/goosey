import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { address, getBase58Decoder, signature, type Signature } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const defaults = vi.hoisted(() => ({
  transaction: vi.fn(() => {
    throw new Error("The default database must not be used by this isolated integration test.");
  }),
  startup: vi.fn(() => {
    throw new Error("The default database startup guard must not run for an injected client.");
  }),
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: defaults.transaction },
  requireDatabaseStartup: defaults.startup,
}));

import { deriveGooseyMarketAddresses } from "./escrow-client";
import type { SolanaRuntime } from "./runtime";
import { readSolanaTradeTape } from "./trade-tape";

// Explicit persistence fixtures only. The suite creates and destroys its own
// SQLite database and never connects to the shared application DB or localnet.
const runtime: SolanaRuntime = {
  cluster: "localnet",
  rpcUrl: "http://127.0.0.1:1",
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
};
const encodedSignature = (seed: number) => signature(
  getBase58Decoder().decode(new Uint8Array(64).fill(seed)),
);
const coverageStart = encodedSignature(1);
const head = encodedSignature(2);
const signatures = [encodedSignature(3), encodedSignature(4), encodedSignature(5)]
  .sort((left, right) => left.localeCompare(right));
const [lowSignature, middleSignature, highSignature] = signatures as [Signature, Signature, Signature];
const foreignSignature = encodedSignature(6);
const updatedAt = new Date("2026-09-19T18:30:00.000Z");
const U64_MAX = (1n << 64n) - 1n;

let directory: string;
let databasePath: string;
let database: PrismaClient;
let marketAddress: string;
let foreignMarketAddress: string;

function canonicalPayload(market: string, values: {
  makerOrderId: bigint;
  takerOrderId: bigint;
  makerSeat: bigint;
  takerSeat: bigint;
  quantity: bigint;
  yesPrice: bigint;
  makerFee: bigint;
  takerFee: bigint;
}) {
  const payload = {
    kind: "TradeExecuted",
    makerAction: "1",
    makerFee: values.makerFee.toString(),
    makerOrderId: values.makerOrderId.toString(),
    makerOutcome: "0",
    makerSeat: values.makerSeat.toString(),
    market,
    quantity: values.quantity.toString(),
    takerAction: "0",
    takerFee: values.takerFee.toString(),
    takerOrderId: values.takerOrderId.toString(),
    takerOutcome: "1",
    takerSeat: values.takerSeat.toString(),
    yesPrice: values.yesPrice.toString(),
  };
  return JSON.stringify(Object.fromEntries(
    Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

async function insertReceipt(signatureValue: Signature, slot: bigint, events: Array<{
  market: string;
  logIndex: number;
  values: Parameters<typeof canonicalPayload>[1];
}>) {
  await database.solanaTransactionReceipt.create({
    data: {
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      signature: signatureValue,
      slot,
      status: "VERIFIED_SUCCESS",
      eventCount: events.length,
      decoderVersion: 1,
      events: {
        create: events.map(({ market, logIndex, values }) => ({
          eventKey: `${runtime.genesisHash}:${runtime.programAddress}:${signatureValue}:${logIndex}`,
          logIndex,
          invocationDepth: 1,
          kind: "TradeExecuted",
          payload: canonicalPayload(market, values),
          schemaVersion: 1,
          marketAddress: market,
        })),
      },
    },
  });
}

function dumpDatabase() {
  return execFileSync("sqlite3", ["-batch", "-bail", "-init", "/dev/null", databasePath, ".dump"], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "goosey-trade-tape-integration-"));
  databasePath = path.join(directory, "isolated.db");
  const databaseUrl = `file:${databasePath}`;
  const schema = execFileSync(
    path.join(process.cwd(), "node_modules/.bin/prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "test",
        DATABASE_PROVIDER: "sqlite",
        DATABASE_URL: databaseUrl,
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  execFileSync("sqlite3", ["-batch", "-bail", "-init", "/dev/null", databasePath], {
    input: `PRAGMA foreign_keys=ON;\n${schema}`,
    timeout: 20_000,
  });
  database = new PrismaClient({ datasourceUrl: databaseUrl });
  await database.$connect();

  marketAddress = (await deriveGooseyMarketAddresses({
    programAddress: runtime.programAddress,
    marketId: 7n,
  })).market;
  foreignMarketAddress = (await deriveGooseyMarketAddresses({
    programAddress: runtime.programAddress,
    marketId: 8n,
  })).market;

  await database.solanaIngestionCursor.create({
    data: {
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      coverageStartSignature: coverageStart,
      committedHeadSignature: null,
      scanHeadSignature: head,
      scanBeforeSignature: lowSignature,
      backfillComplete: false,
      revision: 3,
      updatedAt,
    },
  });

  await insertReceipt(highSignature, 100n, [
    {
      market: marketAddress,
      logIndex: 8,
      values: {
        makerOrderId: U64_MAX,
        takerOrderId: U64_MAX - 1n,
        makerSeat: U64_MAX - 2n,
        takerSeat: U64_MAX - 3n,
        quantity: U64_MAX - 4n,
        yesPrice: U64_MAX - 5n,
        makerFee: U64_MAX - 6n,
        takerFee: U64_MAX - 7n,
      },
    },
    {
      market: marketAddress,
      logIndex: 7,
      values: {
        makerOrderId: 102n,
        takerOrderId: 202n,
        makerSeat: 302n,
        takerSeat: 402n,
        quantity: 502n,
        yesPrice: 602n,
        makerFee: 702n,
        takerFee: 802n,
      },
    },
  ]);
  await insertReceipt(middleSignature, 100n, [{
    market: marketAddress,
    logIndex: 9,
    values: {
      makerOrderId: 103n,
      takerOrderId: 203n,
      makerSeat: 303n,
      takerSeat: 403n,
      quantity: 503n,
      yesPrice: 603n,
      makerFee: 703n,
      takerFee: 803n,
    },
  }]);
  await insertReceipt(lowSignature, 99n, [{
    market: marketAddress,
    logIndex: 2,
    values: {
      makerOrderId: 104n,
      takerOrderId: 204n,
      makerSeat: 304n,
      takerSeat: 404n,
      quantity: 504n,
      yesPrice: 604n,
      makerFee: 704n,
      takerFee: 804n,
    },
  }]);
  await insertReceipt(foreignSignature, 101n, [{
    market: foreignMarketAddress,
    logIndex: 10,
    values: {
      makerOrderId: 999n,
      takerOrderId: 998n,
      makerSeat: 997n,
      takerSeat: 996n,
      quantity: 995n,
      yesPrice: 994n,
      makerFee: 993n,
      takerFee: 992n,
    },
  }]);
}, 30_000);

afterAll(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("verified Solana trade tape with real isolated SQLite", () => {
  it("filters by canonical market and keyset-paginates deterministically without mutation", async () => {
    const before = dumpDatabase();
    const first = await readSolanaTradeTape(runtime, 7n, { limit: 2 }, database);

    expect(first.coverage).toEqual({
      status: "partial",
      coverageStartSignature: coverageStart,
      headSignature: head,
      backfillComplete: false,
      revision: 3,
      updatedAt,
      fullHistory: false,
    });
    expect(first.items.map(item => [item.slot, item.signature, item.logIndex])).toEqual([
      [100n, highSignature, 8],
      [100n, highSignature, 7],
    ]);
    expect(first.items[0]).toMatchObject({
      makerOrderId: U64_MAX,
      takerOrderId: U64_MAX - 1n,
      makerSeat: U64_MAX - 2n,
      takerSeat: U64_MAX - 3n,
      quantity: U64_MAX - 4n,
      yesPrice: U64_MAX - 5n,
      makerFee: U64_MAX - 6n,
      takerFee: U64_MAX - 7n,
      makerOutcome: "YES",
      makerAction: "SELL",
      takerOutcome: "NO",
      takerAction: "BUY",
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await readSolanaTradeTape(runtime, 7n, {
      limit: 2,
      cursor: first.nextCursor!,
    }, database);
    expect(second.items.map(item => [item.slot, item.signature, item.logIndex])).toEqual([
      [100n, middleSignature, 9],
      [99n, lowSignature, 2],
    ]);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items]).toHaveLength(4);
    expect([...first.items, ...second.items].some(item => item.signature === foreignSignature)).toBe(false);
    expect(dumpDatabase()).toBe(before);
    expect(defaults.startup).not.toHaveBeenCalled();
    expect(defaults.transaction).not.toHaveBeenCalled();
  });

  it("reports only bounded completion and leaves the completed journal unchanged", async () => {
    await database.solanaIngestionCursor.update({
      where: {
        genesisHash_programAddress: {
          genesisHash: runtime.genesisHash,
          programAddress: runtime.programAddress,
        },
      },
      data: {
        committedHeadSignature: head,
        scanHeadSignature: null,
        scanBeforeSignature: null,
        backfillComplete: true,
        revision: 4,
        updatedAt,
      },
    });
    const before = dumpDatabase();

    const result = await readSolanaTradeTape(runtime, 7n, { limit: 50 }, database);

    expect(result.coverage).toEqual({
      status: "bounded_complete",
      coverageStartSignature: coverageStart,
      headSignature: head,
      backfillComplete: true,
      revision: 4,
      updatedAt,
      fullHistory: false,
    });
    expect(result.items).toHaveLength(4);
    expect(result.items.every(item => item.signature !== foreignSignature)).toBe(true);
    expect(dumpDatabase()).toBe(before);
  });
});
