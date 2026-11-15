import { describe, expect, it } from "vitest";
import { AdapterRegistry, slots } from "./index.js";

describe("adapter registry", () => {
  it("registers and retrieves adapters", () => {
    const registry = new AdapterRegistry();
    registry.register(slots.runtime, { id: "scripted" });
    registry.register(slots.browser, { id: "fake" });
    expect(registry.get<{ id: string }>(slots.runtime).id).toBe("scripted");
    expect(registry.get<{ id: string }>(slots.browser).id).toBe("fake");
  });

  it("throws when missing", () => {
    const registry = new AdapterRegistry();
    expect(() => registry.get("nope")).toThrow(/no adapter/i);
  });
});
