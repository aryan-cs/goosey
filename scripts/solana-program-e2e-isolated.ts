/** Own-process-only local validator harness. Never resumes or resets a ledger. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getAddressDecoder } from "@solana/kit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const program = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const help = `Usage: node --import tsx scripts/solana-program-e2e-isolated.ts [--suite foundation|exchange|cancellation|resolution]

Runs the actual compiled Goosey program on a NEW loopback validator and ledger.
No build, public network, existing wallet, shared validator reset, or deployment.
Each selected suite receives its own fresh ledger. Default: foundation.
Requires installed project dependencies and an Agave validator supporting
--upgradeable-program (verified with 4.2.2 / SBPFv3).

Environment:
  GOOSEY_SOLANA_VALIDATOR_BIN  Explicit validator executable (highest priority).
  GOOSEY_SOLANA_BIN_DIR        Directory containing solana-test-validator.
  Otherwise solana-test-validator must be on PATH; no personal CLI config is read.
  GOOSEY_SOLANA_PROGRAM_ARTIFACT  Real compiled .so (default chain/target/deploy/goosey_exchange.so).

Fresh admin, private CLI config, logs, manifest and ledger are retained in a
mode-0700 /tmp/goosey-solana-* directory. Private key material is never printed.
Ports are reserved dynamically, excluding 8080, 18999, 19000 and 19900.
Socket handoff cannot be atomic: a bind race fails rather than adopting a chain
whose upgrade authority does not match this run's fresh key. Only this runner's
children are stopped on completion, failure, SIGINT, SIGTERM, or 10-minute timeout.
Retained keys are disposable LOCAL TEST keys; never fund them on public networks.
`;

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { console.log(help); return; }
  const argsIn = process.argv.slice(2);
  assert(argsIn.length === 0 || (argsIn.length === 2 && argsIn[0] === "--suite"
    && ["foundation", "exchange", "cancellation", "resolution"].includes(argsIn[1])), "Unknown arguments; use --help");
  const selectedSuite = argsIn[1] ?? "foundation";
  const suiteScript = selectedSuite === "exchange" ? "solana-exchange-e2e.ts"
    : selectedSuite === "cancellation" ? "solana-cancellation-e2e.ts"
    : selectedSuite === "resolution" ? "solana-resolution-e2e.ts" : "solana-program-e2e.ts";
  const validatorBin = process.env.GOOSEY_SOLANA_VALIDATOR_BIN
    ?? (process.env.GOOSEY_SOLANA_BIN_DIR ? path.join(process.env.GOOSEY_SOLANA_BIN_DIR, "solana-test-validator") : "solana-test-validator");
  const artifact = await realpath(process.env.GOOSEY_SOLANA_PROGRAM_ARTIFACT ?? path.join(root, "chain/target/deploy/goosey_exchange.so"));
  const artifactBytes = await readFile(artifact);
  assert.equal(artifactBytes.subarray(0, 4).toString("hex"), "7f454c46", "Program artifact must be a compiled ELF, not source or a mock");
  const capability = spawnSync(validatorBin, ["--help"], { encoding: "utf8", timeout: 10_000 });
  assert(!capability.error && capability.status === 0 && capability.stdout.includes("--upgradeable-program"), "Validator unavailable or missing upgradeable genesis support");
  const version = spawnSync(validatorBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0, "Validator version probe failed");
  const directory = await mkdtemp("/tmp/goosey-solana-runner-");
  await chmod(directory, 0o700);
  console.log(`Retaining private local-test artifacts: ${directory}`);
  const reservations: (() => Promise<void>)[] = [];
  const children: { child: ChildProcess; done: Promise<void>; finished: boolean }[] = [];
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("Runner interrupted; stopping only owned children"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timeout = setTimeout(() => abort.abort(new Error("Runner exceeded ten-minute deadline")), 600_000);
  async function reserve(port: number) {
    const tcp = createServer();
    await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", resolve); });
    reservations.push(() => new Promise<void>(resolve => tcp.close(() => resolve())));
    const udp = createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, "127.0.0.1", resolve); });
    } catch (error) { udp.close(); throw error; }
    reservations.push(() => new Promise<void>(resolve => udp.close(resolve)));
  }
  async function release() { await Promise.all(reservations.splice(0).map(close => close())); }
  function launch(command: string, args: string[], logName: string, env = process.env, echo = false) {
    abort.signal.throwIfAborted();
    const log = createWriteStream(path.join(directory, logName), { flags: "wx", mode: 0o600 });
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const tracked = { child, finished: false, done: Promise.resolve() };
    tracked.done = new Promise<void>(resolve => child.once("close", () => { tracked.finished = true; log.end(resolve); }));
    child.once("error", () => abort.abort(new Error(`Could not start ${logName}`)));
    log.once("error", () => abort.abort(new Error(`Could not write ${logName}`)));
    child.stdout!.on("data", chunk => { log.write(chunk); if (echo) process.stdout.write(chunk); });
    child.stderr!.on("data", chunk => { log.write(chunk); if (echo) process.stderr.write(chunk); });
    children.push(tracked);
    return tracked;
  }
  try {
    // Reserve a contiguous random block for RPC+WS, faucet, gossip and Agave's
    // dynamic sockets, in both protocols. No hardcoded shared-service ports.
    let base = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      abort.signal.throwIfAborted();
      base = randomInt(30_000, 59_000);
      // Agave's dynamic-port-range has an inclusive upper endpoint.
      try { for (let p = base; p <= base + 40; p++) await reserve(p); break; }
      catch { await release(); base = 0; }
    }
    assert(base, "Could not reserve an isolated port block");
    const endpoint = `http://127.0.0.1:${base}`;
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    assert(jwk.d && jwk.x);
    const publicBytes = Buffer.from(jwk.x, "base64url");
    const admin = getAddressDecoder().decode(publicBytes);
    const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), publicBytes]);
    const adminPath = path.join(directory, "goosey-admin-keypair.json");
    await writeFile(adminPath, JSON.stringify([...secret]), { flag: "wx", mode: 0o600 });
    secret.fill(0);
    delete jwk.d;
    const config = path.join(directory, "cli-config.yml");
    await writeFile(config, `json_rpc_url: ${endpoint}\nwebsocket_url: ws://127.0.0.1:${base + 1}\nkeypair_path: ${adminPath}\naddress_labels: {}\ncommitment: confirmed\n`, { flag: "wx", mode: 0o600 });
    // Snapshot the bytes we hash: another agent may rebuild the source artifact
    // during this run. Genesis must load exactly the recorded compiled binary.
    const loadedArtifact = path.join(directory, "goosey_exchange.so");
    await writeFile(loadedArtifact, artifactBytes, { flag: "wx", mode: 0o400 });
    const args = ["--config", config, "--ledger", path.join(directory, "ledger"), "--bind-address", "127.0.0.1",
      "--rpc-port", String(base), "--faucet-port", String(base + 2), "--gossip-port", String(base + 3),
      "--dynamic-port-range", `${base + 4}-${base + 40}`, "--mint", admin,
      "--upgradeable-program", program, loadedArtifact, admin, "--quiet"];
    await release();
    const validator = launch(validatorBin, args, "validator.log");
    async function rpc(method: string) {
      abort.signal.throwIfAborted();
      assert(!validator.finished && validator.child.exitCode === null, "Owned validator exited; inspect validator.log");
      const response = await fetch(endpoint, { method: "POST", redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2_000)]),
        headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) });
      assert(response.ok);
      const body = await response.json() as { result?: unknown; error?: unknown };
      assert(!body.error, "RPC not healthy yet");
      return body.result;
    }
    const readyDeadline = Date.now() + 90_000;
    while (true) {
      abort.signal.throwIfAborted();
      assert(!validator.finished && validator.child.exitCode === null, "Owned validator exited during startup; inspect validator.log");
      try { if (await rpc("getHealth") === "ok" && Number(await rpc("getSlot")) > 0) break; } catch { /* bounded startup retry */ }
      assert(Date.now() < readyDeadline, "Owned validator failed to become ready in 90 seconds");
      await delay(250, undefined, { signal: abort.signal });
    }
    const genesis = await rpc("getGenesisHash");
    assert(typeof genesis === "string");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      validator: version.stdout.trim(), artifact, loadedArtifact, artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
      program, admin, suite: selectedSuite, suiteScript, rpc: endpoint, genesis, ports: { rpc: base, websocket: base + 1, faucet: base + 2, gossip: base + 3, dynamic: [base + 4, base + 40] },
      validatorArguments: args, startedAt: new Date().toISOString(),
    }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Isolated RPC ${endpoint}; genesis ${genesis}`);
    // The suite verifies genesis AND this fresh key's actual upgrade authority
    // before signing anything, so a port-handoff race cannot adopt another chain.
    const suite = launch(process.execPath, ["--import", "tsx", path.join(root, "scripts", suiteScript)], "program-e2e.log", {
      ...process.env, GOOSEY_SOLANA_RPC_URL: endpoint, GOOSEY_SOLANA_GENESIS_HASH: genesis,
      GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR: adminPath,
    }, true);
    while (!suite.finished) {
      assert(!validator.finished, "Owned validator exited while suite was running");
      await delay(200, undefined, { signal: abort.signal });
    }
    assert.equal(suite.child.exitCode, 0, "Actual-chain suite failed; inspect program-e2e.log");
    console.log(`PASS isolated suite. Evidence retained at ${directory}`);
  } finally {
    clearTimeout(timeout);
    await release();
    for (const tracked of children.reverse()) {
      if (!tracked.finished && tracked.child.exitCode === null) tracked.child.kill("SIGTERM");
      const escalation = setTimeout(() => { if (!tracked.finished && tracked.child.exitCode === null) tracked.child.kill("SIGKILL"); }, 5_000);
      await tracked.done;
      clearTimeout(escalation);
    }
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    console.log(`Owned children stopped; private ledger, keys and logs retained: ${directory}`);
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Isolated runner failed"); process.exitCode = 1; });
