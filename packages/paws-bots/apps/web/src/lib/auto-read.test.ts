import { describe, expect, it } from "vitest";
import { autoReadStillWanted } from "./auto-read";

const page = (visibilityState: DocumentVisibilityState, focused: boolean) => ({
  visibilityState,
  hasFocus: () => focused,
});

describe("autoReadStillWanted", () => {
  it("reads only on the same visit with the window shown and focused", () => {
    expect(autoReadStillWanted(3, 3, page("visible", true))).toBe(true);
    expect(autoReadStillWanted(4, 3, page("visible", true))).toBe(false);
    expect(autoReadStillWanted(3, 3, page("hidden", true))).toBe(false);
    // The tab is shown but another window has focus.
    expect(autoReadStillWanted(3, 3, page("visible", false))).toBe(false);
  });
});
