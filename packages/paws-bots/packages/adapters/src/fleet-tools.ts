import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor, Group, MessageBlock } from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BotSectionName,
  CreateGroupInput,
  CreateRoutineInput,
  canonicalPiProviderId,
  FLEET_WRITE_TOOL_NAMES,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  isAttachmentImageMimeType,
  ThinkingLevelSchema,
  TimeZoneSchema,
  UpdateGroupInput,
} from "@rakazo/contracts";
import { CARD_TITLE_ESCAPED_CHARACTERS, ONCE_ROUTINE_CRON, redactSecrets } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  commitBotUpdate,
  createGroupRepos,
  createRepos,
  InstructionConflictError,
  IsolationError,
  isRecordNotFound,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { FleetCardSummary } from "./approval-ask.js";
import { approvalDetailLength, MAX_APPROVAL_SUMMARY_LENGTH } from "./approval-ask.js";
import { attachedImageArtifactIds, resolveUpdateBotAvatar } from "./bot-avatar.js";
import { createdByWhere, managedBotsWhere } from "./child-bots.js";
import { stopCancelledGroupRuns } from "./computer-idle.js";
import { asRecord } from "./connector-http.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { resolveModelChoice } from "./model-choice.js";
import type { BotModelChangeDeps } from "./model-selection.js";
import { validateBotModelChange } from "./model-selection.js";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import type { ScheduleToolDeps } from "./schedule-tools.js";
import {
  compactScheduleInput,
  createScheduleFromTool,
  isScheduleValueProvided,
  resolveScheduleTiming,
  scheduleTimingArgs,
  userTimeZone,
} from "./schedule-tools.js";
import type { UpdateBotPatch } from "./update-bot-patch.js";
import { argumentGiven, parseUpdateBotPatch } from "./update-bot-patch.js";

/** The fleet writes resolved up front so an approval card can show what will run. */
export type FleetApprovalToolName = Exclude<
  (typeof FLEET_WRITE_TOOL_NAMES)[number],
  "organize_bot"
>;

export function isFleetApprovalTool(name: string): name is FleetApprovalToolName {
  return name !== "organize_bot" && (FLEET_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/** All scope comes from the run; no tool argument may name a space or user. */
export type FleetRun = {
  spaceId: string;
  userId: string;
  botId: string;
  groupId: string | null;
  /** The thread the run is in; fleet events for the caller land here. */
  threadId: string;
  runId: string;
};

export type FleetDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append" | "notify">;
  jobs: Pick<JobPublisher, "cancel">;
};

export type FleetPrepareDeps = {
  prisma: PrismaClient;
  modelChange: Omit<BotModelChangeDeps, "prisma">;
};

export type FleetPrepared =
  | { ok: true; canonical: Record<string, unknown>; summary: FleetCardSummary }
  | { ok: false; error: string };

type Member = { id: string; name: string };
type Refusal = { ok: false; error: string };

const GROUP_SIZE_ERROR = `A group needs ${GROUP_MEMBER_MIN} to ${GROUP_MEMBER_MAX} bots.`;

/**
 * Resolve everything the model could vary before the effect is recorded. The canonical request
 * is what the card shows, what the effect stores and what replay runs, so a rename or a
 * membership change while the card waits cannot change what was approved.
 */
export async function prepareFleetRequest(
  deps: FleetPrepareDeps,
  run: FleetRun,
  name: FleetApprovalToolName,
  args: Record<string, unknown>,
  secrets: readonly string[] = [],
): Promise<FleetPrepared> {
  const prepared = await prepareByTool(deps, run, name, args, secrets);
  // The card must show the whole request as rendered, after redaction; one that would be cut off
  // is refused instead.
  if (
    prepared.ok &&
    (redactSecrets(prepared.summary.title, [...secrets]).length > MAX_APPROVAL_SUMMARY_LENGTH ||
      redactSecrets(prepared.summary.lines.join("\n"), [...secrets]).length >
        approvalDetailLength(name))
  ) {
    return refuse("This request is too long to show on the approval card. Shorten it.");
  }
  return prepared;
}

function prepareByTool(
  deps: FleetPrepareDeps,
  run: FleetRun,
  name: FleetApprovalToolName,
  args: Record<string, unknown>,
  secrets: readonly string[],
): Promise<FleetPrepared> {
  switch (name) {
    case "create_group":
      return prepareCreateGroup(deps, run, args, secrets);
    case "update_group":
      return prepareUpdateGroup(deps, run, args, secrets);
    case "set_child_instructions":
      return prepareChildInstructions(deps, run, args, secrets);
    case "set_child_bot_model":
      return prepareChildModel(deps, run, args);
    case "create_child_routine":
      return prepareChildRoutine(deps, run, args, secrets);
  }
}

async function prepareCreateGroup(
  deps: FleetPrepareDeps,
  run: FleetRun,
  args: Record<string, unknown>,
  secrets: readonly string[],
): Promise<FleetPrepared> {
  const ids = stringList(args.bot_ids, "bot_ids");
  if (!Array.isArray(ids)) return ids;
  const names = stringList(args.bot_names, "bot_names");
  if (!Array.isArray(names)) return names;
  if (ids.length && names.length) return refuse("Pass bot_ids or bot_names, not both.");
  const requested = ids.length ? ids : names;
  if (new Set(requested).size !== requested.length) {
    return refuse("Each bot can be in the group only once.");
  }
  if (requested.length < GROUP_MEMBER_MIN || requested.length > GROUP_MEMBER_MAX) {
    return refuse(GROUP_SIZE_ERROR);
  }
  const members = await resolveBots(deps.prisma, run, { ids, names });
  if ("error" in members) return members;
  const groupName = singleLine(text(args.name) ?? "");
  const credential = credentialField({ name: groupName }, secrets);
  if (credential) return refuse(credential);
  const parsed = CreateGroupInput.safeParse({
    name: groupName,
    botIds: members.map((member) => member.id),
  });
  if (!parsed.success) return refuse(issueMessage(parsed.error));
  return {
    ok: true,
    canonical: { name: parsed.data.name, botIds: parsed.data.botIds, members },
    summary: {
      title: `Create group “${cardName(parsed.data.name)}”?`,
      lines: [`Members: ${memberNames(members)}`],
    },
  };
}

async function prepareUpdateGroup(
  deps: FleetPrepareDeps,
  run: FleetRun,
  args: Record<string, unknown>,
  secrets: readonly string[],
): Promise<FleetPrepared> {
  const group = await resolveGroup(deps.prisma, run, args);
  if ("error" in group) return group;
  const current: Member[] = group.members
    .filter((member) => member.bot.archivedAt === null)
    .map((member) => ({ id: member.botId, name: member.bot.name }));
  const currentIds = new Set(current.map((member) => member.id));

  const removeIds = stringList(args.remove_bot_ids, "remove_bot_ids");
  if (!Array.isArray(removeIds)) return removeIds;
  const requestedAdds = stringList(args.add_bot_ids, "add_bot_ids");
  if (!Array.isArray(requestedAdds)) return requestedAdds;
  const removed = current.filter((member) => removeIds.includes(member.id));
  const notMember = removeIds.find((id) => !currentIds.has(id));
  if (notMember) return refuse(`Bot "${notMember}" is not in group "${singleLine(group.name)}".`);
  if (run.groupId === group.id && removeIds.includes(run.botId)) {
    return refuse("You cannot remove yourself from the group you are running in.");
  }

  const addIds = requestedAdds.filter((id) => !currentIds.has(id));
  const added = addIds.length ? await resolveBots(deps.prisma, run, { ids: addIds }) : [];
  if ("error" in added) return added;

  const typedName = text(args.name);
  const nextName = typedName === undefined ? undefined : singleLine(typedName);
  const credential = credentialField({ name: nextName }, secrets);
  if (credential) return refuse(credential);
  const renamed = nextName !== undefined && nextName !== group.name;
  if (!renamed && !added.length && !removed.length) return refuse("Nothing to change.");

  const next = [...current.filter((member) => !removeIds.includes(member.id)), ...added];
  if (next.length < GROUP_MEMBER_MIN || next.length > GROUP_MEMBER_MAX) {
    return refuse(GROUP_SIZE_ERROR);
  }
  const membershipChanged = added.length > 0 || removed.length > 0;
  const parsed = UpdateGroupInput.safeParse({
    groupId: group.id,
    ...(renamed ? { name: nextName } : {}),
    ...(membershipChanged ? { botIds: next.map((member) => member.id) } : {}),
    expectedBotIds: current.map((member) => member.id),
  });
  if (!parsed.success) return refuse(issueMessage(parsed.error));

  const lines: string[] = [];
  if (parsed.data.name !== undefined) lines.push(`Rename to “${singleLine(parsed.data.name)}”`);
  if (added.length) lines.push(`Add: ${memberNames(added)}`);
  if (removed.length) lines.push(`Remove: ${memberNames(removed)}`);
  return {
    ok: true,
    canonical: {
      groupId: group.id,
      groupName: group.name,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      expectedBotIds: parsed.data.expectedBotIds ?? [],
      ...(parsed.data.botIds ? { botIds: parsed.data.botIds } : {}),
      added,
      removed,
    },
    summary: { title: `Update group “${cardName(group.name)}”?`, lines },
  };
}

async function prepareChildModel(
  deps: FleetPrepareDeps,
  run: FleetRun,
  args: Record<string, unknown>,
): Promise<FleetPrepared> {
  const provider = text(args.provider);
  const model = text(args.model);
  const thinkingLevel = text(args.thinking_level);
  const clear = args.clear === true;
  if (clear && (provider || model)) {
    return refuse("Pass either clear: true or model, not both.");
  }
  if (!clear && !model) return refuse("Pass model, or clear: true.");
  // A model without catalog levels skips the shared check, so the level must be a real one first.
  if (thinkingLevel && !ThinkingLevelSchema.safeParse(thinkingLevel).success) {
    return refuse(`Thinking level must be one of: ${ThinkingLevelSchema.options.join(", ")}`);
  }

  const child = await resolveBot(deps.prisma, run, args);
  if ("error" in child) return child;
  const previous = {
    provider: child.modelProvider,
    model: child.modelId,
    thinkingLevel: child.thinkingLevel ?? null,
  };
  const chosen = model
    ? await resolveModelChoice({ prisma: deps.prisma, ...deps.modelChange }, run, {
        model,
        provider,
        preferredProvider: child.modelProvider,
      })
    : undefined;
  if (chosen && !chosen.ok) return refuse(chosen.error);
  const validated = await validateBotModelChange(
    { prisma: deps.prisma, ...deps.modelChange },
    {
      userId: run.userId,
      spaceId: run.spaceId,
      provider: chosen?.provider ?? null,
      model: chosen?.model ?? null,
      thinkingLevel: thinkingLevel ?? null,
      current: previous,
    },
  );
  if (!validated.ok) return refuse(validated.error);
  // Leaving the level out resets it to the default, so that is a change when one was set.
  if (
    validated.provider === previous.provider &&
    validated.model === previous.model &&
    (thinkingLevel ?? null) === previous.thinkingLevel
  ) {
    return refuse("That bot already uses this model.");
  }
  const lines = [
    `From: ${modelLabel(previous.provider, previous.model)}`,
    `To: ${modelLabel(validated.provider, validated.model)}`,
  ];
  if (thinkingLevel) lines.push(`Thinking: ${thinkingLevel}`);
  // The change resets a level the owner set; the card says so.
  else if (child.thinkingLevel) lines.push("Thinking: Default");
  return {
    ok: true,
    canonical: {
      botId: child.id,
      botName: child.name,
      previous,
      provider: validated.provider,
      model: validated.model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    summary: { title: `Change the model of ${cardName(child.name)}?`, lines },
  };
}

async function prepareChildRoutine(
  deps: FleetPrepareDeps,
  run: FleetRun,
  args: Record<string, unknown>,
  secrets: readonly string[],
): Promise<FleetPrepared> {
  const typedName = text(args.name);
  const name = typedName === undefined ? undefined : singleLine(typedName);
  // Collapse blank-line padding so the stored prompt and the card read the same.
  const prompt = text(args.prompt)?.replace(/\n\s*\n(\s*\n)+/g, "\n\n");
  if (!name) return refuse("name is required.");
  if (!prompt) return refuse("prompt is required.");
  const credential = credentialField({ name, prompt }, secrets);
  if (credential) return refuse(credential);
  const hidden = invisibleField({ prompt });
  if (hidden) return refuse(hidden);
  const namedRoutine = CreateRoutineInput.shape.name.safeParse(name);
  if (!namedRoutine.success) return refuse(`name: ${issueMessage(namedRoutine.error)}`);
  const namedTimezone = text(args.timezone);
  const timezone = namedTimezone ?? (await userTimeZone(deps.prisma, run.userId));
  if (!TimeZoneSchema.safeParse(timezone).success) {
    return refuse(`Unknown timezone "${timezone}". Use an IANA name like Europe/Paris.`);
  }
  const resolved = resolveScheduleTiming(compactScheduleInput(scheduleTimingArgs(args)), timezone);
  if (!resolved.ok) return refuse(resolved.error);

  const child = await resolveBot(deps.prisma, run, args);
  if ("error" in child) return child;
  if (!child.thread) return refuse("That bot has no thread.");

  const when = formatTime(resolved.nextRunAt, timezone);
  return {
    ok: true,
    canonical: {
      botId: child.id,
      botName: child.name,
      threadId: child.thread.id,
      name,
      prompt,
      timezone,
      // A zone the bot did not name is the account's, re-read when the approved routine
      // is created, so a zone change between approval and creation does not strand the
      // routine in the old zone.
      ...(namedTimezone === undefined ? { timezoneFromAccount: true } : {}),
      // A one-shot keeps its absolute time so a delay is not measured again at approval,
      // and a delayed repeat keeps its first run.
      schedule: resolved.oneShot
        ? { runAt: resolved.nextRunAt.toISOString() }
        : {
            cron: resolved.cron,
            ...(isScheduleValueProvided(args.startAt)
              ? { startAt: resolved.nextRunAt.toISOString() }
              : {}),
          },
    },
    summary: {
      title: `Schedule “${cardName(name)}” for ${cardName(child.name)}?`,
      lines: [
        resolved.oneShot
          ? `Runs at ${when}`
          : `Repeats ${singleLine(resolved.cron)}, next at ${when}`,
        `Prompt: ${prompt}`,
      ],
    },
  };
}

async function prepareChildInstructions(
  deps: FleetPrepareDeps,
  run: FleetRun,
  args: Record<string, unknown>,
  secrets: readonly string[],
): Promise<FleetPrepared> {
  const instructions = text(args.instructions) ? (args.instructions as string) : undefined;
  const expectedVersion = text(args.expected_version);
  if (instructions === undefined) return refuse("instructions is required.");
  if (!expectedVersion) return refuse("Pass expected_version from list_fleet.");
  if (instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    return refuse(`instructions must be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters.`);
  }
  const credential = credentialField({ instructions }, secrets);
  if (credential) return refuse(credential);
  const hidden = invisibleField({ instructions });
  if (hidden) return refuse(hidden);
  const child = await resolveBot(deps.prisma, run, args);
  if ("error" in child) return child;
  if (!child.thread) return refuse(NOT_FOUND);
  // Checked before the card too, so a second edit never asks the owner for nothing.
  if (await wroteInstructionsThisRun(deps.prisma, run, child.id)) {
    return refuse(ALREADY_WROTE_INSTRUCTIONS);
  }
  const current = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: child.id },
    select: { instructions: true, instructionHistory: true },
  });
  if (instructionsVersionOf(current) !== expectedVersion) return refuse(CHILD_CHANGED);
  return {
    ok: true,
    canonical: {
      botId: child.id,
      botName: child.name,
      instructions,
      expectedVersion,
      previousLength: current.instructions.length,
      length: instructions.length,
    },
    summary: {
      title: `Replace the instructions of ${cardName(child.name)}?`,
      lines: [
        `Old length: ${current.instructions.length} characters`,
        `New length: ${instructions.length} characters`,
        "",
        instructions,
      ],
    },
  };
}

const FLEET_BOT_LIMIT = 200;
const FLEET_GROUP_LIMIT = 100;
const FLEET_SECTION_LIMIT = 100;
const FLEET_ROSTER_MAX_LENGTH = 60_000;
const GROUP_PAGE_SIZE = 200;
const NOT_FOUND = "That bot or group is no longer available. Call list_fleet and try again.";

type FleetBot = {
  id: string;
  name: string;
  description: string;
  section: string | null;
  pinned: boolean;
  createdByMe: boolean;
  /** As update_bot's own read shows it; a bot on the space default is marked "(default)". */
  model: string;
  /** "default" when the bot follows the space's default thinking level. */
  thinkingLevel: string;
};
type FleetGroup = {
  id: string;
  name: string;
  members: Member[];
  section: string | null;
  pinned: boolean;
};
export type FleetListing = {
  bots: FleetBot[];
  groups: FleetGroup[];
  sections: string[];
  truncated: boolean;
  /** With `bot_id`: what an instruction edit must start from. */
  bot?: { id: string; name: string; instructions: string; instructionsVersion: string };
};

/** The version an instruction edit must echo back: the newest history entry, or "initial". */
export function instructionsVersionOf(bot: { instructionHistory: unknown }): string {
  const head = Array.isArray(bot.instructionHistory) ? bot.instructionHistory[0] : undefined;
  const id = head && typeof head === "object" ? (head as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : "initial";
}

export async function listFleet(
  deps: FleetPrepareDeps,
  run: FleetRun,
  args: { bot_id?: unknown },
): Promise<FleetListing | { error: string }> {
  const { prisma } = deps;
  let detail: FleetListing["bot"];
  if (text(args.bot_id)) {
    const child = await resolveBot(prisma, run, { bot_id: args.bot_id });
    if ("error" in child) return { error: child.error };
    const row = await prisma.bot.findUniqueOrThrow({
      where: { id: child.id },
      select: { instructions: true, instructionHistory: true },
    });
    detail = {
      id: child.id,
      name: singleLine(child.name),
      instructionsVersion: instructionsVersionOf(row),
      instructions: row.instructions,
    };
  }
  if (detail) return { bot: detail, bots: [], groups: [], sections: [], truncated: false };
  const [bots, groups, sections, fallback] = await Promise.all([
    prisma.bot.findMany({
      where: activeBotsWhere(run),
      select: {
        id: true,
        name: true,
        description: true,
        pinned: true,
        section: { select: { name: true } },
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: FLEET_BOT_LIMIT + 1,
    }),
    visibleGroups(prisma, run),
    prisma.botSection.findMany({
      where: { spaceId: run.spaceId },
      select: { name: true },
      orderBy: { position: "asc" },
      take: FLEET_SECTION_LIMIT + 1,
    }),
    deps.modelChange.defaultModel(),
  ]);
  const listedBots = bots.slice(0, FLEET_BOT_LIMIT);
  // Only the listed bots need the creator flag, so this read is bounded by the bot cap.
  const children = await prisma.bot.findMany({
    where: {
      ...createdByWhere({ botId: run.botId, spaceId: run.spaceId }),
      archivedAt: null,
      id: { in: listedBots.map((bot) => bot.id) },
    },
    select: { id: true },
  });
  const childIds = new Set(children.map((child) => child.id));
  const listing: FleetListing = {
    bots: listedBots.map((bot) => ({
      id: bot.id,
      name: singleLine(bot.name),
      description: bot.description,
      section: bot.section ? singleLine(bot.section.name) : null,
      pinned: bot.pinned,
      createdByMe: childIds.has(bot.id),
      // Everyone's model in one read, so nobody has to ask each bot to inspect itself.
      model: botModelLabel(bot, fallback),
      thinkingLevel: bot.thinkingLevel ?? "default",
    })),
    groups: groups.slice(0, FLEET_GROUP_LIMIT),
    sections: sections.slice(0, FLEET_SECTION_LIMIT).map((section) => singleLine(section.name)),
    truncated:
      bots.length > FLEET_BOT_LIMIT ||
      groups.length > FLEET_GROUP_LIMIT ||
      sections.length > FLEET_SECTION_LIMIT,
  };
  let remaining =
    FLEET_ROSTER_MAX_LENGTH -
    JSON.stringify({ bots: [], groups: [], sections: [], truncated: false }).length;
  for (const rows of [listing.bots, listing.groups, listing.sections]) {
    let kept = 0;
    for (const row of rows) {
      const length = JSON.stringify(row).length + 1;
      if (length > remaining) break;
      remaining -= length;
      kept += 1;
    }
    if (kept < rows.length) {
      rows.splice(kept);
      listing.truncated = true;
    }
  }
  return listing;
}

/**
 * Up to one group past the cap of the groups the sidebar shows. A group left with too few active
 * members is hidden there, so it is skipped here and never counts toward the cap.
 */
async function visibleGroups(prisma: PrismaClient, run: FleetRun): Promise<FleetGroup[]> {
  const visible: FleetGroup[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.chatGroup.findMany({
      where: { spaceId: run.spaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        pinned: true,
        section: { select: { name: true } },
        members: {
          orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
          select: { botId: true, bot: { select: { name: true, archivedAt: true } } },
        },
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
      take: GROUP_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const group of page) {
      const members = group.members
        .filter((member) => member.bot.archivedAt === null)
        .map((member) => ({ id: member.botId, name: singleLine(member.bot.name) }));
      if (members.length < GROUP_MEMBER_MIN) continue;
      visible.push({
        id: group.id,
        name: singleLine(group.name),
        members,
        section: group.section ? singleLine(group.section.name) : null,
        pinned: group.pinned,
      });
      if (visible.length > FLEET_GROUP_LIMIT) return visible;
    }
    if (page.length < GROUP_PAGE_SIZE) return visible;
    cursor = page.at(-1)!.id;
  }
}

/** Move a bot or group into a section, clear its section, or pin it. Any of the user's. */
export async function organizeBot(
  deps: FleetDeps & { runSecrets: readonly string[] },
  run: FleetRun,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { error: string }> {
  const bot = text(args.bot_id) ?? text(args.bot_name);
  const group = text(args.group_id) ?? text(args.group_name);
  if (bot && group) return { error: "Pass a bot or a group, not both." };
  if (!bot && !group) return { error: "Pass bot_id, bot_name, group_id or group_name." };
  for (const flag of ["pinned", "clear_section"] as const) {
    const value = args[flag];
    if (value !== undefined && value !== null && typeof value !== "boolean") {
      return { error: `${flag} must be true or false.` };
    }
  }
  const pinned = typeof args.pinned === "boolean" ? args.pinned : undefined;
  // Clearing is explicit: a null or blank section is an omitted field, never a request to clear.
  const clearSection = args.clear_section === true;
  let section: string | null | undefined;
  if (typeof args.section === "string" && args.section.trim()) {
    const parsed = BotSectionName.safeParse(singleLine(args.section));
    if (!parsed.success) return { error: `section: ${issueMessage(parsed.error)}` };
    const credential = credentialField({ section: parsed.data }, deps.runSecrets);
    if (credential) return { error: credential };
    section = parsed.data;
  } else if (args.section !== undefined && args.section !== null && args.section !== "") {
    return { error: "section must be a section name." };
  }
  if (clearSection && section) return { error: "Pass section or clear_section, not both." };
  if (clearSection) section = null;
  if (section === undefined && pinned === undefined) {
    return { error: "Pass section, clear_section or pinned." };
  }

  const actor = actorOf(run);
  try {
    if (bot) {
      const target = await resolveBot(deps.prisma, run, args);
      if ("error" in target) return { error: target.error };
      if (!target.thread) return { error: NOT_FOUND };
      // A named section is always the user's own: found or created by name in their scope.
      if (section) {
        await createRepos(deps.prisma).createBotSection(actor, { botId: target.id, name: section });
      }
      await commitBotUpdate({
        prisma: deps.prisma,
        notify: (threadId, seq) => deps.events.notify(threadId, seq),
        spaceId: run.spaceId,
        threadId: target.thread.id,
        botId: target.id,
        emitBotUpdated: true,
        data: {
          ...(pinned !== undefined ? { pinned } : {}),
          ...(section === null ? { sectionId: null } : {}),
        },
      });
      return { ok: true };
    }
    const target = await resolveGroup(deps.prisma, run, args);
    if ("error" in target) return { error: target.error };
    if (
      target.members.filter((member) => member.bot.archivedAt === null).length < GROUP_MEMBER_MIN
    ) {
      return { error: NOT_FOUND };
    }
    if (section) {
      await createRepos(deps.prisma).createBotSection(actor, { groupId: target.id, name: section });
    }
    const updated = await createGroupRepos(deps.prisma).updateGroup(actor, {
      groupId: target.id,
      pinned,
      ...(section === null ? { sectionId: null } : {}),
    });
    await appendGroupEvent(deps, run, "group.updated", updated.group);
    return { ok: true };
  } catch (error) {
    return repoRefusal(error);
  }
}

/** Create the approved group, or return the active one with the same name and members. */
export async function createFleetGroup(
  deps: FleetDeps,
  run: FleetRun,
  canonical: Record<string, unknown>,
): Promise<
  { groupId: string; threadId: string; name: string; members: Member[] } | { error: string }
> {
  const parsed = CreateGroupInput.safeParse({ name: canonical.name, botIds: canonical.botIds });
  if (!parsed.success) return { error: issueMessage(parsed.error) };
  const { name, botIds } = parsed.data;
  const wanted = new Set(botIds);
  const sameName = await deps.prisma.chatGroup.findMany({
    where: { spaceId: run.spaceId, archivedAt: null, name },
    select: {
      id: true,
      name: true,
      thread: { select: { id: true } },
      members: {
        where: { bot: { archivedAt: null } },
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
        select: { botId: true, bot: { select: { name: true } } },
      },
    },
  });
  const existing = sameName.find(
    (group) =>
      group.thread &&
      group.members.length === wanted.size &&
      group.members.every((member) => wanted.has(member.botId)),
  );
  if (existing?.thread) {
    return {
      groupId: existing.id,
      threadId: existing.thread.id,
      name: singleLine(existing.name),
      members: existing.members.map((member) => ({
        id: member.botId,
        name: singleLine(member.bot.name),
      })),
    };
  }
  let group: Group;
  try {
    group = await createGroupRepos(deps.prisma).createGroup(actorOf(run), { name, botIds });
  } catch (error) {
    return repoRefusal(error);
  }
  await appendGroupEvent(deps, run, "group.created", { ...group, threadId: run.threadId });
  return {
    groupId: group.id,
    threadId: group.threadId,
    name: singleLine(group.name),
    members: group.members.map((member) => ({ id: member.botId, name: singleLine(member.name) })),
  };
}

/** Apply the approved membership change against the members the card was built from. */
export async function updateFleetGroup(
  deps: FleetDeps & Parameters<typeof stopCancelledGroupRuns>[0],
  run: FleetRun,
  canonical: Record<string, unknown>,
): Promise<
  | { ok: true; group: { id: string; name: string; threadId: string; members: Member[] } }
  | { error: string }
> {
  const parsed = UpdateGroupInput.safeParse({
    groupId: canonical.groupId,
    name: canonical.name,
    botIds: canonical.botIds,
    expectedBotIds: canonical.expectedBotIds,
  });
  if (!parsed.success) return { error: issueMessage(parsed.error) };
  let updated: Awaited<ReturnType<ReturnType<typeof createGroupRepos>["updateGroup"]>>;
  try {
    updated = await createGroupRepos(deps.prisma).updateGroup(actorOf(run), parsed.data);
  } catch (error) {
    return repoRefusal(error);
  }
  await appendGroupEvent(deps, run, "group.updated", updated.group);
  // The change is committed: a failed cleanup must not leave the approved effect uncertain.
  await stopCancelledGroupRuns(deps, run, updated).catch((error) =>
    getLogger().error("group member teardown", error),
  );
  const { group } = updated;
  return {
    ok: true,
    group: {
      id: group.id,
      name: singleLine(group.name),
      threadId: group.threadId,
      members: group.members.map((member) => ({ id: member.botId, name: singleLine(member.name) })),
    },
  };
}

const CHILD_CHANGED = "child changed; read it again with list_fleet";
const ALREADY_WROTE_INSTRUCTIONS = "You already changed this bot's instructions in this run.";

/** `update_bot` with `bot_id`: the profile fields of another bot in the space. */
export async function updateChildBot(
  deps: Pick<FleetDeps, "prisma" | "events"> & { runSecrets: readonly string[] },
  run: FleetRun,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { error: string }> {
  if (argumentGiven(args.artifact_id) || args.use_attached_image === true) {
    return { error: "artifact_id and use_attached_image work only on yourself." };
  }
  if (argumentGiven(args.instructions)) {
    return { error: "Change another bot's instructions with set_child_instructions." };
  }
  const profile = {
    dailyCheckIns: argumentGiven(args.dailyCheckIns) ? args.dailyCheckIns : undefined,
    name: argumentGiven(args.name) ? args.name : undefined,
    description: argumentGiven(args.description) ? args.description : undefined,
    notifyOnFinish: argumentGiven(args.notifyOnFinish)
      ? args.notifyOnFinish
      : argumentGiven(args.notify_on_finish)
        ? args.notify_on_finish
        : undefined,
  };
  const credential = credentialField(
    { name: profile.name, description: profile.description },
    deps.runSecrets,
  );
  if (credential) return { error: credential };

  const child = await resolveBot(deps.prisma, run, { bot_id: args.bot_id });
  if ("error" in child) {
    return { error: child.error };
  }
  if (!child.thread) return { error: NOT_FOUND };

  let patch: UpdateBotPatch = {};
  if (Object.values(profile).some((value) => value !== undefined)) {
    const parsed = parseUpdateBotPatch(profile);
    if ("error" in parsed) return parsed;
    patch = parsed.patch;
  }
  if (argumentGiven(args.color)) {
    const avatar = await resolveUpdateBotAvatar({
      color: args.color,
      sourceImageArtifactIds: [],
      loadArtifact: async () => null,
    });
    if ("error" in avatar) return avatar;
    patch.color = avatar.color;
  }
  if (Object.keys(patch).length === 0) {
    return {
      error: "Provide at least one of name, description, notify_on_finish, or color.",
    };
  }
  await commitBotUpdate({
    prisma: deps.prisma,
    notify: (threadId, seq) => deps.events.notify(threadId, seq),
    spaceId: run.spaceId,
    threadId: child.thread.id,
    botId: child.id,
    emitBotUpdated: true,
    data: patch,
  });
  return { ok: true };
}

/** Replace the approved child's instructions, checking ownership and the version again. */
export async function setChildInstructions(
  deps: Pick<FleetDeps, "prisma" | "events">,
  run: FleetRun,
  canonical: Record<string, unknown>,
): Promise<{ ok: true; botId: string; name: string; length: number } | { error: string }> {
  const instructions =
    typeof canonical.instructions === "string" ? canonical.instructions : undefined;
  const expectedVersion = text(canonical.expectedVersion);
  if (!instructions || !expectedVersion) return { error: "The approved change is incomplete." };
  const child = await resolveBot(deps.prisma, run, { bot_id: canonical.botId });
  if ("error" in child) return { error: child.error };
  if (!child.thread) return { error: NOT_FOUND };
  if (await wroteInstructionsThisRun(deps.prisma, run, child.id)) {
    return { error: ALREADY_WROTE_INSTRUCTIONS };
  }
  const current = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: child.id },
    select: { instructions: true, instructionHistory: true },
  });
  if (instructionsVersionOf(current) !== expectedVersion) return { error: CHILD_CHANGED };
  const caller = await deps.prisma.bot.findUnique({
    where: { id: run.botId },
    select: { name: true },
  });
  try {
    await commitBotUpdate({
      prisma: deps.prisma,
      notify: (threadId, seq) => deps.events.notify(threadId, seq),
      spaceId: run.spaceId,
      threadId: child.thread.id,
      botId: child.id,
      emitBotUpdated: true,
      data: { instructions },
      expectedInstructions: current.instructions,
      reason: `Updated by ${singleLine(caller?.name ?? "a bot")}`,
    });
  } catch (error) {
    if (error instanceof InstructionConflictError) return { error: CHILD_CHANGED };
    throw error;
  }
  return { ok: true, botId: child.id, name: singleLine(child.name), length: instructions.length };
}

/**
 * One instruction write per child per run. The effect ledger outlives an approval pause,
 * so a resumed run still sees the write it made before.
 */
async function wroteInstructionsThisRun(prisma: PrismaClient, run: FleetRun, childId: string) {
  const effects = await prisma.externalEffect.findMany({
    where: { runId: run.runId, kind: "set_child_instructions" },
    select: { request: true, result: true },
  });
  return effects.some(
    (effect) => asRecord(effect.request)?.botId === childId && asRecord(effect.result)?.ok === true,
  );
}

/** Apply the approved model, checking the child and the model again: either may have changed. */
export async function setChildBotModel(
  deps: FleetPrepareDeps & Pick<FleetDeps, "events">,
  run: FleetRun,
  canonical: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      botId: string;
      name: string;
      provider: string | null;
      model: string | null;
      thinkingLevel: string | null;
    }
  | { error: string }
> {
  const child = await resolveBot(deps.prisma, run, { bot_id: canonical.botId });
  if ("error" in child) return { error: child.error };
  if (!child.thread) return { error: NOT_FOUND };
  const previous = asRecord(canonical.previous);
  if (
    (previous?.provider ?? null) !== child.modelProvider ||
    (previous?.model ?? null) !== child.modelId ||
    (previous?.thinkingLevel ?? null) !== (child.thinkingLevel ?? null)
  ) {
    return { error: "That bot's model changed since you approved; ask again." };
  }
  const validated = await validateBotModelChange(
    { prisma: deps.prisma, ...deps.modelChange },
    {
      userId: run.userId,
      spaceId: run.spaceId,
      provider: text(canonical.provider) ?? null,
      model: text(canonical.model) ?? null,
      thinkingLevel: text(canonical.thinkingLevel) ?? null,
      current: { provider: child.modelProvider, model: child.modelId },
    },
  );
  if (!validated.ok) return { error: validated.error };
  try {
    await commitBotUpdate({
      prisma: deps.prisma,
      notify: (threadId, seq) => deps.events.notify(threadId, seq),
      spaceId: run.spaceId,
      threadId: child.thread.id,
      botId: child.id,
      emitBotUpdated: true,
      expectedSettings: {
        modelProvider: child.modelProvider,
        modelId: child.modelId,
        thinkingLevel: child.thinkingLevel ?? null,
      },
      data: {
        modelProvider: validated.provider,
        modelId: validated.model,
        thinkingLevel: validated.thinkingLevel,
      },
    });
  } catch (error) {
    if (isRecordNotFound(error))
      return { error: "That bot's model changed since you approved; ask again." };
    throw error;
  }
  return {
    ok: true,
    botId: child.id,
    name: singleLine(child.name),
    provider: validated.provider,
    model: validated.model,
    thinkingLevel: validated.thinkingLevel,
  };
}

/** Schedule the approved routine in the child's thread, or return the identical one. */
export async function createChildRoutine(
  deps: ScheduleToolDeps,
  run: FleetRun,
  canonical: Record<string, unknown>,
) {
  const typedName = text(canonical.name);
  const name = typedName === undefined ? undefined : singleLine(typedName);
  const prompt = text(canonical.prompt);
  const timezone = text(canonical.timezone) ?? "UTC";
  const schedule = asRecord(canonical.schedule);
  if (!name || !prompt || !schedule) return { error: "The approved routine is incomplete." };
  const child = await resolveBot(deps.prisma, run, { bot_id: canonical.botId });
  if ("error" in child) return { error: child.error };
  if (!child.thread || child.thread.id !== canonical.threadId) return { error: NOT_FOUND };

  const runAt = text(schedule.runAt);
  const cron = runAt ? ONCE_ROUTINE_CRON : text(schedule.cron);
  if (!cron) return { error: "The approved routine is incomplete." };
  // A zone that came from the account is re-read under the account lock at creation,
  // not replayed from the approval. The identical-routine lookup filters on the
  // account's current zone for such routines — the move keeps them on it — instead of
  // the approval's zone, which would miss a routine created or moved since, or no zone
  // at all, which would also match an unrelated pinned routine.
  const pinnedTimezone = canonical.timezoneFromAccount === true ? undefined : timezone;
  const replayTimezone =
    pinnedTimezone === undefined ? await userTimeZone(deps.prisma, run.userId) : pinnedTimezone;
  const existing = await deps.prisma.routine.findFirst({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: child.id,
      threadId: child.thread.id,
      name,
      prompt,
      timezone: replayTimezone,
      crons: { equals: [cron] },
      active: true,
      ...(runAt ? { nextRunAt: new Date(runAt) } : {}),
    },
    select: { id: true, name: true, crons: true, nextRunAt: true },
  });
  const target = { botId: child.id, botName: singleLine(child.name) };
  if (existing) {
    return {
      ok: true as const,
      routineId: existing.id,
      name: singleLine(existing.name),
      cron: existing.crons[0],
      nextRunAt: existing.nextRunAt?.toISOString() ?? null,
      oneShot: Boolean(runAt),
      ...target,
    };
  }
  const created = await createScheduleFromTool(deps, {
    spaceId: run.spaceId,
    botId: run.botId,
    userId: run.userId,
    threadId: run.threadId,
    target: { botId: child.id, threadId: child.thread.id },
    name,
    prompt,
    ...(pinnedTimezone === undefined ? {} : { timezone: pinnedTimezone }),
    schedule,
  });
  return "error" in created ? created : { ...created, ...target };
}

function actorOf(run: FleetRun): Actor {
  return { spaceId: run.spaceId, userId: run.userId, email: "", isDeploymentOwner: false };
}

const DEFAULT_ISOLATION_MESSAGE = new IsolationError().message;

/** A bare isolation failure says only "not found"; one with its own message says why. */
function repoRefusal(error: unknown): { error: string } {
  if (error instanceof IsolationError) {
    return { error: error.message === DEFAULT_ISOLATION_MESSAGE ? NOT_FOUND : error.message };
  }
  if (error instanceof SpaceDeletionInProgressError) return { error: error.message };
  throw error;
}

/** The change is committed; a lost sidebar refresh must not turn it into a failure. */
async function appendGroupEvent(
  deps: FleetDeps,
  run: FleetRun,
  type: "group.created" | "group.updated",
  group: { id: string; name: string; threadId: string },
) {
  try {
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: group.threadId,
      botId: run.botId,
      // A run belongs to one thread; an event in another thread carries no run.
      ...(group.threadId === run.threadId ? { runId: run.runId } : {}),
      type,
      payload: { groupId: group.id, name: singleLine(group.name) },
    });
  } catch (error) {
    getLogger().error(`${type} notification`, error);
  }
}

const botSelect = {
  id: true,
  name: true,
  modelProvider: true,
  modelId: true,
  thinkingLevel: true,
  thread: { select: { id: true } },
} satisfies Prisma.BotSelect;

function activeBotsWhere(run: FleetRun): Prisma.BotWhereInput {
  return { ...managedBotsWhere(run), archivedAt: null };
}

/** Exact ids or exact names, in the order given; every one must match exactly one active bot. */
async function resolveBots(
  prisma: PrismaClient,
  run: FleetRun,
  input: { ids?: string[]; names?: string[] },
): Promise<Member[] | Refusal> {
  const ids = input.ids ?? [];
  const names = input.names ?? [];
  const rows = await prisma.bot.findMany({
    where: {
      ...activeBotsWhere(run),
      ...(ids.length ? { id: { in: ids } } : { name: { in: names } }),
    },
    select: { id: true, name: true },
  });
  const members: Member[] = [];
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return refuse(`No bot with id "${id}". Call list_fleet for ids.`);
    members.push({ id: row.id, name: row.name });
  }
  for (const name of names) {
    const matching = rows.filter((candidate) => candidate.name === name);
    if (matching.length === 0) {
      return refuse(`No bot named "${name}". Call list_fleet and pass bot_id.`);
    }
    if (matching.length > 1) {
      return refuse(`More than one bot is named "${name}". Pass bot_id instead.`);
    }
    members.push({ id: matching[0]!.id, name: matching[0]!.name });
  }
  return members;
}

/** One active bot in the current user’s space, by `bot_id` or exact `bot_name`. */
async function resolveBot(prisma: PrismaClient, run: FleetRun, args: Record<string, unknown>) {
  const id = text(args.bot_id);
  const name = text(args.bot_name);
  if (id && name) return refuse("Pass bot_id or bot_name, not both.");
  if (!id && !name) return refuse("Pass bot_id or bot_name.");
  const target = id ? { id } : { name };
  const bots = await prisma.bot.findMany({
    where: { ...activeBotsWhere(run), ...target },
    select: botSelect,
    take: 2,
  });
  if (bots.length > 1) {
    return refuse(`More than one bot is named "${name}". Pass bot_id instead.`);
  }
  if (bots[0]) return bots[0];
  return refuse(
    id
      ? `No bot with id "${id}". Call list_fleet for ids.`
      : `No bot named "${name}". Call list_fleet and pass bot_id.`,
  );
}

/** One active group of the space, by `group_id` or exact `group_name`. Groups have no creator. */
async function resolveGroup(prisma: PrismaClient, run: FleetRun, args: Record<string, unknown>) {
  const id = text(args.group_id);
  const name = text(args.group_name);
  if (id && name) return refuse("Pass group_id or group_name, not both.");
  if (!id && !name) return refuse("Pass group_id or group_name.");
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: run.spaceId,
      archivedAt: null,
      ...(id ? { id } : { name }),
    },
    select: {
      id: true,
      name: true,
      members: {
        orderBy: { createdAt: "asc" },
        select: { botId: true, bot: { select: { name: true, archivedAt: true } } },
      },
    },
    take: 2,
  });
  if (groups.length > 1) {
    return refuse(`More than one group is named "${name}". Pass group_id instead.`);
  }
  if (groups[0]) return groups[0];
  return refuse(
    id
      ? `No group with id "${id}". Call list_fleet for ids.`
      : `No group named "${name}". Call list_fleet and pass group_id.`,
  );
}

function refuse(error: string): Refusal {
  return { ok: false, error };
}

/** Providers send omitted optional fields as null or blank; treat those as absent. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Absent means empty; anything other than a list of non-empty strings is refused. */
function stringList(value: unknown, field: string): string[] | Refusal {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value.map(text) : undefined;
  if (!items || items.some((item) => item === undefined)) {
    return refuse(`${field} must be a list of non-empty strings.`);
  }
  return items as string[];
}

/** Names reach the card as one line, so a name cannot add lines of its own. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const CARD_TITLE_ESCAPED = new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g");

/** A name in a card title, which renders as Markdown: one line, and no links or emphasis. */
export function cardName(value: string): string {
  return singleLine(value).replace(CARD_TITLE_ESCAPED, "\\$&");
}

/** The first given text field a credential of this run would be redacted from, as a refusal. */
function credentialField(
  fields: Record<string, unknown>,
  secrets: readonly string[],
): string | undefined {
  const field = Object.entries(fields).find(
    ([, value]) => typeof value === "string" && redactSecrets(value, [...secrets]) !== value,
  )?.[0];
  return field ? `${field} cannot contain credentials.` : undefined;
}

/**
 * Tag, zero-width and bidirectional control characters render as nothing on a plain-text card
 * while the child's model still reads them, so the owner could approve text they cannot see.
 */
const INVISIBLE_CHARACTERS =
  /[\u{E0000}-\u{E007F}\u200B-\u200F\u2060-\u2064\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/** The first given text field holding characters the card would not show, as a refusal. */
function invisibleField(fields: Record<string, string>): string | undefined {
  const field = Object.entries(fields).find(([, value]) => INVISIBLE_CHARACTERS.test(value))?.[0];
  return field ? `${field} contains invisible characters.` : undefined;
}

function memberNames(members: Member[]): string {
  return members.map((member) => singleLine(member.name)).join(", ");
}

/** A bot's model as its own settings read shows it: the space default is marked "(default)". */
export function botModelLabel(
  bot: { modelProvider: string | null; modelId: string | null },
  fallback: { provider: string | null; model: string | null },
): string {
  if (bot.modelProvider && bot.modelId) return modelLabel(bot.modelProvider, bot.modelId);
  return `${modelLabel(fallback.provider, fallback.model)} (default)`;
}

export function modelLabel(provider: string | null, model: string | null): string {
  if (!provider || !model) return "Default model";
  const catalog = [...listPiCatalog(), scriptedCatalogEntry];
  const catalogProvider = canonicalPiProviderId(provider);
  const entry = catalog.find((item) => item.provider === catalogProvider && item.id === model);
  const providerName =
    catalog.find((item) => item.provider === catalogProvider)?.providerName ?? provider;
  return entry ? `${entry.providerName}: ${entry.label}` : `${model} (${providerName})`;
}

function issueMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

function formatTime(date: Date, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return `${local} ${timezone}`;
}

/** update_bot on the calling bot's own profile. */
export async function updateOwnBotFromTool(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; userId: string; sourceMessageId: string | null },
  threadId: string,
  bot: { id: string; name: string },
  args: Record<string, unknown>,
  context: AdapterContext,
) {
  const parsed = parseUpdateBotPatch(args);
  if ("error" in parsed) return parsed;
  const patch = parsed.patch;
  const wantsImage = args.artifact_id !== undefined || args.use_attached_image === true;
  let sourceImageArtifactIds: string[] = [];
  if (wantsImage && run.sourceMessageId) {
    const source = await deps.prisma.message.findUnique({
      where: { id: run.sourceMessageId },
      select: { blocks: true, threadId: true },
    });
    if (source?.threadId === threadId) {
      sourceImageArtifactIds = attachedImageArtifactIds(source.blocks as MessageBlock[]);
    }
  }
  const avatar = await resolveUpdateBotAvatar({
    color: args.color,
    artifactId: args.artifact_id,
    useAttachedImage: args.use_attached_image,
    sourceImageArtifactIds,
    loadArtifact: async (id) => {
      if (!deps.artifacts) return null;
      const row = await deps.prisma.artifact.findFirst({
        where: { id, spaceId: run.spaceId },
        select: { mimeType: true, storageKey: true },
      });
      if (!row || !isAttachmentImageMimeType(row.mimeType)) return null;
      try {
        return await deps.artifacts.get(row.storageKey, context);
      } catch {
        return null;
      }
    },
  });
  if ("error" in avatar && avatar.error !== "missing") {
    return { error: avatar.error };
  }
  if ("color" in avatar) patch.color = avatar.color;
  if (Object.keys(patch).length === 0) {
    return {
      error:
        "Provide at least one of name, description, notifyOnFinish, color, artifact_id, or use_attached_image.",
    };
  }
  const updated = await deps.prisma.bot.update({
    where: { id: bot.id },
    data: patch,
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      notifyOnFinish: true,
      dailyCheckIns: true,
    },
  });
  try {
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: threadId,
      botId: bot.id,
      runId: run.id,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
        description: updated.description,
      },
    });
  } catch (error) {
    getLogger().error("bot.updated notification", error);
  }
  return {
    ok: true,
    botId: updated.id,
    name: updated.name,
    description: updated.description,
    avatar: updated.color.startsWith("data:image/") ? "image" : updated.color,
    notifyOnFinish: updated.notifyOnFinish,
    dailyCheckIns: updated.dailyCheckIns,
  };
}
