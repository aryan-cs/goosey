import { describe, expect, it } from "vitest";

import { principalScopedIdempotencyScope } from "./market-service";

describe("economic journal idempotency isolation", () => {
  it("allows different users to safely use the same client idempotency key", () => {
    const route = "/api/markets/market_123/trades";

    const alice = principalScopedIdempotencyScope(route, "user_alice");
    const bob = principalScopedIdempotencyScope(route, "user_bob");

    expect(alice).not.toBe(bob);
    expect(alice).toBe("USER:user_alice:/api/markets/market_123/trades");
  });

  it("keeps trade and redemption namespaces separate for one user", () => {
    expect(principalScopedIdempotencyScope("/trades", "user_1")).not.toBe(
      principalScopedIdempotencyScope("/redeem", "user_1"),
    );
  });
});
