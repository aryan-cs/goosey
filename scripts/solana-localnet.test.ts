import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSolanaRpc, signature } from "@solana/kit";
import { describe, expect, it } from "vitest";

const script = "scripts/solana-localnet.ts";
describe("localnet operator startup argument guards (real subprocess, no validator)", () => {
  it("documents bounded retention without needing any configured binary", () => {
    const result = execFileSync(process.execPath, ["--import", "tsx", script, "--help"], {
      env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 15_000,
    });
    expect(result).toContain("10000..10000000"); expect(result).toContain("Pruned history cannot be restored");
  });
  it.each(["0", "9999", "10000001", "1e6", "010000"])("rejects create retention %s before filesystem/binary access", value => {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "create", "--directory", "/nonexistent-parent/no-create",
      "--rpc-port", "31000", "--per-wallet-cap", "1000", "--campaign-cap", "1000", "--ledger-shreds", value], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", GOOSEY_SOLANA_VALIDATOR_BIN: "/no-such-validator" }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("arguments and validator");
  });
  it("cannot override immutable retention on start", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "start", "--directory", "/nonexistent-parent/no-start",
      "--ledger-shreds", "250000"], { env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 15_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain("arguments and validator");
  });
});

// Explicit opt-in real validator proof. Never use a retained/shared instance.
// Only the operator's one real initialize instruction is sent, then read-only RPC.
it.skipIf(process.env.GOOSEY_LOCALNET_RETENTION_E2E !== "1")("real isolated create/start/restart retains history and immutable shred policy", async () => {
  assert(process.env.GOOSEY_SOLANA_BIN_DIR || process.env.GOOSEY_SOLANA_VALIDATOR_BIN, "Explicit validator binary required");
  // Short /tmp path also avoids macOS UNIX-domain admin socket path limits.
  const parent = await realpath(await mkdtemp("/tmp/goosey-localnet-retention-"));
  const directory = path.join(parent, "instance");
  // Reserve the whole TCP/UDP block while creating the instance. Never use
  // shared 20999, 18999 or 8080; operator reserves again immediately on startup.
  let port = 0;
  const reservations: (() => Promise<void>)[] = [];
  const release = async () => { await Promise.all(reservations.splice(0).map(close => close())); };
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    const candidate = randomInt(30000, 60000);
    try {
      for (let p = candidate; p <= candidate + 40; p++) {
        const tcp = createServer();
        await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(p, "127.0.0.1", resolve); });
        reservations.push(() => new Promise(resolve => tcp.close(() => resolve())));
        const udp = createSocket("udp4");
        try { await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(p, "127.0.0.1", resolve); }); }
        catch (error) { udp.close(); throw error; }
        reservations.push(() => new Promise(resolve => udp.close(resolve)));
      }
      port = candidate;
    } catch { await release(); }
  }
  assert(port, "No isolated free port block");
  let child: ChildProcess | undefined;
  let closed: Promise<number | null> | undefined;
  async function stop() {
    if (!child || !closed) return;
    child.kill("SIGTERM");
    assert.equal(await Promise.race([closed, delay(15_000).then(() => "timeout")]), 0, "Owned operator must stop cleanly");
    child = undefined; closed = undefined;
  }
  async function start() {
    let output = "", errors = "", exited = false;
    child = spawn(process.execPath, ["--import", "tsx", script, "start", "--directory", directory], {
      env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", data => { output += data.toString(); });
    child.stderr!.on("data", data => { errors += data.toString(); });
    closed = new Promise(resolve => child!.once("close", code => { exited = true; resolve(code); }));
    const deadline = Date.now() + 150_000;
    while (!output.includes("Rolling ledger retention: 250000 shreds.")) {
      assert(!exited, `Isolated operator exited: ${errors}`); assert(Date.now() < deadline, "Isolated operator readiness timeout");
      await delay(200);
    }
    // Actual OS child argv, not a mocked spawn assertion.
    const processes = execFileSync("ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
    const validator = processes.split("\n").find(line => line.trim().startsWith(`${child!.pid} `)
      && line.includes("solana-test-validator") && line.includes(directory));
    assert(validator?.includes("--limit-ledger-size 250000"), "Owned real validator missing retention flag");
  }
  try {
    execFileSync(process.execPath, ["--import", "tsx", script, "create", "--directory", directory, "--rpc-port", String(port),
      "--per-wallet-cap", "1000", "--campaign-cap", "1000", "--ledger-shreds", "250000"],
    { env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8", timeout: 30_000 });
    const manifest = await readFile(path.join(directory, "manifest.json"), "utf8");
    expect(JSON.parse(manifest).ledgerShredLimit).toBe(250000);
    await release(); await start();
    const rpc = createSolanaRpc(`http://127.0.0.1:${port}`);
    const genesis = await rpc.getGenesisHash().send();
    const receipt = await readFile(path.join(directory, "initialize-receipt.json"), "utf8");
    const sig = signature(JSON.parse(receipt).signature);
    const before = await rpc.getTransaction(sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
    assert(before && before.meta?.err === null, "Real initialization receipt unavailable");
    await stop(); await start();
    expect(await rpc.getGenesisHash().send()).toBe(genesis);
    // Current config/root can become available before historical receipt serving
    // catches up on restart. Require both within a bounded read-only wait; never
    // treat a null receipt as success or resend initialization to replace it.
    const replayDeadline = Date.now() + 60_000;
    let after;
    while (true) {
      const root = await rpc.getSlot({ commitment: "finalized" }).send({ abortSignal: AbortSignal.timeout(5000) });
      after = await rpc.getTransaction(sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 })
        .send({ abortSignal: AbortSignal.timeout(5000) });
      if (root >= before.slot && after) break;
      assert(Date.now() < replayDeadline, "Restart did not serve finalized historical initialization receipt");
      await delay(250);
    }
    assert(after && after.meta?.err === null); expect(after.slot).toBe(before.slot);
    expect(await readFile(path.join(directory, "manifest.json"), "utf8")).toBe(manifest);
    expect(await readFile(path.join(directory, "initialize-receipt.json"), "utf8")).toBe(receipt);
    const history = await rpc.getSignaturesForAddress(JSON.parse(manifest).program, { commitment: "finalized", limit: 100 }).send();
    expect(history.map(row => row.signature)).toContain(sig);
    console.log(JSON.stringify({ evidence: "isolated-localnet-retention", directory, rpcPort: port, ledgerShredLimit: 250000,
      genesis, initializationSignature: sig, finalizedSlot: before.slot.toString(), retainedAfterRestart: true }));
  } finally {
    await release(); await stop();
    // Keep this owned private fixture, keys and logs for inspection; never delete
    // or reset a ledger implicitly. No existing operator directory was touched.
  }
}, 360_000);
