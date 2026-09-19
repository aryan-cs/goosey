import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { promoteExistingAdmin } from "./promote-existing-admin";
function fixture(role = "USER", status = "ACTIVE", count = 1) {
  const tx = { user: { findUnique: vi.fn().mockResolvedValue({ id: "id", username: "bowenzhu21", role, status }), updateMany: vi.fn().mockResolvedValue({ count }) }, auditLog: { create: vi.fn() } };
  return { tx, db: { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as PrismaClient };
}
describe("explicit existing-account promotion", () => {
  it("changes only the role and records who was authorized", async () => {
    const {tx,db}=fixture(); await promoteExistingAdmin(db,"bowenzhu21");
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: "id", username: "bowenzhu21", role: "USER", status: "ACTIVE" }, data: { role: "ADMIN" } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({action:"ADMIN_PROMOTED_OUT_OF_BAND",entityId:"id"})});
  });
  it("does not repeat an existing promotion", async () => { const {tx,db}=fixture("ADMIN"); await promoteExistingAdmin(db,"bowenzhu21"); expect(tx.user.updateMany).not.toHaveBeenCalled(); });
  it.each([["SYSTEM","ACTIVE"],["USER","SUSPENDED"]])("refuses %s/%s",async(role,status)=>{const {tx,db}=fixture(role,status); await expect(promoteExistingAdmin(db,"bowenzhu21")).rejects.toThrow(); expect(tx.user.updateMany).not.toHaveBeenCalled();});
  it("refuses a concurrently changed account", async()=>{const {tx,db}=fixture("USER","ACTIVE",0); await expect(promoteExistingAdmin(db,"bowenzhu21")).rejects.toThrow(/changed/);expect(tx.auditLog.create).not.toHaveBeenCalled();});
});
