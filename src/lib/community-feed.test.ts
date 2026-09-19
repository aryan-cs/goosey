import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { comment: { findMany: mocks.findMany } },
}));

vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { getCommunityFeed } from "./community-feed";

const CREATED_AT = new Date("2026-09-19T14:00:00.000Z");
const CURSOR_ID = "cm12345678901234567890123";

function item(index: number, createdAt = CREATED_AT) {
  return {
    id: `cm${String(index).padStart(23, "0")}`,
    body: `Community comment ${index}`,
    parentId: index % 2 === 0 ? null : "cm99999999999999999999999",
    createdAt,
    user: { username: `hacker_${index}`, displayName: `Hacker ${index}` },
    market: { slug: `market-${index}`, shortTitle: `Market ${index}` },
  };
}

function cursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("getCommunityFeed", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.findMany.mockResolvedValue([]);
  });

  it("loads only public visible comments from non-draft markets and eligible reply parents", async () => {
    mocks.findMany.mockResolvedValue([item(1)]);

    const result = await getCommunityFeed();

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        status: "VISIBLE",
        user: { profilePublic: true },
        market: { status: { not: "DRAFT" } },
        AND: [{
          OR: [
            { parentId: null },
            { parent: { is: { status: "VISIBLE" } } },
          ],
        }],
      },
      select: {
        id: true,
        body: true,
        parentId: true,
        createdAt: true,
        user: { select: { username: true, displayName: true } },
        market: { select: { slug: true, shortTitle: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 26,
    });
    expect(result).toEqual({ items: [item(1)], nextCursor: null });
  });

  it("uses lookahead and returns a cursor for the twenty-fifth item", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => item(99 - index));
    mocks.findMany.mockResolvedValue(rows);

    const result = await getCommunityFeed();

    expect(result.items).toEqual(rows.slice(0, 25));
    expect(result.nextCursor).toBeTypeOf("string");
    expect(
      JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString("utf8")),
    ).toEqual({
      createdAt: rows[24]!.createdAt.toISOString(),
      id: rows[24]!.id,
    });
  });

  it("uses a descending timestamp/id seek boundary without depending on the cursor row", async () => {
    const encoded = cursor({ createdAt: CREATED_AT.toISOString(), id: CURSOR_ID });
    mocks.findMany.mockResolvedValue([item(1, new Date(CREATED_AT.getTime() - 1))]);

    await getCommunityFeed(encoded);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            expect.objectContaining({ OR: expect.any(Array) }),
            {
              OR: [
                { createdAt: { lt: CREATED_AT } },
                { createdAt: CREATED_AT, id: { lt: CURSOR_ID } },
              ],
            },
          ],
        }),
      }),
    );
    expect(mocks.findMany.mock.calls[0]![0]).not.toHaveProperty("cursor");
    expect(mocks.findMany.mock.calls[0]![0]).not.toHaveProperty("skip");
  });

  it.each([
    ["empty", ""],
    ["invalid alphabet", "%%%"],
    ["invalid JSON", Buffer.from("not-json").toString("base64url")],
    ["missing timestamp", cursor({ id: CURSOR_ID })],
    ["invalid timestamp", cursor({ createdAt: "yesterday", id: CURSOR_ID })],
    ["invalid id", cursor({ createdAt: CREATED_AT.toISOString(), id: "not_an_id" })],
    ["extra field", cursor({ createdAt: CREATED_AT.toISOString(), id: CURSOR_ID, userId: "other" })],
    ["oversized", "a".repeat(513)],
  ])("rejects a %s cursor before querying", async (_label, encoded) => {
    await expect(getCommunityFeed(encoded)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_CURSOR",
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
