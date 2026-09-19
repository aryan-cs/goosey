import { inspectCoverageRotation, rotateCoverageBoundary, type CoverageRotationInput } from "../src/lib/solana/coverage-rotation";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";

const APPLY_CONFIRMATION = "ROTATE_LOCALNET_BOUNDED_COVERAGE";
const help = `Usage:
  npm run chain:index:rotate-coverage -- inspect \\
    --confirm-genesis=HASH --confirm-program=ADDRESS \\
    --confirm-old-boundary=SIGNATURE \\
    --new-boundary=SIGNATURE --confirm-new-boundary=SIGNATURE \\
    --confirm-enrolled-wallet=ADDRESS --reason="single-line reason"

  npm run chain:index:rotate-coverage -- apply [the same arguments] \\
    --confirm-old-cursor-sha256=HEX \\
    --execute=${APPLY_CONFIRMATION}

This command is deliberately localnet-only. Inspect performs read-only finalized
RPC and database checks and prints the exact old cursor digest. Apply repeats all
checks, requires that digest, appends immutable rotation evidence, and atomically
changes only the empty ingestion cursor boundary. It never submits a Solana
transaction, starts a worker, runs a migration, or supports devnet/mainnet.
`;

type Parsed = Readonly<{
  mode: "inspect" | "apply";
  newBoundarySignature: string;
  enrolledWalletAddress: string;
  reason: string;
  confirmations: CoverageRotationInput["confirmations"];
}>;

export function parseCoverageRotationArguments(args: readonly string[]): Parsed | { mode: "help" } {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { mode: "help" };
  const mode = args[0];
  if (mode !== "inspect" && mode !== "apply") throw new Error("First argument must be inspect or apply; use --help");
  const allowed = new Set(["--confirm-genesis", "--confirm-program", "--confirm-old-boundary", "--new-boundary",
    "--confirm-new-boundary", "--confirm-enrolled-wallet", "--reason", "--confirm-old-cursor-sha256", "--execute"]);
  const values = new Map<string, string>();
  for (const argument of args.slice(1)) {
    const separator = argument.indexOf("=");
    const key = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    if (!allowed.has(key) || values.has(key) || !value) throw new Error("Invalid, empty, or duplicate rotation argument; use --help");
    values.set(key, value);
  }
  const required = ["--confirm-genesis", "--confirm-program", "--confirm-old-boundary", "--new-boundary",
    "--confirm-new-boundary", "--confirm-enrolled-wallet", "--reason"];
  for (const key of required) if (!values.has(key)) throw new Error(`Missing ${key}; use --help`);
  if (values.get("--new-boundary") !== values.get("--confirm-new-boundary")) {
    throw new Error("--confirm-new-boundary must exactly repeat --new-boundary");
  }
  if (mode === "inspect" && (values.has("--confirm-old-cursor-sha256") || values.has("--execute"))) {
    throw new Error("Apply-only confirmations are not accepted by inspect");
  }
  if (mode === "apply" && (!values.has("--confirm-old-cursor-sha256")
    || values.get("--execute") !== APPLY_CONFIRMATION)) {
    throw new Error("Apply requires the inspected cursor digest and exact --execute confirmation");
  }
  return {
    mode,
    newBoundarySignature: values.get("--new-boundary")!,
    enrolledWalletAddress: values.get("--confirm-enrolled-wallet")!,
    reason: values.get("--reason")!,
    confirmations: {
      genesisHash: values.get("--confirm-genesis")!,
      programAddress: values.get("--confirm-program")!,
      oldBoundarySignature: values.get("--confirm-old-boundary")!,
      newBoundarySignature: values.get("--confirm-new-boundary")!,
      ...(values.has("--confirm-old-cursor-sha256")
        ? { oldCursorSha256: values.get("--confirm-old-cursor-sha256")! } : {}),
    },
  };
}

export async function runCoverageRotationCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
  const parsed = parseCoverageRotationArguments(args);
  if (parsed.mode === "help") { process.stdout.write(help); return; }
  const runtime = resolveSolanaRuntime(env);
  const input = { runtime, newBoundarySignature: parsed.newBoundarySignature,
    enrolledWalletAddress: parsed.enrolledWalletAddress, reason: parsed.reason, confirmations: parsed.confirmations };
  const result = parsed.mode === "inspect" ? await inspectCoverageRotation(input) : await rotateCoverageBoundary(input);
  process.stdout.write(`${JSON.stringify({ event: `solana_coverage_rotation_${parsed.mode}`, ...result },
    (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
}

if (process.argv[1]?.endsWith("solana-rotate-indexer-coverage.ts")) {
  void runCoverageRotationCli(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ event: "solana_coverage_rotation_stopped",
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: "Coverage was not rotated. Re-run inspect and verify the explicit localnet confirmations." }));
    process.exitCode = 1;
  });
}
