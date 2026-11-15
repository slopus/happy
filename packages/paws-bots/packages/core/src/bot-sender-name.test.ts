import { describe, expect, it } from "vitest";
import { shouldShowBotSenderName } from "./bot-sender-name.js";

describe("shouldShowBotSenderName", () => {
  it.each(
    [[], ["bot-a", "bot-a", undefined]].map((speakerBotIds) => ({
      speakerBotIds,
    })),
  )("hides names in a non-group thread with at most one known bot: %j", ({ speakerBotIds }) => {
    expect(shouldShowBotSenderName({ isGroup: false, speakerBotIds })).toBe(false);
  });

  it("shows names for distinct bots in a non-group thread", () => {
    expect(
      shouldShowBotSenderName({
        isGroup: false,
        speakerBotIds: ["bot-a", undefined, "bot-a", "bot-b"],
      }),
    ).toBe(true);
  });

  it("shows names in groups regardless of loaded speakers", () => {
    expect(shouldShowBotSenderName({ isGroup: true, speakerBotIds: [] })).toBe(true);
  });
});
