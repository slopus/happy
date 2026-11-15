import { describe, expect, it } from "vitest";
import {
  AgentImportCreateInput,
  BOT_AVATAR_VALUE_MAX_LENGTH,
  BotAvatarValueSchema,
  CreateBotInput,
  DEFAULT_NEW_BOT_AVATAR_SET,
  ExportManifestSchema,
  isBotAvatarValue,
  parseBotAvatarValue,
  resolveBotAvatarSet,
  UpdateBotInput,
} from "./index.js";

describe("bot avatar values", () => {
  it("parses hex, encoded shapes, and data images", () => {
    expect(parseBotAvatarValue("#8B5CF6")).toEqual({ kind: "color", color: "#8B5CF6" });
    expect(parseBotAvatarValue("#8B5CF6::shape_3")).toEqual({
      kind: "shape",
      color: "#8B5CF6",
      shapeIndex: 3,
    });
    expect(parseBotAvatarValue("data:image/png;base64,abc")).toEqual({
      kind: "image",
      imageUrl: "data:image/png;base64,abc",
    });
  });

  it("does not treat remote URLs as images", () => {
    expect(parseBotAvatarValue("https://evil.example/track.png")).toEqual({
      kind: "other",
      raw: "https://evil.example/track.png",
    });
    expect(isBotAvatarValue("https://evil.example/track.png")).toBe(false);
  });

  it("accepts persisted writes and rejects oversized or remote values", () => {
    expect(isBotAvatarValue("#3EC5A8")).toBe(true);
    expect(isBotAvatarValue("#8B5CF6::shape_0")).toBe(true);
    expect(isBotAvatarValue("data:image/webp;base64,aGVsbG8=")).toBe(true);
    expect(isBotAvatarValue("#8B5CF6::shape_3junk")).toBe(false);
    expect(
      isBotAvatarValue(`data:image/png;base64,${"A".repeat(BOT_AVATAR_VALUE_MAX_LENGTH)}`),
    ).toBe(false);
    expect(BotAvatarValueSchema.safeParse("#fff").success).toBe(true);
    expect(BotAvatarValueSchema.safeParse("not-a-color").success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", color: "#8B5CF6::shape_2" }).success).toBe(
      true,
    );
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", color: "https://evil.example/x.png" }).success,
    ).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", color: "gray" }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", name: "Atlas" }).success).toBe(true);
  });
});

describe("per-bot avatar sets", () => {
  it("keeps missing or unknown legacy metadata on the original renderer", () => {
    expect(resolveBotAvatarSet()).toBe("organic");
    expect(resolveBotAvatarSet(null)).toBe("organic");
    expect(resolveBotAvatarSet("future-set")).toBe("organic");
    expect(resolveBotAvatarSet("organic")).toBe("organic");
    expect(resolveBotAvatarSet("rakazo")).toBe("rakazo");
    expect(DEFAULT_NEW_BOT_AVATAR_SET).toBe("organic");
  });

  it("accepts an explicit set on create/update and rejects unrecognised writes", () => {
    for (const avatarSet of ["organic", "rakazo"] as const) {
      expect(CreateBotInput.parse({ name: "Scout", avatarSet }).avatarSet).toBe(avatarSet);
      expect(UpdateBotInput.parse({ botId: "bot-1", avatarSet }).avatarSet).toBe(avatarSet);
    }
    expect(CreateBotInput.safeParse({ name: "Scout", avatarSet: "other" }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", avatarSet: "other" }).success).toBe(false);
  });

  it("accepts a reserved creation seed without changing old-client inputs", () => {
    const id = "c0123456789abcdef01234567";
    expect(CreateBotInput.parse({ name: "Scout", id }).id).toBe(id);
    expect(CreateBotInput.parse({ name: "Scout" }).id).toBeUndefined();
    for (const invalid of ["", "existing-id", `${id}x`, id.toUpperCase()]) {
      expect(CreateBotInput.safeParse({ name: "Scout", id: invalid }).success).toBe(false);
    }
  });

  it("roundtrips the set and untouched photo or shape through portable profiles", () => {
    const base = {
      version: 1,
      exportedAt: "2026-10-27T00:00:00Z",
      bot: { name: "Scout", title: "", description: "", instructions: "" },
      memory: [],
      routines: [],
      files: [],
      history: [],
    };
    expect(ExportManifestSchema.parse(base).bot.avatarSet).toBeUndefined();
    for (const color of ["#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="]) {
      const exported = ExportManifestSchema.parse({
        ...base,
        bot: { ...base.bot, avatarSet: "rakazo", color },
      });
      const imported = AgentImportCreateInput.parse({
        name: "Scout",
        color: exported.bot.color,
        avatarSet: exported.bot.avatarSet,
        files: [{ path: "SOUL.md", content: "Be helpful." }],
        selection: { instructions: [], memory: [], skills: [] },
      });
      expect(imported.avatarSet).toBe("rakazo");
      expect(imported.color).toBe(color);
    }
  });
});
