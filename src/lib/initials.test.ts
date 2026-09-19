import { expect, it } from "vitest";
import { initials } from "./initials";

it.each([
  ["Ada Lovelace", "AL"],
  ["  Mary Jane Watson Parker  ", "MJW"],
  ["Simulation Trader 9", "ST9"],
  ["Aryan", "A"],
  ["Anne-Marie O’Neill", "AMO"],
  ["élise 王", "É王"],
  ["e\u0301lise Dupont", "ÉD"],
  ["trader_one_two_three", "TOT"],
  ["ß ß ß", "SSS"],
  ["   ", "?"],
])("uses at most three initials for %s", (name, expected) => {
  expect(initials(name)).toBe(expected);
});
