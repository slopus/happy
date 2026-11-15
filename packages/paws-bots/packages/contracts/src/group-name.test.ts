import { expect, it } from "vitest";
import { defaultGroupName } from "./domain.js";

it("joins names in pick order and trims the result", () => {
  expect(defaultGroupName([" Writer", "Researcher "])).toBe("Writer, Researcher");
});
it("caps names at 80 characters without a dangling surrogate or space", () => {
  expect(defaultGroupName(["a".repeat(90)])).toHaveLength(80);
  expect(defaultGroupName([`${"a".repeat(79)}😀`])).toBe("a".repeat(79));
  expect(defaultGroupName(["a".repeat(79), "Writer"])).toHaveLength(80);
  expect(defaultGroupName([])).toBe("");
});
