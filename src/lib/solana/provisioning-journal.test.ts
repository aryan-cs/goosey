import { generateKeyPairSync } from "node:crypto";

import { createKeyPairSignerFromBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";

import type { ProvisioningCheckpoint } from "./account-provisioning";
import { decodeProvisioningCheckpoint, encodeProvisioningCheckpoint, PrismaProvisioningJournal } from "./provisioning-journal";

async function signer() {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x) throw new Error("test key export failed");
  const bytes = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]);
  try { return await createKeyPairSignerFromBytes(bytes); } finally { bytes.fill(0); }
}

async function checkpoint(): Promise<ProvisioningCheckpoint> {
  const [wallet, authority, sponsor, genesis] = await Promise.all([signer(), signer(), signer(), signer()]);
  return { version: 1, userId: "user_12345678", chainId: "solana:localnet", genesisHash: genesis.address,
    programAddress: authority.address, walletAddress: wallet.address, identityDigestHex: "ab".repeat(32),
    allowance: "100000", expiresAt: "2000000000", enrollmentAuthority: authority.address,
    sponsor: sponsor.address, pending: null };
}

function database() {
  let row: { id: string; revision: number; checkpointJson: string } | null = null;
  const model = {
    findUnique: async () => row && ({ revision: row.revision, checkpointJson: row.checkpointJson }),
    create: async ({ data }: { data: { checkpointJson: string } }) => {
      if (row) { const error = new Error("unique") as Error & { code: string }; error.code = "P2002"; throw error; }
      row = { id: "checkpoint_1", revision: 0, checkpointJson: data.checkpointJson }; return row;
    },
    updateMany: async ({ where, data }: { where: { revision: number; checkpointJson: string };
      data: { checkpointJson: string } }) => {
      if (!row || row.revision !== where.revision || row.checkpointJson !== where.checkpointJson) return { count: 0 };
      row = { ...row, revision: row.revision + 1, checkpointJson: data.checkpointJson }; return { count: 1 };
    },
  };
  const client = { solanaProvisioningCheckpoint: model,
    $transaction: async (operation: (tx: unknown) => unknown) => operation(client) };
  return client as never;
}

describe("Prisma provisioning journal", () => {
  it("round-trips bigint receipt metadata without exposing a mutable checkpoint", async () => {
    const initial = await checkpoint();
    const pending = { ...initial, pending: { operation: "claim" as const, signature: "1".repeat(64),
      signedWireBase64: "AQ==", lastValidBlockHeight: 99n } };
    const decoded = decodeProvisioningCheckpoint(encodeProvisioningCheckpoint(pending));
    expect(decoded).toEqual(pending);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.pending)).toBe(true);
  });

  it("enforces exact compare-and-set lineage and immutable intent", async () => {
    const journal = new PrismaProvisioningJournal(database());
    const initial = await checkpoint();
    await journal.save(null, initial);
    const loaded = await journal.load({ userId: initial.userId, chainId: initial.chainId, genesisHash: initial.genesisHash });
    expect(loaded).not.toBeNull();
    const pending = { ...loaded!, pending: { operation: "enrollment" as const, signature: "1".repeat(64),
      signedWireBase64: "AQ==", lastValidBlockHeight: 100n } };
    await journal.save(loaded, pending);
    await expect(journal.save(loaded, pending)).rejects.toThrow(/conflict|loaded/);
    await expect(journal.save(pending, { ...pending, allowance: "2" })).rejects.toThrow(/immutable/);
  });
});
