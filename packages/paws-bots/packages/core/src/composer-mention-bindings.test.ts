import { describe, expect, it } from "vitest";
import type { ComposerMentionBinding } from "./composer-mention-bindings.js";
import {
  bindComposerMention,
  composerMentionDeletionRange,
  composerMentionSegments,
  composerMentionsForPrompt,
  composerSelectedMentions,
  resolveComposerMentionBackspace,
  resolveComposerMentionEdit,
  updateComposerMentionBindings,
  validateComposerMentionBindings,
} from "./composer-mention-bindings.js";
import type { ComposerMention, ComposerMentionRange } from "./composer-mentions.js";
import { composerMentionQuery, resolveComposerSendPlan } from "./composer-mentions.js";
import { serializeComposerPrompt } from "./composer-slash.js";

const bot: ComposerMention = { kind: "bot", id: "bot-bob", name: "Bob" };
const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
const text = "@Bob and @Bob ";
const bindings: ComposerMentionBinding[] = [
  { start: 0, end: 4, mention: bot },
  { start: 9, end: 13, mention: group },
];
const shift = (items: ComposerMentionBinding[], offset: number) =>
  items.map((item) => ({ ...item, start: item.start + offset, end: item.end + offset }));

describe("completed mention occurrence bindings", () => {
  it.each([0, 1])("retires only edited occurrence %s despite identical names", (index) => {
    const removed = bindings[index]!;
    const next = text.slice(0, removed.start) + text.slice(removed.end);
    const retained = updateComposerMentionBindings(text, next, bindings, {
      before: [removed],
      after: { start: removed.start, end: removed.start },
    });
    expect(composerSelectedMentions(retained)).toEqual([bindings[1 - index]!.mention]);
  });

  it.each([false, true])(
    "maps identical adjacent deletion using native edit selection (selection-first %s)",
    (selectionFirst) => {
      const before = [{ start: 0, end: 5 }];
      if (selectionFirst) before.unshift({ start: 0, end: 0 });
      const result = updateComposerMentionBindings(
        "@Bob @Bob ",
        "@Bob ",
        [
          { start: 0, end: 4, mention: bot },
          { start: 5, end: 9, mention: group },
        ],
        { before, after: { start: 0, end: 0 } },
      );
      expect(result).toEqual([{ start: 0, end: 4, mention: group }]);
    },
  );

  it("does not retain an intersected binding when an edited name still appears elsewhere", () => {
    const next = text.replace("and @Bob", "and @Bobby");
    expect(composerSelectedMentions(updateComposerMentionBindings(text, next, bindings))).toEqual([
      bot,
    ]);
  });

  it("shifts untouched occurrences through a prefix edit", () => {
    const next = `please ${text}`;
    expect(updateComposerMentionBindings(text, next, bindings)).toEqual(
      bindings.map((binding) => ({ ...binding, start: binding.start + 7, end: binding.end + 7 })),
    );
  });

  it("retires a binding when a letter is inserted at its token boundary", () => {
    expect(
      updateComposerMentionBindings("@Bob ", "@Bobby ", [bindings[0]!], {
        before: [{ start: 4, end: 4 }],
        after: { start: 6, end: 6 },
      }),
    ).toEqual([]);
  });

  it("completion replaces the bound occurrence identity even when the text is unchanged", () => {
    const query = composerMentionQuery(text, 2, 2, [bot, group], bindings)!;
    const result = bindComposerMention(text, query, group, bindings);
    expect(result.text).toBe(text);
    expect(result.bindings.map((binding) => binding.mention)).toEqual([group, group]);
    expect(composerSelectedMentions(result.bindings)).toEqual([group]);
  });

  it("deduplicates routing but retains repeated occurrences", () => {
    const twice = bindings.map((binding) => ({ ...binding, mention: bot }));
    expect(composerSelectedMentions(twice)).toEqual([bot]);
    expect(composerMentionSegments(text, twice).filter((segment) => segment.binding)).toHaveLength(
      2,
    );
  });

  it("segments plain runs around each completed occurrence", () => {
    expect(composerMentionSegments(`hi ${text}`, shift(bindings, 3))).toEqual([
      { text: "hi " },
      { text: "@Bob", binding: shift(bindings, 3)[0] },
      { text: " and " },
      { text: "@Bob", binding: shift(bindings, 3)[1] },
      { text: " " },
    ]);
    expect(
      composerMentionSegments("@Bob@Bob", [bindings[0]!, { ...bindings[1]!, start: 4, end: 8 }]),
    ).toHaveLength(2);
    expect(composerMentionSegments("plain", [])).toEqual([{ text: "plain" }]);
    expect(composerMentionSegments("", [])).toEqual([]);
  });

  it.each([
    ["Backspace at the end", { start: 3, end: 4 }, { start: 0, end: 4 }],
    ["Delete at the start", { start: 9, end: 10 }, { start: 9, end: 13 }],
    ["a caret inside", { start: 1, end: 2 }, { start: 0, end: 4 }],
    ["a selection cutting into both", { start: 2, end: 11 }, { start: 0, end: 13 }],
    ["a selection ending inside", { start: 6, end: 11 }, { start: 6, end: 13 }],
  ] as [string, ComposerMentionRange, ComposerMentionRange][])(
    "widens %s to whole mentions",
    (_label, range, expected) => {
      expect(composerMentionDeletionRange(bindings, range)).toEqual(expected);
    },
  );

  it.each([
    ["plain text", { start: 5, end: 6 }],
    ["the space after a mention", { start: 4, end: 5 }],
    ["a selection already covering a mention", { start: 0, end: 5 }],
    ["an empty range at a boundary", { start: 4, end: 4 }],
  ] as [string, ComposerMentionRange][])("leaves %s unchanged", (_label, range) => {
    expect(composerMentionDeletionRange(bindings, range)).toBeNull();
  });

  it.each([
    ["Backspace at the end", "@Bo and @Bob ", { start: 4, end: 4 }, " and @Bob ", 0],
    ["a selection cutting in", "@Bob anBob ", { start: 7, end: 10 }, "@Bob an ", 7],
    ["Delete at the start", "@Bob and Bob ", { start: 9, end: 9 }, "@Bob and  ", 9],
  ] as [string, string, ComposerMentionRange, string, number][])(
    "removes the whole mention for %s",
    (_label, next, before, expected, caret) => {
      const result = resolveComposerMentionEdit(text, next, bindings, { before: [before] });
      expect(result).toMatchObject({ text: expected, caret });
      expect(
        composerMentionSegments(result.text, result.bindings).filter((s) => s.binding),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["a whole mention", "@Bob and  ", { start: 9, end: 13 }],
    ["plain text", "@Bob nd @Bob ", { start: 6, end: 6 }],
    ["an insertion", "@Bob and @Bobx ", { start: 13, end: 13 }],
    ["a replacement", "@Bob and xyz ", { start: 9, end: 13 }],
  ] as [string, string, ComposerMentionRange][])(
    "keeps the native text for %s",
    (_label, next, before) => {
      const hints = { before: [before] };
      expect(resolveComposerMentionEdit(text, next, bindings, hints)).toEqual({
        text: next,
        bindings: updateComposerMentionBindings(text, next, bindings, hints),
        caret: null,
      });
    },
  );

  it("places an ambiguous deletion with the same hints the bindings use", () => {
    const doubled = "@@Bob ";
    const mention = [{ start: 1, end: 5, mention: bot }];
    const caret = (at: number) => ({ start: at, end: at });
    expect(
      resolveComposerMentionEdit(doubled, "@Bob ", mention, {
        before: [caret(1)],
        after: caret(0),
      }),
    ).toEqual({ text: "@Bob ", bindings: [{ start: 0, end: 4, mention: bot }], caret: null });
    expect(
      resolveComposerMentionEdit(doubled, "@Bob ", mention, {
        before: [caret(1)],
        after: caret(1),
      }),
    ).toEqual({ text: "@ ", bindings: [], caret: 1 });
    expect(
      resolveComposerMentionEdit(doubled, "@@Bo ", mention, { before: [caret(5)] }),
    ).toMatchObject({ text: "@ ", caret: 1 });
  });

  it("preserves the bot's same-name text when stripping a separate group occurrence", () => {
    const draft = "  @Bob and @Bob ";
    const occurrences = bindings.map((binding) => ({
      ...binding,
      start: binding.start + 2,
      end: binding.end + 2,
    }));
    for (const skill of [null, { name: "Write" }]) {
      const prompt = serializeComposerPrompt(draft, skill);
      const mentions = composerMentionsForPrompt(draft, skill, occurrences);
      expect(
        resolveComposerSendPlan({ text: prompt, mentions, hasAttachments: false }),
      ).toMatchObject({
        trimmed: skill ? "/Write\n@Bob and" : "@Bob and",
        rerouteGroupId: group.id,
        mentionPayload: [{ kind: "bot", id: bot.id }],
      });
    }
  });

  it("prioritizes an explicitly bound short name over an unselected longer catalog name", () => {
    const value = "@Bob Smith ";
    expect(composerMentionQuery(value, 2, 2, [bot, { name: "Bob Smith" }], [bindings[0]!])).toEqual(
      { start: 0, end: 4, query: "B" },
    );
  });

  it("validates persisted metadata without inferring ambiguous identities", () => {
    expect(validateComposerMentionBindings(text, bindings)).toEqual(bindings);
    expect(
      validateComposerMentionBindings(text, [
        ...bindings,
        { start: 0, end: 4, mention: group },
        { start: 99, end: 103, mention: bot },
      ]),
    ).toEqual(bindings);
    expect(validateComposerMentionBindings("changed", bindings)).toEqual([]);
    expect(validateComposerMentionBindings(text, { name: "Bob" })).toEqual([]);
  });
});

describe("two-step mention delete", () => {
  const caret = (at: number) => ({ start: at, end: at });

  it("keeps the text and selects the mention on the first backspace at its end", () => {
    const result = resolveComposerMentionBackspace(
      text,
      "@Bo and @Bob ",
      bindings,
      { before: [caret(4)] },
      null,
    );
    expect(result).toEqual({ text, bindings, caret: 4, selected: 0 });
  });

  it("selects the mention instead of deleting the space after it", () => {
    const result = resolveComposerMentionBackspace(
      text,
      "@Boband @Bob ",
      bindings,
      { before: [caret(5)] },
      null,
    );
    expect(result).toEqual({ text, bindings, caret: 5, selected: 0 });
  });

  it("removes the mention and its space on the second backspace from after the space", () => {
    const result = resolveComposerMentionBackspace(
      text,
      "@Boband @Bob ",
      bindings,
      { before: [caret(5)] },
      0,
    );
    expect(result).toEqual({
      text: "and @Bob ",
      bindings: [{ start: 4, end: 8, mention: group }],
      caret: 0,
      selected: null,
    });
  });

  it("never leaves a mention glued to the next word in mid-text", () => {
    const mid = "hi @Bob now";
    const only = [{ start: 3, end: 7, mention: bot }];
    const first = resolveComposerMentionBackspace(
      mid,
      "hi @Bobnow",
      only,
      { before: [caret(8)] },
      null,
    );
    expect(first).toEqual({ text: mid, bindings: only, caret: 8, selected: 3 });
    const second = resolveComposerMentionBackspace(
      mid,
      "hi @Bobnow",
      only,
      { before: [caret(8)] },
      3,
    );
    expect(second).toEqual({ text: "hi now", bindings: [], caret: 3, selected: null });
  });

  it("removes the mention and the space after it on the second backspace", () => {
    const result = resolveComposerMentionBackspace(
      text,
      "@Bo and @Bob ",
      bindings,
      { before: [caret(4)] },
      0,
    );
    expect(result).toEqual({
      text: "and @Bob ",
      bindings: [{ start: 4, end: 8, mention: group }],
      caret: 0,
      selected: null,
    });
  });

  it("removes only the mention when no space follows it", () => {
    const result = resolveComposerMentionBackspace(
      "hi @Bob",
      "hi @Bo",
      [{ start: 3, end: 7, mention: bot }],
      { before: [caret(7)] },
      3,
    );
    expect(result).toMatchObject({ text: "hi ", bindings: [], caret: 3, selected: null });
  });

  it("selects again when a different mention is selected", () => {
    const result = resolveComposerMentionBackspace(
      text,
      "@Bob and @Bo ",
      bindings,
      { before: [caret(13)] },
      0,
    );
    expect(result).toMatchObject({ text, caret: 13, selected: 9 });
  });

  it("leaves a forward delete after a mention to the ordinary edit", () => {
    expect(
      resolveComposerMentionBackspace(
        text,
        "@Boband @Bob ",
        bindings,
        { before: [caret(4)] },
        null,
      ),
    ).toBeNull();
  });

  it.each([
    ["plain text", "@Bob nd @Bob ", { start: 6, end: 6 }],
    ["the character after the space", "@Bob nd @Bob ", { start: 6, end: 6 }],
    ["an insertion", "@Bob and @Bobx ", { start: 13, end: 13 }],
  ] as [string, string, ComposerMentionRange][])("ignores %s", (_label, next, before) => {
    expect(
      resolveComposerMentionBackspace(text, next, bindings, { before: [before] }, null),
    ).toBeNull();
  });
});
