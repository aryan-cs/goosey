import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

import type { ProvisioningCheckpoint, ProvisioningOperation } from "@/lib/solana/account-provisioning";
import {
  provisioningChainCommand,
  provisioningSignedWireJournal,
} from "@/lib/solana/chain-command-provisioning";

const base58 = (length: number, fill: number) => getBase58Decoder().decode(new Uint8Array(length).fill(fill));
const sponsor = base58(32, 1);
const authority = base58(32, 2);
const wallet = base58(32, 3);
const blockhash = base58(32, 4);
const transactionSignature = base58(64, 5);

function wire(signers: readonly string[]): string {
  const encoder = (value: string) => Buffer.from(getBase58Encoder().encode(value));
  return Buffer.concat([
    Buffer.from([signers.length]),
    Buffer.from(new Uint8Array(64).fill(5)),
    ...Array.from({ length: signers.length - 1 }, () => Buffer.from(new Uint8Array(64).fill(6))),
    Buffer.from([signers.length, 0, 0]),
    Buffer.from([signers.length]),
    ...signers.map(encoder),
    encoder(blockhash),
    Buffer.from([0]),
  ]).toString("base64");
}

function checkpoint(operation: ProvisioningOperation): ProvisioningCheckpoint {
  const signers = operation === "enrollment" ? [sponsor, authority] : [sponsor, wallet];
  return {
    version: 1,
    userId: "user_12345678",
    chainId: "solana:localnet",
    genesisHash: "11111111111111111111111111111111",
    programAddress: "BPFLoaderUpgradeab1e11111111111111111111111",
    walletAddress: wallet,
    identityDigestHex: "12".repeat(32),
    allowance: "1000000",
    expiresAt: "2000000000",
    enrollmentAuthority: authority,
    sponsor,
    pending: { operation, signature: transactionSignature, signedWireBase64: wire(signers), lastValidBlockHeight: 300n },
  };
}

describe("provisioning ChainCommand adapter", () => {
  it.each(["enrollment", "claim"] as const)("freezes the complete %s intent into a scoped request", operation => {
    const command = provisioningChainCommand(checkpoint(operation), operation);
    expect(command).toMatchObject({
      cluster: "localnet",
      scope: "USER",
      scopeId: "user_12345678",
      actorId: "user_12345678",
      operation: operation.toUpperCase(),
      idempotencyKey: `provisioning:v1:${operation}`,
    });
    expect(command.requestJson).toContain('"identityDigestHex"');
    expect(command.requestJson).toContain('"enrollmentAuthority"');
    expect(command.requestJson).toContain('"sponsor"');
  });

  it.each(["enrollment", "claim"] as const)("journals the exact pending %s receipt", operation => {
    const journal = provisioningSignedWireJournal(checkpoint(operation), {
      commandId: "command_12345678", sequence: 0, leaseEpoch: 1, commandRevision: 2,
    });
    expect(journal).toMatchObject({
      transactionSignature,
      recentBlockhash: blockhash,
      lastValidBlockHeight: 300n,
      feePayerAddress: sponsor,
      wireVersion: "legacy",
    });
  });

  it("rejects signer-role substitution and mutable provisioning intent", () => {
    const changed = checkpoint("enrollment");
    expect(() => provisioningSignedWireJournal({ ...changed, sponsor: wallet }, {
      commandId: "command_12345678", sequence: 0, leaseEpoch: 1, commandRevision: 2,
    })).toThrow(/signer roles/);
    expect(() => provisioningChainCommand({ ...changed, allowance: "01" }, "enrollment")).toThrow(/allowance/);
  });

  it("does not invent a receipt before provisioning has durably frozen one", () => {
    expect(() => provisioningSignedWireJournal({ ...checkpoint("claim"), pending: null }, {
      commandId: "command_12345678", sequence: 0, leaseEpoch: 1, commandRevision: 2,
    })).toThrow(/no pending/);
  });
});
