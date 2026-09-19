import { describe, expect, it } from "vitest";
import { parseCoverageRotationArguments } from "./solana-rotate-indexer-coverage";

const signature = "2".repeat(64);
const args = ["--confirm-genesis=11111111111111111111111111111111", "--confirm-program=11111111111111111111111111111111",
  `--confirm-old-boundary=${"3".repeat(64)}`, `--new-boundary=${signature}`, `--confirm-new-boundary=${signature}`,
  "--confirm-enrolled-wallet=11111111111111111111111111111111", "--reason=Retained localnet history pruned the prior boundary"];

describe("coverage rotation command arguments", () => {
  it("keeps inspect read-only and makes apply repeat the inspected digest plus an explicit verb", () => {
    const inspected = parseCoverageRotationArguments(["inspect", ...args]);
    expect(inspected).toMatchObject({ mode: "inspect" });
    if (inspected.mode !== "help") expect(inspected.confirmations).not.toHaveProperty("oldCursorSha256");
    expect(parseCoverageRotationArguments(["apply", ...args, `--confirm-old-cursor-sha256=${"a".repeat(64)}`,
      "--execute=ROTATE_LOCALNET_BOUNDED_COVERAGE"])).toMatchObject({ mode: "apply",
      confirmations: { oldCursorSha256: "a".repeat(64) } });
  });

  it.each([
    ["missing mode", args],
    ["duplicate", ["inspect", ...args, args[0]]],
    ["mismatched new", ["inspect", ...args.filter(value => !value.startsWith("--confirm-new-boundary=")), `--confirm-new-boundary=${"4".repeat(64)}`]],
    ["apply without digest", ["apply", ...args, "--execute=ROTATE_LOCALNET_BOUNDED_COVERAGE"]],
    ["apply without verb", ["apply", ...args, `--confirm-old-cursor-sha256=${"a".repeat(64)}`]],
    ["inspect with apply flag", ["inspect", ...args, `--confirm-old-cursor-sha256=${"a".repeat(64)}`]],
  ])("rejects %s", (_name, value) => {
    expect(() => parseCoverageRotationArguments(value)).toThrow();
  });
});
