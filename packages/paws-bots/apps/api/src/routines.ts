import { ORPCError } from "@orpc/server";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { parseRoutineWatch, parseRoutineWatchState, routineRunModelPin } from "@rakazo/adapters";
import type { Actor, CreateRoutineInput, Routine } from "@rakazo/contracts";
import { canonicalPiProviderId, RoutineEmailSendersSchema } from "@rakazo/contracts";
import {
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
  routineScheduleDelayed,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

export function assertRoutineSchedule(input: CreateRoutineInput): void {
  if (hasMixedOneShotSchedule(input.crons)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A one-time schedule can't be combined with other schedules.",
    });
  }
  if (input.active && isOneShotRoutineCrons(input.crons)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "One-shot schedules must be created from chat.",
    });
  }
}

export function routineNextRunAt(input: CreateRoutineInput): Date | null {
  // Validate every recurring cron even when inactive; @once and webhook-only have no next date.
  let nextRunAt: Date | null = null;
  if (input.crons.length > 0 && !isOneShotRoutineCrons(input.crons)) {
    const computedNextRunAt = nextRoutineDate(input.crons, input.timezone);
    nextRunAt = input.active ? computedNextRunAt : null;
  }
  // A change trigger takes its first reading right away; that reading is the baseline.
  if (input.watch && input.active) nextRunAt = firstWatchCheck();
  return nextRunAt;
}

export function routineRowData(actor: Actor, input: CreateRoutineInput, nextRunAt: Date | null) {
  return {
    spaceId: actor.spaceId,
    botId: input.botId,
    userId: actor.userId,
    name: input.name,
    prompt: input.prompt,
    crons: input.crons,
    timezone: input.timezone,
    notify: input.notify,
    active: input.active,
    webhookEnabled: input.webhookEnabled,
    githubEnabled: input.githubEnabled,
    messageProvider: input.messageProvider,
    emailSenders: input.emailSenders,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    ...(input.watch ? { watch: input.watch as Prisma.InputJsonValue } : {}),
    nextRunAt,
  };
}

export function nextRoutineDate(crons: string[], timezone: string): Date {
  let next: Date | null;
  try {
    next = nextCronDateAcrossStrict(crons, new Date(), timezone);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  }
  if (!next) throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  return next;
}

/** A new or re-armed watch takes its first reading a moment from now. */
export function firstWatchCheck(): Date {
  return new Date(Date.now() + 2_000);
}

export function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  emailSenders: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  watch: unknown;
  watchState: unknown;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}): Routine {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    webhookEnabled: row.webhookEnabled,
    githubEnabled: row.githubEnabled,
    messageProvider: row.messageProvider,
    emailSenders: RoutineEmailSendersSchema.safeParse(row.emailSenders).data ?? null,
    modelProvider: row.modelProvider ? canonicalPiProviderId(row.modelProvider) : null,
    modelId: row.modelId ?? null,
    thinkingLevel: (row.thinkingLevel as Routine["thinkingLevel"]) ?? null,
    watch: parseRoutineWatch(row.watch),
    watchState: parseRoutineWatchState(row.watchState),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    scheduleDelayed: routineScheduleDelayed({
      active: row.active,
      nextRunAt: row.nextRunAt?.getTime() ?? null,
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Any member may change a routine; editing it hands it to them (see routines.update). */
export async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId },
  });
  return rows.map(mapRoutine);
}

export function createRoutineAnnouncer(deps: RouterDeps) {
  const announceRoutine = async (
    actor: Actor,
    bot: { id: string; thread: { id: string } | null },
    row: Awaited<ReturnType<typeof deps.prisma.routine.create>>,
  ) => {
    if (bot.thread) {
      await deps.events.append({
        spaceId: actor.spaceId,
        threadId: bot.thread.id,
        botId: bot.id,
        type: "routine.created",
        payload: { name: row.name },
      });
    }
    if (row.active && row.nextRunAt) {
      await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
    }
  };
  return announceRoutine;
}

/** A routine in the caller's Space on a bot they may use, the check behind every routine test run. */
export async function routineTestTarget(
  prisma: PrismaClient,
  repos: RouterContext["repos"],
  actor: Actor,
  routineId: string,
) {
  const routine = await prisma.routine.findFirst({
    where: { id: routineId, spaceId: actor.spaceId },
  });
  if (!routine) throw new IsolationError();
  const bot = await repos.getBot(actor, routine.botId);
  if (!bot.thread) throw new IsolationError();
  return { routine, botId: bot.id, threadId: bot.thread.id };
}

/**
 * The run key of a test run. The caller's id keeps another member from ever taking it, and the
 * previous release wrote `routine-test:<client nonce>` as given, so it can never write this prefix.
 */
export function routineTestRunNonce(actor: Actor, clientNonce: string): string {
  return `routine-run:${actor.userId}:${clientNonce}`;
}

/** Task + run commit together; a run already saved under the nonce fails the insert. */
export async function createRoutineTestRun(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Awaited<ReturnType<typeof routineTestTarget>>,
  prompt: string,
  nonce: string | undefined,
) {
  const { routine, botId, threadId } = target;
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      userId: actor.userId,
      prompt,
      status: "queued",
    },
  });
  const currentModel = await tx.routine.findUnique({
    where: { id: routine.id },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!currentModel) throw new IsolationError();
  return tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "routine",
      routineId: routine.id,
      ...routineRunModelPin(currentModel),
      clientNonce: nonce,
    },
    select: { id: true, status: true },
  });
}
