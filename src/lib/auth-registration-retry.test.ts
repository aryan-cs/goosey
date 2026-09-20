import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
import { grantWelcomeFeathers, registerUser } from "./auth";

const input = {
  email: "registration@example.test", username: "registration", displayName: "Registration",
  password: "Registration test password!",
};
const user = { id: "registered-user", ...input, role: "USER", status: "ACTIVE", emailVerifiedAt: null };
function fixture() {
  const tx = {
    user: { create: vi.fn().mockResolvedValue(user), findUnique: vi.fn().mockResolvedValue(user), update: vi.fn().mockResolvedValue(user) },
    ledgerAccount: {
      create: vi.fn().mockResolvedValue({ id: "wallet" }),
      upsert: vi.fn().mockImplementation(async (args) => ({ id: args.create.purpose === "ISSUANCE" ? "issuance" : "wallet" })),
      update: vi.fn().mockResolvedValue({}),
    },
    journalEntry: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "grant" }) },
    session: { create: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn().mockImplementation(async (operation) => operation(tx));
  return { tx, transaction, database: { $transaction: transaction } as unknown as Parameters<typeof registerUser>[1] };
}

describe("registration and welcome grant contention", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_PROVIDER", "postgresql");
    vi.stubEnv("POSTGRES_DATABASE_URL", "postgresql://fixture:fixture@127.0.0.1/fixture");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", "false");
    vi.stubEnv("STARTING_FEATHERS", "1000");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses value-preserving nonempty account upserts and exact journal-backed grant amounts", async () => {
    const { tx } = fixture();
    expect(await grantWelcomeFeathers(tx as unknown as Prisma.TransactionClient, user.id)).toBe(true);
    expect(tx.ledgerAccount.upsert).toHaveBeenCalledTimes(2);
    for (const [args] of tx.ledgerAccount.upsert.mock.calls) {
      expect(args.update).toEqual({ balanceMilli: { increment: 0n } });
      expect(args.select).toEqual({ id: true });
      expect(args.where.ownerType_ownerId_purpose).toEqual({
        ownerType: args.create.ownerType, ownerId: args.create.ownerId, purpose: args.create.purpose,
      });
    }
    expect(tx.journalEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      idempotencyScope: "WELCOME_GRANT", idempotencyKey: user.id,
      postings: { create: [
        { ledgerAccountId: "issuance", amountMilli: -1_000_000n },
        { ledgerAccountId: "wallet", amountMilli: 1_000_000n },
      ] },
    }) }));
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { balanceMilli: { increment: 1_000_000n } } });
  });

  it("retries the whole registration transaction after PostgreSQL serialization contention", async () => {
    const { tx, database, transaction } = fixture();
    // Simulate an aborted first transaction at its shared issuance write.
    tx.ledgerAccount.upsert.mockRejectedValueOnce({ code: "P2034" });
    const result = await registerUser(input, database);
    expect(result.user.id).toBe(user.id);
    expect(transaction).toHaveBeenCalledTimes(2);
    for (const [, options] of transaction.mock.calls) expect(options).toMatchObject({ isolationLevel: "Serializable" });
    expect(tx.user.create).toHaveBeenCalledTimes(2);
    expect(tx.journalEntry.create).toHaveBeenCalledOnce();
    expect(tx.session.create).toHaveBeenCalledOnce();
  });

  it.each(["email", "username"])("does not retry a genuine duplicate %s", async (field) => {
    const { tx, database, transaction } = fixture();
    const duplicate = { code: "P2002", meta: { target: [field] } };
    tx.user.create.mockRejectedValueOnce(duplicate);
    await expect(registerUser(input, database)).rejects.toBe(duplicate);
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
    expect(tx.session.create).not.toHaveBeenCalled();
  });

  it("still defers the welcome grant when email verification is required", async () => {
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", "true");
    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("SMTP_FROM", "Goosey <noreply@example.test>");
    const { tx, database } = fixture();
    await registerUser(input, database);
    expect(tx.ledgerAccount.create).toHaveBeenCalledOnce();
    expect(tx.ledgerAccount.upsert).not.toHaveBeenCalled();
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
    expect(tx.session.create).toHaveBeenCalledOnce();
  });

  it("returns without modifying accounts when the welcome grant already exists", async () => {
    const { tx } = fixture();
    tx.journalEntry.findUnique.mockResolvedValue({ id: "existing-grant" });
    expect(await grantWelcomeFeathers(tx as unknown as Prisma.TransactionClient, user.id)).toBe(false);
    expect(tx.ledgerAccount.upsert).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });
});
