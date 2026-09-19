import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { INTERACTIVE_ROLES, requiresEmailVerification } from "@/lib/auth";
import { db } from "@/lib/db";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { constantTimeEqual, sha256 } from "@/lib/security";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import {
  createWalletChallenge,
  verifyWalletChallenge,
  type WalletChallenge,
  type WalletChallengeChain,
} from "@/lib/solana/wallet-challenge";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const LINK_PURPOSE = "LINK_WALLET";
const MAX_SESSION_TOKEN_LENGTH = 512;

export type WalletLinkConfiguration = Readonly<{
  origin: string;
  chainId: WalletChallengeChain;
  genesisHash: string;
}>;

export type WalletLinkAuthentication = Readonly<{
  userId: string;
  sessionToken: string;
}>;

export type IssuedWalletLinkChallenge = Readonly<{
  id: string;
  challenge: WalletChallenge;
}>;

export type LinkedSolanaWallet = Readonly<{
  id: string;
  userId: string;
  chainId: string;
  genesisHash: string;
  walletAddress: string;
  verifiedAt: Date;
}>;

export type WalletLinkErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "EMAIL_VERIFICATION_REQUIRED"
  | "INVALID_CHALLENGE"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_ALREADY_USED"
  | "WALLET_LINK_CONFLICT";

export class WalletLinkError extends Error {
  constructor(
    readonly code: WalletLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletLinkError";
  }
}

/** Resolve only server-owned deployment settings. A future route must not
 * derive these values from Host, Origin, wallet, or RPC request input. */
export function resolveWalletLinkConfiguration(
  env: Record<string, string | undefined> = process.env,
): WalletLinkConfiguration {
  const runtime = resolveSolanaRuntime(env);
  const rawOrigin = env.APP_URL;
  let url: URL;
  try {
    url = new URL(rawOrigin ?? "");
  } catch {
    throw new Error("APP_URL must configure the exact Goosey origin before wallet linking is enabled.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("APP_URL must configure the exact Goosey HTTP(S) origin before wallet linking is enabled.");
  }
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Wallet linking requires an HTTPS APP_URL in production.");
  }
  return {
    origin: url.origin,
    chainId: `solana:${runtime.cluster}`,
    genesisHash: runtime.genesisHash,
  };
}

const walletLinkSelect = {
  id: true,
  userId: true,
  chainId: true,
  genesisHash: true,
  walletAddress: true,
  verifiedAt: true,
} satisfies Prisma.SolanaWalletLinkSelect;

function sessionTokenHash(authentication: WalletLinkAuthentication): string {
  if (
    typeof authentication.userId !== "string" ||
    authentication.userId.length === 0 ||
    typeof authentication.sessionToken !== "string" ||
    authentication.sessionToken.length === 0 ||
    authentication.sessionToken.length > MAX_SESSION_TOKEN_LENGTH
  ) {
    throw new WalletLinkError("AUTHENTICATION_REQUIRED", "Sign in again before linking a wallet.");
  }
  return sha256(authentication.sessionToken);
}

async function requireSession(
  tx: Prisma.TransactionClient,
  authentication: WalletLinkAuthentication,
  tokenHash: string,
  now: Date,
): Promise<{ id: string }> {
  const session = await tx.session.findFirst({
    where: {
      tokenHash,
      userId: authentication.userId,
      expiresAt: { gt: now },
      user: { status: "ACTIVE", role: { in: INTERACTIVE_ROLES } },
    },
    select: {
      id: true,
      user: { select: { role: true, emailVerifiedAt: true } },
    },
  });
  if (!session) {
    throw new WalletLinkError("AUTHENTICATION_REQUIRED", "Sign in again before linking a wallet.");
  }
  if (requiresEmailVerification(session.user)) {
    throw new WalletLinkError("EMAIL_VERIFICATION_REQUIRED", "Verify your email before linking a wallet.");
  }
  return { id: session.id };
}

function challengeMatchesRecord(
  challenge: WalletChallenge,
  record: {
    purpose: string;
    origin: string;
    domain: string;
    uri: string;
    chainId: string;
    genesisHash: string;
    walletAddress: string;
    nonceHash: string;
    messageHash: string;
    issuedAt: Date;
    expiresAt: Date;
  },
  configuration: WalletLinkConfiguration,
): boolean {
  try {
    return (
      record.purpose === LINK_PURPOSE &&
      record.origin === challenge.uri &&
      record.chainId === configuration.chainId &&
      record.genesisHash === configuration.genesisHash &&
      challenge.domain === record.domain &&
      challenge.uri === record.uri &&
      challenge.chainId === record.chainId &&
      challenge.genesisHash === record.genesisHash &&
      challenge.walletAddress === record.walletAddress &&
      challenge.issuedAt === record.issuedAt.toISOString() &&
      challenge.expirationTime === record.expiresAt.toISOString() &&
      constantTimeEqual(sha256(challenge.nonce), record.nonceHash) &&
      constantTimeEqual(sha256(challenge.message), record.messageHash)
    );
  } catch {
    return false;
  }
}

/** Persist a short-lived ownership challenge for one current Goosey session.
 * The caller supplies trusted deployment configuration, never request headers. */
export async function issueWalletLinkChallenge(
  input: {
    authentication: WalletLinkAuthentication;
    configuration: WalletLinkConfiguration;
    walletAddress: string;
    now?: Date;
  },
  client: TransactionRunner = db,
): Promise<IssuedWalletLinkChallenge> {
  const now = input.now ?? new Date();
  const challenge = createWalletChallenge({
    ...input.configuration,
    walletAddress: input.walletAddress,
    now,
  });
  const id = randomUUID();
  const tokenHash = sessionTokenHash(input.authentication);

  try {
    return await runSerializableTransaction(client, async (tx) => {
      const session = await requireSession(tx, input.authentication, tokenHash, now);
      await tx.solanaWalletLinkChallenge.create({
        data: {
          id,
          userId: input.authentication.userId,
          sessionId: session.id,
          purpose: LINK_PURPOSE,
          origin: challenge.uri,
          domain: challenge.domain,
          uri: challenge.uri,
          chainId: challenge.chainId,
          genesisHash: challenge.genesisHash,
          walletAddress: challenge.walletAddress,
          nonceHash: sha256(challenge.nonce),
          messageHash: sha256(challenge.message),
          issuedAt: new Date(challenge.issuedAt),
          expiresAt: new Date(challenge.expirationTime),
        },
      });
      return { id, challenge };
    });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) {
      throw new WalletLinkError("INVALID_CHALLENGE", "Unable to issue a unique wallet challenge.");
    }
    throw error;
  }
}

/** Verify exact signed bytes, consume the session-bound challenge, and create
 * the off-chain account association in one transaction. This does not grant
 * feathers or authorize any Solana or Goosey exchange transaction. */
export async function consumeWalletLinkChallenge(
  input: {
    authentication: WalletLinkAuthentication;
    configuration: WalletLinkConfiguration;
    challengeId: string;
    challenge: WalletChallenge;
    signedMessageBase64: string;
    signatureBase64: string;
    now?: Date;
  },
  client: TransactionRunner = db,
): Promise<LinkedSolanaWallet> {
  const now = input.now ?? new Date();
  const tokenHash = sessionTokenHash(input.authentication);

  try {
    return await runSerializableTransaction(client, async (tx) => {
      const session = await requireSession(tx, input.authentication, tokenHash, now);
      const stored = await tx.solanaWalletLinkChallenge.findFirst({
        where: {
          id: input.challengeId,
          userId: input.authentication.userId,
          sessionId: session.id,
        },
      });
      if (!stored) {
        throw new WalletLinkError("INVALID_CHALLENGE", "Wallet challenge was not found for this session.");
      }
      if (stored.consumedAt) {
        throw new WalletLinkError("CHALLENGE_ALREADY_USED", "Wallet challenge has already been used.");
      }
      if (stored.expiresAt.getTime() <= now.getTime()) {
        throw new WalletLinkError("CHALLENGE_EXPIRED", "Wallet challenge has expired.");
      }
      if (!challengeMatchesRecord(input.challenge, stored, input.configuration)) {
        throw new WalletLinkError("INVALID_CHALLENGE", "Wallet challenge does not match its stored request.");
      }

      const verification = verifyWalletChallenge({
        challenge: input.challenge,
        context: {
          ...input.configuration,
          walletAddress: stored.walletAddress,
        },
        signedMessageBase64: input.signedMessageBase64,
        signatureBase64: input.signatureBase64,
        now,
      });
      if (!verification.verified) {
        const code = verification.reason === "EXPIRED" ? "CHALLENGE_EXPIRED" : "INVALID_CHALLENGE";
        throw new WalletLinkError(code, "Wallet ownership signature could not be verified.");
      }

      const consumed = await tx.solanaWalletLinkChallenge.updateMany({
        where: {
          id: stored.id,
          userId: input.authentication.userId,
          sessionId: session.id,
          purpose: LINK_PURPOSE,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw new WalletLinkError("CHALLENGE_ALREADY_USED", "Wallet challenge has already been used.");
      }

      return tx.solanaWalletLink.create({
        data: {
          userId: input.authentication.userId,
          chainId: stored.chainId,
          genesisHash: stored.genesisHash,
          walletAddress: verification.walletAddress,
          verifiedAt: now,
        },
        select: walletLinkSelect,
      });
    });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) {
      throw new WalletLinkError(
        "WALLET_LINK_CONFLICT",
        "That wallet or Goosey account is already linked for this Solana deployment.",
      );
    }
    throw error;
  }
}
