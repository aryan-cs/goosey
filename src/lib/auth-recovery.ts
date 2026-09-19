import { grantWelcomeFeathers, hashPassword, INTERACTIVE_ROLES } from "@/lib/auth";
import { db } from "@/lib/db";
import { EmailConfigurationError, sendEmail, smtpConfigFromEnvironment } from "@/lib/email";
import { randomToken, sha256 } from "@/lib/security";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { authDestination } from "@/lib/auth-destination";

export const EMAIL_VERIFICATION_PURPOSE = "EMAIL_VERIFICATION";
export const PASSWORD_RESET_PURPOSE = "PASSWORD_RESET";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class InvalidAccountTokenError extends Error {
  constructor() {
    super("The link is invalid or has expired.");
    this.name = "InvalidAccountTokenError";
  }
}

export function tokenDurationMinutes(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 5 || value > maximum) {
    throw new Error(`${name} must be an integer between 5 and ${maximum}`);
  }
  return value;
}

export function buildAccountActionUrl(environmentName: string, defaultPath: string, token: string, next?: string): string {
  const configured = process.env[environmentName]?.trim();
  const appUrl = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = configured || (appUrl ? new URL(defaultPath, appUrl).toString() : null);
  if (!base) throw new EmailConfigurationError();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new EmailConfigurationError();
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new EmailConfigurationError();
  }
  if (process.env.NODE_ENV === "production") {
    const canonicalValue = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (!canonicalValue) throw new EmailConfigurationError();
    let canonical: URL;
    try {
      canonical = new URL(canonicalValue);
    } catch {
      throw new EmailConfigurationError();
    }
    if (canonical.protocol !== "https:" || url.origin !== canonical.origin) {
      throw new EmailConfigurationError();
    }
  }
  if (next !== undefined) url.searchParams.set("next", authDestination(next));
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function isValidAccountToken(token: string): boolean {
  return TOKEN_PATTERN.test(token) && Buffer.from(token, "base64url").byteLength === 32;
}

async function issueToken(input: {
  userId: string;
  purpose: string;
  expiresAt: Date;
}): Promise<{ id: string; token: string; tokenHash: string }> {
  const token = randomToken();
  const tokenHash = sha256(token);
  const record = await db.$transaction(async (tx) => {
    const issued = await tx.accountToken.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        tokenHash,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    const systemActor = await tx.user.findFirst({
      where: { role: "SYSTEM", status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!systemActor) throw new EmailConfigurationError();
    await tx.auditLog.create({
      data: {
        actorUserId: systemActor.id,
        action: `${input.purpose}_ISSUED`,
        entityType: "USER",
        entityId: input.userId,
      },
    });
    return issued;
  });
  return { ...record, token, tokenHash };
}

async function removeUndeliveredToken(id: string, tokenHash: string): Promise<void> {
  await db.accountToken.deleteMany({ where: { id, tokenHash, consumedAt: null } });
}

export async function requestEmailVerification(email: string, next?: string): Promise<void> {
  smtpConfigFromEnvironment();
  buildAccountActionUrl("EMAIL_VERIFICATION_URL", "/verify-email", "A".repeat(43));
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true, emailVerifiedAt: true, status: true, role: true },
  });
  if (!user || user.status !== "ACTIVE" || user.role !== "USER" || user.emailVerifiedAt) return;

  const minutes = tokenDurationMinutes("EMAIL_VERIFICATION_TTL_MINUTES", 60, 1_440);
  const issued = await issueToken({
    userId: user.id,
    purpose: EMAIL_VERIFICATION_PURPOSE,
    expiresAt: new Date(Date.now() + minutes * 60_000),
  });
  try {
    const url = buildAccountActionUrl("EMAIL_VERIFICATION_URL", "/verify-email", issued.token, next);
    await sendEmail({
      to: user.email,
      subject: "Verify your Goosey email",
      text: `Hi ${user.displayName},\n\nVerify your Goosey email by opening this link:\n${url}\n\nThis one-time link expires in ${minutes} minutes. If you did not request it, you can ignore this email.`,
    });
  } catch (error) {
    await removeUndeliveredToken(issued.id, issued.tokenHash);
    throw error;
  }
}

export async function confirmEmailVerificationWithDatabase(
  database: typeof db,
  token: string,
): Promise<{ userId: string; welcomeGrantIssued: boolean }> {
  if (!isValidAccountToken(token)) throw new InvalidAccountTokenError();
  const tokenHash = sha256(token);
  const operationAt = new Date();
  return runSerializableTransaction(database, async (tx) => {
    const record = await tx.accountToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, purpose: true },
    });
    if (!record || record.purpose !== EMAIL_VERIFICATION_PURPOSE) throw new InvalidAccountTokenError();
    const now = operationAt;
    const eligibleUser = await tx.user.findFirst({
      where: { id: record.userId, role: "USER", status: "ACTIVE", emailVerifiedAt: null },
      select: { id: true },
    });
    if (!eligibleUser) throw new InvalidAccountTokenError();
    const claimed = await tx.accountToken.updateMany({
      where: { id: record.id, tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) throw new InvalidAccountTokenError();
    await tx.accountToken.updateMany({
      where: { userId: record.userId, purpose: EMAIL_VERIFICATION_PURPOSE, consumedAt: null },
      data: { consumedAt: now },
    });
    const verified = await tx.user.updateMany({
      where: { id: record.userId, role: "USER", status: "ACTIVE", emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
    if (verified.count !== 1) throw new InvalidAccountTokenError();
    const welcomeGrantIssued = await grantWelcomeFeathers(tx, record.userId);
    if (!welcomeGrantIssued) {
      throw new Error("Email verification welcome grant integrity check failed.");
    }
    await tx.auditLog.create({
      data: {
        actorUserId: record.userId,
        action: "EMAIL_VERIFIED",
        entityType: "USER",
        entityId: record.userId,
      },
    });
    return { userId: record.userId, welcomeGrantIssued };
  });
}

export async function confirmEmailVerification(token: string): Promise<{ userId: string; welcomeGrantIssued: boolean }> {
  return confirmEmailVerificationWithDatabase(db, token);
}

export async function requestPasswordReset(email: string, next?: string): Promise<void> {
  smtpConfigFromEnvironment();
  buildAccountActionUrl("PASSWORD_RESET_URL", "/reset-password", "A".repeat(43));
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true, status: true, role: true },
  });
  if (!user || user.status !== "ACTIVE" || !INTERACTIVE_ROLES.includes(user.role)) return;

  const minutes = tokenDurationMinutes("PASSWORD_RESET_TTL_MINUTES", 30, 240);
  const issued = await issueToken({
    userId: user.id,
    purpose: PASSWORD_RESET_PURPOSE,
    expiresAt: new Date(Date.now() + minutes * 60_000),
  });
  try {
    const url = buildAccountActionUrl("PASSWORD_RESET_URL", "/reset-password", issued.token, next);
    await sendEmail({
      to: user.email,
      subject: "Reset your Goosey password",
      text: `Hi ${user.displayName},\n\nReset your Goosey password by opening this link:\n${url}\n\nThis one-time link expires in ${minutes} minutes. If you did not request it, you can ignore this email.`,
    });
  } catch (error) {
    await removeUndeliveredToken(issued.id, issued.tokenHash);
    throw error;
  }
}

export async function confirmPasswordResetWithDatabase(
  database: typeof db,
  token: string,
  newPassword: string,
): Promise<void> {
  if (!isValidAccountToken(token)) throw new InvalidAccountTokenError();
  const passwordHash = await hashPassword(newPassword);
  const tokenHash = sha256(token);
  const operationAt = new Date();
  await runSerializableTransaction(database, async (tx) => {
    const record = await tx.accountToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, purpose: true },
    });
    if (!record || record.purpose !== PASSWORD_RESET_PURPOSE) throw new InvalidAccountTokenError();
    const now = operationAt;
    const claimed = await tx.accountToken.updateMany({
      where: { id: record.id, tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) throw new InvalidAccountTokenError();
    await tx.accountToken.updateMany({
      where: { userId: record.userId, purpose: PASSWORD_RESET_PURPOSE, consumedAt: null },
      data: { consumedAt: now },
    });

    const updated = await tx.user.updateMany({
      where: { id: record.userId, status: "ACTIVE", role: { in: INTERACTIVE_ROLES } },
      data: { passwordHash },
    });
    if (updated.count !== 1) throw new InvalidAccountTokenError();
    await tx.session.deleteMany({ where: { userId: record.userId } });
    await tx.auditLog.create({
      data: {
        actorUserId: record.userId,
        action: "PASSWORD_RESET",
        entityType: "USER",
        entityId: record.userId,
        metadata: JSON.stringify({ sessionsRevoked: true }),
      },
    });
  });
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  return confirmPasswordResetWithDatabase(db, token, newPassword);
}
