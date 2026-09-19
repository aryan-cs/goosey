import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../src/lib/auth";

const ID = "goosey-market-publisher-v1";
const USERNAME = "goosey_market_publisher";
const EMAIL = "market-publisher@goosey.invalid";

/** Dedicated audit principal; generated login secret is discarded, never shared. */
export async function marketPublisher(database: PrismaClient) {
  const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
  return database.$transaction(async tx => {
    const existing = await tx.user.findUnique({ where: { id: ID } });
    if (existing) {
      if (existing.username !== USERNAME || existing.email !== EMAIL || existing.role !== "ADMIN" || existing.status !== "ACTIVE") throw new Error("Market publisher identity changed; refusing to overwrite it.");
      const audit = await tx.auditLog.findFirst({ where: { actorUserId: ID, action: "MARKET_PUBLISHER_PROVISIONED", entityId: ID } });
      if (!audit) throw new Error("Publisher provisioning audit missing.");
      return existing;
    }
    const user = await tx.user.create({ data: {
      id: ID, username: USERNAME, email: EMAIL, displayName: "Goosey Market Publisher",
      passwordHash, role: "ADMIN", status: "ACTIVE", balanceMilli: 0n,
      profilePublic: false, leaderboardVisible: false,
    } });
    await tx.auditLog.create({ data: {
      actorUserId: ID, action: "MARKET_PUBLISHER_PROVISIONED", entityType: "USER", entityId: ID,
      metadata: JSON.stringify({ method: "scripts/launch-selected-markets.ts", purpose: "user-approved market catalog publication" }),
    } });
    return user;
  });
}
