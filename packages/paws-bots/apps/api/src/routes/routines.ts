import { ORPCError } from "@orpc/server";
import { routineJobKey, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import {
  finishRoutineHandover,
  parseRoutineWatch,
  stableStringify,
  validateRoutineWatch,
} from "@rakazo/adapters";
import { canonicalPiProviderId, ROUTINE_TRIGGER_REQUIRED } from "@rakazo/contracts";
import {
  expandSkillReferencesInPrompt,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
} from "@rakazo/core";
import { IsolationError, isRecordNotFound, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { assertEmailTrigger } from "../bot-email-address.js";
import { assertRoutineModel } from "../model-pins.js";
import { listRoutineRuns } from "../routine-runs.js";
import {
  assertRoutineSchedule,
  createRoutineTestRun,
  firstWatchCheck,
  listRoutinesDto,
  mapRoutine,
  nextRoutineDate,
  routineNextRunAt,
  routineRowData,
  routineTestRunNonce,
  routineTestTarget,
} from "../routines.js";
import type { RouterContext } from "./context.js";

export function routinesRoutes(ctx: RouterContext) {
  const { deps, repos, announceRoutine, codexCatalog, agentSkills, authed } = ctx;
  return {
    routines: {
      listForMentions: authed.routines.listForMentions.handler(async ({ context, input }) => {
        const { actor } = context;
        // Same ownership predicates as getBot, so a batch never widens what routines/list allows.
        const bots = await deps.prisma.bot.findMany({
          where: {
            id: { in: input.botIds },
            spaceId: actor.spaceId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const rows = await deps.prisma.routine.findMany({
          where: { botId: { in: bots.map((bot) => bot.id) }, spaceId: actor.spaceId },
        });
        return bots.map((bot) => ({
          botId: bot.id,
          routines: rows.filter((row) => row.botId === bot.id).map(mapRoutine),
        }));
      }),
      history: authed.routines.history.handler(async ({ context, input }) =>
        listRoutineRuns(deps.prisma, context.actor, input.routineId, input.before, input.limit),
      ),
      list: authed.routines.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listRoutinesDto(deps, context.actor, input.botId);
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        assertRoutineSchedule(input);
        const bot = await repos.getBot(context.actor, input.botId);
        if (input.watch) {
          try {
            await validateRoutineWatch(
              {},
              input.watch,
              { ...context.actor, botId: bot.id },
              bot.computer,
            );
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Invalid change trigger.",
            });
          }
        }
        if (input.emailSenders) {
          await assertEmailTrigger(deps.prisma, deps.env.inboundEmailDomain, bot.id);
        }
        await assertRoutineModel(deps, context.actor, input, codexCatalog);
        const row = await deps.prisma.routine.create({
          data: routineRowData(context.actor, input, routineNextRunAt(input)),
        });
        await announceRoutine(context.actor, bot, row);
        return mapRoutine(row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        // Archived bots keep their routines paused, so resolve an active parent before any write.
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            bot: { archivedAt: null },
          },
        });
        if (!existing) throw new ORPCError("NOT_FOUND");
        const bot = await repos.getBot(context.actor, existing.botId);
        const active = input.active ?? existing.active;
        const crons = input.crons ?? existing.crons;
        const timezone = input.timezone ?? existing.timezone;
        const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
        const githubEnabled = input.githubEnabled ?? existing.githubEnabled;
        const messageProvider =
          input.messageProvider === undefined ? existing.messageProvider : input.messageProvider;
        const emailSenders =
          input.emailSenders === undefined ? existing.emailSenders : input.emailSenders;
        if (input.emailSenders && input.emailSenders !== existing.emailSenders) {
          await assertEmailTrigger(deps.prisma, deps.env.inboundEmailDomain, bot.id);
        }
        const modelProvider =
          input.modelProvider === undefined ? existing.modelProvider : input.modelProvider;
        const modelId = input.modelId === undefined ? existing.modelId : input.modelId;
        const hasModel = Boolean(modelProvider && modelId);
        const modelChanged =
          canonicalPiProviderId(modelProvider ?? "") !==
            canonicalPiProviderId(existing.modelProvider ?? "") || modelId !== existing.modelId;
        const touchesModel =
          input.modelProvider !== undefined ||
          input.modelId !== undefined ||
          input.thinkingLevel !== undefined;
        if (Boolean(modelProvider) !== Boolean(modelId)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Model provider and model id must both be set or both cleared",
          });
        }
        if (input.thinkingLevel && !hasModel) {
          throw new ORPCError("BAD_REQUEST", { message: "Pick a model for this routine first" });
        }
        // A thinking level belongs to a model, so changing the model resets it.
        const thinkingLevel = !hasModel
          ? null
          : input.thinkingLevel === undefined
            ? modelChanged
              ? null
              : existing.thinkingLevel
            : input.thinkingLevel;
        if (modelChanged) {
          await assertRoutineModel(deps, context.actor, { modelProvider, modelId }, codexCatalog);
        }
        const watch = input.watch === undefined ? parseRoutineWatch(existing.watch) : input.watch;
        if (input.watch) {
          try {
            await validateRoutineWatch(
              {},
              input.watch,
              { ...context.actor, botId: bot.id },
              bot.computer,
            );
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Invalid change trigger.",
            });
          }
        }
        const watchChanged =
          input.watch !== undefined &&
          stableStringify(input.watch) !== stableStringify(parseRoutineWatch(existing.watch));
        if (
          crons.length === 0 &&
          !webhookEnabled &&
          !githubEnabled &&
          !messageProvider &&
          !emailSenders &&
          !watch
        ) {
          throw new ORPCError("BAD_REQUEST", { message: ROUTINE_TRIGGER_REQUIRED });
        }
        if (watch && crons.length > 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A change trigger checks on its own interval; remove the schedule",
          });
        }
        if (hasMixedOneShotSchedule(crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (active && isOneShotRoutineCrons(crons)) {
          if (!isOneShotRoutineCrons(existing.crons)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules must be created from chat.",
            });
          }
          if (!existing.nextRunAt && existing.lastRunAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "This one-shot already ran.",
            });
          }
        }
        const scheduleChanged =
          (!existing.active && active) ||
          (input.crons !== undefined &&
            JSON.stringify(input.crons) !== JSON.stringify(existing.crons)) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const recalculatedNextRunAt =
          crons.length > 0 &&
          !isOneShotRoutineCrons(crons) &&
          (scheduleChanged || (active && !existing.nextRunAt))
            ? nextRoutineDate(crons, timezone)
            : null;
        let armedOneShotAt: Date | null = null;
        if (active && isOneShotRoutineCrons(crons) && !existing.nextRunAt && !existing.lastRunAt) {
          if (!input.runAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Add a run time for this one-shot.",
            });
          }
          const parsed = new Date(input.runAt);
          if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Run time must be in the future.",
            });
          }
          armedOneShotAt = parsed;
        } else if (input.runAt !== undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A run time is only for one-shots that have not run yet.",
          });
        }
        const nextRunAt = !active
          ? null
          : watch
            ? // Turning a watch on, or changing it, checks right away; otherwise keep its rhythm.
              !existing.active || watchChanged || !existing.nextRunAt
              ? firstWatchCheck()
              : existing.nextRunAt
            : crons.length === 0
              ? null
              : isOneShotRoutineCrons(crons)
                ? (armedOneShotAt ?? existing.nextRunAt)
                : (recalculatedNextRunAt ?? existing.nextRunAt);
        const writesSchedule = nextRunAt?.getTime() !== existing.nextRunAt?.getTime();
        // An explicit on/off must not undo an enable, a disable or a finished one-shot that landed
        // after the read; neither may a schedule change computed from the old on/off state.
        const writesActive = input.active !== undefined || scheduleChanged || watchChanged;
        // Re-check the parent in the write itself so an archive that lands after the read wins.
        // Model and schedule patches must also match the snapshot they were computed from, so a
        // tick that fired after the read is not rewound onto an occurrence that already ran.
        const row = await deps.prisma.routine
          .update({
            where: {
              id: existing.id,
              bot: { archivedAt: null },
              // Optimistic fence: every write must match the snapshot it was
              // computed from, so concurrent edits never silently overwrite
              // each other's prompt/name/notify/any other field.
              updatedAt: existing.updatedAt,
              ...(touchesModel
                ? {
                    modelProvider: existing.modelProvider,
                    modelId: existing.modelId,
                    thinkingLevel: existing.thinkingLevel,
                  }
                : {}),
              ...(writesSchedule ? { nextRunAt: existing.nextRunAt } : {}),
              ...(writesActive ? { active: existing.active } : {}),
            },
            data: {
              // A routine runs with its owner's accounts, so whoever edits it takes it over.
              userId: context.actor.userId,
              name: input.name,
              prompt: input.prompt,
              crons: input.crons,
              timezone: input.timezone,
              active: input.active,
              notify: input.notify,
              webhookEnabled: input.webhookEnabled,
              githubEnabled: input.githubEnabled,
              messageProvider: input.messageProvider,
              emailSenders: input.emailSenders,
              ...(touchesModel ? { modelProvider, modelId, thinkingLevel } : {}),
              // A changed watch starts from a fresh baseline, and so does one that now reads
              // a different person's accounts.
              ...(input.watch === undefined
                ? {}
                : { watch: (input.watch as Prisma.InputJsonValue | null) ?? Prisma.DbNull }),
              ...(watchChanged || existing.userId !== context.actor.userId
                ? { watchState: Prisma.DbNull }
                : {}),
              ...(writesSchedule ? { nextRunAt } : {}),
            },
          })
          .catch(async (error: unknown) => {
            if (isRecordNotFound(error)) {
              if (
                await deps.prisma.routine.findFirst({
                  where: {
                    id: existing.id,
                    spaceId: context.actor.spaceId,
                    bot: { archivedAt: null },
                  },
                  select: { id: true },
                })
              ) {
                throw new ORPCError("CONFLICT", { message: "Routine changed; retry." });
              }
              throw new ORPCError("NOT_FOUND");
            }
            throw error;
          });
        if (existing.userId !== context.actor.userId) {
          await finishRoutineHandover(deps, {
            id: row.id,
            previousUserId: existing.userId,
            userId: context.actor.userId,
          });
        }
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.updated",
            payload: { routineId: row.id, active: row.active },
          });
        }
        const scheduleNeedsSync =
          existing.active !== row.active ||
          scheduleChanged ||
          watchChanged ||
          existing.nextRunAt?.getTime() !== row.nextRunAt?.getTime() ||
          (!existing.nextRunAt && !!row.nextRunAt);
        if (scheduleNeedsSync) {
          if (row.active && row.nextRunAt) {
            await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
          } else {
            await deps.jobs.cancel(routineJobKey(row.id));
          }
        }
        return mapRoutine(row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        // Any member can change a routine, so any member can delete one.
        const existing = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, spaceId: context.actor.spaceId },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.routine.delete({ where: { id: existing.id } });
        await deps.jobs.cancel(routineJobKey(existing.id));
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const target = await routineTestTarget(deps.prisma, repos, context.actor, input.routineId);
        const { threadId } = target;
        // The previous release stored the key without the user id; a retry still replays it.
        const keys = input.clientNonce
          ? [
              routineTestRunNonce(context.actor, input.clientNonce),
              `routine-test:${input.clientNonce}`,
            ]
          : [];
        const nonce = keys[0];
        const findExisting = async () =>
          keys.length
            ? deps.prisma.run.findFirst({
                where: { threadId, userId: context.actor.userId, clientNonce: { in: keys } },
                select: { id: true },
              })
            : null;
        const existing = await findExisting();
        if (existing) return { runId: existing.id };
        const skillRecords = await agentSkills.listWithContent(context.actor);
        const prompt = expandSkillReferencesInPrompt(target.routine.prompt, skillRecords);
        let run: { id: string };
        try {
          // Task + run must commit together so a nonce collision cannot leave an orphan queued Task.
          run = await deps.prisma.$transaction(async (tx) => {
            const existing = nonce
              ? await tx.run.findFirst({
                  where: { threadId, clientNonce: nonce },
                  select: { id: true },
                })
              : null;
            return existing ?? createRoutineTestRun(tx, context.actor, target, prompt, nonce);
          });
        } catch (error) {
          const existing = await findExisting();
          if (existing) return { runId: existing.id };
          throw error;
        }
        // Keep enqueue outside the nonce-collision catch. The queued run is durable;
        // log enqueue failures and still return success — the reconciler repairs a missed wake.
        await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          getLogger().error("routine testRun enqueue", error);
        });
        return { runId: run.id };
      }),
    },
  };
}
