import type { BotAvatarSet, Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import type { CronLabels } from "./cron.js";
import { ENGLISH_CRON_LABELS, formatCron } from "./cron.js";
import { displayName } from "./display-name.js";

export const COMPOSER_MENTION_KINDS = ["bot", "group", "routine", "connector", "everyone"] as const;

export type ComposerMentionKind = (typeof COMPOSER_MENTION_KINDS)[number];

export type ComposerMentionRange = { start: number; end: number };

/** Chip selected in the composer `@` picker. */
export type ComposerMention = {
  kind: ComposerMentionKind;
  id: string;
  name: string;
  /** Exact prompt occurrences for client-side action-token cleanup. */
  ranges?: ComposerMentionRange[];
  subtitle?: string;
  color?: string;
  avatarSet?: BotAvatarSet;
  /** Owning bot for routine chips (test-run lands on that bot). */
  botId?: string;
  /** Connected connection row id when kind is connector + connected. */
  connectionId?: string;
  authStatus?: "connected" | "needs_auth";
};

export type MentionPickerBot = {
  id: string;
  name: string;
  color?: string;
  avatarSet?: BotAvatarSet;
};
export type MentionPickerGroup = { id: string; name: string };
export type MentionPickerRoutine = {
  id: string;
  name: string;
  crons: string[];
  botId: string;
  botName?: string;
};
export type MentionPickerConnector = {
  id: string;
  name: string;
  authStatus: "connected" | "needs_auth";
  connectionId?: string;
};

/**
 * Connected apps first, then catalog apps the user could still connect. A catalog
 * entry already covered by a connected row (same provider or name) is skipped.
 */
export function mentionConnectorsFrom(
  connections: readonly Pick<Connection, "id" | "displayName" | "provider" | "status">[],
  catalog: readonly Pick<
    ConnectionCatalogItem,
    "connectorId" | "slug" | "name" | "connected" | "noAuth"
  >[],
): MentionPickerConnector[] {
  const connected = connections.filter((row) => row.status === "connected");
  const options: MentionPickerConnector[] = connected.map((row) => ({
    id: row.id,
    name: row.displayName,
    authStatus: "connected",
    connectionId: row.id,
  }));
  for (const item of catalog) {
    if (item.connected || item.noAuth) continue;
    const covered = connected.some(
      (row) =>
        row.provider.toLowerCase() === item.slug.toLowerCase() ||
        row.displayName.toLowerCase() === item.name.toLowerCase(),
    );
    if (covered) continue;
    options.push({
      id: `catalog:${item.connectorId}:${item.slug}`,
      name: item.name,
      authStatus: "needs_auth",
    });
  }
  return options;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionChipKey(mention: Pick<ComposerMention, "kind" | "id">): string {
  return `${mention.kind}:${mention.id}`;
}

type MentionName = { name: string };

/** Recognize each full mention once, so a name is not also its shorter prefix. */
function composerMentionSpans(text: string, mentions: readonly MentionName[]) {
  const names = [...new Set(mentions.map((mention) => mention.name.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return [];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_-])@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
    "giu",
  );
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[1]!.toLowerCase(),
  }));
}

/** The active @query at a collapsed caret, including its full recognized name. */
export type ComposerMentionQuery = { start: number; end: number; query: string };

export function composerMentionQuery(
  text: string,
  selectionStart = text.length,
  selectionEnd = selectionStart,
  knownMentions: readonly MentionName[] = [],
  bindings: readonly (ComposerMentionRange & { mention: MentionName })[] = [],
): ComposerMentionQuery | null {
  if (selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > text.length)
    return null;
  const bound = bindings.find((span) => selectionStart > span.start && selectionStart <= span.end);
  if (bound)
    return {
      start: bound.start,
      end: bound.end,
      query: text.slice(bound.start + 1, selectionStart),
    };
  const recognized = composerMentionSpans(text, knownMentions).find(
    (span) => selectionStart > span.start && selectionStart <= span.end,
  );
  if (recognized) return { ...recognized, query: text.slice(recognized.start + 1, selectionStart) };
  const match = /(?:^|\s)@((?:[\p{L}\p{M}\p{N}_\u200c\u30fb-]|\u200d)*)$/u.exec(
    text.slice(0, selectionStart),
  );
  if (!match) return null;
  const query = match[1] ?? "";
  const start = selectionStart - query.length - 1;
  const rest =
    /^(?:[\p{L}\p{M}\p{N}_\u200c\u30fb-]|\u200d)*/u.exec(text.slice(selectionStart))?.[0] ?? "";
  // CJK prose need not have spaces. Extend into it only as far as a known name matches.
  const cjk = rest.search(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  );
  if (cjk < 0) return { start, end: selectionStart + rest.length, query };
  let end = selectionStart + cjk;
  const typed = text.slice(start + 1, selectionStart + rest.length);
  for (const { name } of knownMentions) {
    const candidate = name.trim();
    let matched = 0;
    for (const character of typed) {
      if (
        candidate.slice(matched, matched + character.length).toLowerCase() !==
        character.toLowerCase()
      )
        break;
      matched += character.length;
    }
    if (matched >= query.length) end = Math.max(end, start + 1 + matched);
  }
  return { start, end, query };
}

function pickerWords(value: string): string[] {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Picker order for a typed query: every query word must appear in the name, a word that starts
 * a name word counts more than one inside it, and ties keep the given order. `everyone` also
 * answers to `all`. An empty query keeps every target in order.
 */
export function filterComposerMentionTargets<T extends Pick<ComposerMention, "kind" | "name">>(
  targets: readonly T[],
  query: string,
): T[] {
  const words = pickerWords(query);
  if (words.length === 0) return [...targets];
  const scored = targets.flatMap((target, index) => {
    const nameWords = pickerWords(target.name);
    const name = nameWords.join(" ");
    let score = 0;
    for (const word of words) {
      if (
        target.kind === "everyone" &&
        ["everyone", "all"].some((alias) => alias.startsWith(word))
      ) {
        score += 2;
      } else if (nameWords.some((nameWord) => nameWord.startsWith(word))) {
        score += 2;
      } else if (name.includes(word)) {
        score += 1;
      } else {
        return [];
      }
    }
    return [{ target, index, score }];
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ target }) => target);
}

/** A sent message's text cut into plain runs and the `@Name` runs that name a known target. */
export type MentionTextPart<T> = { text: string; target?: T };

export function splitMentionText<T extends MentionName>(
  text: string,
  targets: readonly T[],
): MentionTextPart<T>[] {
  const spans = composerMentionSpans(text, targets);
  if (spans.length === 0) return [{ text }];
  const parts: MentionTextPart<T>[] = [];
  let index = 0;
  for (const span of spans) {
    const target = targets.find((candidate) => candidate.name.trim().toLowerCase() === span.name);
    if (!target) continue;
    if (span.start > index) parts.push({ text: text.slice(index, span.start) });
    parts.push({ text: text.slice(span.start, span.end), target });
    index = span.end;
  }
  if (index < text.length) parts.push({ text: text.slice(index) });
  return parts;
}

export function completeComposerMention(
  text: string,
  query: ComposerMentionQuery,
  mention: MentionName,
): { text: string; caret: number } {
  const suffix = text.slice(query.end);
  const token = `@${mention.name}`;
  const separator = suffix.length === 0 ? " " : "";
  return {
    text: `${text.slice(0, query.start)}${token}${separator}${suffix}`,
    caret: query.start + token.length + (separator || suffix.startsWith(" ") ? 1 : 0),
  };
}

/** Remove selected full tokens without rewriting surrounding text or whitespace. */
export function removeComposerMention(
  text: string,
  mention: MentionName,
  knownMentions: readonly MentionName[] = [],
): string {
  const spans = composerMentionSpans(text, [...knownMentions, mention]);
  let result = text;
  for (const span of spans.reverse()) {
    if (span.name === mention.name.trim().toLowerCase()) {
      result = result.slice(0, span.start) + result.slice(span.end);
    }
  }
  return result;
}

export function stripMentionToken(
  text: string,
  mentionName: string,
  knownMentions: readonly MentionName[] = [],
): string {
  const normalized = mentionName.trim();
  if (!normalized) return text.trim();
  return removeComposerMention(text, { name: normalized }, knownMentions)
    .replace(/[^\S\n]+/g, " ")
    .replace(/[^\S\n]*\n/g, "\n")
    .trim();
}

export function stripMentionKinds(
  text: string,
  mentions: readonly Pick<ComposerMention, "kind" | "name" | "ranges">[],
  kinds: readonly ComposerMentionKind[],
): string {
  const ranges = mentions
    .filter((mention) => kinds.includes(mention.kind))
    .flatMap((mention) =>
      (mention.ranges ?? []).filter(
        (range) =>
          Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          range.start >= 0 &&
          range.end <= text.length &&
          text.slice(range.start, range.end) === `@${mention.name}`,
      ),
    )
    .sort((a, b) => b.start - a.start);
  let result = text;
  let previousStart = text.length;
  for (const range of ranges) {
    if (range.end > previousStart) continue;
    result = result.slice(0, range.start) + result.slice(range.end);
    previousStart = range.start;
  }
  for (const mention of mentions) {
    if (kinds.includes(mention.kind) && mention.ranges === undefined) {
      result = stripMentionToken(result, mention.name, mentions);
    }
  }
  if (ranges.length) result = result.replace(/[^\S\n]+/g, " ").replace(/[^\S\n]*\n/g, "\n");
  return result.trim();
}

export function partitionComposerMentions(mentions: readonly ComposerMention[]) {
  const bots: ComposerMention[] = [];
  const groups: ComposerMention[] = [];
  const routines: ComposerMention[] = [];
  const connectors: ComposerMention[] = [];
  let everyone = false;
  for (const mention of mentions) {
    if (mention.kind === "bot") bots.push(mention);
    else if (mention.kind === "group") groups.push(mention);
    else if (mention.kind === "routine") routines.push(mention);
    else if (mention.kind === "connector") connectors.push(mention);
    else if (mention.kind === "everyone") everyone = true;
  }
  return { bots, groups, routines, connectors, everyone };
}

/** Payload entries for `threads/send` mentions (legacy bare bot ids still accepted). */
export function toThreadMentionPayload(
  mentions: readonly ComposerMention[],
): Array<string | { kind: "bot" | "group" | "routine" | "connector"; id: string }> {
  const payload: Array<string | { kind: "bot" | "group" | "routine" | "connector"; id: string }> =
    [];
  for (const mention of mentions) {
    if (mention.kind === "everyone") continue;
    if (mention.kind === "bot") {
      payload.push({ kind: "bot", id: mention.id });
      continue;
    }
    if (mention.kind === "group") {
      payload.push({ kind: "group", id: mention.id });
      continue;
    }
    if (mention.kind === "routine") {
      payload.push({ kind: "routine", id: mention.id });
      continue;
    }
    if (mention.kind === "connector") {
      const connectionId = mention.connectionId ?? mention.id;
      if (mention.authStatus === "needs_auth" && !mention.connectionId) continue;
      if (!connectionId || connectionId.startsWith("catalog:")) continue;
      payload.push({ kind: "connector", id: connectionId });
    }
  }
  return payload;
}

export function connectorIntentLine(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  return `Use these connectors if relevant: ${unique.join(", ")}.`;
}

/** Names that need a client-side connector line (not yet a owned connection row). */
export function needsAuthConnectorNames(mentions: readonly ComposerMention[]): string[] {
  return mentions
    .filter((mention) => mention.kind === "connector" && mention.authStatus === "needs_auth")
    .map((mention) => mention.name);
}

export function appendConnectorIntent(text: string, names: readonly string[]): string {
  const line = connectorIntentLine(names);
  if (!line) return text.trim();
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n\n${line}` : line;
}

export function routineScheduleSubtitle(
  crons: readonly string[],
  botName?: string,
  labels: CronLabels = ENGLISH_CRON_LABELS,
): string {
  const schedule = crons.map((cron) => formatCron(cron, labels)).join(", ");
  const name = displayName(botName, "");
  if (name) return `${schedule} (${name})`;
  return schedule;
}

export function buildComposerMentionOptions(input: {
  query: string;
  bots: readonly MentionPickerBot[];
  groups: readonly MentionPickerGroup[];
  routines: readonly MentionPickerRoutine[];
  connectors: readonly MentionPickerConnector[];
  currentGroupId?: string | null;
  includeEveryone?: boolean;
  /** Localized schedule words for routine subtitles; English when omitted. */
  cronLabels?: CronLabels;
  /** When omitted, return every match (catalog build). When set, apply after query filter. */
  limit?: number;
}): ComposerMention[] {
  const query = input.query.trim().toLowerCase();
  const options: ComposerMention[] = [];

  const matches = (name: string) => !query || name.toLowerCase().startsWith(query);

  if (input.includeEveryone && matches("everyone")) {
    options.push({
      kind: "everyone",
      id: "everyone",
      name: "everyone",
      subtitle: "Everyone in this group",
      color: "#85858A",
    });
  }

  for (const bot of input.bots) {
    const name = displayName(bot.name, "Bot");
    if (!matches(name)) continue;
    options.push({
      kind: "bot",
      id: bot.id,
      name,
      subtitle: "Bot",
      color: bot.color,
      avatarSet: bot.avatarSet,
    });
  }

  for (const group of input.groups) {
    if (input.currentGroupId && group.id === input.currentGroupId) continue;
    const name = displayName(group.name, "Group");
    if (!matches(name)) continue;
    options.push({
      kind: "group",
      id: group.id,
      name,
      subtitle: "Group",
    });
  }

  const routineNameCounts = new Map<string, number>();
  for (const routine of input.routines) {
    const key = displayName(routine.name, "Routine").toLowerCase();
    routineNameCounts.set(key, (routineNameCounts.get(key) ?? 0) + 1);
  }
  for (const routine of input.routines) {
    const name = displayName(routine.name, "Routine");
    if (!matches(name)) continue;
    const duplicate = (routineNameCounts.get(name.toLowerCase()) ?? 0) > 1;
    options.push({
      kind: "routine",
      id: routine.id,
      name,
      botId: routine.botId,
      subtitle: routineScheduleSubtitle(
        routine.crons,
        duplicate ? routine.botName : undefined,
        input.cronLabels,
      ),
    });
  }

  for (const connector of input.connectors) {
    if (!matches(connector.name)) continue;
    options.push({
      kind: "connector",
      id: connector.id,
      name: connector.name,
      connectionId: connector.connectionId,
      authStatus: connector.authStatus,
      subtitle: connector.authStatus === "connected" ? "Connected" : "Needs auth",
    });
  }

  if (input.limit == null) return options;
  return options.slice(0, input.limit);
}

/**
 * Shared send routing for web + mobile composers.
 * Chip-only `@Group` opens that group (no fabricated body), including from
 * another group thread. Routines always test-run; with a group chip, open after.
 * Callers should omit the current group from the picker (`currentGroupId`).
 */
export function resolveComposerSendPlan(input: {
  text: string;
  mentions: readonly ComposerMention[];
  hasAttachments: boolean;
}): {
  trimmed: string;
  routineIds: string[];
  rerouteGroupId: string | null;
  rerouteGroupName: string | null;
  mentionPayload: ReturnType<typeof toThreadMentionPayload>;
  shouldSend: boolean;
  shouldOpenGroup: boolean;
  shouldRunRoutines: boolean;
  isNoOp: boolean;
} {
  const parts = partitionComposerMentions(input.mentions);
  const mentionedGroup = parts.groups[0];
  let trimmed = stripMentionKinds(input.text, input.mentions, ["group", "routine", "connector"]);
  trimmed = appendConnectorIntent(trimmed, needsAuthConnectorNames(input.mentions));
  if (!trimmed && parts.connectors.length) {
    trimmed = parts.connectors.map((mention) => `@${mention.name}`).join(" ");
  }
  const routineIds = [...new Set(parts.routines.map((routine) => routine.id))];
  const shouldSend = Boolean(trimmed) || input.hasAttachments;
  const shouldOpenGroup = Boolean(mentionedGroup);
  const shouldRunRoutines = routineIds.length > 0;
  return {
    trimmed,
    routineIds,
    rerouteGroupId: mentionedGroup?.id ?? null,
    rerouteGroupName: mentionedGroup?.name ?? null,
    mentionPayload: toThreadMentionPayload(
      input.mentions.filter((mention) => mention.kind !== "group" && mention.kind !== "routine"),
    ),
    shouldSend,
    shouldOpenGroup,
    shouldRunRoutines,
    isNoOp: !shouldSend && !shouldOpenGroup && !shouldRunRoutines,
  };
}
