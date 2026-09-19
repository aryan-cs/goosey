import { describe, expect, it, vi } from "vitest";
import { verifyPostgresConnection } from "./postgres-startup";

describe("PostgreSQL startup probe", () => {
  it("returns sanitized database identity and supported server version", async () => {
    const client = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{
        database_name: "goosey_test",
        database_user: "goosey_runtime",
        server_version_num: "160004",
      }]),
    };
    await expect(verifyPostgresConnection(client as never)).resolves.toEqual({
      provider: "postgresql",
      database: "goosey_test",
      user: "goosey_runtime",
      serverVersionNum: 160004,
    });
  });

  it("fails closed on malformed or unsupported probe results", async () => {
    await expect(verifyPostgresConnection({ $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never)).rejects.toThrow(/unexpected result/);
    await expect(verifyPostgresConnection({
      $queryRawUnsafe: vi.fn().mockResolvedValue([{
        database_name: "goosey",
        database_user: "runtime",
        server_version_num: "130000",
      }]),
    } as never)).rejects.toThrow(/invalid identity or version/);
  });
});
