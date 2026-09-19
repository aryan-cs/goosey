import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { createSession, INTERACTIVE_ROLES, requiresEmailVerification, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { constantTimeEqual, isValidPassword, sha256 } from "@/lib/security";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import {
  createWalletChallenge,
  verifyWalletChallenge,
  type WalletChallenge,
  type WalletChallengeChain,
} from "@/lib/solana/wallet-challenge";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

// Only challenges issued AFTER explicit credential verification satisfy this
// purpose. Pre-upgrade LINK_WALLET rows cannot be upgraded by session rotation.
const LINK_PURPOSE = "LINK_WALLET_REAUTH_V1";
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
  | "REAUTHENTICATION_REQUIRED"
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

/** Reverify the current password, then persist a five-minute ownership challenge
 * for the ORIGINAL authenticated session. Its new purpose is the durable proof
 * this issuance used credential reauthentication, not merely a fresh cookie.
 * The caller supplies trusted deployment configuration, never request headers. */
export async function issueWalletLinkChallenge(
  input: {
    authentication: WalletLinkAuthentication;
    configuration: WalletLinkConfiguration;
    walletAddress: string;
    password: string;
    now?: Date;
  },
  client: TransactionRunner = db,
): Promise<IssuedWalletLinkChallenge> {
  const authentication = { ...input.authentication }, configuration = { ...input.configuration };
  const walletAddress = input.walletAddress, password = input.password;
  const tokenHash = sessionTokenHash(authentication);
  if (typeof password !== "string" || !isValidPassword(password)) throw new WalletLinkError("REAUTHENTICATION_REQUIRED", "Current password required.");
  const credential = await runSerializableTransaction(client, async tx => {
    await requireSession(tx, authentication, tokenHash, input.now ?? new Date());
    return tx.user.findUniqueOrThrow({ where: { id: authentication.userId }, select: { passwordHash: true } });
  });
  // bcrypt stays outside the serializable transaction, like login. Re-read the
  // exact verified hash below to close the concurrent credential-change race.
  if (!await verifyPassword(password, credential.passwordHash)) throw new WalletLinkError("REAUTHENTICATION_REQUIRED", "Current password required.");
  const now = input.now ?? new Date();
  const challenge = createWalletChallenge({
    ...configuration,
    walletAddress,
    now,
  });
  const id = randomUUID();

  try {
    return await runSerializableTransaction(client, async (tx) => {
      const session = await requireSession(tx, authentication, tokenHash, now);
      const current = await tx.user.findFirst({ where: { id: authentication.userId, passwordHash: credential.passwordHash }, select: { id: true } });
      if (!current) throw new WalletLinkError("REAUTHENTICATION_REQUIRED", "Credentials changed; authenticate again.");
      await tx.solanaWalletLinkChallenge.create({
        data: {
          id,
          userId: authentication.userId,
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

/** Verify exact signed bytes, consume the reauthenticated session-bound challenge,
 * create the association and replace/revoke the session in ONE transaction.
 * The route must set the replacement cookie only after commit, never serialize
 * its token into JSON. Lost responses require sign-in and reading the existing
 * link, not replaying the consumed challenge. No feather grant or transaction
 * authorization occurs here; replacement session issuance is NOT reauth proof. */
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
): Promise<{ wallet: LinkedSolanaWallet; session: Awaited<ReturnType<typeof createSession>> }> {
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

      const wallet = await tx.solanaWalletLink.create({
        data: {
          userId: input.authentication.userId,
          chainId: stored.chainId,
          genesisHash: stored.genesisHash,
          walletAddress: verification.walletAddress,
          verifiedAt: now,
        },
        select: walletLinkSelect,
      });
      const old = await tx.session.findUniqueOrThrow({ where: { id: session.id }, select: { userAgent: true, ipHash: true } });
      const replacement = await createSession(tx, input.authentication.userId, old);
      const revoked = await tx.session.deleteMany({ where: { id: session.id, tokenHash, userId: input.authentication.userId } });
      if (revoked.count !== 1) throw new WalletLinkError("AUTHENTICATION_REQUIRED", "Session changed during linking.");
      // sessionId on challenge is intentionally NOT a FK: retain its original
      // binding and consumed tombstone after revoking the old session.
      return { wallet, session: replacement };
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
