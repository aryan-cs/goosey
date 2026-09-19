/** Real publication CLI integration. TEST-ONLY market on the fresh isolated
 * runner's ledger. No public/shared deployments, database, grants to participants,
 * invented production terms, or injected account state. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  generateKeyPairSigner, getAddressDecoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Instruction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { buildInitializeInstruction, buildAuthorizeEnrollmentInstruction, deriveGooseyProgramAddresses } from "../src/lib/solana/program-client";
import { buildCreateMarketInstructions, deriveGooseySeatAddresses, GOOSEY_SEATS_ACCOUNT_SPACE } from "../src/lib/solana/escrow-client";
import { buildAcceptMarketTermsInstruction } from "../src/lib/solana/market-terms-client";
import { encodeMarketTerms, type MarketTerms } from "../src/lib/solana/market-terms";
import { readGooseyConfiguration } from "../src/lib/solana/configuration";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";
import { trackTransactionStatus } from "../src/lib/solana/transaction-status";
import { verifyLocalnetProgramData, elfHash } from "../src/lib/solana/localnet-manifest";
import { loadPublicationManifest, publicationComputeBudget, readPublicationSnapshot, writePublicationFile } from "./lib/solana-publication";

const executeFile = promisify(execFile);
const PROGRAM = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
async function main() {
  if (process.argv.includes("--help")) { console.log("Run only via solana-program-e2e-isolated.ts --suite publication. All market/reviewer fixtures are isolated TEST ONLY."); return; }
  assert.equal(process.argv.length, 2);
  const adminPath = await realpath(process.env.GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR ?? "");
  const directory = path.dirname(adminPath), relative = path.relative(await realpath("/tmp"), adminPath).split(path.sep);
  assert(relative.length === 2 && /^goosey-solana-runner-[A-Za-z0-9]+$/.test(relative[0]) && relative[1] === "goosey-admin-keypair.json", "Fresh runner key required");
  const runner = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(runner.suite, "publication"); assert.equal(runner.program, PROGRAM);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: process.env.GOOSEY_SOLANA_RPC_URL,
    GOOSEY_SOLANA_GENESIS_HASH: process.env.GOOSEY_SOLANA_GENESIS_HASH, GOOSEY_SOLANA_PROGRAM_ID: PROGRAM });
  assert.equal(runtime.rpcUrl, new URL(runner.rpc).href); assert.equal(runtime.genesisHash, runner.genesis);
  assert(!["8080", "18999", "19000", "19900"].includes(new URL(runtime.rpcUrl).port));
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const rpc = createSolanaRpc(runtime.rpcUrl), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(540_000)]);
  const pin = async () => assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash);
  await pin();
  const raw = Uint8Array.from(JSON.parse(await readFile(adminPath, "utf8")) as number[]);
  const admin = await createKeyPairSignerFromBytes(raw); raw.fill(0); assert.equal(admin.address, runner.admin);
  const base = await deriveGooseyProgramAddresses(PROGRAM);
  const initial = await rpc.getMultipleAccounts([PROGRAM, base.programData, base.config], { encoding: "base64", commitment: "confirmed" }).send({ abortSignal: signal });
  const [program, programData, config] = initial.value;
  assert(program?.executable && program.owner === "BPFLoaderUpgradeab1e11111111111111111111111" && programData?.owner === program.owner && !programData.executable);
  const programBytes = Buffer.from(program.data[0], "base64");
  assert.equal(programBytes.readUInt32LE(0), 2); assert.equal(getAddressDecoder().decode(programBytes.subarray(4)), base.programData);
  const artifact = await readFile(path.join(directory, "goosey_exchange.so"));
  assert.equal(elfHash(artifact), runner.artifactSha256); verifyLocalnetProgramData(Buffer.from(programData.data[0], "base64"), admin.address, artifact);
  assert.equal(config, null, "Fresh uninitialized isolated chain required");
  const evidence = path.join(directory, "publication-evidence"); await mkdir(evidence, { mode: 0o700 });
  let sequence = 0;
  const pass = (name: string) => console.log(`PASS ${++sequence}: ${name}`);
  pass(`immutable deployed ELF verified: ${runner.artifactSha256}`);
  async function transaction(name: string, payer: TransactionSigner, instructions: readonly Instruction[]) {
    await pin();
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: signal });
    const message = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(payer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), m => appendTransactionMessageInstructions([publicationComputeBudget(), ...instructions], m));
    const signed = await signTransactionMessageWithSigners(message);
    assert.deepEqual(Object.keys(signed.signatures), [payer.address], "External transaction must use only its actual independent payer");
    const signature = getSignatureFromTransaction(signed), wire = getBase64EncodedWireTransaction(signed);
    await writePublicationFile(evidence, `external-${sequence}.receipt.json`, JSON.stringify({ signature, signedWireBase64: wire, lastValidBlockHeight: lifetime.lastValidBlockHeight.toString() }));
    assert.equal(await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5n }).send({ abortSignal: signal }), signature);
    assert.equal((await trackTransactionStatus(rpc, { signature, lastValidBlockHeight: lifetime.lastValidBlockHeight, timeoutMs: 60_000, pollIntervalMs: 200, signal })).status, "finalized");
    pass(`${name} (${signature})`);
  }
  const initialize = await buildInitializeInstruction({ programAddress: PROGRAM, admin, environment: 1,
    genesisDomain: createHash("sha256").update(runtime.genesisHash).digest(), enrollmentAuthority: admin.address, perWalletCap: 100_000n, campaignCap: 1_000_000n });
  await transaction("actual foundation initialization", admin, [initialize.instruction]);
  const reviewers = [await generateKeyPairSigner(), await generateKeyPairSigner()];
  const clock = (await rpc.getAccountInfo(address("SysvarC1ock11111111111111111111111111111111"), { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal })).value;
  assert(clock); const now = Buffer.from(clock.data[0], "base64").readBigInt64LE(32);
  for (const [i, reviewer] of reviewers.entries()) {
    const grant = await buildAuthorizeEnrollmentInstruction({ programAddress: PROGRAM, enrollmentAuthority: admin, wallet: reviewer.address,
      identityDigest: randomBytes(32), allowance: 1000n, expiresAt: now + 7200n });
    await transaction(`enroll independent TEST reviewer ${i}; fund explicit test fees only`, admin,
      [grant.instruction, getTransferSolInstruction({ source: admin, destination: reviewer.address, amount: 50_000_000n })]);
  }
  const marketId = 71001n;
  const canonical = await deriveGooseySeatAddresses({ programAddress: PROGRAM, marketId, wallet: admin.address });
  const reviewer = async (i: number) => ({ wallet: reviewers[i].address, enrollment: (await deriveGooseySeatAddresses({ programAddress: PROGRAM, marketId, wallet: reviewers[i].address })).enrollment });
  const terms: MarketTerms = { version: 1, binding: { cluster: "localnet", genesisHash: runtime.genesisHash, program: PROGRAM, config: base.config,
    market: canonical.market, marketId: marketId.toString(), creator: admin.address, featherMint: base.featherMint },
    question: "ISOLATED TEST ONLY: did both independent test reviewers accept this exact manifest?",
    rules: { yes: "TEST ONLY: YES when both exact-digest acceptance bits exist on this disposable validator.",
      no: "TEST ONLY: NO when only one acceptance bit exists at observation end.", void: "TEST ONLY: VOID if the disposable validator is unavailable. No real event is represented." },
    observation: { startsAt: now.toString(), endsAt: (now + 3600n).toString(), timezone: "UTC" },
    sources: [{ id: "isolated-test", uri: "https://example.invalid/isolated-publication-test", selection: "Explicit isolated RPC test fixture, not a production source or actual Hack the North outcome.", snapshotSha256: null }],
    sourcePolicy: { priority: "array-order-first-authoritative", missing: "Isolated test only: no public fallback.", revisions: "No fixture revisions after commitment." },
    economics: { payoutMilli: "100000", feeBps: "100", closesAt: (now + 3600n).toString(), resolvesAt: (now + 3601n).toString(), decimals: 3 },
    oracle: { kind: "two-reviewer-no-fallback-v1", proposer: await reviewer(0), approver: await reviewer(1), unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false } };
  const manifest = encodeMarketTerms(terms), publication = await loadPublicationManifest(manifest, runtime);
  const runtimeFile = path.join(evidence, "runtime.json"), manifestFile = path.join(evidence, "manifest.json"), state = path.join(evidence, "signing-state"), store = path.join(evidence, "terms-store");
  await mkdir(store, { mode: 0o700 });
  await writePublicationFile(evidence, "runtime.json", JSON.stringify(runtime)); await writePublicationFile(evidence, "manifest.json", manifest);
  async function cli(command: string, options: { reject?: boolean; manifest?: string } = {}) {
    const args = ["--import", "tsx", "scripts/solana-publish-market.ts", command, "--runtime", runtimeFile,
      "--manifest", options.manifest ?? manifestFile, "--state", state, "--terms-directory", store];
    if (!["status", "review-instructions"].includes(command)) args.push("--admin-key", adminPath);
    let code = 0, stdout = "";
    try { stdout = (await executeFile(process.execPath, args, { timeout: 240_000, maxBuffer: 1024 * 1024, encoding: "utf8", signal })).stdout; }
    catch (error) { const e = error as { code?: unknown; stdout?: string }; assert(typeof e.code === "number", "CLI terminated unexpectedly"); code = e.code; stdout = e.stdout ?? ""; }
    assert(options.reject ? code !== 0 : code === 0, `${command} exit ${code}: ${stdout}`);
    return stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  await cli("prepare"); pass("CLI prepare retains exact terms and Seats key without publishing");
  const seatsRaw = Uint8Array.from(JSON.parse(await readFile(path.join(state, "seats.json"), "utf8")) as number[]);
  const seats = await createKeyPairSignerFromBytes(seatsRaw); seatsRaw.fill(0);
  assert.equal((await readPublicationSnapshot(runtime, publication, seats.address, signal)).market, null);
  const rent = await rpc.getMinimumBalanceForRentExemption(GOOSEY_SEATS_ACCOUNT_SPACE).send({ abortSignal: signal });
  const intended = await buildCreateMarketInstructions({ programAddress: PROGRAM, marketId, admin, seats, seatsRentLamports: rent,
    payoutMilli: 100000n, feeBps: 100, closesAt: now + 3600n, resolvesAt: now + 3601n });
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send({ abortSignal: signal });
  const unsent = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(admin, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), m => appendTransactionMessageInstructions([publicationComputeBudget(), ...intended.instructions], m)));
  const damaged = Buffer.from(getBase64EncodedWireTransaction(unsent), "base64"); damaged[65] ^= 1; // Corrupt actual Seats signature, never broadcast.
  await writePublicationFile(state, "market.receipt.json", JSON.stringify({ step: "market", digest: publication.digest, genesisHash: runtime.genesisHash,
    signature: getSignatureFromTransaction(unsent), lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(), signedWireBase64: damaged.toString("base64") }));
  const before = (await rpc.getBalance(admin.address, { commitment: "finalized" }).send({ abortSignal: signal })).value;
  await cli("init", { reject: true }); assert.equal((await readPublicationSnapshot(runtime, publication, seats.address, signal)).market, null);
  assert.equal((await rpc.getBalance(admin.address, { commitment: "finalized" }).send({ abortSignal: signal })).value, before);
  await rename(path.join(state, "market.receipt.json"), path.join(evidence, "rejected-tampered.receipt.json"));
  pass("CLI rejects tampered real co-signature before any transaction or rent payment");
  await writePublicationFile(evidence, "tampered-manifest.json", encodeMarketTerms({ ...terms, question: "ISOLATED TEST ONLY: altered retained question" }));
  await cli("status", { reject: true, manifest: path.join(evidence, "tampered-manifest.json") });
  pass("CLI rejects altered canonical manifest against retained exact bytes");
  await cli("init"); pass("CLI real market + bounded book growth + terms initialization finalized");
  let snapshot = await readPublicationSnapshot(runtime, publication, seats.address, signal);
  assert(snapshot.book?.ready && snapshot.terms?.acceptanceBits === 0 && !snapshot.terms.sealed && !snapshot.resolution);
  await cli("seal", { reject: true }); await cli("activate", { reject: true }); pass("missing independent approvals fail closed");
  // Renaming is stronger than chmod for proving no key read: both paths vanish.
  const hiddenAdmin = path.join(directory, "admin-inaccessible-during-readonly.json"), hiddenSeats = path.join(state, "seats-inaccessible.json");
  await rename(adminPath, hiddenAdmin); await rename(path.join(state, "seats.json"), hiddenSeats);
  let exported: Array<{ reviewer: string; programAddress: string; accounts: { address: string; role: number }[]; dataBase64: string }>;
  try {
    const status = (await cli("status")).at(-1); assert.equal(status.reviewerAcceptanceBits, 0);
    exported = (await cli("review-instructions")).find(row => row.status === "unsigned-reviewer-instructions-only").instructions;
    assert.equal(exported.length, 2); pass("status and unsigned reviewer export work with private key paths inaccessible");
  } finally { await rename(hiddenAdmin, adminPath); await rename(hiddenSeats, path.join(state, "seats.json")); }
  for (const [i, reviewerKey] of reviewers.entries()) {
    const approval = await buildAcceptMarketTermsInstruction({ programAddress: PROGRAM, marketId, seats: seats.address, reviewer: reviewerKey, expectedDigest: Buffer.from(publication.digest, "hex") });
    const expected = exported!.find(row => row.reviewer === reviewerKey.address); assert(expected);
    assert.equal(expected.programAddress, PROGRAM); assert.equal(expected.dataBase64, Buffer.from(approval.instruction.data).toString("base64"));
    assert.deepEqual(expected.accounts, approval.instruction.accounts.map(({ address, role }) => ({ address, role })));
    await transaction(`external independent reviewer ${i} signs exact exported acceptance`, reviewerKey, [approval.instruction]);
    snapshot = await readPublicationSnapshot(runtime, publication, seats.address, signal);
    assert.equal(snapshot.terms?.acceptanceBits, i === 0 ? 1 : 3);
    if (i === 0) { await cli("seal", { reject: true }); pass("one approval cannot seal"); }
  }
  await cli("seal"); await cli("activate"); pass("creator seal and resolution activation finalized");
  const files = (await readdir(state)).filter(name => name.endsWith(".receipt.json")).sort();
  const hashes = async () => Promise.all(files.map(async name => createHash("sha256").update(await readFile(path.join(state, name))).digest("hex")));
  const receiptHashes = await hashes(), balance = (await rpc.getBalance(admin.address, { commitment: "finalized" }).send({ abortSignal: signal })).value;
  const stable = await readPublicationSnapshot(runtime, publication, seats.address, signal); assert(stable.resolution?.phase === 0 && stable.terms?.sealed);
  for (const command of ["init", "seal", "activate", "status"]) await cli(command);
  const after = await readPublicationSnapshot(runtime, publication, seats.address, signal);
  assert.deepEqual(after.terms, stable.terms); assert.deepEqual(after.resolution, stable.resolution); assert.deepEqual(after.market, stable.market);
  assert.deepEqual(await hashes(), receiptHashes); assert.deepEqual((await readdir(state)).filter(name => name.endsWith(".receipt.json")).sort(), files);
  assert.equal((await rpc.getBalance(admin.address, { commitment: "finalized" }).send({ abortSignal: signal })).value, balance);
  const finalConfig = await readGooseyConfiguration(runtime, signal);
  assert.equal(finalConfig.totalAuthorized, 2000n); assert.equal(finalConfig.totalMinted, 0n); assert.equal(finalConfig.supply, 0n);
  assert.equal(after.market?.marketState.accountedVault, 0n); // No fake participant funding; economics/payout remain positive.
  pass("fresh CLI process restarts preserve receipts, exact finalized state and admin balance; no duplicate transactions");
  // New database only, after chain publication. The subprocess must not inherit
  // a developer DB URL, signing secrets, SMTP configuration or NODE_OPTIONS.
  const catalogDirectory = path.join(evidence, "catalog"); await mkdir(catalogDirectory, { mode: 0o700 });
  const catalogDatabase = path.join(catalogDirectory, "catalog.db");
  const catalogHandle = await open(catalogDatabase, "wx", 0o600); await catalogHandle.close();
  const catalogEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
    NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: `file:${catalogDatabase}`,
    POSTGRES_DATABASE_URL: "", POSTGRES_DIRECT_DATABASE_URL: "", NEON_DATABASE_URL: "", NEXT_TELEMETRY_DISABLED: "1",
    APP_URL: "https://publication-catalog.test.invalid", REQUIRE_EMAIL_VERIFICATION: "true",
    GOOSEY_PUBLICATION_CATALOG_DIRECTORY: catalogDirectory, GOOSEY_SOLANA_CLUSTER: runtime.cluster,
    GOOSEY_SOLANA_RPC_URL: runtime.rpcUrl, GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash };
  await executeFile(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"],
    { env: catalogEnv, encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024, signal });
  const catalogProof = await executeFile(process.execPath, ["--import", "tsx", "scripts/lib/solana-publication-catalog-e2e.ts", catalogDirectory],
    { env: catalogEnv, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, signal });
  process.stdout.write(catalogProof.stdout);
  const catalogResult = JSON.parse(await readFile(path.join(catalogDirectory, "result.json"), "utf8"));
  assert.equal(catalogResult.status, "PASS"); assert.equal(catalogResult.marketAddress, canonical.market); assert.equal(catalogResult.digest, publication.digest);
  pass("real chain-to-catalog service proof on NEW isolated SQLite database, no chain/store mocks");
  await writePublicationFile(evidence, "result.json", JSON.stringify({ status: "PASS", scope: "isolated TEST ONLY real CLI/RPC", checks: sequence,
    artifactSha256: runner.artifactSha256, genesisHash: runtime.genesisHash, market: canonical.market, digest: publication.digest,
    receiptCount: files.length, reviewerAcceptanceBits: after.terms?.acceptanceBits, resolutionPhase: after.resolution?.phase,
    totalAuthorized: finalConfig.totalAuthorized.toString(), totalMinted: "0", supply: "0", catalog: catalogResult }, null, 2));
  await chmod(evidence, 0o700);
  console.log(`PASS publication suite: ${sequence} checks; public evidence ${path.join(evidence, "result.json")}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Publication suite failed"); process.exitCode = 1; });
