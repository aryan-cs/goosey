import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { orderPlacementMessage, orderRejectionMessage, parseOrderOptions } from "./order-options";

const now = new Date(2026, 0, 1, 12, 0);
const defaults = { timeInForce: "GTC", postOnly: false, expiresAtLocal: "" };

describe("order option parsing", () => {
  it.each(["GTC", "IOC", "FOK"])("accepts %s without GTC-only options", (timeInForce) => {
    expect(parseOrderOptions({ ...defaults, timeInForce }, now)).toEqual({ valid: true, timeInForce, postOnly: false, expiresAt: null });
  });
  it("allows GTC post-only with an exact future local expiration", () => {
    expect(parseOrderOptions({ ...defaults, postOnly: true, expiresAtLocal: "2028-02-29T13:45" }, now)).toEqual({
      valid: true, timeInForce: "GTC", postOnly: true, expiresAt: new Date(2028, 1, 29, 13, 45).toISOString(),
    });
  });
  it("does not impose an arbitrary duration limit", () => {
    expect(parseOrderOptions({ ...defaults, expiresAtLocal: "9999-12-31T12:00" }, now)).toMatchObject({ valid: true });
  });
  it.each(["gtc", "DAY", "", null, 1])("rejects invalid mode %s", (timeInForce) => {
    expect(parseOrderOptions({ ...defaults, timeInForce }, now)).toMatchObject({ valid: false });
  });
  it.each(["false", "true", 0, 1, null, undefined])("rejects non-boolean post-only %s", (postOnly) => {
    expect(parseOrderOptions({ ...defaults, postOnly }, now)).toMatchObject({ valid: false });
  });
  it.each(["IOC", "FOK"])("rejects post-only or expiration for %s instead of dropping them", (timeInForce) => {
    expect(parseOrderOptions({ ...defaults, timeInForce, postOnly: true }, now)).toMatchObject({ valid: false });
    expect(parseOrderOptions({ ...defaults, timeInForce, expiresAtLocal: "2028-02-29T13:45" }, now)).toMatchObject({ valid: false });
  });
  it.each([
    "2027-02-29T12:00", "2028-02-30T12:00", "2028-04-31T12:00", "2028-13-01T12:00",
    "2028-00-01T12:00", "2028-01-00T12:00", "2028-01-01T24:00", "2028-01-01T12:60",
    "2028-1-01T12:00", "2028-01-01 12:00", "2028-01-01T12:00:00", "2028-01-01T12:00Z",
    "2028-01-01T12:00+01:00", " 2028-01-01T12:00", "2028-01-01T12:00 ", "0000-01-01T12:00",
  ])("rejects noncanonical or impossible local time %s", (expiresAtLocal) => {
    expect(parseOrderOptions({ ...defaults, expiresAtLocal }, now)).toMatchObject({ valid: false });
  });
  it("requires strictly future expiration, including seconds in the current clock", () => {
    for (const expiresAtLocal of ["2025-12-31T23:59", "2026-01-01T12:00"]) {
      expect(parseOrderOptions({ ...defaults, expiresAtLocal }, now)).toMatchObject({ valid: false });
    }
    expect(parseOrderOptions({ ...defaults, expiresAtLocal: "2026-01-01T12:01" }, now)).toMatchObject({ valid: true });
    expect(parseOrderOptions({ ...defaults, expiresAtLocal: "2028-01-01T12:00" }, new Date(NaN))).toMatchObject({ valid: false });
  });
  it("rejects a Toronto DST gap but accepts real times and the fall overlap", () => {
    const modulePath = fileURLToPath(new URL("./order-options.ts", import.meta.url));
    const script = `import { parseOrderOptions } from ${JSON.stringify(modulePath)};
      console.log(JSON.stringify(['2027-03-14T02:30', '2027-03-14T03:30', '2027-11-07T01:30'].map(expiresAtLocal =>
        parseOrderOptions({ timeInForce: 'GTC', postOnly: false, expiresAtLocal }, new Date('2027-01-01T00:00:00Z')))));`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, TZ: "America/Toronto" }, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual([
      expect.objectContaining({ valid: false }),
      expect.objectContaining({ valid: true, expiresAt: "2027-03-14T07:30:00.000Z" }),
      expect.objectContaining({ valid: true, expiresAt: "2027-11-07T05:30:00.000Z" }),
    ]);
  });
});

describe("order result messages", () => {
  it("preserves existing open and filled messages", () => {
    expect(orderPlacementMessage({ status: "OPEN", filledQuantity: 0, remainingQuantity: 5 })).toBe("Limit order placed. You can cancel its unfilled quantity below.");
    expect(orderPlacementMessage({ status: "FILLED", filledQuantity: 5, remainingQuantity: 0 })).toBe("Order filled.");
  });
  it("distinguishes resting partial fills from IOC cancellations", () => {
    expect(orderPlacementMessage({ status: "PARTIALLY_FILLED", filledQuantity: 2, remainingQuantity: 3 })).toBe("2 contracts filled. 3 contracts remain open; you can cancel the unfilled quantity below.");
    expect(orderPlacementMessage({ status: "CANCELED", filledQuantity: 2, remainingQuantity: 0, canceledQuantity: 3 })).toBe("2 contracts filled. 3 contracts canceled. No quantity remains open.");
    expect(orderPlacementMessage({ status: "CANCELED", filledQuantity: 0, remainingQuantity: 0, canceledQuantity: 5 })).toBe("Order canceled without any fills. No quantity remains open.");
    expect(orderPlacementMessage({ status: "CANCELED", filledQuantity: 1, remainingQuantity: 0 })).toContain("1 contract filled. The unfilled remainder was canceled.");
  });
  it("describes expiration without suggesting an active order", () => {
    expect(orderPlacementMessage({ status: "EXPIRED", filledQuantity: 0, remainingQuantity: 0 })).toBe("Order expired without any fills. No quantity remains open.");
    expect(orderPlacementMessage({ status: "EXPIRED", filledQuantity: 2, remainingQuantity: 0 })).toBe("Order expired after 2 contracts filled. No quantity remains open.");
  });
  it("does not invent success for unknown status or malformed quantities", () => {
    expect(orderPlacementMessage({ status: "REJECTED", filledQuantity: 0, remainingQuantity: 0 })).toContain("could not be confirmed");
    expect(orderPlacementMessage({ status: "FILLED", filledQuantity: NaN, remainingQuantity: 0 })).toContain("could not be confirmed");
  });
  it.each(["REJECT_FOK", "FOK_NOT_FILLABLE"])("explains %s without claiming a fill", (reason) => {
    expect(orderRejectionMessage(reason)).toContain("Fill-or-kill order rejected");
    expect(orderRejectionMessage(reason)).toContain("Nothing was filled.");
  });
  it.each(["REJECT_POST_ONLY", "POST_ONLY_WOULD_TRADE"])("explains %s", (reason) => {
    expect(orderRejectionMessage(reason)).toContain("Post-only order rejected");
  });
  it("uses safe generic rejection copy for unknown reasons", () => {
    expect(orderRejectionMessage("unrecognized private details")).toBe("The order was not accepted. Review your order details and try again.");
  });
});
