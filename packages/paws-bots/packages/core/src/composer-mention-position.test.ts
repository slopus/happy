import { describe, expect, it } from "vitest";
import {
  completeComposerMention,
  composerMentionQuery,
  filterComposerMentionTargets,
  removeComposerMention,
  resolveComposerSendPlan,
} from "./composer-mentions.js";

describe("inline mention completion", () => {
  it.each([
    ["@bo", 3, "@Bot ", 5],
    ["ask @bo", 7, "ask @Bot ", 9],
    ["ask @bo and do this", 7, "ask @Bot and do this", 9],
    ["ask @bo, please", 6, "ask @Bot, please", 8],
    [" \task\n @bo  later\n", 10, " \task\n @Bot  later\n", 12],
    ["@Bot ask @bo later", 12, "@Bot ask @Bot later", 14],
  ] as const)("replaces the active query in %j", (text, caret, expected, nextCaret) => {
    const query = composerMentionQuery(text, caret);
    expect(query).not.toBeNull();
    expect(completeComposerMention(text, query!, { name: "Bot" })).toEqual({
      text: expected,
      caret: nextCaret,
    });
  });

  it.each([
    ["研", "研究助手"],
    ["نامه\u200c", "نامه\u200cنگار"],
    ["क्\u200d", "क्\u200dष"],
    ["リサーチ・", "リサーチ・ボット"],
    ["Ré", "Réviseur"],
    ["Re\u0301", "Réviseur"],
    ["מר", "מרים"],
    ["مُ", "مُساعد"],
    ["𐐀", "𐐀bot"],
    ["bot_１２-", "bot_１２-helper"],
  ])("keeps the picker open for the Unicode prefix %j", (prefix, name) => {
    const text = `ask @${prefix}`;
    const target = { kind: "bot", id: "target", name } as const;
    const query = composerMentionQuery(text, text.length, text.length, [target]);
    expect(query).toEqual({ start: 4, end: text.length, query: prefix });
    expect(filterComposerMentionTargets([target], query!.query)).toEqual([target]);
  });

  it.each(["研究", "Rév", "Re\u0301v", "𐐀bot"])(
    "replaces the whole Unicode query %j when the caret is in the middle",
    (prefix) => {
      const text = `ask @${prefix}, please`;
      const caret = 5 + [...prefix][0]!.length;
      const query = composerMentionQuery(text, caret, caret, [{ name: `${prefix}Helper` }])!;
      expect(query).toEqual({ start: 4, end: 5 + prefix.length, query: text.slice(5, caret) });
      expect(completeComposerMention(text, query, { name: "Reviewer" })).toEqual({
        text: "ask @Reviewer, please",
        caret: 13,
      });
    },
  );

  it.each([
    ["ask @研究助手请回复", 6, ["研究助手"], 9],
    ["ask @研究请回复", 6, ["研究助手"], 7],
    ["ask @bo请回复", 6, ["Bot"], 7],
    ["ask @リサーチ・ボットお願いします", 7, ["リサーチ・ボット"], 13],
    ["ask @研请回复", 6, [], 6],
  ] as const)("preserves adjacent CJK prose in %j", (text, caret, names, end) => {
    const query = composerMentionQuery(
      text,
      caret,
      caret,
      names.map((name) => ({ name })),
    )!;
    expect(query).toMatchObject({ start: 4, end });
    expect(completeComposerMention(text, query, { name: "Reviewer" }).text).toBe(
      `ask @Reviewer${text.slice(end)}`,
    );
  });

  it.each(["email@bo", "@bo done", "ordinary text"])(
    "ignores nonqueries at the end of %j",
    (text) => {
      expect(composerMentionQuery(text)).toBeNull();
    },
  );

  it("does not complete a selected range", () => {
    expect(composerMentionQuery("ask @bo later", 5, 7)).toBeNull();
  });

  it("removes repeated tokens without touching suffixes or whitespace", () => {
    expect(removeComposerMention("ask @Bot  and @Bot\n@Botany", { name: "Bot" })).toBe(
      "ask   and \n@Botany",
    );
  });
  it("replaces a complete multiword name when the caret is inside either word", () => {
    const names = [{ name: "Bob" }, { name: "Bob Smith" }, { name: "Bob Jones" }];
    for (const caret of [7, 11]) {
      const text = "ask @Bob Smith  later";
      const query = composerMentionQuery(text, caret, caret, names)!;
      expect(query).toMatchObject({ start: 4, end: 14 });
      expect(completeComposerMention(text, query, names[2]!)).toEqual({
        text: "ask @Bob Jones  later",
        caret: 15,
      });
    }
  });

  it("does not retain or remove a shorter name inside a recognized longer mention", () => {
    const short = { kind: "group", id: "group-bob", name: "Bob" } as const;
    const long = { kind: "bot", id: "bot-bob", name: "Bob Smith" } as const;
    const text = "ask @Bob Smith ";
    expect(removeComposerMention(text, short, [short, long])).toBe(text);
    expect(
      resolveComposerSendPlan({ text, mentions: [long], hasAttachments: false }),
    ).toMatchObject({
      trimmed: "ask @Bob Smith",
      rerouteGroupId: null,
      mentionPayload: [{ kind: "bot", id: "bot-bob" }],
    });
  });

  it("removes a separate shorter occurrence without changing the longer name", () => {
    const short = { name: "Bob" },
      long = { name: "Bob Smith" };
    const text = "@Bob and ask @Bob Smith ";
    expect(removeComposerMention(text, short, [short, long])).toBe(" and ask @Bob Smith ");
  });
  it("strips a separate group occurrence without stripping a longer bot name on send", () => {
    const short = { kind: "group", id: "group-bob", name: "Bob" } as const;
    const long = { kind: "bot", id: "bot-bob", name: "Bob Smith" } as const;
    expect(
      resolveComposerSendPlan({
        text: "@Bob and ask @Bob Smith",
        mentions: [short, long],
        hasAttachments: false,
      }),
    ).toMatchObject({
      trimmed: "and ask @Bob Smith",
      rerouteGroupId: "group-bob",
      mentionPayload: [{ kind: "bot", id: "bot-bob" }],
    });
  });
});
