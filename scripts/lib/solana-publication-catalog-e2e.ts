/** Subprocess-only real chain -> SQLite catalog proof. No mocked boundaries.
 * Environment must point at the NEW database created by the publication suite.
 * Stateful application imports occur only after validating that isolation. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { loadPublicationManifest, readPublicationSnapshot, writePublicationFile } from "./solana-publication";
import { resolveSolanaRuntime } from "../../src/lib/solana/runtime";

async function main() {
  assert.equal(process.argv.length, 3, "Explicit isolated catalog directory required");
  const directory = await realpath(process.argv[2]);
  assert.equal(directory, process.env.GOOSEY_PUBLICATION_CATALOG_DIRECTORY);
  const parts = path.relative(await realpath("/tmp"), directory).split(path.sep);
  assert(parts.length === 3 && /^goosey-solana-runner-[A-Za-z0-9]+$/.test(parts[0])
    && parts[1] === "publication-evidence" && parts[2] === "catalog", "Only isolated publication evidence directory allowed");
  const databaseFile = path.join(directory, "catalog.db");
  const dbStat = await lstat(databaseFile);
  assert(dbStat.isFile() && !dbStat.isSymbolicLink() && (dbStat.mode & 0o077) === 0);
  assert.equal(process.env.DATABASE_URL, `file:${databaseFile}`); assert.equal(process.env.DATABASE_PROVIDER, "sqlite");
  assert.equal(process.env.NODE_ENV, "test");
  const evidence = path.dirname(directory), runnerDir = path.dirname(evidence);
  const runner = JSON.parse(await readFile(path.join(runnerDir, "manifest.json"), "utf8"));
  assert.equal(runner.suite, "publication");
  const runtime = resolveSolanaRuntime(); assert.equal(runtime.cluster, "localnet");
  assert.equal(runtime.rpcUrl, new URL(runner.rpc).href); assert.equal(runtime.genesisHash, runner.genesis); assert.equal(runtime.programAddress, runner.program);
  const publication = await loadPublicationManifest(await readFile(path.join(evidence, "manifest.json")), runtime);
  const { manifest, digest } = publication;
  const termsDirectory = path.join(evidence, "terms-store"), chainMarketId = BigInt(manifest.binding.marketId);
  const { address } = await import("@solana/kit");
  const seats = address(JSON.parse(await readFile(path.join(evidence, "signing-state/seats-address.json"), "utf8")).address);
  const chainBefore = await readPublicationSnapshot(runtime, publication, seats, AbortSignal.timeout(20_000));
  assert(chainBefore.terms?.sealed && chainBefore.terms.acceptanceBits === 3 && chainBefore.resolution?.phase === 0);
  // This is the generated SQLite client behind the actual application singleton,
  // loaded in this fresh process only after exact database isolation checks.
  const { db, requireDatabaseStartup } = await import("../../src/lib/db");
  try {
    await requireDatabaseStartup();
    const { registerSolanaMarket } = await import("../../src/lib/solana/market-catalog");
    assert.equal(await db.user.count(), 0, "Existing database refused"); assert.equal(await db.market.count(), 0);
    const admin = await db.user.create({ data: { email: "publication-catalog-admin@test.invalid", username: "publication_catalog_admin",
      displayName: "ISOLATED TEST Catalog Administrator", passwordHash: `disabled-test-login:${randomBytes(32).toString("hex")}`,
      role: "ADMIN", status: "ACTIVE", emailVerifiedAt: new Date() } });
    assert.equal(admin.balanceMilli, 0n); assert.equal(admin.realizedPnlMilli, 0n);
    const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
    // Compare EVERY existing table outside the three intentionally added catalog
    // tables, not just empty ledger counts. quote/hex keep bigints/blobs exact.
    async function unaffectedState() {
      const tables = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const rows: Record<string, string[]> = {};
      for (const table of tables) {
        if (["Market", "SolanaMarketBinding", "AuditLog"].includes(table.name)) continue;
        const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_xinfo(${identifier(table.name)})`);
        const fields = columns.map(c => { const col = identifier(c.name); return `json_array(typeof(${col}),quote(${col}),CASE WHEN typeof(${col})='text' THEN hex(CAST(${col} AS BLOB)) END)`; });
        const records = await db.$queryRawUnsafe<Array<{ row: string }>>(`SELECT json_array(${fields.join(",")}) AS row FROM ${identifier(table.name)} ORDER BY row COLLATE BINARY`);
        rows[table.name] = records.map(row => row.row);
      }
      return rows;
    }
    const financialBefore = await unaffectedState();
    for (const [table, rows] of Object.entries(financialBefore)) if (table !== "User") assert.deepEqual(rows, [], `Unexpected pre-existing ${table} rows`);
    // Actual SQLite guards additionally reject attempted writes, including a
    // write followed by a compensating write that a final-state comparison alone
    // would miss. These exist ONLY in this owned disposable database.
    for (const table of Object.keys(financialBefore)) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const name = `publication_no_write_${createHash("sha256").update(table + operation).digest("hex")}`;
        await db.$executeRawUnsafe(`CREATE TRIGGER ${identifier(name)} BEFORE ${operation} ON ${identifier(table)} BEGIN SELECT RAISE(ABORT, 'publication catalog proof forbids noncatalog writes'); END`);
      }
    }
    const input = { actorUserId: admin.id, runtime, termsDirectory, chainMarketId,
      metadata: { slug: "isolated-publication-catalog-test", shortTitle: "ISOLATED TEST publication",
        description: "ISOLATED TEST ONLY catalog registration for this disposable validator and private test database. Not a real Hack the North market.", category: "Isolated Tests" } };
    const first = await registerSolanaMarket({ ...input, signal: AbortSignal.timeout(30_000) });
    assert(first.created); const market = first.market;
    assert.equal(market.executionBackend, "SOLANA"); assert.equal(market.status, "DRAFT"); assert.equal(market.pricingModel, "ORDER_BOOK");
    assert.equal(market.acceptingOrders, false); assert.equal(market.collateralAccountId, null); assert.equal(market.createdById, admin.id);
    assert.equal(market.title, manifest.question); assert.equal(market.payoutMilli, BigInt(manifest.economics.payoutMilli));
    assert.equal(market.feeBps, Number(manifest.economics.feeBps)); assert.equal(market.volumeMilli, 0n);
    assert.equal(market.yesShares, 0); assert.equal(market.noShares, 0);
    assert.equal(market.closesAt.getTime(), Number(BigInt(manifest.economics.closesAt) * 1000n));
    assert.equal(market.resolvesAt?.getTime(), Number(BigInt(manifest.economics.resolvesAt) * 1000n));
    assert.equal(market.rules, `YES: ${manifest.rules.yes}\n\nNO: ${manifest.rules.no}\n\nVOID: ${manifest.rules.void}`);
    assert.equal(market.resolutionSource, manifest.sources.map(source => source.uri).join("\n"));
    const identity = { cluster: runtime.cluster, genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
      marketAddress: manifest.binding.market, chainMarketId: chainMarketId.toString() };
    for (const [key, value] of Object.entries(identity)) assert.equal(first.binding[key as keyof typeof identity], value);
    assert.equal(first.binding.marketId, market.id);
    async function catalogState() { return { markets: await db.market.findMany({ orderBy: { id: "asc" } }),
      bindings: await db.solanaMarketBinding.findMany({ orderBy: { id: "asc" } }), audits: await db.auditLog.findMany({ orderBy: { id: "asc" } }) }; }
    const registered = await catalogState();
    assert.equal(registered.markets.length, 1); assert.equal(registered.bindings.length, 1); assert.equal(registered.audits.length, 1);
    const audit = registered.audits[0];
    assert.equal(audit.action, "REGISTER_SOLANA_MARKET"); assert.equal(audit.actorUserId, admin.id);
    assert.equal(audit.entityType, "MARKET"); assert.equal(audit.entityId, market.id);
    const metadata = JSON.parse(audit.metadata);
    assert(BigInt(metadata.finalizedSlot) >= chainBefore.slot);
    assert.deepEqual(metadata, { ...identity, digest, finalizedSlot: metadata.finalizedSlot, visibility: "DRAFT", financialLedgerCreated: false });
    assert.deepEqual(await unaffectedState(), financialBefore, "Registration changed non-catalog/financial SQL data");
    const replay = await registerSolanaMarket({ ...input, signal: AbortSignal.timeout(30_000) });
    assert.equal(replay.created, false); assert.equal(replay.market.id, first.market.id); assert.equal(replay.binding.id, first.binding.id);
    assert.deepEqual(await catalogState(), registered, "Replay mutated catalog/audit rows");
    assert.deepEqual(await unaffectedState(), financialBefore, "Replay changed non-catalog/financial SQL data");
    const chainAfter = await readPublicationSnapshot(runtime, publication, seats, AbortSignal.timeout(20_000));
    assert(chainAfter.slot >= BigInt(metadata.finalizedSlot));
    assert.deepEqual(chainAfter.market, chainBefore.market); assert.deepEqual(chainAfter.terms, chainBefore.terms); assert.deepEqual(chainAfter.resolution, chainBefore.resolution);
    const integrity = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
    assert.deepEqual(await db.$queryRawUnsafe("PRAGMA foreign_key_check"), []);
    const result = { status: "PASS", scope: "actual finalized RPC + immutable terms + generated SQLite client + shipping catalog service; no mocks",
      marketId: market.id, ...identity, digest, auditFinalizedSlot: metadata.finalizedSlot, visibility: market.status,
      executionBackend: market.executionBackend, marketCount: 1, bindingCount: 1, auditCount: 1, replayCreated: replay.created,
      financialStateSha256: createHash("sha256").update(JSON.stringify(financialBefore)).digest("hex"), unchangedTableCount: Object.keys(financialBefore).length,
      forbiddenWriteGuards: Object.keys(financialBefore).length * 3 };
    await writePublicationFile(directory, "result.json", JSON.stringify(result, null, 2));
    console.log("PASS actual chain-to-catalog registration: one SOLANA DRAFT, canonical binding/audit, exact replay, no SQL financial mutations");
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Isolated catalog proof failed"); process.exitCode = 1; });
