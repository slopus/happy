import { describe, expect, it } from "vitest";
import { changedBotSettings } from "./bot-setting-analytics.js";

const bot = {
  id: "bot-1",
  name: "Chief",
  description: "Runs the day",
  instructions: "Be brief.",
  color: "#8B5CF6",
  dailyCheckIns: true,
  notifyOnFinish: true,
  modelProvider: "anthropic",
  modelId: "claude",
  disabledBuiltinTools: ["web_search"],
};

describe("changedBotSettings", () => {
  it("ignores fields a save resends unchanged", () => {
    expect(
      changedBotSettings(bot, {
        botId: bot.id,
        name: "Chief",
        color: "#8B5CF6",
        notifyOnFinish: true,
        disabledBuiltinTools: ["web_search"],
      }),
    ).toEqual([]);
  });

  it("names each changed setting once", () => {
    expect(
      changedBotSettings(bot, {
        botId: bot.id,
        instructions: "Be thorough.",
        color: "#000000",
        avatarSet: "rakazo",
        modelProvider: "openai",
        modelId: "gpt",
      }),
    ).toEqual(["instructions", "avatar", "model"]);
  });

  it("counts a provider change that keeps the model id", () => {
    expect(
      changedBotSettings(bot, { botId: bot.id, modelProvider: "openrouter", modelId: "claude" }),
    ).toEqual(["model"]);
  });

  it("counts the daily check-in opt-out", () => {
    expect(changedBotSettings(bot, { botId: bot.id, dailyCheckIns: false })).toEqual([
      "daily_check_ins",
    ]);
    expect(changedBotSettings(bot, { botId: bot.id, dailyCheckIns: true })).toEqual([]);
  });

  it("leaves sidebar organization out", () => {
    expect(changedBotSettings(bot, { botId: bot.id, pinned: true, sectionId: null })).toEqual([]);
  });
});
