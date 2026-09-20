import { describe, expect, it, vi } from "vitest";
import { requireActiveAdmin } from "./admin-service";
describe("single-admin resolution authorization", () => {
  it.each(["USER", "SYSTEM"])("rejects %s roles", async (role) => {
    const tx = { user: { findUnique: vi.fn().mockResolvedValue({role, status:"ACTIVE"}) } };
    await expect(requireActiveAdmin(tx as never, "actor")).rejects.toMatchObject({code:"ADMIN_REQUIRED"});
  });
  it("rejects suspended administrators", async () => {
    const tx = { user: { findUnique: vi.fn().mockResolvedValue({role:"ADMIN", status:"SUSPENDED"}) } };
    await expect(requireActiveAdmin(tx as never, "actor")).rejects.toMatchObject({code:"ADMIN_REQUIRED"});
  });
});
