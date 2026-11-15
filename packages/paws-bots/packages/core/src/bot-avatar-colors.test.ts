import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botEyeInk, botEyeTone, chatUserBubbleColors, contrastRatio } from "./bot-avatar-colors.js";

describe("botEyeTone", () => {
  it("cuts eyes in the page color unless the body is nearly white or black", () => {
    expect(botEyeTone("#FF5EB1")).toBe("page");
    // White cut-outs would fade on a pale amber body in light mode.
    expect(botEyeTone("#FFAF38")).toBe("dark");
    expect(botEyeTone("#FFFFFF")).toBe("dark");
    expect(botEyeTone("#111111")).toBe("light");
  });
});

describe("chatUserBubbleColors", () => {
  it("wears the bot's color under readable text", () => {
    const red = chatUserBubbleColors("#EF4444::shape_2", "bot-1");
    expect(red?.foreground).toBe("#FFFFFF");
    expect(contrastRatio(red!.background, red!.foreground)).toBeGreaterThanOrEqual(3);
    // A bot saved with a color's earlier value wears that color's current bubble.
    expect(chatUserBubbleColors("#64748B", "bot-1")).toEqual(
      chatUserBubbleColors("#94A3B8", "bot-1"),
    );
  });

  it.each(BOT_COLOR_LIST.filter((color) => color.id !== "white"))(
    "keeps $name white text at 3:1 contrast",
    ({ hex }) => {
      const bubble = chatUserBubbleColors(hex, "bot-1");
      expect(bubble).toBeDefined();
      expect(bubble!.foreground).toBe("#FFFFFF");
      expect(contrastRatio(bubble!.background, bubble!.foreground)).toBeGreaterThanOrEqual(3);
    },
  );

  it("leaves colors that already read well as the avatar's own", () => {
    expect(chatUserBubbleColors("#2A92FE", "bot-1")?.background).toBe("#2A92FE");
  });

  it("deepens bright colors without turning them muddy", () => {
    const orange = chatUserBubbleColors("#FF781C", "bot-1")!;
    // Darkening in RGB pulled orange toward brown; OKLCH keeps it orange.
    expect(orange.background).toBe("#F16B00");
    expect(contrastRatio(orange.background, orange.foreground)).toBeGreaterThanOrEqual(3);
  });

  it("deepens custom violet for readable white text", () => {
    const bubble = chatUserBubbleColors("#C9A8FF", "bot-1")!;
    expect(bubble.foreground).toBe("#FFFFFF");
    expect(bubble.background).not.toBe("#C9A8FF");
    expect(contrastRatio(bubble.background, bubble.foreground)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the neutral bubble for a photo or the white bot", () => {
    expect(chatUserBubbleColors("data:image/png;base64,AAAA", "bot-1")).toBeUndefined();
    expect(chatUserBubbleColors("#FFFFFF", "bot-1")).toBeUndefined();
  });
});

it("cuts bot eyes in the page color unless the body is nearly white", () => {
  const dark = { background: "#121212", foreground: "#F5F5F5" };
  const light = { background: "#FFFFFF", foreground: "#1C1C1C" };
  expect(botEyeInk("#FF5EB1", dark)).toBe("#121212");
  expect(botEyeInk("#FF5EB1", light)).toBe("#FFFFFF");
  expect(botEyeInk("#FFFFFF", light)).toBe("#1C1C1C");
});
