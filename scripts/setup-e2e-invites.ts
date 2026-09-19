import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { sha256 } from "../src/lib/security";

const db = new PrismaClient();

async function main() {
  const codes = (process.env.E2E_INVITE_CODES ?? "").split(",").map((code) => code.trim()).filter(Boolean);
  if (codes.length < 2) throw new Error("E2E_INVITE_CODES must contain at least two codes");
  const email = "invite-fixture-admin@goosey.test";
  let admin = await db.user.findUnique({ where: { email } });
  if (!admin) {
    admin = await db.user.create({ data: { email, username: "invite_fixture_admin", displayName: "Invite Fixture Admin", passwordHash: await hash("Invite-fixture-password-only", 4), role: "ADMIN" } });
  }
  await Promise.all(codes.map((code, index) => db.registrationInvite.upsert({
    where: { codeHash: sha256(code) },
    create: { codeHash: sha256(code), label: `API E2E participant ${index + 1}`, maxUses: 1, createdById: admin!.id },
    update: {},
  })));
}

main().finally(() => db.$disconnect());
