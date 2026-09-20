import { Prisma, type User } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { isEmailDeliveryConfigured } from "@/lib/email";
import { deterministicSecretToken, randomToken, RegistrationDeviceInUseError, sha256 } from "@/lib/security";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const INTERACTIVE_ROLES = ["USER", "ADMIN"];

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "goosey_session";
export const REGISTRATION_DEVICE_COOKIE_NAME = "goosey_registration_device";

const DEFAULT_STARTING_FEATHERS = "1000";
const MAX_STARTING_FEATHERS = 1_000_000n;

export class WelcomeGrantConfigurationError extends Error {
  constructor() {
    super(`STARTING_FEATHERS must be a positive integer no greater than ${MAX_STARTING_FEATHERS.toString()}.`);
    this.name = "WelcomeGrantConfigurationError";
  }
}

export function parseWelcomeGrantMilli(raw: string | undefined): bigint {
  const value = raw === undefined ? DEFAULT_STARTING_FEATHERS : raw.trim();
  if (!/^[1-9]\d*$/.test(value)) throw new WelcomeGrantConfigurationError();
  const feathers = BigInt(value);
  if (feathers > MAX_STARTING_FEATHERS) throw new WelcomeGrantConfigurationError();
  return feathers * 1_000n;
}

export function welcomeGrantMilliFromEnvironment(): bigint {
  return parseWelcomeGrantMilli(process.env.STARTING_FEATHERS);
}

// Keep module import safe even when deployment configuration is invalid. Economic
// mutation paths re-validate and fail closed before posting any journal entry.
export const WELCOME_GRANT_MILLI = (() => {
  try {
    return welcomeGrantMilliFromEnvironment();
  } catch {
    return 0n;
  }
})();

const BCRYPT_ROUNDS = 12;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("goosey-timing-equalization-only", BCRYPT_ROUNDS);
const SESSION_TTL_DAYS = Number.parseInt(process.env.SESSION_TTL_DAYS || "14", 10);
const SESSION_TTL_MS =
  (Number.isFinite(SESSION_TTL_DAYS) && SESSION_TTL_DAYS > 0 ? SESSION_TTL_DAYS : 14) *
  24 *
  60 *
  60 *
  1_000;
const ISSUANCE_OWNER_ID = "issuance";

export type PublicUser = Pick<User, "id" | "email" | "username" | "displayName" | "role" | "status" | "emailVerifiedAt">;

export function emailVerificationEnabled(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true" && isEmailDeliveryConfigured();
}

export function requiresEmailVerification(
  user: Pick<User, "role" | "emailVerifiedAt">,
): boolean {
  return emailVerificationEnabled() && user.role === "USER" && user.emailVerifiedAt === null;
}

export function emailVerificationState(user: Pick<User, "role" | "emailVerifiedAt">) {
  const required = requiresEmailVerification(user);
  return {
    required,
    allowedActions: required ? ["VERIFY_EMAIL", "RESEND_VERIFICATION", "LOGOUT"] : [],
  };
}

export class RegistrationInviteError extends Error {
  constructor() {
    super("A valid unused participant invitation is required.");
    this.name = "RegistrationInviteError";
  }
}

type SessionMetadata = {
  userAgent?: string | null;
  ipHash?: string | null;
};

type SessionRecord = {
  token: string;
  expiresAt: Date;
};

const publicUserSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
} satisfies Prisma.UserSelect;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export async function createSession(
  tx: Prisma.TransactionClient,
  userId: string,
  metadata: SessionMetadata = {},
): Promise<SessionRecord> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await tx.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: metadata.userAgent?.slice(0, 512) || null,
      ipHash: metadata.ipHash || null,
    },
  });
  return { token, expiresAt };
}

export function setSessionCookie(response: NextResponse, session: SessionRecord): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
}

export function setRegistrationDeviceCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: REGISTRATION_DEVICE_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 365 * 24 * 60 * 60,
  });
}

async function bindRegistrationDevice(
  tx: Prisma.TransactionClient,
  token: string,
  userId: string,
): Promise<void> {
  const tokenHash = deterministicSecretToken("registration-device-v1", token);
  await tx.registrationDevice.upsert({
    where: { tokenHash },
    create: { tokenHash, userId },
    // Preserve the first account ever bound to this browser identity.
    update: { tokenHash },
  });
}

export async function revokeRequestSession(request: NextRequest): Promise<void> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function getAuthenticatedUser(request: NextRequest): Promise<PublicUser | null> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await db.session.findFirst({
    where: {
      tokenHash: sha256(token),
      expiresAt: { gt: new Date() },
      user: { status: "ACTIVE", role: { in: INTERACTIVE_ROLES } },
    },
    select: { user: { select: publicUserSelect } },
  });
  return session?.user ?? null;
}

export async function grantWelcomeFeathers(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const grantMilli = welcomeGrantMilliFromEnvironment();
  const existing = await tx.journalEntry.findUnique({
    where: {
      idempotencyScope_idempotencyKey: {
        idempotencyScope: "WELCOME_GRANT",
        idempotencyKey: userId,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, emailVerifiedAt: true },
  });
  if (!user || user.role !== "USER" || user.status !== "ACTIVE" || requiresEmailVerification(user)) return false;

  const issuance = await tx.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "SYSTEM",
        ownerId: ISSUANCE_OWNER_ID,
        purpose: "ISSUANCE",
      },
    },
    create: {
      ownerType: "SYSTEM",
      ownerId: ISSUANCE_OWNER_ID,
      purpose: "ISSUANCE",
      allowsNegative: true,
    },
    // A nonempty, value-preserving update lets Prisma use native ON CONFLICT
    // rather than a racy read/create for this shared cold-start account.
    update: { balanceMilli: { increment: 0n } },
    select: { id: true },
  });
  const wallet = await tx.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "USER",
        ownerId: userId,
        purpose: "USER_FEATHERS",
      },
    },
    create: {
      ownerType: "USER",
      ownerId: userId,
      purpose: "USER_FEATHERS",
    },
    update: { balanceMilli: { increment: 0n } },
    select: { id: true },
  });

  await tx.journalEntry.create({
    data: {
      type: "WELCOME_GRANT",
      status: "POSTED",
      referenceType: "USER",
      referenceId: userId,
      idempotencyScope: "WELCOME_GRANT",
      idempotencyKey: userId,
      actorUserId: userId,
      metadata: JSON.stringify({ amountMilli: grantMilli.toString() }),
      postings: {
        create: [
          { ledgerAccountId: issuance.id, amountMilli: -grantMilli },
          { ledgerAccountId: wallet.id, amountMilli: grantMilli },
        ],
      },
    },
  });
  await Promise.all([
    tx.ledgerAccount.update({ where: { id: issuance.id }, data: { balanceMilli: { decrement: grantMilli } } }),
    tx.ledgerAccount.update({ where: { id: wallet.id }, data: { balanceMilli: { increment: grantMilli } } }),
    tx.user.update({ where: { id: userId }, data: { balanceMilli: { increment: grantMilli } } }),
  ]);
  return true;
}

export async function registerUser(input: {
  email: string;
  username: string;
  displayName: string;
  password: string;
  inviteCodeHash?: string | null;
  registrationDeviceToken?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
}, database: typeof db = db): Promise<{ user: PublicUser; session: SessionRecord }> {
  const passwordHash = await hashPassword(input.password);
  const registrationDeviceHash = input.registrationDeviceToken
    ? deterministicSecretToken("registration-device-v1", input.registrationDeviceToken)
    : null;

  try {
    return await runSerializableTransaction(database, async (tx) => {
      if (registrationDeviceHash) {
        const existingDevice = await tx.registrationDevice.findUnique({
          where: { tokenHash: registrationDeviceHash },
          select: { id: true },
        });
        if (existingDevice) throw new RegistrationDeviceInUseError();
      }
      const invite = input.inviteCodeHash ? await tx.registrationInvite.findUnique({ where: { codeHash: input.inviteCodeHash } }) : null;
      if (input.inviteCodeHash) {
        if (!invite || invite.status !== "ACTIVE" || (invite.expiresAt && invite.expiresAt <= new Date())) throw new RegistrationInviteError();
        const consumed = await tx.registrationInvite.updateMany({
          where: { id: invite.id, status: "ACTIVE", useCount: { lt: invite.maxUses }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          data: { useCount: { increment: 1 } },
        });
        if (consumed.count !== 1) throw new RegistrationInviteError();
      }
      const user = await tx.user.create({
        data: {
          email: input.email,
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          balanceMilli: 0n,
        },
        select: publicUserSelect,
      });

      if (registrationDeviceHash) {
        await tx.registrationDevice.create({ data: { tokenHash: registrationDeviceHash, userId: user.id } });
      }
      if (invite) await tx.registrationInviteClaim.create({ data: { inviteId: invite.id, userId: user.id } });

      await tx.ledgerAccount.create({
        data: {
          ownerType: "USER",
          ownerId: user.id,
          purpose: "USER_FEATHERS",
          balanceMilli: 0n,
        },
      });
      if (!requiresEmailVerification(user)) await grantWelcomeFeathers(tx, user.id);
      const session = await createSession(tx, user.id, {
        userAgent: input.userAgent,
        ipHash: input.ipHash,
      });
      return { user, session };
    });
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error && error.code === "P2002" &&
      "meta" in error && error.meta && typeof error.meta === "object" && "target" in error.meta &&
      (Array.isArray(error.meta.target) ? error.meta.target : [error.meta.target]).includes("tokenHash")
    ) {
      throw new RegistrationDeviceInUseError();
    }
    throw error;
  }
}

export async function loginUser(input: {
  email: string;
  password: string;
  registrationDeviceToken?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<{ user: PublicUser; session: SessionRecord } | null> {
  const record = await db.user.findUnique({
    where: { email: input.email },
    select: { ...publicUserSelect, passwordHash: true },
  });

  const valid = await verifyPassword(input.password, record?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!record || !valid || record.status !== "ACTIVE" || !INTERACTIVE_ROLES.includes(record.role)) return null;

  return createSessionForVerifiedLoginSnapshot(db, record, {
    userAgent: input.userAgent,
    ipHash: input.ipHash,
  }, input.registrationDeviceToken);
}

export async function createSessionForVerifiedLoginSnapshot(
  database: typeof db,
  verifiedSnapshot: PublicUser & { passwordHash: string },
  metadata: SessionMetadata = {},
  registrationDeviceToken?: string | null,
): Promise<{ user: PublicUser; session: SessionRecord } | null> {
  return runSerializableTransaction(
    database,
    async (tx) => {
      // Password verification is deliberately outside the transaction because bcrypt is
      // expensive. Re-read the exact credential snapshot before issuing a session so a
      // concurrent password reset cannot revoke sessions and then lose a race to a login
      // that had already verified the old password.
      const current = await tx.user.findFirst({
        where: {
          id: verifiedSnapshot.id,
          passwordHash: verifiedSnapshot.passwordHash,
          status: "ACTIVE",
          role: { in: INTERACTIVE_ROLES },
        },
        select: publicUserSelect,
      });
      if (!current) return null;
      if (current.emailVerifiedAt === null && !requiresEmailVerification(current)) await grantWelcomeFeathers(tx, current.id);
      if (registrationDeviceToken) await bindRegistrationDevice(tx, registrationDeviceToken, current.id);
      const session = await createSession(tx, current.id, metadata);
      return { user: current, session };
    },
    { timeoutMs: 10_000 },
  );
}
