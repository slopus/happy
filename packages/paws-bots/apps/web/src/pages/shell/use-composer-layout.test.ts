import { describe, expect, it } from "vitest";
import { spaceBetween } from "./use-composer-layout";

describe("composer controls spacing", () => {
  const attach = { left: 12, right: 44 };
  const actions = { left: 300, right: 340 };

  it("measures the free width between the controls in either reading direction", () => {
    expect(spaceBetween(attach, actions)).toBe(256);
    expect(spaceBetween({ left: 346, right: 378 }, { left: 12, right: 52 })).toBe(294);
  });
});
