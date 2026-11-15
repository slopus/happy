export type MentionPickerKeyAction =
  | { type: "complete"; index: number }
  | { type: "move"; index: number }
  | { type: "dismiss" }
  | { type: "send" }
  | { type: "none" };

/** Wrap highlight within `[0, count)`. Returns `0` when the list is empty. */
export function wrapMentionHighlightIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

/** Keep a stored highlight valid after the option list shrinks or grows. */
export function clampMentionHighlightIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * Resolve composer key handling while (or after) the mention picker is open.
 * When `optionCount` is 0 the picker is closed or empty: Enter sends (unless Shift),
 * or unless `enterToSend` is false — then plain Enter inserts a newline and only
 * Ctrl/Cmd+Enter sends (handy on touch keyboards, where Shift is one-shot).
 * While IME composition is active, returns `none` so Enter confirms text instead.
 */
export function resolveMentionPickerKey(input: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  optionCount: number;
  highlightedIndex: number;
  /** When false, plain Enter inserts a newline; Ctrl/Cmd+Enter still sends. Defaults to true. */
  enterToSend?: boolean;
}): MentionPickerKeyAction {
  if (input.isComposing) return { type: "none" };

  const {
    key,
    shiftKey = false,
    ctrlKey = false,
    metaKey = false,
    optionCount,
    enterToSend = true,
  } = input;
  const highlightedIndex = clampMentionHighlightIndex(input.highlightedIndex, optionCount);

  if (key === "Enter" && !shiftKey && (ctrlKey || metaKey)) return { type: "send" };

  if (optionCount > 0) {
    if (key === "ArrowDown") {
      return { type: "move", index: wrapMentionHighlightIndex(highlightedIndex + 1, optionCount) };
    }
    if (key === "ArrowUp") {
      return { type: "move", index: wrapMentionHighlightIndex(highlightedIndex - 1, optionCount) };
    }
    if (key === "Enter" && !shiftKey) {
      return { type: "complete", index: highlightedIndex };
    }
    if (key === "Tab") {
      return { type: "complete", index: highlightedIndex };
    }
    if (key === "Escape") {
      return { type: "dismiss" };
    }
    return { type: "none" };
  }

  if (key === "Enter" && !shiftKey) {
    if (!enterToSend && !ctrlKey && !metaKey) return { type: "none" };
    return { type: "send" };
  }
  return { type: "none" };
}
