/** Fresh, owned localnet for real Wallet Standard browser tests. Never adopts a ledger. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { open, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { address, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction, getSignatureFromTransaction, lamports, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { readGooseyConfiguration } from "../../src/lib/solana/configuration";
import { localnetManifestSchema } from "../../src/lib/solana/localnet-manifest";
import { resolveSolanaRuntime } from "../../src/lib/solana/runtime";
import { trackTransactionStatus } from "../../src/lib/solana/transaction-status";
import { readGooseyWalletBalance } from "../../src/lib/solana/wallet-balance";
import { validateEnrollmentReceipt } from "../solana-enroll";

import { deriveGooseySeatAddresses } from "../../src/lib/solana/escrow-client";
import { buildAcceptMarketTermsInstruction } from "../../src/lib/solana/market-terms-client";
import { encodeMarketTerms, hashMarketTerms, type MarketTerms } from "../../src/lib/solana/market-terms";
import { readGooseyEscrow } from "../../src/lib/solana/escrow-read";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const allowanceBaseUnits = 100_000n;
// Validate the SDK constant before any validator or funding operation.
const clockAddress = address(SYSVAR_CLOCK_ADDRESS);

async function reservePortBlock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = randomInt(30_000, 59_000);
    const close: (() => Promise<void>)[] = [];
    try {
      for (let port = base; port <= base + 40; port++) {
        const tcp = createServer();
        await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", resolve); });
        close.push(() => new Promise(resolve => tcp.close(() => resolve())));
        const udp = createSocket("udp4");
        try { await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, "127.0.0.1", resolve); }); }
        catch (error) { udp.close(); throw error; }
        close.push(() => new Promise(resolve => udp.close(resolve)));
      }
      return base;
    } catch { /* Try a different unused block; never attach to an existing RPC. */ }
    finally { await Promise.all(close.map(stop => stop())); }
  }
  throw new Error("Could not reserve a fresh localnet port block");
}

export async function startChainMarketBrowserChain(options: { walletAddress: string; recipientAddress: string }) {
  const wallet = address(options.walletAddress), recipient = address(options.recipientAddress);
  assert.notEqual(wallet, recipient, "Use distinct real signing keys");
  const reviewers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  assert.equal(new Set([wallet, recipient, ...reviewers.map(r => r.address)]).size, 4);
  const parent = await mkdtemp(path.join(await realpath("/tmp"), "goosey-chain-market-browser-"));
  const directory = path.join(parent, "chain");
  const port = await reservePortBlock();
  const cli = path.join(root, "scripts/solana-localnet.ts");
  await execute(process.execPath, ["--import", "tsx", cli, "create", "--directory", directory,
    "--rpc-port", String(port), "--per-wallet-cap", allowanceBaseUnits.toString(), "--campaign-cap", (3n * allowanceBaseUnits).toString()],
  { cwd: root, env: process.env, timeout: 30_000, maxBuffer: 65536 });
  const log = await open(path.join(parent, "operator.log"), "wx", 0o600);
  const operator = spawn(process.execPath, ["--import", "tsx", cli, "start", "--directory", directory],
    { cwd: root, env: process.env, stdio: ["ignore", log.fd, log.fd] });
  let ended = false, spawnError: Error | undefined;
  const done = new Promise<void>(resolve => operator.once("close", () => { ended = true; resolve(); }));
  operator.once("error", error => { spawnError = error; });
  await log.close();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    clearTimeout(deadline);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (!ended) operator.kill("SIGTERM");
    // The operator owns its validator and has its own five-second escalation.
    await done;
  })();
  const interrupt = () => { void stop(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const deadline = setTimeout(interrupt, 30 * 60_000);
  const signal = AbortSignal.timeout(15 * 60_000);
  try {
    let genesis: string | undefined;
    while (!genesis) {
      signal.throwIfAborted(); assert(!ended && !spawnError, "Fresh localnet operator exited; inspect operator.log");
      try { genesis = JSON.parse(await readFile(path.join(directory, "genesis.json"), "utf8")).genesis; }
      catch { await delay(250, undefined, { signal }); }
    }
    const manifest = localnetManifestSchema.parse(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
    const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: `http://127.0.0.1:${port}`,
      GOOSEY_SOLANA_PROGRAM_ID: manifest.program, GOOSEY_SOLANA_GENESIS_HASH: genesis,
      GOOSEY_SOLANA_BROWSER_ENABLED: "true", GOOSEY_SOLANA_PUBLIC_RPC_URL: `http://127.0.0.1:${port}` };
    const runtime = resolveSolanaRuntime(env), rpc = createSolanaRpc(runtime.rpcUrl);
    while (true) {
      signal.throwIfAborted(); assert(!ended, "Fresh localnet operator exited during initialization");
      try {
        const configuration = await readGooseyConfiguration(runtime, signal);
        assert.equal(configuration.admin, manifest.admin); assert.equal(configuration.enrollmentAuthority, manifest.enrollment);
        assert.equal(configuration.perWalletCap, allowanceBaseUnits); assert.equal(configuration.campaignCap, 3n * allowanceBaseUnits);
        break;
      } catch { await delay(250, undefined, { signal }); }
    }
    assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), genesis);
    // Real localnet faucet transactions only, on this freshly verified owned chain.
    const funding = await Promise.all([address(manifest.enrollment), wallet, ...reviewers.map(r => r.address)].map(async destination => {
      const signature = await rpc.requestAirdrop(destination, lamports(2_000_000_000n), { commitment: "confirmed" }).send({ abortSignal: signal });
      while (true) {
        signal.throwIfAborted();
        const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send({ abortSignal: signal })).value[0];
        assert(!status?.err, "Localnet SOL funding transaction failed");
        if (status?.confirmationStatus === "finalized") break;
        await delay(250, undefined, { signal });
      }
      return { destination, signature };
    }));
    const clock = await rpc.getAccountInfo(clockAddress, { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal });
    assert(clock.value);
    const expiry = Buffer.from(clock.value.data[0], "base64").readBigInt64LE(32) + 3600n;
    const enrollmentSignatures = [];
    for (const [index, enrolledWallet] of [wallet, ...reviewers.map(r => r.address)].entries()) {
      const receiptPath = path.join(parent, `enrollment-${index}-receipt.json`);
      await execute(process.execPath, ["--import", "tsx", path.join(root, "scripts/solana-enroll.ts"), "submit",
        "--authority-keyfile", path.join(directory, "enrollment.json"), "--wallet", enrolledWallet,
        "--identity-digest", randomBytes(32).toString("hex"), "--allowance", allowanceBaseUnits.toString(),
        "--expires-at", expiry.toString(), "--receipt", receiptPath],
      { cwd: root, env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 65536 });
      const receipt = await validateEnrollmentReceipt(await readFile(receiptPath, "utf8"), runtime);
      assert.equal((await trackTransactionStatus(rpc, { signature: receipt.signature, lastValidBlockHeight: receipt.lastValidBlockHeight, signal, timeoutMs: 60_000 })).status, "finalized");
      enrollmentSignatures.push(receipt.signature);
    }
    const before = await readGooseyWalletBalance({ runtime, wallet, signal });
    const recipientBefore = await readGooseyWalletBalance({ runtime, wallet: recipient, signal });
    assert.equal(before.featherAmount, 0n); assert.equal(before.featherAccountStatus, "absent");
    assert.equal(recipientBefore.featherAmount, 0n); assert.equal(recipientBefore.featherAccountStatus, "absent");
    assert.equal(recipientBefore.solLamports, 0n);
    await writeFile(path.join(parent, "bootstrap-evidence.json"), JSON.stringify({ runtime, wallet, recipient,
      allowanceBaseUnits: allowanceBaseUnits.toString(), funding, enrollmentSignatures,
      artifactSha256: manifest.artifactSha256, senderAtaInitiallyAbsent: true, recipientAtaInitiallyAbsent: true }, null, 2), { flag: "wx", mode: 0o600 });
    const marketId = 1n;
    const addresses = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet });
    const reviewerBindings = await Promise.all(reviewers.map(async reviewer => ({ wallet: reviewer.address,
      enrollment: (await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: reviewer.address })).enrollment })));
    const marketClock = await rpc.getAccountInfo(clockAddress,
      { encoding: "base64", commitment: "finalized" }).send({ abortSignal: signal });
    assert(marketClock.value);
    const startsAt = Buffer.from(marketClock.value.data[0], "base64").readBigInt64LE(32), closesAt = startsAt + 3600n;
    // Explicit disposable verification market. Its provenance is the actual
    // browser-run receipt report, never a fabricated outcome or live catalog row.
    const terms: MarketTerms = {
      version: 1,
      binding: { cluster: "localnet", genesisHash: runtime.genesisHash, program: runtime.programAddress,
        config: addresses.config, market: addresses.market, marketId: marketId.toString(), creator: manifest.admin, featherMint: addresses.featherMint },
      question: "Will this isolated Goosey browser run finalize its full market journey?",
      rules: { yes: "YES if the trader claims feathers, registers a seat, deposits, places and cancels an order, and withdraws on this pinned isolated ledger before close.",
        no: "NO if the complete journey has not finalized before close while the isolated ledger remains available.",
        void: "VOID if the isolated ledger or retained receipt report is unavailable and the outcome cannot be verified." },
      observation: { startsAt: startsAt.toString(), endsAt: closesAt.toString(), timezone: "UTC" },
      sources: [{ id: "browser-run", uri: "https://github.com/aryan-cs/goosey", selection: "Use the browser verification runner's retained transaction signatures and finalized account observations for the genesis and market bound in these terms.", snapshotSha256: null }],
      sourcePolicy: { priority: "array-order-first-authoritative", missing: "Wait for the retained browser-run report; do not invent a result.", revisions: "Only the report for this pinned genesis and market is eligible evidence." },
      economics: { payoutMilli: "1000", feeBps: "100", closesAt: closesAt.toString(), resolvesAt: (closesAt + 60n).toString(), decimals: 3 },
      oracle: { kind: "two-reviewer-no-fallback-v1", proposer: reviewerBindings[0], approver: reviewerBindings[1],
        unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false },
    };
    const termsDirectory = path.join(parent, "terms-store"), state = path.join(parent, "publication");
    await mkdir(termsDirectory, { mode: 0o700 });
    const runtimeFile = path.join(parent, "publication-runtime.json"), manifestFile = path.join(parent, "market-terms.json");
    const termsBytes = encodeMarketTerms(terms), digest = await hashMarketTerms(termsBytes);
    await writeFile(runtimeFile, JSON.stringify(runtime), { flag: "wx", mode: 0o600 });
    await writeFile(manifestFile, termsBytes, { flag: "wx", mode: 0o600 });
    async function publish(command: string) {
      assert(!ended, "Owned validator stopped during publication"); signal.throwIfAborted();
      const result = await execute(process.execPath, ["--import", "tsx", path.join(root, "scripts/solana-publish-market.ts"), command,
        "--runtime", runtimeFile, "--manifest", manifestFile, "--state", state, "--terms-directory", termsDirectory,
        ...(command === "status" ? [] : ["--admin-key", path.join(directory, "admin.json")])],
      { cwd: root, env: process.env, timeout: 600_000, maxBuffer: 262144 });
      await writeFile(path.join(parent, `publication-${command}.log`), result.stdout, { flag: "wx", mode: 0o600 });
    }
    await publish("prepare"); await publish("init");
    const seats = address(JSON.parse(await readFile(path.join(state, "seats-address.json"), "utf8")).address);
    const acceptanceSignatures = [];
    for (const reviewer of reviewers) {
      assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash);
      const plan = await buildAcceptMarketTermsInstruction({ programAddress: runtime.programAddress, marketId, seats,
        reviewer, expectedDigest: Buffer.from(digest, "hex") });
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send({ abortSignal: signal });
      const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(reviewer, tx),
        tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([plan.instruction], tx));
      const signed = await signTransactionMessageWithSigners(message), signature = getSignatureFromTransaction(signed);
      // Independent actual reviewer signatures; no admin impersonation/account injection.
      const receiptFile = path.join(parent, `reviewer-${acceptanceSignatures.length}.json`);
      await writeFile(receiptFile, JSON.stringify({ signature, lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
        reviewer: reviewer.address, digest, signedWireBase64: getBase64EncodedWireTransaction(signed) }), { flag: "wx", mode: 0o600 });
      assert.equal(await rpc.getGenesisHash().send({ abortSignal: signal }), runtime.genesisHash);
      assert.equal(await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", skipPreflight: false,
        preflightCommitment: "confirmed", maxRetries: 0n }).send({ abortSignal: signal }), signature);
      assert.equal((await trackTransactionStatus(rpc, { signature, lastValidBlockHeight: lifetime.lastValidBlockHeight,
        signal, timeoutMs: 90_000 })).status, "finalized");
      acceptanceSignatures.push(signature);
    }
    await publish("seal"); await publish("activate"); await publish("status");
    const verified = await readGooseyEscrow(runtime, { marketId, wallet }, { signal, includeMarketTerms: true, includeResolution: true });
    assert.equal(verified.marketTerms?.sealed, true); assert.equal(verified.marketTerms.acceptanceBits, 3);
    assert.equal(verified.resolution?.phase, 0); assert.equal(verified.registered, false);
    assert.equal(verified.orderBook?.orders.length, 0); assert.equal(verified.walletTokenAmount, null);
    await writeFile(path.join(parent, "market-bootstrap-evidence.json"), JSON.stringify({ marketId: marketId.toString(),
      market: verified.market, seats, digest, acceptanceSignatures, finalizedSlot: verified.finalizedSlot.toString(),
      termsDirectory, publicationState: state }), { flag: "wx", mode: 0o600 });
    return { env: { ...env, GOOSEY_SOLANA_TERMS_DIRECTORY: termsDirectory }, runtime, directory: parent,
      allowanceBaseUnits, marketId, termsDirectory, stop };
  } catch (error) { await stop(); throw error; }
}
