import type { Prisma, PrismaClient } from "@prisma/client";
import { createKeyPairSignerFromBytes, type TransactionPartialSigner } from "@solana/kit";

import { INTERACTIVE_ROLES, requiresEmailVerification } from "@/lib/auth";
import { db } from "@/lib/db";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import {
  CustodyKeyDecryptionError,
  generateSolanaSecretKey,
  openCustodySecretKey,
  resolveCustodyEncryptionConfiguration,
  sealCustodySecretKey,
} from "@/lib/solana/custody-crypto";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

type CustodyDatabase = PrismaClient | (TransactionRunner & Pick<PrismaClient, "solanaCustodyIdentity">);

export type AppManagedSolanaIdentity = Readonly<{
  id: string;
  userId: string;
  chainId: "solana:localnet" | "solana:devnet";
  genesisHash: string;
  walletAddress: string;
  createdAt: Date;
}>;

export class CustodyIdentityAccessError extends Error {
  constructor() {
    super("An active authenticated Goosey account is required for app-managed Solana custody.");
    this.name = "CustodyIdentityAccessError";
  }
}

export class CustodyIdentityMissingError extends Error {
  constructor() {
    super("No app-managed Solana identity exists for this Goosey account and network.");
    this.name = "CustodyIdentityMissingError";
  }
}

const publicSelect = {
  id: true,
  userId: true,
  chainId: true,
  genesisHash: true,
  walletAddress: true,
  createdAt: true,
} satisfies Prisma.SolanaCustodyIdentitySelect;

const signerSelect = {
  ...publicSelect,
  encryptionAlgorithm: true,
  keyVersion: true,
  keyId: true,
  encryptedSecretKey: true,
  encryptionNonce: true,
  encryptionAuthTag: true,
} satisfies Prisma.SolanaCustodyIdentitySelect;

function domain(env: Record<string, string | undefined>) {
  const runtime = resolveSolanaRuntime(env);
  return {
    chainId: `solana:${runtime.cluster}` as const,
    genesisHash: runtime.genesisHash,
  };
}

async function requireEligibleUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  if (!userId || userId.length > 191) throw new CustodyIdentityAccessError();
  const user = await tx.user.findFirst({
    where: { id: userId, status: "ACTIVE", role: { in: INTERACTIVE_ROLES } },
    select: { role: true, emailVerifiedAt: true },
  });
  if (!user || requiresEmailVerification(user)) throw new CustodyIdentityAccessError();
}

/**
 * Idempotently maps an authenticated Goosey principal to a server-custodied
 * identity. Callers must pass the user id obtained from Goosey's authenticated
 * server session, never a client-provided id. The returned DTO cannot contain
 * encrypted or plaintext key material.
 */
export async function ensureAppManagedSolanaIdentity(
  userId: string,
  env: Record<string, string | undefined> = process.env,
  database: CustodyDatabase = db,
): Promise<AppManagedSolanaIdentity> {
  const network = domain(env);
  const encryption = resolveCustodyEncryptionConfiguration(env);
  try {
    return await runSerializableTransaction(database, async (tx) => {
      await requireEligibleUser(tx, userId);
      const existing = await tx.solanaCustodyIdentity.findUnique({
        where: { userId_chainId_genesisHash: { userId, ...network } },
        select: publicSelect,
      });
      if (existing) return existing as AppManagedSolanaIdentity;

      const generated = generateSolanaSecretKey();
      try {
        const context = { userId, ...network, walletAddress: generated.walletAddress };
        const sealed = sealCustodySecretKey(generated.secretKey, context, encryption);
        return await tx.solanaCustodyIdentity.create({
          data: { userId, ...network, walletAddress: generated.walletAddress, ...sealed },
          select: publicSelect,
        }) as AppManagedSolanaIdentity;
      } finally {
        generated.secretKey.fill(0);
      }
    });
  } finally {
    encryption.key.fill(0);
  }
}

/** Server-internal signer access for a future settlement worker. Never return
 * this object from a route, Server Action, log statement, or client prop. */
export async function loadAppManagedSolanaSigner(
  userId: string,
  env: Record<string, string | undefined> = process.env,
  database: CustodyDatabase = db,
): Promise<TransactionPartialSigner> {
  const network = domain(env);
  const encryption = resolveCustodyEncryptionConfiguration(env);
  try {
    const record = await runSerializableTransaction(database, async (tx) => {
      await requireEligibleUser(tx, userId);
      return tx.solanaCustodyIdentity.findUnique({
        where: { userId_chainId_genesisHash: { userId, ...network } },
        select: signerSelect,
      });
    });
    if (!record) throw new CustodyIdentityMissingError();
    const context = { userId, ...network, walletAddress: record.walletAddress };
    const secretKey = openCustodySecretKey({
      encryptionAlgorithm: record.encryptionAlgorithm as "AES-256-GCM",
      keyVersion: record.keyVersion as 1,
      keyId: record.keyId,
      encryptedSecretKey: record.encryptedSecretKey,
      encryptionNonce: record.encryptionNonce,
      encryptionAuthTag: record.encryptionAuthTag,
    }, context, encryption);
    try {
      const signer = await createKeyPairSignerFromBytes(secretKey);
      if (signer.address !== record.walletAddress) throw new CustodyKeyDecryptionError();
      return signer;
    } finally {
      secretKey.fill(0);
    }
  } finally {
    encryption.key.fill(0);
  }
}
