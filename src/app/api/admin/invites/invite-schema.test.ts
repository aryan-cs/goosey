import { describe, expect, it } from "vitest";

import { createInviteSchema } from "./route";

const baseInvite = { label: "Hacker check-in", expiresAt: null };

describe("admin invitation contract", () => {
  it.each([1, 2, 10])("accepts a bounded maxUses value of %i", (maxUses) => {
    expect(createInviteSchema.parse({ ...baseInvite, maxUses }).maxUses).toBe(maxUses);
  });

  it.each([0, 11, 1.5])("rejects an unsafe maxUses value of %s", (maxUses) => {
    expect(createInviteSchema.safeParse({ ...baseInvite, maxUses }).success).toBe(false);
  });
});
