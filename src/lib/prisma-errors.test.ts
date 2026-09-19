import { describe, expect, it } from "vitest";
import { isPrismaErrorCode, prismaErrorCode } from "./prisma-errors";

describe("provider-neutral Prisma error recognition", () => {
  it("recognizes known request codes without relying on client-specific instanceof", () => {
    const foreignClientError = Object.assign(new Error("unique constraint"), { code: "P2002" });
    expect(prismaErrorCode(foreignClientError)).toBe("P2002");
    expect(isPrismaErrorCode(foreignClientError, "P2002")).toBe(true);
  });

  it("rejects malformed and non-Prisma codes", () => {
    expect(prismaErrorCode({ code: "SQLITE_BUSY" })).toBeNull();
    expect(prismaErrorCode({ code: 2002 })).toBeNull();
    expect(isPrismaErrorCode(new Error("P2002"), "P2002")).toBe(false);
  });
});
