import { probeSolanaRuntime, resolveSolanaRuntime } from "../src/lib/solana/runtime";

try {
  const result = await probeSolanaRuntime(resolveSolanaRuntime());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Third-party RPC errors can include provider credentials in URL query params.
  process.stderr.write("Solana preflight failed. Verify the non-mainnet cluster, pinned genesis, RPC availability, and deployed program. No transaction was submitted.\n");
  process.exitCode = 1;
}
