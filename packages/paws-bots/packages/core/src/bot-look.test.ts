import { describe, expect, it } from "vitest";
import { ORGANIC_AVATAR_HEART_FAMILY, organicAvatarFamily } from "./avatar-shape.js";
import { DEFAULT_BOT_AVATAR_COLOR } from "./bot-avatar-colors.js";
import {
  botLookState,
  botLookWithColor,
  botLookWithShape,
  newBotLook,
  newBotLookInput,
  newBotPreviewIdentity,
} from "./bot-look.js";

describe("newBotLook", () => {
  it("reserves a valid id that never draws the heart body", () => {
    for (let index = 0; index < 50; index++) {
      const look = newBotLook();
      expect(look.id).toMatch(/^c[a-z0-9]{24}$/);
      expect(organicAvatarFamily(look.id)).not.toBe(ORGANIC_AVATAR_HEART_FAMILY);
    }
  });

  it("keeps the preview's look through creation", () => {
    const look = { id: "c".padEnd(25, "a"), color: "#2A92FE", identity: "look-3-0" };
    expect(newBotPreviewIdentity("rakazo", look)).toBe(look.id);
    expect(newBotLookInput("rakazo", look)).toEqual({ color: look.color, id: look.id });
    expect(newBotPreviewIdentity("organic", look)).toBe(look.identity);
    expect(newBotLookInput("organic", look)).toEqual({
      color: look.color,
      avatarFamily: organicAvatarFamily(look.identity),
    });
    const shaped = { ...look, color: "#2A92FE::shape_2" };
    expect(newBotLookInput("organic", shaped)).toEqual({ color: shaped.color });
    expect(newBotLookInput("rakazo", shaped)).toEqual({ color: look.color, id: look.id });
  });
});

describe("botLookState", () => {
  it("keeps the shape when the color changes and the color when the shape changes", () => {
    expect(botLookWithColor("#00C972::shape_3", "#FF781C")).toBe("#FF781C::shape_3");
    expect(botLookWithColor("#00C972", "#FF781C")).toBe("#FF781C");
    expect(botLookState(botLookWithShape("#FF781C", 5))).toEqual({
      photo: false,
      shapeIndex: 5,
      color: "#FF781C",
      defaultLook: false,
    });
  });

  it("selects a color saved as its earlier value", () => {
    expect(botLookState("#8B5CF6").color).toBe("#A97EFE");
  });

  it("replaces a photo with a plain color", () => {
    const photo = "data:image/webp;base64,AAAA";
    expect(botLookState(photo)).toEqual({
      photo: true,
      shapeIndex: null,
      color: DEFAULT_BOT_AVATAR_COLOR,
      defaultLook: false,
    });
    expect(botLookWithColor(photo, "#2A92FE")).toBe("#2A92FE");
  });
});
