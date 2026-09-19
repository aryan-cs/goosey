import bcrypt from "bcryptjs";
import { db as prisma, requireDatabaseStartup } from "../src/lib/db";
import { isPrismaErrorCode } from "../src/lib/prisma-errors";

const BCRYPT_COST = 12;
const PASSWORD_MIN_LENGTH = 16;
const PASSWORD_MAX_BYTES = 72;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])$/;
const EMAIL_MAX_LENGTH = 254;

const ENV = {
  email: "GOOSEY_ADMIN_EMAIL",
  username: "GOOSEY_ADMIN_USERNAME",
  displayName: "GOOSEY_ADMIN_DISPLAY_NAME",
  password: "GOOSEY_ADMIN_PASSWORD",
} as const;

class InputError extends Error {}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new InputError(`${name} is required.`);
  }
  return value;
}

function normalizeEmail(value: string): string {
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(email)) {
    throw new InputError(`${ENV.email} must be a valid email address.`);
  }

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) {
    throw new InputError(`${ENV.email} must be a valid email address.`);
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const validLocal =
    local.length <= 64 &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local);
  const validDomain =
    domain.length <= 253 &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".") &&
    domain
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));

  if (!validLocal || !validDomain) {
    throw new InputError(`${ENV.email} must be a valid email address.`);
  }
  return email;
}

function normalizeUsername(value: string): string {
  const username = value.trim().normalize("NFKC").toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new InputError(
      `${ENV.username} must be 3–24 lowercase letters, numbers, or underscores, and start and end with a letter or number.`,
    );
  }
  return username;
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim().normalize("NFKC").replace(/\s+/g, " ");
  if (
    displayName.length < 2 ||
    displayName.length > 40 ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    throw new InputError(`${ENV.displayName} must contain 2–40 printable characters.`);
  }
  return displayName;
}

function validatePassword(value: string, identityValues: string[]): string {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (value.length < PASSWORD_MIN_LENGTH || byteLength > PASSWORD_MAX_BYTES) {
    throw new InputError(
      `${ENV.password} must be at least ${PASSWORD_MIN_LENGTH} characters and no more than ${PASSWORD_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new InputError(`${ENV.password} must not contain control characters.`);
  }

  const foldedPassword = value.normalize("NFKC").toLowerCase();
  if (identityValues.some((identity) => identity.length >= 3 && foldedPassword.includes(identity.toLowerCase()))) {
    throw new InputError(`${ENV.password} must not contain the administrator's email, username, or display name.`);
  }
  if (/^(.)\1+$/u.test(value) || new Set(value).size < 6) {
    throw new InputError(`${ENV.password} is too repetitive. Use a generated password or a long unique passphrase.`);
  }
  return value;
}

async function createAdmin(): Promise<string> {
  if (process.argv.length > 2) {
    throw new InputError("This command accepts no arguments. Supply credentials only through the documented environment variables.");
  }

  const email = normalizeEmail(requiredEnvironmentVariable(ENV.email));
  const username = normalizeUsername(requiredEnvironmentVariable(ENV.username));
  const displayName = normalizeDisplayName(requiredEnvironmentVariable(ENV.displayName));
  const password = validatePassword(requiredEnvironmentVariable(ENV.password), [email, username, displayName]);

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findMany({
      where: { OR: [{ email }, { username }] },
      select: { email: true, username: true },
    });
    if (existing.length > 0) {
      const conflicts = [
        existing.some((user) => user.email === email) ? "email" : null,
        existing.some((user) => user.username === username) ? "username" : null,
      ].filter(Boolean);
      throw new InputError(
        `An account with that ${conflicts.join(" and ")} already exists; refusing to promote or overwrite it.`,
      );
    }

    const admin = await tx.user.create({
      data: {
        email,
        username,
        displayName,
        passwordHash,
        role: "ADMIN",
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
        balanceMilli: 0n,
        profilePublic: false,
        leaderboardVisible: false,
      },
      select: { id: true },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: "ADMIN_PROVISIONED_OUT_OF_BAND",
        entityType: "USER",
        entityId: admin.id,
        metadata: JSON.stringify({ method: "scripts/create-admin.ts" }),
      },
    });

    return admin.id;
  });
}

async function main(): Promise<void> {
  try {
    await requireDatabaseStartup();
    const adminId = await createAdmin();
    console.log(`Administrator created successfully (user ID: ${adminId}). No credentials were printed.`);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`Administrator was not created: ${error.message}`);
    } else if (isPrismaErrorCode(error, "P2002")) {
      console.error("Administrator was not created: that email or username already exists; no account was changed.");
    } else if (error instanceof Error && error.name === "PrismaClientInitializationError") {
      console.error("Administrator was not created: database initialization failed. Check the selected database provider, URL, and availability.");
    } else {
      console.error("Administrator was not created because of an unexpected database error; no existing account was changed.");
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

await main();
