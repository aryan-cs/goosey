import { cookies } from "next/headers";
import { INTERACTIVE_ROLES, SESSION_COOKIE_NAME } from "@/lib/auth";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/security";

export async function getServerUser() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await db.session.findFirst({
    where: { tokenHash: sha256(token), expiresAt: { gt: new Date() }, user: { status: "ACTIVE", role: { in: INTERACTIVE_ROLES } } },
    select: {
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          role: true,
          emailVerifiedAt: true,
          balanceMilli: true,
          realizedPnlMilli: true,
        },
      },
    },
  });
  return session?.user ?? null;
}
