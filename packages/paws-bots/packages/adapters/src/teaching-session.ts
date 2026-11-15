import type {
  AdapterContext,
  ComputerInput,
  ControlLeaseRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { skillTeachingExpireJobKey } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock, TaughtSkill } from "@rakazo/contracts";
import type { SkillPlaybook, TeachRecordingEvent, TeachSnapshot } from "@rakazo/core";
import {
  buildPlaybookFromRecording,
  computerInputForDomKey,
  sanitizeTeachRecordingEvent,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  draftTeachingRecordingInTransaction,
  IsolationError,
} from "@rakazo/db";
import { releaseComputerControlLease } from "./computer-control.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import { toComputerRef } from "./computer-support.js";

export type TaughtSkillRow = {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  name: string;
  goal: string;
  status: string;
  playbook: unknown;
  recording: unknown;
  startedAt: Date | null;
  expiresAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type TeachRecording = {
  events: TeachRecordingEvent[];
  snapshots: TeachSnapshot[];
  controlLeaseId?: string;
};

export type TeachComputerInput = (
  | ComputerInput
  | {
      kind: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount?: number;
      x?: number;
      y?: number;
    }
) & {
  sensitive?: boolean;
  skillId?: string;
};

export interface TeachingSessionDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
}

export function emptyRecording(): TeachRecording {
  return { events: [], snapshots: [] };
}

export function parseRecording(value: unknown): TeachRecording {
  if (!value || typeof value !== "object") return emptyRecording();
  const record = value as Partial<TeachRecording>;
  return {
    events: Array.isArray(record.events) ? (record.events as TeachRecordingEvent[]) : [],
    snapshots: Array.isArray(record.snapshots) ? (record.snapshots as TeachSnapshot[]) : [],
    controlLeaseId: typeof record.controlLeaseId === "string" ? record.controlLeaseId : undefined,
  };
}

export function parsePlaybook(value: unknown): SkillPlaybook {
  if (!value || typeof value !== "object") {
    return buildPlaybookFromRecording("", []);
  }
  const record = value as Partial<SkillPlaybook>;
  return {
    whenToUse: String(record.whenToUse ?? ""),
    inputs: Array.isArray(record.inputs) ? record.inputs.map(String) : [],
    steps: Array.isArray(record.steps) ? record.steps.map(String) : [],
    howToCheck: String(record.howToCheck ?? ""),
    whatToReturn: String(record.whatToReturn ?? ""),
    approvalBoundaries: String(record.approvalBoundaries ?? ""),
    failureHandling: String(record.failureHandling ?? ""),
  };
}

export function mapTaughtSkill(row: TaughtSkillRow): TaughtSkill {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    goal: row.goal,
    status: row.status as TaughtSkill["status"],
    playbook: parsePlaybook(row.playbook),
    recording: parseRecording(row.recording),
    startedAt: row.startedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

export async function getActiveTeachingSession(
  prisma: PrismaClient,
  spaceId: string,
  botId: string,
  userId?: string,
) {
  return prisma.taughtSkill.findFirst({
    where: {
      spaceId,
      botId,
      status: "recording",
      ...(userId ? { userId } : {}),
    },
  });
}

function recordingEventKey(event: TeachRecordingEvent): string {
  return JSON.stringify(event);
}

async function mutateRecording(
  deps: TeachingSessionDeps,
  skillId: string,
  mutate: (recording: TeachRecording) => { recording: TeachRecording; changed: boolean },
  options?: { requireRecording?: boolean },
): Promise<TaughtSkillRow> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skillId} FOR UPDATE`;
    const skill = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
    if (options?.requireRecording !== false && skill.status !== "recording") {
      return skill;
    }
    if (skill.expiresAt && skill.expiresAt.getTime() <= Date.now()) {
      return skill;
    }
    const current = parseRecording(skill.recording);
    const next = mutate(current);
    if (!next.changed) return skill;
    return tx.taughtSkill.update({
      where: { id: skillId },
      data: { recording: next.recording as never },
    });
  });
}

export async function observeStopSnapshot(
  deps: TeachingSessionDeps,
  actor: Actor,
  bot: { id: string; computer: { providerRef: string | null } | null },
): Promise<TeachSnapshot | undefined> {
  if (!bot.computer?.providerRef) return undefined;
  try {
    const observation = await deps.sandbox.observe(
      toComputerRef(bot.computer as never),
      computerContext(actor, bot.id, "skills.snapshot"),
    );
    const summary =
      typeof observation === "object" &&
      observation &&
      "activeWindow" in observation &&
      observation.activeWindow &&
      typeof observation.activeWindow === "object" &&
      "title" in observation.activeWindow
        ? String((observation.activeWindow as { title?: string }).title ?? "screen captured")
        : "screen captured";
    return { at: new Date().toISOString(), summary };
  } catch {
    return undefined;
  }
}

async function finalizeTeachingRecording(
  deps: TeachingSessionDeps,
  actor: Actor,
  skillId: string,
  reason: "stopped" | "expired",
  stopSnapshot?: TeachSnapshot,
): Promise<{ skill: TaughtSkillRow; stopped: { threadId: string; seq: number } | null }> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skillId} FOR UPDATE`;
    const skill = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
    if (skill.status === "draft" || skill.status === "saved") {
      return { skill, stopped: null };
    }
    if (skill.status !== "recording" && skill.status !== "drafting") {
      throw new Error("Teaching session is not active");
    }
    return draftTeachingRecordingInTransaction(tx, skill, {
      spaceId: actor.spaceId,
      reason,
      stopSnapshot,
    });
  });
}

export async function appendRecordingEvent(
  deps: TeachingSessionDeps,
  skillId: string,
  event: TeachRecordingEvent,
  options?: { requireRecording?: boolean },
): Promise<TaughtSkillRow> {
  return mutateRecording(
    deps,
    skillId,
    (recording) => {
      const stored = sanitizeTeachRecordingEvent(event);
      const key = recordingEventKey(stored);
      if (recording.events.some((existing) => recordingEventKey(existing) === key)) {
        return { recording, changed: false };
      }
      recording.events.push(stored);
      return { recording, changed: true };
    },
    options,
  );
}

export async function releaseTeachingComputerControlForBot(
  deps: TeachingSessionDeps,
  actor: Actor,
  botId: string,
  expectedLeaseId?: string | null,
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    include: { computer: true },
  });
  if (!bot) return;
  await releaseTeachingComputerControl(deps, actor, bot, expectedLeaseId);
}

async function releaseTeachingComputerControl(
  deps: TeachingSessionDeps,
  actor: Actor,
  bot: {
    id: string;
    computer: {
      id: string;
      homeKey: string;
      kind: string;
      providerRef: string | null;
      controlHolder: string;
      controlBotId: string | null;
      controlLeaseId: string | null;
      spaceId: string;
    } | null;
  },
  expectedLeaseId?: string | null,
): Promise<void> {
  const computer = bot.computer;
  if (
    computer?.controlHolder !== "user" ||
    computer.controlBotId !== bot.id ||
    !computer.controlLeaseId
  ) {
    return;
  }
  if (!expectedLeaseId || computer.controlLeaseId !== expectedLeaseId) return;
  await releaseComputerControlLease(
    deps,
    computer,
    bot.id,
    computer.controlLeaseId,
    computerContext(actor, bot.id, "skills.release"),
    "released",
  );
  await scheduleComputerSleep(deps.jobs, computer.id);
}

function skillDraftBlocks(skill: TaughtSkillRow): MessageBlock[] {
  return [
    {
      kind: "skill_draft",
      skillId: skill.id,
      name: skill.name || skill.goal.slice(0, 80),
      goal: skill.goal,
      playbook: parsePlaybook(skill.playbook),
      status: "draft",
    },
  ];
}

async function findSkillDraftMessage(
  prisma: { message: { findMany: PrismaClient["message"]["findMany"] } },
  threadId: string,
  skillId: string,
): Promise<{ id: string; blocks: MessageBlock[] } | null> {
  const messages = await prisma.message.findMany({
    where: { threadId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 100,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (
      Array.isArray(blocks) &&
      blocks.some((block) => block.kind === "skill_draft" && block.skillId === skillId)
    ) {
      return { id: message.id, blocks };
    }
  }
  return null;
}

async function hasSkillDraftCreatedEvent(
  prisma: { event: { findMany: PrismaClient["event"]["findMany"] } },
  threadId: string,
  skillId: string,
): Promise<boolean> {
  const events = await prisma.event.findMany({
    where: { threadId, type: "skill.draft.created" },
    select: { payload: true },
    take: 50,
  });
  return events.some((event) => {
    const payload = event.payload;
    return (
      payload !== null &&
      typeof payload === "object" &&
      "skillId" in payload &&
      payload.skillId === skillId
    );
  });
}

async function emitSkillDraftMessages(
  deps: TeachingSessionDeps,
  actor: Actor,
  skill: TaughtSkillRow,
  bot: { id: string; thread: { id: string } | null },
): Promise<void> {
  if (skill.status !== "draft" || !bot.thread) return;
  const threadId = bot.thread.id;
  const published = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skill.id} FOR UPDATE`;
    let created = await findSkillDraftMessage(tx, threadId, skill.id);
    if (!created) {
      const blocks = skillDraftBlocks(skill);
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "bot",
        blocks,
      });
      created = { id: message.id, blocks };
    }
    if (await hasSkillDraftCreatedEvent(tx, threadId, skill.id)) return null;
    await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: created.id, role: "bot", blocks: created.blocks },
    });
    const draftEvent = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId,
      botId: bot.id,
      type: "skill.draft.created",
      payload: { skillId: skill.id, name: skill.name || skill.goal.slice(0, 80) },
    });
    return draftEvent.seq;
  });
  if (published != null) await deps.events.notify(threadId, published);
}

export async function completeTeachingSession(
  deps: TeachingSessionDeps,
  actor: Actor,
  skillId: string,
  reason: "stopped" | "expired",
  stopSnapshot?: TeachSnapshot,
): Promise<TaughtSkillRow> {
  const { skill: finalized, stopped } = await finalizeTeachingRecording(
    deps,
    actor,
    skillId,
    reason,
    stopSnapshot,
  );
  const bot = await deps.prisma.bot.findUnique({
    where: { id: finalized.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  await releaseTeachingComputerControlForBot(
    deps,
    actor,
    bot.id,
    parseRecording(finalized.recording).controlLeaseId,
  );
  if (finalized.status === "draft") {
    await emitSkillDraftMessages(deps, actor, finalized, bot);
  }
  if (stopped) await deps.events.notify(stopped.threadId, stopped.seq);
  return finalized;
}

export async function expireTaughtSkillTeaching(
  deps: TeachingSessionDeps,
  skillId: string,
): Promise<TaughtSkillRow | null> {
  const skill = await deps.prisma.taughtSkill.findUnique({ where: { id: skillId } });
  if (!skill) return null;
  const actor = { spaceId: skill.spaceId, userId: skill.userId } as Actor;
  if (skill.status !== "recording") {
    const leaseId = parseRecording(skill.recording).controlLeaseId;
    if (leaseId) await releaseTeachingComputerControlForBot(deps, actor, skill.botId, leaseId);
    if (skill.status === "draft") {
      const bot = await deps.prisma.bot.findUnique({
        where: { id: skill.botId },
        include: { thread: true },
      });
      if (bot) await emitSkillDraftMessages(deps, actor, skill, bot);
    }
    return skill;
  }
  if (!skill.expiresAt || skill.expiresAt.getTime() > Date.now()) {
    return skill;
  }
  const bot = await deps.prisma.bot.findUnique({
    where: { id: skill.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) return skill;
  const stopSnapshot = bot.computer?.providerRef
    ? await observeStopSnapshot(deps, actor, bot)
    : undefined;
  const finalized = await completeTeachingSession(deps, actor, skill.id, "expired", stopSnapshot);
  await deps.jobs.cancel(skillTeachingExpireJobKey(skill.id));
  return finalized;
}

export async function applyTeachingDesktopInput(
  sandbox: SandboxProvider,
  computer: {
    homeKey: string;
    kind: string;
    providerRef: string | null;
    controlLeaseId: string | null;
  },
  mapped: TeachComputerInput,
  context: AdapterContext,
): Promise<void> {
  if (!computer.providerRef) return;
  const lease: ControlLeaseRef = {
    leaseId: computer.controlLeaseId ?? "lease",
    holder: "user",
    fence: 0,
  };
  if (mapped.kind === "scroll") {
    await sandbox.act(
      toComputerRef(computer),
      {
        actions: [
          {
            kind: "scroll",
            direction: mapped.direction,
            amount: mapped.amount,
            ...(mapped.x !== undefined && mapped.y !== undefined
              ? { x: mapped.x, y: mapped.y }
              : {}),
          },
        ],
        observe: false,
      },
      context,
    );
    return;
  }
  const { skillId: _skillId, ...desktop } = mapped;
  const input: ComputerInput =
    desktop.kind === "key" && desktop.key && !desktop.modifiers?.length
      ? computerInputForDomKey(desktop.key)
      : desktop;
  await sandbox.sendInput(toComputerRef(computer), input, lease, context);
}

function protectedInputMissesRecording(
  mapped: TeachComputerInput,
  activeSkillId: string | undefined,
): boolean {
  return mapped.sensitive === true && Boolean(mapped.skillId) && activeSkillId !== mapped.skillId;
}

export async function recordTeachingInputEvent(
  deps: TeachingSessionDeps,
  actor: Actor,
  botId: string,
  mapped: TeachComputerInput,
): Promise<"recorded" | "idle" | "stale"> {
  const skill = await getActiveTeachingSession(deps.prisma, actor.spaceId, botId, actor.userId);
  // Protected input names the recording it was queued for, so a later one cannot receive it.
  if (protectedInputMissesRecording(mapped, skill?.id)) return "stale";
  if (!skill) return "idle";
  if (skill.expiresAt && skill.expiresAt.getTime() <= Date.now()) {
    await expireTaughtSkillTeaching(deps, skill.id);
    return "stale";
  }
  const event = sanitizeTeachRecordingEvent({
    at: new Date().toISOString(),
    kind: mapped.kind === "scroll" ? "scroll" : mapped.kind,
    ...(mapped.sensitive ? { sensitive: true as const } : {}),
    ...(mapped.kind === "key"
      ? { key: mapped.key }
      : mapped.kind === "clipboard"
        ? { text: mapped.text }
        : mapped.kind === "scroll"
          ? {
              type: mapped.direction,
              text: String(mapped.amount ?? 3),
              ...(mapped.x !== undefined && mapped.y !== undefined
                ? { x: mapped.x, y: mapped.y }
                : {}),
            }
          : {
              x: mapped.x,
              y: mapped.y,
              button: mapped.button,
              type: mapped.type,
            }),
  });
  const prepared = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skill.id} FOR UPDATE`;
    const current = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    if (current.status !== "recording") return { kind: "stale" as const };
    if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
      return { kind: "expired" as const };
    }
    const bot = await tx.bot.findUnique({
      where: { id: botId },
      include: { computer: true },
    });
    return { kind: "ready" as const, computer: bot?.computer ?? null };
  });
  if (prepared.kind === "expired") {
    await expireTaughtSkillTeaching(deps, skill.id);
    return "stale";
  }
  if (prepared.kind === "stale") return "stale";
  if (prepared.computer?.providerRef) {
    // The row lock above does not cover sandbox IO. Only protected input is
    // bound to a recording, so ordinary events skip this extra read.
    if (mapped.sensitive === true && mapped.skillId) {
      const active = await getActiveTeachingSession(
        deps.prisma,
        actor.spaceId,
        botId,
        actor.userId,
      );
      if (protectedInputMissesRecording(mapped, active?.id)) return "stale";
    }
    await applyTeachingDesktopInput(
      deps.sandbox,
      prepared.computer,
      mapped,
      computerContext(actor, botId, "input"),
    );
  }
  const recorded = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skill.id} FOR UPDATE`;
    const current = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    if (current.status !== "recording") return "stale" as const;
    if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) return "expired" as const;
    const recording = parseRecording(current.recording);
    recording.events.push(event);
    await tx.taughtSkill.update({
      where: { id: skill.id },
      data: { recording: recording as never },
    });
    return "recorded" as const;
  });
  if (recorded === "expired") {
    await expireTaughtSkillTeaching(deps, skill.id);
    return "stale";
  }
  return recorded;
}

export async function captureTeachingSnapshot(
  deps: TeachingSessionDeps,
  actor: Actor,
  bot: { id: string; computer: { id: string; kind: string; providerRef: string | null } | null },
  skill: TaughtSkillRow,
): Promise<TaughtSkillRow> {
  const snapshot = await observeStopSnapshot(deps, actor, bot);
  if (!snapshot) return skill;
  return mutateRecording(deps, skill.id, (recording) => {
    recording.snapshots.push(snapshot);
    recording.events.push({ at: snapshot.at, kind: "snapshot", summary: snapshot.summary });
    return { recording, changed: true };
  });
}
