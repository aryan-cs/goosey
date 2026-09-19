import type { PrismaClient } from "@prisma/client";

export async function promoteExistingAdmin(database: PrismaClient, username: string) {
  return database.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { username }, select: { id: true, username: true, role: true, status: true } });
    if (!user || user.status !== "ACTIVE" || !["USER", "ADMIN"].includes(user.role)) {
      throw new Error("The exact username must identify an existing active participant or admin.");
    }
    if (user.role === "ADMIN") return user;
    const updated = await tx.user.updateMany({ where: { id: user.id, username, role: "USER", status: "ACTIVE" }, data: { role: "ADMIN" } });
    if (updated.count !== 1) throw new Error("Account changed during promotion; no promotion was committed.");
    await tx.auditLog.create({ data: {
      actorUserId: user.id, action: "ADMIN_PROMOTED_OUT_OF_BAND", entityType: "USER", entityId: user.id,
      metadata: JSON.stringify({ method: "scripts/launch-selected-markets.ts", previousRole: "USER", requestedUsername: username }),
    } });
    return { ...user, role: "ADMIN" };
  });
}
