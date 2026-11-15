import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botProfilePatch } from "./bot-profile-patch.js";

describe("bot profile patch", () => {
  it("leaves instructions alone when the description field was not touched", () => {
    const stored = "I".repeat(BOT_DESCRIPTION_MAX_LENGTH + 1500);
    expect(botProfilePatch(stored, stored)).toEqual({});
  });

  it("treats whitespace around the stored description as untouched", () => {
    const stored = "I".repeat(BOT_DESCRIPTION_MAX_LENGTH + 1500);
    expect(botProfilePatch(`  ${stored}\n`, stored)).toEqual({});
    expect(botProfilePatch(" Billing questions ", "Billing questions")).toEqual({});
  });

  it("preserves instructions when the description is edited", () => {
    const patch = botProfilePatch("Billing questions", "Invoices");
    expect(patch).toEqual({ description: "Invoices" });
  });

  it("clamps an edited description", () => {
    const patch = botProfilePatch("short", "D".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 100));
    expect(patch.description).toHaveLength(BOT_DESCRIPTION_MAX_LENGTH);
    expect(patch).not.toHaveProperty("instructions");
  });

  it("still sends a cleared description", () => {
    const patch = botProfilePatch("Invoices", "");
    expect(patch).toEqual({ description: "" });
  });
});
