import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("database-backed session principal security", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-principal-security-"));
  const url = `file:${join(directory, "auth.db")}`;
  const db = new PrismaClient({ datasourceUrl: url });
  let auth: typeof import("./auth");
  let security: typeof import("./security");
  const password = "principal security test password";
  let passwordHash: string;
  let sequence = 0;

  beforeAll(async () => {
    await db.$connect();
    execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe", timeout: 20_000 });
    vi.doMock("@/lib/db", () => ({ db }));
    auth = await import("./auth");
    security = await import("./security");
    passwordHash = await hash(password, 4);
  }, 30_000);
  afterAll(async () => { vi.doUnmock("@/lib/db"); await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

  async function principal(role = "USER", status = "ACTIVE") {
    const number = sequence++;
    const user = await db.user.create({ data: { email: `principal-${number}@example.com`, username: `principal_${number}`, displayName: "Principal", passwordHash, role, status } });
    const token = security.randomToken();
    const session = await db.session.create({ data: { userId: user.id, tokenHash: security.sha256(token), expiresAt: new Date(Date.now() + 60_000) } });
    const request = new NextRequest("http://localhost:8080/api/me", { headers: { cookie: `${auth.SESSION_COOKIE_NAME}=${token}`, "x-user-id": "administrator", "x-user-role": "ADMIN", authorization: "Bearer admin" } });
    return { user, session, request };
  }

  it("loads identity and role from the session database, ignoring forged identity headers", async () => {
    const { user, request } = await principal();
    expect(await auth.getAuthenticatedUser(request)).toMatchObject({ id: user.id, role: "USER" });
  });
  it.each(["SYSTEM", "MODERATOR", "unknown"])("rejects %s at both login and existing-session boundaries", async (role) => {
    const { user, request } = await principal(role);
    expect(await auth.getAuthenticatedUser(request)).toBeNull();
    expect(await auth.loginUser({ email: user.email, password })).toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
  it("immediately rejects a suspended principal's existing session", async () => {
    const { user, request } = await principal();
    await db.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    expect(await auth.getAuthenticatedUser(request)).toBeNull();
  });
  it("rejects expired and revoked tokens", async () => {
    const { session, request } = await principal();
    await db.session.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
    expect(await auth.getAuthenticatedUser(request)).toBeNull();
    await db.session.delete({ where: { id: session.id } });
    expect(await auth.getAuthenticatedUser(request)).toBeNull();
  });
  it("reads a changed role on the next request instead of trusting the login snapshot", async () => {
    const { user, request } = await principal("ADMIN");
    expect((await auth.getAuthenticatedUser(request))?.role).toBe("ADMIN");
    await db.user.update({ where: { id: user.id }, data: { role: "USER" } });
    expect((await auth.getAuthenticatedUser(request))?.role).toBe("USER");
  });
});
