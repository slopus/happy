import { describe, expect, it } from "vitest";
import { BotSchema, SpaceBotSchema } from "./domain.js";

describe("bot roster failure compatibility", () => {
  it("defaults an older bot payload's missing error signal to null", () => {
    expect(BotSchema.shape.runErrorId.parse(undefined)).toBeNull();
    expect(SpaceBotSchema.shape.runErrorId.parse(undefined)).toBeNull();
  });

  it("preserves a failure run ID and an explicit cleared signal", () => {
    expect(BotSchema.shape.runErrorId.parse("run-failed")).toBe("run-failed");
    expect(SpaceBotSchema.shape.runErrorId.parse(null)).toBeNull();
  });
});
