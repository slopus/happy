import { BOT_COLORS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { seededLogoAvatarColor } from "./logo-avatar-traits.js";

describe("seeded logo colours", () => {
  it("reproduces a valid colour from a persisted identity across calls and reload data", () => {
    const first = seededLogoAvatarColor("persistent-bot-1");
    expect(first).toMatch(/^#[0-9A-F]{6}$/);
    for (let index = 0; index < 30; index++) {
      const restored = JSON.parse(JSON.stringify({ id: "persistent-bot-1" }));
      expect(seededLogoAvatarColor(restored.id)).toBe(first);
      expect(logoAvatarTraits(restored.id).color).toBe(first);
    }
  });

  it("only picks colours from the shared palette, and all of them across a fleet", () => {
    const colors = new Set(
      Array.from({ length: 1000 }, (_, index) => seededLogoAvatarColor(`bot-${index}`)),
    );
    expect(colors).toEqual(new Set(BOT_COLORS));
  });

  it("preserves a saved colour and leaves seeded motion parameters unchanged", () => {
    const { color, originalOrange: _orange, ...seeded } = logoAvatarTraits("persistent-bot-1");
    const {
      color: explicit,
      originalOrange: _explicitOrange,
      ...chosen
    } = logoAvatarTraits("persistent-bot-1", "#123456");
    expect(color).toBe(seededLogoAvatarColor("persistent-bot-1"));
    expect(explicit).toBe("#123456");
    expect(chosen).toEqual(seeded);
  });
});

import { LOGO_AVATAR_LOOP_MS, logoAvatarTraits } from "./logo-avatar-traits.js";

describe("stable logo avatar traits", () => {
  it("reproduces colour, phase and timing from the same identity", () => {
    const first = logoAvatarTraits("inbox-01");
    for (let index = 0; index < 20; index++) expect(logoAvatarTraits("inbox-01")).toEqual(first);
  });

  it("gives a fleet independent blink and movement clocks", () => {
    const fleet = Array.from({ length: 200 }, (_, index) => logoAvatarTraits(`bot-${index}`));
    expect(new Set(fleet.map((bot) => `${bot.blinkMs}:${bot.blinkDelayMs}`)).size).toBe(200);
    expect(new Set(fleet.map((bot) => `${bot.periods.reading}:${bot.phase}`)).size).toBe(200);
    expect(new Set(fleet.map((bot) => bot.blinkVariant))).toEqual(new Set(["three", "four"]));
    expect(fleet.every((bot) => bot.blinkMs === 24000)).toBe(true);
    expect(fleet.every((bot) => bot.blinkDelayMs <= 0 && bot.blinkDelayMs >= -bot.blinkMs)).toBe(
      true,
    );
  });

  it("closes every seeded track in the exact common export interval", () => {
    for (let index = 0; index < 200; index++) {
      const traits = logoAvatarTraits(`bot-${index}`);
      for (const period of [traits.blinkMs, ...Object.values(traits.periods)]) {
        expect(LOGO_AVATAR_LOOP_MS % period).toBe(0);
      }
    }
  });

  it("keeps movement identity when the saved colour changes", () => {
    const {
      color: _firstColor,
      originalOrange: _firstOrange,
      ...first
    } = logoAvatarTraits("bot-1", "orange");
    const {
      color: _secondColor,
      originalOrange: _secondOrange,
      ...second
    } = logoAvatarTraits("bot-1", "blue");
    expect(first).toEqual(second);
    expect(logoAvatarTraits("bot-1", "blue").color).toBe("#2A92FE");
    expect(logoAvatarTraits("bot-1", "#abc").color).toBe("#abc");
  });
});
