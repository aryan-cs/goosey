import { randomBytes } from "node:crypto";

import { address, createNoopSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { ensureManagedFeatherAccountReady, managedIdentityDigest } from "./managed-account-readiness";

const GENESIS = "Stake11111111111111111111111111111111111111";
const PROGRAM = "Vote111111111111111111111111111111111111111";
const AUTHORITY = createNoopSigner(address("SysvarRent111111111111111111111111111111111"));
const SPONSOR = createNoopSigner(address("11111111111111111111111111111111"));
const secret = randomBytes(32).toString("base64url");
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
  GOOSEY_SOLANA_IDENTITY_DIGEST_SECRET: secret, GOOSEY_SOLANA_USER_FEATHER_ALLOWANCE: "1000000",
  GOOSEY_SOLANA_ENROLLMENT_EXPIRES_AT: "2147483647" };

describe("managed feather account readiness", () => {
  it("derives a stable deployment-scoped private identity digest", () => {
    const first = managedIdentityDigest("user_12345678", GENESIS, secret);
    expect(first).toEqual(managedIdentityDigest("user_12345678", GENESIS, secret));
    expect(first).not.toEqual(managedIdentityDigest("user_87654321", GENESIS, secret));
    expect(first).toHaveLength(32);
  });

  it("resumes enrollment and claim until the finalized account is ready", async () => {
    const provision = vi.fn()
      .mockResolvedValueOnce({ status: "pending", operation: "enrollment", walletAddress: "wallet",
        chainId: "solana:localnet", genesisHash: GENESIS })
      .mockResolvedValueOnce({ status: "pending", operation: "claim", walletAddress: "wallet",
        chainId: "solana:localnet", genesisHash: GENESIS })
      .mockResolvedValueOnce({ status: "ready", operation: null, walletAddress: "wallet",
        chainId: "solana:localnet", genesisHash: GENESIS, finalizedSlot: 9n });
    const result = await ensureManagedFeatherAccountReady({ userId: "user_12345678", env }, {
      journal: {} as never,
      loadEnrollmentAuthority: vi.fn(async () => AUTHORITY),
      loadSponsor: vi.fn(async () => SPONSOR),
      provision,
    });
    expect(result.status).toBe("ready");
    expect(provision).toHaveBeenCalledTimes(3);
    const digest = provision.mock.calls[0][0].identityDigest as Uint8Array;
    expect([...digest]).toEqual([...provision.mock.calls[2][0].identityDigest]);
  });

  it("halts rather than replacing a transaction requiring reconciliation", async () => {
    const provision = vi.fn(async () => ({ status: "manual-reconciliation-required" as const,
      operation: "claim" as const, walletAddress: "wallet", chainId: "solana:localnet" as const,
      genesisHash: GENESIS }));
    await expect(ensureManagedFeatherAccountReady({ userId: "user_12345678", env }, {
      journal: {} as never, loadEnrollmentAuthority: vi.fn(async () => AUTHORITY),
      loadSponsor: vi.fn(async () => SPONSOR), provision,
    })).rejects.toThrow(/reconciliation/);
    expect(provision).toHaveBeenCalledOnce();
  });
});
