import type {
  ComposerMention,
  ComposerMentionQuery,
  ComposerMentionRange,
} from "./composer-mentions.js";
import {
  COMPOSER_MENTION_KINDS,
  completeComposerMention,
  mentionChipKey,
} from "./composer-mentions.js";

export type ComposerMentionBinding = ComposerMentionRange & { mention: ComposerMention };
export type ComposerMentionEditHints = {
  /** Most recent native/pre-edit selection first. */
  before?: readonly ComposerMentionRange[];
  after?: ComposerMentionRange;
};

function validBinding(text: string, binding: ComposerMentionBinding): boolean {
  return (
    Number.isInteger(binding.start) &&
    Number.isInteger(binding.end) &&
    binding.start >= 0 &&
    binding.end <= text.length &&
    binding.end > binding.start &&
    text.slice(binding.start, binding.end) === `@${binding.mention.name}` &&
    !/[\p{L}\p{N}_-]$/u.test(text.slice(0, binding.start)) &&
    !/^[\p{L}\p{N}_-]/u.test(text.slice(binding.end))
  );
}

/** Restore only well-formed, non-overlapping bindings; never guess identity from names. */
export function validateComposerMentionBindings(
  text: string,
  value: unknown,
): ComposerMentionBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings: ComposerMentionBinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || !item.mention || typeof item.mention !== "object")
      continue;
    const source = item.mention;
    if (
      !COMPOSER_MENTION_KINDS.includes(source.kind) ||
      typeof source.id !== "string" ||
      !source.id ||
      typeof source.name !== "string" ||
      !source.name
    )
      continue;
    const mention: ComposerMention = { kind: source.kind, id: source.id, name: source.name };
    for (const key of ["subtitle", "color", "botId", "connectionId"] as const)
      if (typeof source[key] === "string") mention[key] = source[key];
    if (source.authStatus === "connected" || source.authStatus === "needs_auth")
      mention.authStatus = source.authStatus;
    const binding = { start: item.start, end: item.end, mention };
    if (validBinding(text, binding)) bindings.push(binding);
  }
  bindings.sort((a, b) => a.start - b.start);
  return bindings.filter(
    (binding, index) => index === 0 || binding.start >= bindings[index - 1]!.end,
  );
}

function editBetween(previous: string, next: string, hints: ComposerMentionEditHints) {
  const delta = next.length - previous.length;
  const candidate = (start: number, end: number) => {
    const length = delta + end - start;
    if (start < 0 || end < start || end > previous.length || length < 0) return null;
    if (previous.slice(0, start) + next.slice(start, start + length) + previous.slice(end) !== next)
      return null;
    return { start, end, length };
  };
  for (const before of hints.before ?? []) {
    if (before.start !== before.end) {
      const edit = candidate(before.start, before.end);
      if (edit) return edit;
    } else {
      const edits =
        delta < 0
          ? [
              candidate(before.start + delta, before.start),
              candidate(before.start, before.start - delta),
            ]
          : [candidate(before.start, before.end)];
      const after = hints.after;
      const aligned =
        after?.start === after?.end
          ? edits.find((edit) => edit && edit.start + edit.length === after?.start)
          : null;
      if (aligned) return aligned;
      const edit = edits.find((item) => item !== null);
      if (edit) return edit;
    }
  }
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < next.length - start &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  const minimal = { start, end: previous.length - suffix, length: next.length - suffix - start };
  const after = hints.after;
  if (after && after.start === after.end && after.start >= 0 && after.start <= next.length) {
    let tail = 0;
    while (
      tail < next.length - after.start &&
      tail < previous.length &&
      previous[previous.length - tail - 1] === next[next.length - tail - 1]
    )
      tail++;
    let prefix = 0;
    while (
      prefix < after.start &&
      prefix < previous.length - tail &&
      previous[prefix] === next[prefix]
    )
      prefix++;
    const aligned = candidate(prefix, previous.length - tail);
    if (
      aligned &&
      aligned.end - aligned.start + aligned.length === minimal.end - minimal.start + minimal.length
    )
      return aligned;
  }
  return minimal;
}

function mapEdit(
  bindings: readonly ComposerMentionBinding[],
  start: number,
  end: number,
  length: number,
  text: string,
): ComposerMentionBinding[] {
  const delta = length - (end - start);
  return bindings.flatMap((binding) => {
    if (binding.end <= start) return validBinding(text, binding) ? [binding] : [];
    if (binding.start >= end) {
      const shifted = { ...binding, start: binding.start + delta, end: binding.end + delta };
      return validBinding(text, shifted) ? [shifted] : [];
    }
    return [];
  });
}

/** Carry only untouched completed occurrences through one native text edit. */
export function updateComposerMentionBindings(
  previous: string,
  next: string,
  bindings: readonly ComposerMentionBinding[],
  hints: ComposerMentionEditHints = {},
): ComposerMentionBinding[] {
  if (previous === next) return bindings.filter((binding) => validBinding(next, binding));
  const edit = editBetween(previous, next, hints);
  return mapEdit(bindings, edit.start, edit.end, edit.length, next);
}

export function bindComposerMention(
  text: string,
  query: ComposerMentionQuery,
  mention: ComposerMention,
  bindings: readonly ComposerMentionBinding[],
) {
  const completion = completeComposerMention(text, query, mention);
  const length = completion.text.length - text.length + query.end - query.start;
  const retained = mapEdit(bindings, query.start, query.end, length, completion.text);
  const { ranges: _ranges, ...metadata } = mention;
  return {
    ...completion,
    bindings: [
      ...retained,
      { start: query.start, end: query.start + mention.name.length + 1, mention: metadata },
    ].sort((a, b) => a.start - b.start),
  };
}

export function composerSelectedMentions(
  bindings: readonly ComposerMentionBinding[],
): ComposerMention[] {
  const selected = new Map<string, ComposerMention>();
  for (const binding of bindings)
    if (!selected.has(mentionChipKey(binding.mention)))
      selected.set(mentionChipKey(binding.mention), binding.mention);
  return [...selected.values()];
}

/** Only action tokens need prompt offsets; bot routing remains deduplicated metadata. */
export function composerMentionsForPrompt(
  draft: string,
  skill: { name: string } | null,
  bindings: readonly ComposerMentionBinding[],
): ComposerMention[] {
  const offset = (skill ? skill.name.length + 2 : 0) - (draft.length - draft.trimStart().length);
  return composerSelectedMentions(bindings).map((mention) => {
    if (mention.kind === "bot" || mention.kind === "everyone") return mention;
    return {
      ...mention,
      ranges: bindings
        .filter((binding) => mentionChipKey(binding.mention) === mentionChipKey(mention))
        .map((binding) => ({ start: binding.start + offset, end: binding.end + offset })),
    };
  });
}

export type ComposerMentionSegment = { text: string; binding?: ComposerMentionBinding };

export function composerMentionSegments(
  text: string,
  bindings: readonly ComposerMentionBinding[],
): ComposerMentionSegment[] {
  const segments: ComposerMentionSegment[] = [];
  let index = 0;
  for (const binding of bindings) {
    if (binding.start < index) continue;
    if (binding.start > index) segments.push({ text: text.slice(index, binding.start) });
    segments.push({ text: text.slice(binding.start, binding.end), binding });
    index = binding.end;
  }
  if (index < text.length) segments.push({ text: text.slice(index) });
  return segments;
}

export function composerMentionDeletionRange(
  bindings: readonly ComposerMentionBinding[],
  range: ComposerMentionRange,
): ComposerMentionRange | null {
  let { start, end } = range;
  for (const binding of bindings) {
    if (binding.start >= range.end || binding.end <= range.start) continue;
    start = Math.min(start, binding.start);
    end = Math.max(end, binding.end);
  }
  return start === range.start && end === range.end ? null : { start, end };
}

export function resolveComposerMentionEdit(
  previous: string,
  next: string,
  bindings: readonly ComposerMentionBinding[],
  hints: ComposerMentionEditHints = {},
): { text: string; bindings: ComposerMentionBinding[]; caret: number | null } {
  const edit = next.length < previous.length ? editBetween(previous, next, hints) : null;
  const mention =
    edit?.length === 0
      ? composerMentionDeletionRange(bindings, { start: edit.start, end: edit.end })
      : null;
  if (!mention)
    return {
      text: next,
      bindings: updateComposerMentionBindings(previous, next, bindings, hints),
      caret: null,
    };
  const text = previous.slice(0, mention.start) + previous.slice(mention.end);
  return {
    text,
    bindings: mapEdit(bindings, mention.start, mention.end, 0, text),
    caret: mention.start,
  };
}

/**
 * Two-step delete for the mobile composer. A backspace right after a mention, or right after the
 * space that follows it, keeps the text and selects the mention; the next one removes it together
 * with that space. `selected` is the start of the mention that is currently selected, if any.
 */
export function resolveComposerMentionBackspace(
  previous: string,
  next: string,
  bindings: readonly ComposerMentionBinding[],
  hints: ComposerMentionEditHints,
  selected: number | null,
): {
  text: string;
  bindings: ComposerMentionBinding[];
  caret: number;
  selected: number | null;
} | null {
  if (next.length !== previous.length - 1) return null;
  const edit = editBetween(previous, next, hints);
  if (edit.length !== 0 || edit.end - edit.start !== 1) return null;
  // A forward delete removes the character after the caret; only a backspace selects a mention.
  if (!hints.before?.some((caret) => caret.start === caret.end && caret.start === edit.end))
    return null;
  const binding = bindings.find(
    (candidate) =>
      edit.end === candidate.end ||
      (edit.end === candidate.end + 1 && previous[candidate.end] === " "),
  );
  if (!binding) return null;
  if (selected !== binding.start) {
    return { text: previous, bindings: [...bindings], caret: edit.end, selected: binding.start };
  }
  const end = previous[binding.end] === " " ? binding.end + 1 : binding.end;
  const text = previous.slice(0, binding.start) + previous.slice(end);
  return {
    text,
    bindings: mapEdit(bindings, binding.start, end, 0, text),
    caret: binding.start,
    selected: null,
  };
}
