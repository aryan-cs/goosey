import { PrismaClient } from "@prisma/client";

import { EMAIL_VERIFICATION_PURPOSE } from "../src/lib/auth-recovery";
import { randomToken, sha256 } from "../src/lib/security";

const database = new PrismaClient();

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error("Usage: setup-e2e-verification.ts <email>");
  const user = await database.user.findUnique({
    where: { email },
    select: { id: true, role: true, status: true, emailVerifiedAt: true },
  });
  if (!user || user.role !== "USER" || user.status !== "ACTIVE" || user.emailVerifiedAt) {
    throw new Error("Expected one active, unverified participant fixture.");
  }
  const token = randomToken();
  await database.accountToken.create({
    data: {
      userId: user.id,
      purpose: EMAIL_VERIFICATION_PURPOSE,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  process.stdout.write(token);
}

main()
  .finally(async () => database.$disconnect());
