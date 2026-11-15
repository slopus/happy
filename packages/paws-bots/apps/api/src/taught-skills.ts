import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  createAdapterContext,
  runContinueJob,
  skillTeachingExpireJob,
  skillTeachingExpireJobKey,
} from "@rakazo/adapter-kit";
import type { ComputerExecutionLease, TaughtSkillRow, TeachComputerInput } from "@rakazo/adapters";
import {
  acquireComputerExecutionLease,
  anotherPersonHoldsControl,
  appendRecordingEvent,
  ComputerBusyError,
  captureTeachingSnapshot,
  completeTeachingSession,
  emptyRecording,
  expireTaughtSkillTeaching,
  getActiveTeachingSession,
  mapTaughtSkill,
  observeStopSnapshot,
  parsePlaybook,
  parseRecording,
  provisionComputer,
  recordTeachingInputEvent,
  releaseComputerExecutionLease,
  releaseTeachingComputerControlForBot,
  screenLeaseIdForRun,
} from "@rakazo/adapters";
import type { Actor, MessageBlock, TaughtSkill } from "@rakazo/contracts";
import type { SkillPlaybook, TeachRecordingEvent } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  buildPlaybookFromRecording,
  COMPUTER_USING_RUNS,
  formatSkillRunPrompt,
  teachRecordingTtlMs,
} from "@rakazo/core";
import type { createRepos, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  clearEndedRunState,
  expireComputerExecutionLeases,
  IsolationError,
  isUniqueViolation,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { takeComputerControl } from "./computer-control.js";

export interface TaughtSkillsDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  dataDir: string;
}

/**
 * Taught skills are the space's. A live recording is driven by the member who
 * holds the computer takeover, so only that member feeds it (`recorder`).
 */
async function getOwnedSkill(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skillId: string,
  options: { recorder?: boolean } = {},
): Promise<TaughtSkillRow> {
  const skill = await deps.prisma.taughtSkill.findFirst({
    where: {
      id: skillId,
      spaceId: actor.spaceId,
      ...(options.recorder ? { userId: actor.userId } : {}),
    },
  });
  if (!skill) throw new IsolationError();
  return skill;
}

export async function assertTeachingSendAllowed(
  prisma: PrismaClient,
  spaceId: string,
  botId: string,
): Promise<void> {
  const active = await getActiveTeachingSession(prisma, spaceId, botId);
  if (active) {
    throw new ORPCError("CONFLICT", { message: "Stop teaching first" });
  }
}

/**
 * Teaching stops only the teacher's own work on the bot. Another member's run that starts
 * meanwhile is never cancelled here: the check before taking the screen refuses the lesson.
 */
async function cancelActiveRuns(
  deps: TaughtSkillsDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const activeRuns = await deps.prisma.run.updateManyAndReturn({
    where: {
      botId,
      userId: actor.userId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      ...COMPUTER_USING_RUNS,
    },
    data: { status: "cancelled", completedAt: new Date() },
    select: { id: true },
  });
  const runIds = activeRuns.map((run) => run.id);
  await clearEndedRunState(deps.prisma, runIds);
  await expireComputerExecutionLeases(deps.prisma, { botId, runId: { in: runIds } });
  await deps.prisma.computer.updateMany({
    where: { executionBotId: botId, executionRunId: { in: runIds } },
    data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
  });
  await deps.prisma.event.deleteMany({
    where: { type: "thread.progress", runId: { in: runIds } },
  });
}

async function ensureGraphicalComputer(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>,
) {
  if (bot.computer?.kind === "desktop") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Teaching needs a graphical sandbox computer, not a desktop host",
    });
  }
  if (!bot.computer) throw new IsolationError();
  if (bot.computer.state !== "running" || !bot.computer.providerRef) {
    const ctx = createAdapterContext(actor, bot.id, "skills.start");
    const manualRunId = `teach:${randomUUID()}`;
    let lease: ComputerExecutionLease | null;
    try {
      lease = await acquireComputerExecutionLease(deps.prisma, {
        computerId: bot.computer.id,
        runId: manualRunId,
        botId: bot.id,
      });
    } catch (error) {
      if (error instanceof ComputerBusyError) {
        throw new ORPCError("CONFLICT", { message: "Computer is busy" });
      }
      throw error;
    }
    const computerId = bot.computer.id;
    try {
      await getLogger().withContext({ reason: "teaching" }, () =>
        provisionComputer(deps, computerId, {
          ...ctx,
          screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
        }),
      );
    } catch (error) {
      if (error instanceof ComputerBusyError) {
        throw new ORPCError("CONFLICT", { message: "Computer is busy" });
      }
      throw error;
    } finally {
      await releaseComputerExecutionLease(deps.prisma, lease);
    }
    bot = await deps.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { thread: true, computer: true },
    });
  }
  if (!bot.computer?.providerRef || bot.computer.state !== "running") {
    throw new ORPCError("BAD_REQUEST", { message: "Computer must be running to teach" });
  }
  if (bot.computer.kind === "desktop") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Teaching needs a graphical sandbox computer, not a desktop host",
    });
  }
  return bot;
}

/**
 * In a shared Space, teaching never takes another person's screen or stops their work: someone
 * else's live lease, or their run on this bot or any bot sharing its computer, keeps it. Checked
 * before teaching cancels anything, and again before it takes the screen, since the computer is
 * read anew in between.
 */
async function assertComputerFreeFor(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: {
    id: string;
    computerId: string | null;
    computer: Parameters<typeof anotherPersonHoldsControl>[0] | null;
  },
): Promise<void> {
  if (bot.computer && anotherPersonHoldsControl(bot.computer, actor.userId)) {
    throw new ORPCError("CONFLICT", { message: "Someone else is using this computer" });
  }
  const othersWork = await deps.prisma.run.findFirst({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      ...COMPUTER_USING_RUNS,
      userId: { not: actor.userId },
      ...(bot.computerId ? { bot: { computerId: bot.computerId } } : { botId: bot.id }),
    },
    select: { id: true },
  });
  if (othersWork) {
    throw new ORPCError("CONFLICT", { message: "The computer is working for someone else" });
  }
}

async function grantTakeover(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>,
): Promise<{ bot: typeof bot; leaseId: string }> {
  if (!bot.computer) throw new IsolationError();
  await assertComputerFreeFor(deps, actor, bot);
  // Teaching records under the person's ordinary control, and ends when that control does.
  const { leaseId } = await takeComputerControl(deps, actor, bot.id);
  return { bot, leaseId };
}

async function updateSkillDraftMessage(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skill: TaughtSkillRow,
  input: {
    name?: string;
    playbook?: SkillPlaybook;
    status?: "draft" | "saved";
  },
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: skill.botId },
    include: { thread: true },
  });
  if (!bot?.thread) return;

  const messages = await deps.prisma.message.findMany({
    where: { threadId: bot.thread.id, role: "bot" },
    orderBy: { seq: "desc" },
    take: 100,
  });

  for (const message of messages) {
    const parsed = message.blocks as MessageBlock[];
    if (!Array.isArray(parsed)) continue;
    const index = parsed.findIndex(
      (block) => block.kind === "skill_draft" && block.skillId === skill.id,
    );
    if (index === -1) continue;
    const existing = parsed[index];
    if (existing?.kind !== "skill_draft") continue;
    const playbook = input.playbook ?? parsePlaybook(skill.playbook);
    const nextBlocks: MessageBlock[] = [...parsed];
    nextBlocks[index] = {
      kind: "skill_draft",
      skillId: skill.id,
      name: input.name ?? existing.name,
      goal: skill.goal,
      playbook,
      status: input.status ?? existing.status,
    };
    await deps.prisma.message.update({
      where: { id: message.id },
      data: { blocks: nextBlocks as never },
    });
    await deps.events.append({
      spaceId: actor.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: nextBlocks },
    });
    return;
  }
}

export async function expireTeachingSessionIfNeeded(deps: TaughtSkillsDeps, skillId: string) {
  return expireTaughtSkillTeaching(deps, skillId);
}

export async function stopTeachingSession(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skillId: string,
): Promise<TaughtSkill> {
  // Stopping releases the recorder's control of the computer, so it is theirs to do.
  await getOwnedSkill(deps, actor, skillId, { recorder: true });
  await expireTeachingSessionIfNeeded(deps, skillId);
  const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
  if (current.status === "draft" || current.status === "saved") {
    await releaseTeachingComputerControlForBot(
      deps,
      actor,
      current.botId,
      parseRecording(current.recording).controlLeaseId,
    );
    return skillFor(actor, current);
  }
  if (current.status !== "recording" && current.status !== "drafting") {
    throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not active" });
  }
  const bot = await deps.prisma.bot.findUnique({
    where: { id: current.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  const stopSnapshot =
    current.status === "recording" && bot.computer?.providerRef
      ? await observeStopSnapshot(deps, actor, bot)
      : undefined;
  const finalized = await completeTeachingSession(deps, actor, skillId, "stopped", stopSnapshot);
  await deps.jobs.cancel(skillTeachingExpireJobKey(current.id));
  return skillFor(actor, finalized);
}

/*
 * A skill is shared with the space, but its raw recording (keystrokes, clipboard text) stays with
 * the person who taught it: everyone else gets the playbook, and a member who takes the skill
 * over by editing it gets it without the recording, which nothing reads once it is drafted.
 */
const isTeacher = (skill: TaughtSkillRow, actor: Actor) => skill.userId === actor.userId;

function handedOver(skill: TaughtSkillRow, actor: Actor) {
  return isTeacher(skill, actor) ? {} : { recording: emptyRecording() as never };
}

function skillFor(actor: Actor, row: TaughtSkillRow): TaughtSkill {
  const skill = mapTaughtSkill(row);
  return isTeacher(row, actor) ? skill : { ...skill, recording: emptyRecording() };
}

export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  return {
    async list(actor: Actor, botId: string): Promise<TaughtSkill[]> {
      const rows = await deps.prisma.taughtSkill.findMany({
        where: { spaceId: actor.spaceId, botId },
        orderBy: { updatedAt: "desc" },
      });
      return rows.map((row) => skillFor(actor, row));
    },

    async get(actor: Actor, skillId: string): Promise<TaughtSkill> {
      const row = await getOwnedSkill(deps, actor, skillId);
      await expireTeachingSessionIfNeeded(deps, row.id);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      return skillFor(actor, current);
    },

    async start(actor: Actor, botId: string, goal: string): Promise<TaughtSkill> {
      let bot = await deps.prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId },
        include: { thread: true, computer: true },
      });
      if (!bot) throw new IsolationError();
      const alreadyRecording = await deps.prisma.taughtSkill.findFirst({
        where: { botId, status: "recording" },
        select: { id: true },
      });
      if (alreadyRecording) {
        throw new ORPCError("CONFLICT", { message: "A teaching session is already active" });
      }
      await assertComputerFreeFor(deps, actor, bot);
      await cancelActiveRuns(deps, actor, botId);
      bot = await ensureGraphicalComputer(deps, actor, bot);
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + teachRecordingTtlMs());
      const { leaseId } = await grantTakeover(deps, actor, bot);
      let row: TaughtSkillRow;
      try {
        row = await deps.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
          // The recording ends with its control, so it starts only while that control holds; the
          // lock keeps a release from ending it in between.
          const [control] = await tx.$queryRaw<Array<{ controlLeaseId: string | null }>>`
            SELECT "controlLeaseId" FROM computers WHERE id = ${bot.computer!.id} FOR UPDATE`;
          if (control?.controlLeaseId !== leaseId) {
            throw new ORPCError("CONFLICT", { message: "Could not take control of the computer" });
          }
          const existing = await tx.taughtSkill.findFirst({
            where: { botId, status: "recording" },
          });
          if (existing) {
            throw new ORPCError("CONFLICT", { message: "A teaching session is already active" });
          }
          return tx.taughtSkill.create({
            data: {
              spaceId: actor.spaceId,
              botId,
              userId: actor.userId,
              goal,
              status: "recording",
              startedAt,
              expiresAt,
              recording: { ...emptyRecording(), controlLeaseId: leaseId } as never,
              playbook: buildPlaybookFromRecording(goal, []) as never,
            },
          });
        });
      } catch (error) {
        if (error instanceof ORPCError) throw error;
        if (isUniqueViolation(error)) {
          throw new ORPCError("CONFLICT", { message: "A teaching session is already active" });
        }
        throw error;
      }
      await deps.jobs.enqueue(skillTeachingExpireJob(row.id, expiresAt));
      const withSnapshot = await captureTeachingSnapshot(deps, actor, bot, row);
      if (bot.thread) {
        await deps.events.append({
          spaceId: actor.spaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "skill.teaching.started",
          payload: { skillId: row.id, goal },
        });
      }
      return skillFor(actor, withSnapshot);
    },

    async appendEvent(
      actor: Actor,
      skillId: string,
      event: TeachRecordingEvent,
    ): Promise<TaughtSkill> {
      await getOwnedSkill(deps, actor, skillId, { recorder: true });
      await expireTeachingSessionIfNeeded(deps, skillId);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      if (current.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      const updated = await appendRecordingEvent(deps, skillId, event, { requireRecording: true });
      if (updated.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      return skillFor(actor, updated);
    },

    async snapshot(actor: Actor, skillId: string): Promise<TaughtSkill> {
      await getOwnedSkill(deps, actor, skillId, { recorder: true });
      await expireTeachingSessionIfNeeded(deps, skillId);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      if (current.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      const bot = await deps.prisma.bot.findUnique({
        where: { id: current.botId },
        include: { computer: true },
      });
      if (!bot) throw new IsolationError();
      const updated = await captureTeachingSnapshot(deps, actor, bot, current);
      return skillFor(actor, updated);
    },

    stop: (actor: Actor, skillId: string) => stopTeachingSession(deps, actor, skillId),

    async updateDraft(
      actor: Actor,
      skillId: string,
      input: { name?: string; playbook: SkillPlaybook },
    ): Promise<TaughtSkill> {
      const skill = await getOwnedSkill(deps, actor, skillId);
      if (skill.status !== "draft" && skill.status !== "saved") {
        throw new ORPCError("BAD_REQUEST", { message: "Skill is not editable yet" });
      }
      const row = await deps.prisma.taughtSkill.update({
        where: { id: skill.id },
        // The editor owns the playbook now, so routines run it only on the editor's accounts.
        data: {
          userId: actor.userId,
          ...handedOver(skill, actor),
          name: input.name ?? skill.name,
          playbook: input.playbook as never,
          status: skill.status === "saved" ? "saved" : "draft",
        },
      });
      await updateSkillDraftMessage(deps, actor, row, {
        name: row.name,
        playbook: parsePlaybook(row.playbook),
        status: row.status === "saved" ? "saved" : "draft",
      });
      return skillFor(actor, row);
    },

    async save(actor: Actor, skillId: string, name?: string): Promise<TaughtSkill> {
      const skill = await getOwnedSkill(deps, actor, skillId);
      if (skill.status !== "draft" && skill.status !== "saved") {
        throw new ORPCError("BAD_REQUEST", { message: "Finish recording before saving" });
      }
      const row = await deps.prisma.taughtSkill.update({
        where: { id: skill.id },
        data: {
          userId: actor.userId,
          ...handedOver(skill, actor),
          status: "saved",
          name: name ?? (skill.name || skill.goal.slice(0, 80)),
        },
      });
      const bot = await deps.prisma.bot.findUnique({
        where: { id: row.botId },
        include: { thread: true },
      });
      await updateSkillDraftMessage(deps, actor, row, {
        name: row.name,
        playbook: parsePlaybook(row.playbook),
        status: "saved",
      });
      if (bot?.thread) {
        await deps.events.append({
          spaceId: actor.spaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "skill.saved",
          payload: { skillId: row.id, name: row.name },
        });
      }
      return skillFor(actor, row);
    },

    async testRun(actor: Actor, skillId: string, prompt?: string): Promise<{ runId: string }> {
      const skill = await getOwnedSkill(deps, actor, skillId);
      if (skill.status !== "saved" && skill.status !== "draft") {
        throw new ORPCError("BAD_REQUEST", { message: "Skill must be saved or drafted first" });
      }
      const bot = await deps.prisma.bot.findUnique({
        where: { id: skill.botId },
        include: { thread: true },
      });
      if (!bot?.thread) throw new IsolationError();
      const playbook = parsePlaybook(skill.playbook);
      const taskPrompt =
        prompt ?? formatSkillRunPrompt(skill.name || skill.goal.slice(0, 80), playbook, true);
      const task = await deps.prisma.task.create({
        data: {
          spaceId: actor.spaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          userId: actor.userId,
          prompt: taskPrompt,
          status: "queued",
        },
      });
      const run = await deps.prisma.run.create({
        data: {
          spaceId: actor.spaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "skill",
        },
      });
      await deps.jobs.enqueue(runContinueJob(run.id));
      return { runId: run.id };
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const skill = await getOwnedSkill(deps, actor, skillId);
      // A saved skill is the space's; a live recording belongs to whoever is teaching it.
      if (skill.status === "recording" && skill.userId !== actor.userId) {
        throw new ORPCError("CONFLICT", { message: "Someone else is teaching this skill" });
      }
      await deps.prisma.taughtSkill.delete({ where: { id: skill.id } });
      if (skill.status === "recording") {
        await deps.jobs.cancel(skillTeachingExpireJobKey(skill.id));
        // Deleted first, so ending control finds no recording to post a draft card for.
        await releaseTeachingComputerControlForBot(
          deps,
          actor,
          skill.botId,
          parseRecording(skill.recording).controlLeaseId,
        );
      }
      return { ok: true as const };
    },

    expireTeachingSessionIfNeeded: (skillId: string) =>
      expireTeachingSessionIfNeeded(deps, skillId),

    async recordInput(
      actor: Actor,
      botId: string,
      mapped: TeachComputerInput,
    ): Promise<"recorded" | "idle" | "stale"> {
      return recordTeachingInputEvent(deps, actor, botId, mapped);
    },
  };
}
