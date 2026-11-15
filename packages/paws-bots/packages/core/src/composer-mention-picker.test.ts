import { describe, expect, it } from "vitest";

import {
  clampMentionHighlightIndex,
  resolveMentionPickerKey,
  wrapMentionHighlightIndex,
} from "./composer-mention-picker.js";

describe("wrapMentionHighlightIndex", () => {
  it("wraps past the ends of the list", () => {
    expect(wrapMentionHighlightIndex(0, 3)).toBe(0);
    expect(wrapMentionHighlightIndex(2, 3)).toBe(2);
    expect(wrapMentionHighlightIndex(3, 3)).toBe(0);
    expect(wrapMentionHighlightIndex(-1, 3)).toBe(2);
  });

  it("returns 0 when there are no options", () => {
    expect(wrapMentionHighlightIndex(2, 0)).toBe(0);
  });
});

describe("clampMentionHighlightIndex", () => {
  it("keeps the index inside the list", () => {
    expect(clampMentionHighlightIndex(1, 3)).toBe(1);
    expect(clampMentionHighlightIndex(5, 3)).toBe(2);
    expect(clampMentionHighlightIndex(-2, 3)).toBe(0);
    expect(clampMentionHighlightIndex(0, 0)).toBe(0);
  });
});

describe("resolveMentionPickerKey", () => {
  it("completes the highlighted mention on Enter and Tab", () => {
    expect(resolveMentionPickerKey({ key: "Enter", optionCount: 2, highlightedIndex: 1 })).toEqual({
      type: "complete",
      index: 1,
    });
    expect(resolveMentionPickerKey({ key: "Tab", optionCount: 2, highlightedIndex: 0 })).toEqual({
      type: "complete",
      index: 0,
    });
  });

  it("moves the highlight with Arrow Up and Down and wraps", () => {
    expect(
      resolveMentionPickerKey({ key: "ArrowDown", optionCount: 3, highlightedIndex: 2 }),
    ).toEqual({ type: "move", index: 0 });
    expect(
      resolveMentionPickerKey({ key: "ArrowUp", optionCount: 3, highlightedIndex: 0 }),
    ).toEqual({ type: "move", index: 2 });
  });

  it("dismisses the picker on Escape without sending", () => {
    expect(resolveMentionPickerKey({ key: "Escape", optionCount: 2, highlightedIndex: 0 })).toEqual(
      { type: "dismiss" },
    );
  });

  it("sends on Enter when the picker is closed or empty", () => {
    expect(resolveMentionPickerKey({ key: "Enter", optionCount: 0, highlightedIndex: 0 })).toEqual({
      type: "send",
    });
  });

  it("ignores Shift+Enter while completing on Tab and Shift+Tab", () => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        shiftKey: true,
        optionCount: 2,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "none" });
    expect(
      resolveMentionPickerKey({
        key: "Tab",
        shiftKey: true,
        optionCount: 2,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "complete", index: 0 });
  });

  it("does not send on Shift+Enter when the picker is closed", () => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        shiftKey: true,
        optionCount: 0,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "none" });
  });

  it("ignores keys while IME composition is active", () => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        isComposing: true,
        optionCount: 2,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "none" });
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        isComposing: true,
        optionCount: 0,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "none" });
  });

  it("inserts a newline on plain Enter when enter-to-send is off", () => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        enterToSend: false,
        optionCount: 0,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "none" });
  });

  it("sends on Ctrl+Enter and Cmd+Enter when enter-to-send is off", () => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        enterToSend: false,
        ctrlKey: true,
        optionCount: 0,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "send" });
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        enterToSend: false,
        metaKey: true,
        optionCount: 0,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "send" });
  });

  it("still completes the open picker on Enter when enter-to-send is off", () => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        enterToSend: false,
        optionCount: 2,
        highlightedIndex: 0,
      }),
    ).toEqual({ type: "complete", index: 0 });
  });
});

it.each(["ctrlKey", "metaKey"] as const)(
  "sends with %s+Enter while the picker is open",
  (modifier) => {
    expect(
      resolveMentionPickerKey({
        key: "Enter",
        [modifier]: true,
        optionCount: 2,
        highlightedIndex: 0,
        enterToSend: false,
      }),
    ).toEqual({ type: "send" });
  },
);
