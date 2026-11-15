import { describe, expect, it } from "vitest";
import { BOT_COMPUTER_MODES, BOT_SETTINGS_SECTIONS } from "./bot-settings-layout.js";
import type { ComputerMode } from "./computer.js";

describe("bot settings layout", () => {
  it("offers Team before Private using valid computer modes", () => {
    const modes: readonly ComputerMode[] = BOT_COMPUTER_MODES;
    expect(modes).toEqual(["team", "dedicated"]);
  });
  it("assigns each control to one section", () => {
    const controls = Object.values(BOT_SETTINGS_SECTIONS).flat();
    expect(new Set(controls).size).toBe(controls.length);
  });
});
