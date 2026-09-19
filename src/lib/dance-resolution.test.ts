import { describe, expect, it, vi } from "vitest";
import { assertConsistentDanceOutcomes, assertDanceResolution } from "./dance-resolution";

function options(results: Array<string | null> = [null, null, null, null]) {
  return ["worm", "dab", "floss", "none"].map((key, index) => ({
    id: key, slug: `htn-2026-winner-first-dance-${key}`, resolution: results[index],
    resolutionProposals: [] as Array<{ outcome: string }>,
  }));
}

describe("first-dance resolution consistency", () => {
  it.each(["worm", "dab", "floss", "none"])("allows %s as the sole winner and remaining losers", (winner) => {
    const states = options();
    states.forEach((state) => { state.resolution = state.id === winner ? "YES" : "NO"; });
    expect(() => assertConsistentDanceOutcomes(states, winner, "YES")).not.toThrow();
  });
  it("rejects another winner while first winner is resolving or resolved", () => {
    expect(() => assertConsistentDanceOutcomes(options(["YES", null, null, null]), "dab", "YES")).toThrow(/Only the first/);
  });
  it("reserves the winner across pending proposals", () => {
    const states = options();
    states[0].resolutionProposals = [{ outcome: "YES" }];
    expect(() => assertConsistentDanceOutcomes(states, "dab", "YES")).toThrow(/Only the first/);
    expect(() => assertConsistentDanceOutcomes(states, "worm", "YES")).not.toThrow();
  });
  it("rejects all NO including pending proposals, but permits None to win", () => {
    const states = options(["NO", "NO", null, null]);
    states[2].resolutionProposals = [{ outcome: "NO" }];
    expect(() => assertConsistentDanceOutcomes(states, "none", "NO")).toThrow(/Exactly one/);
    expect(() => assertConsistentDanceOutcomes(states, "none", "YES")).not.toThrow();
  });
  it("permits partial losers while a winning option remains possible", () => {
    expect(() => assertConsistentDanceOutcomes(options(["NO", null, null, null]), "dab", "NO")).not.toThrow();
  });
  it.each(["YES", "NO"])("rejects mixing VOID with %s in either direction", (result) => {
    expect(() => assertConsistentDanceOutcomes(options(["VOID", null, null, null]), "dab", result)).toThrow(/void every/);
    expect(() => assertConsistentDanceOutcomes(options([result, null, null, null]), "dab", "VOID")).toThrow(/void every/);
  });
  it("allows an all-VOID event", () => {
    expect(() => assertConsistentDanceOutcomes(options(["VOID", "VOID", "VOID", null]), "none", "VOID")).not.toThrow();
  });
  it("rejects an outcome conflicting with the same option", () => {
    expect(() => assertConsistentDanceOutcomes(options(["NO", null, null, null]), "worm", "YES")).toThrow(/conflicting/);
  });
  it("requires all four exact unique option slugs", () => {
    expect(() => assertConsistentDanceOutcomes(options().slice(0, 3), "worm", "YES")).toThrow(/All four/);
    const states = options();
    states[3].slug = states[0].slug;
    expect(() => assertConsistentDanceOutcomes(states, "worm", "YES")).toThrow(/All four/);
  });
  it("serializes on the event before reading sibling proposals", async () => {
    const calls: string[] = [];
    const tx = {
      marketEvent: { updateMany: vi.fn(async () => { calls.push("lock"); return { count: 1 }; }) },
      market: { findMany: vi.fn(async () => { calls.push("read"); return options(); }) },
    };
    await assertDanceResolution(tx as never, { ...options()[0], eventId: "event" }, "YES");
    expect(calls).toEqual(["lock", "read"]);
    expect(tx.marketEvent.updateMany).toHaveBeenCalledWith({ where: { id: "event", slug: "htn-2026-winner-first-dance" }, data: { version: { increment: 1 } } });
  });
  it("rejects missing or wrong event membership before querying siblings", async () => {
    const tx = { marketEvent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, market: { findMany: vi.fn() } };
    await expect(assertDanceResolution(tx as never, { ...options()[0], eventId: null }, "YES")).rejects.toMatchObject({ code: "DANCE_GROUP_INCOMPLETE" });
    await expect(assertDanceResolution(tx as never, { ...options()[0], eventId: "wrong" }, "YES")).rejects.toMatchObject({ code: "DANCE_GROUP_INCOMPLETE" });
    expect(tx.market.findMany).not.toHaveBeenCalled();
  });
  it("leaves unrelated binary markets unchanged", async () => {
    await expect(assertDanceResolution({} as never, { id: "regular", slug: "regular", eventId: null }, "YES")).resolves.toBeUndefined();
  });
});
