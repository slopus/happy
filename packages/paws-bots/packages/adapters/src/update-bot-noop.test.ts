import { describe, expect, it } from "vitest";
import { dropUnchangedOwnBotArgs, ignoredFieldsNote } from "./update-bot-patch.js";

const current = {
  name: "Helper",
  description: "Answers on a chat app.",
  instructions: "Be brief.",
  color: "#22C55E",
  notifyOnFinish: false,
  dailyCheckIns: false,
  thinkingLevel: "high",
  autoSpeak: false,
  voiceId: null,
};

describe("dropUnchangedOwnBotArgs", () => {
  it("turns a call that repeats every current value into a read", () => {
    expect(
      dropUnchangedOwnBotArgs(
        {
          name: "Helper",
          description: " Answers on a chat app. ",
          instructions: "Be brief.",
          color: "#22C55E",
          notifyOnFinish: false,
          dailyCheckIns: false,
          thinkingLevel: "high",
          readAloud: false,
          voice: "default",
          use_attached_image: false,
          instructions_offset: 0,
        },
        current,
      ),
    ).toEqual({});
  });

  it("treats every name of the current model and the run's thinking as no change", () => {
    const names = ["gpt-fixture", "openai-compatible/gpt-fixture", "gpt-fixture (Compatible)"];
    for (const model of [...names, "GPT-fixture (compatible)"])
      expect(
        dropUnchangedOwnBotArgs(
          { model, thinkingLevel: "medium" },
          { ...current, thinkingLevel: null },
          names,
          "medium",
        ),
      ).toEqual({});
  });

  it("keeps the same model id at another provider", () => {
    expect(
      dropUnchangedOwnBotArgs({ model: "openrouter/gpt-fixture" }, current, [
        "gpt-fixture",
        "openai-compatible/gpt-fixture",
      ]),
    ).toEqual({ model: "openrouter/gpt-fixture" });
  });

  it("treats default thinking as no change for a bot without its own level", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { thinkingLevel: "default" },
        { ...current, thinkingLevel: null },
        [],
        "medium",
      ),
    ).toEqual({});
  });

  it("reads switches sent as text and the default thinking level", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { dailyCheckIns: "false", notifyOnFinish: "true", thinkingLevel: "default" },
        { ...current, thinkingLevel: null },
      ),
    ).toEqual({ notifyOnFinish: true });
  });

  it("keeps real changes", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { thinkingLevel: "max", readAloud: true, use_attached_image: true, model: "gpt-fixture" },
        current,
        ["openai-compatible/gpt-other", "gpt-other"],
      ),
    ).toEqual({
      thinkingLevel: "max",
      readAloud: true,
      use_attached_image: true,
      model: "gpt-fixture",
    });
  });
});

describe("ignoredFieldsNote", () => {
  it("names a bounded number of fields with short previews", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field${i}`, "x".repeat(5000)]),
    );
    const note = ignoredFieldsNote({ ...fields, blank: "", none: null });
    expect(note).toContain("field0=");
    expect(note).toContain("and 4 more");
    expect(note).not.toContain("blank");
    expect(note!.length).toBeLessThan(1000);
    expect(ignoredFieldsNote({ name: "" })).toBeUndefined();
  });
});
