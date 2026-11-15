import { BotSettingsValuesSchema } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  commitBotUpdate,
  createSpaceForMember,
  InstructionConflictError,
  InvalidSpaceNameError,
  isRecordNotFound,
  runAsSystem,
  SpaceLimitError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  writeBotInstructions,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { uncertainEffectResult } from "./approval-effect.js";
import { archiveSpawnedBot, spawnBot } from "./child-bots.js";
import {
  createChildRoutine,
  createFleetGroup,
  listFleet,
  organizeBot,
  setChildBotModel,
  setChildInstructions,
  updateChildBot,
  updateFleetGroup,
  updateOwnBotFromTool,
} from "./fleet-tools.js";
import {
  listDefaultVoices,
  prepareOwnBotSettings,
  readOwnBotSettings,
} from "./own-bot-settings.js";
import type { RunContext } from "./run-context.js";
import {
  OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR,
  OWN_INSTRUCTIONS_CHANGED_ERROR,
} from "./run-context.js";
import { mayOpenModelStream } from "./run-lifecycle.js";
import { publishMessage } from "./run-messages.js";
import { fleetPrepareDeps } from "./run-model.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argumentGiven, ignoredFieldsNote } from "./update-bot-patch.js";

async function archiveBot(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread, context } = ctx;
  const { name, args } = call;
  const archived = await archiveSpawnedBot(
    deps,
    {
      spawnedByBotId: bot.id,
      userId: run.userId,
      spaceId: run.spaceId,
      confirmName: String(args.confirm_name ?? args.confirmName ?? ""),
      botId: args.bot_id ? String(args.bot_id) : args.botId ? String(args.botId) : undefined,
    },
    context,
  );
  if ("error" in archived) return call.finish(archived);
  if (!(await call.persistEffectResult(archived))) return uncertainEffectResult(name);
  try {
    await publishMessage(deps, run, "bot", [
      {
        kind: "child_bot",
        botId: archived.botId,
        name: archived.name,
        status: "archived",
      },
    ]);
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      type: "bot.archived",
      payload: { childBotId: archived.botId, name: archived.name },
    });
  } catch (error) {
    getLogger().error("archived bot notification", error);
  }
  return archived;
}

/** Writes this bot's instructions quietly; earlier versions stay restorable in its settings. */
async function commitOwnInstructions(
  ctx: RunContext,
  input: {
    instructions: string;
    reason: string;
    previousInstructions: string | undefined;
  },
): Promise<{ ok: true } | { error: string }> {
  // A checkpoint that predates the baseline leaves the attempt without the text its rewrite
  // was built from, and an approval proposed back then stored a fresh read instead. Refuse
  // both rather than guess or overwrite what the rewrite never saw.
  if (ctx.state.ownInstructionsBaseline === undefined || input.previousInstructions === undefined)
    return { error: OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR };
  const { deps, run, runId, context } = ctx;
  const botId = ctx.bot.id;
  const previousInstructions = input.previousInstructions;
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
    const live = await tx.run.findUnique({ where: { id: runId } });
    if (!mayOpenModelStream(live, ctx.workerId, ctx.fence, context.signal.aborted)) {
      throw new Error("Instruction update run is no longer active.");
    }
    let undoVersionId: string | null;
    try {
      undoVersionId = await writeBotInstructions(tx, {
        botId,
        instructions: input.instructions,
        reason: input.reason,
        expectedInstructions: previousInstructions,
      });
    } catch (error) {
      if (!(error instanceof InstructionConflictError)) throw error;
      // Re-reading cannot rebase this attempt, so point the model at a fresh run.
      return { error: OWN_INSTRUCTIONS_CHANGED_ERROR };
    }
    if (!undoVersionId) return null;
    const bot = await tx.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { name: true, description: true },
    });
    return appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId,
      runId,
      type: "bot.updated",
      payload: { botId, name: bot.name, description: bot.description },
    });
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed && "error" in committed) return committed;
  if (committed)
    await deps.events
      .notify(run.threadId, committed.seq)
      .catch((error) => getLogger().error("instruction update realtime notification", error));
  ctx.state.ownInstructionsBaseline = input.instructions;
  return { ok: true };
}

/** This bot's own settings, Spaces and the bots this bot manages. */
export const fleetTools: ToolHandlers = {
  async create_space(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    try {
      // The new Space's rows are outside the run's tenant until it exists.
      const space = await runAsSystem("create a Space for its member", () =>
        createSpaceForMember(deps.prisma, {
          currentSpaceId: run.spaceId,
          userId: run.userId,
          name: String(args.name ?? ""),
        }),
      );
      return call.finish({ ok: true, spaceId: space.id, name: space.name });
    } catch (error) {
      if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
        return call.finish({ error: error.message });
      }
      throw error;
    }
  },
  async spawn_bot(ctx, call) {
    const { deps, run, runId, bot, thread } = ctx;
    const { name, args, effectKey } = call;
    const computerModeArg = args.computer_mode;
    let computerMode: "team" | "dedicated" | undefined;
    if (computerModeArg != null && computerModeArg !== "") {
      const value = String(computerModeArg);
      if (value !== "team" && value !== "dedicated") {
        return call.finish({
          error: 'computer_mode must be "team" or "dedicated".',
        });
      }
      computerMode = value;
    }
    const spawned = await spawnBot(deps, {
      spawnedBy: {
        id: bot.id,
        name: bot.name,
        spaceId: bot.spaceId,
        userId: run.userId,
      },
      runId,
      spawnKey: effectKey,
      name: String(args.name ?? ""),
      description: args.description ? String(args.description) : undefined,
      instructions: args.instructions ? String(args.instructions) : undefined,
      prompt: args.prompt ? String(args.prompt) : undefined,
      computerMode,
    });
    if ("error" in spawned) return call.finish(spawned);
    if (!(await call.persistEffectResult(spawned))) return uncertainEffectResult(name);
    try {
      await publishMessage(deps, run, "bot", [
        {
          kind: "child_bot",
          botId: spawned.botId,
          name: spawned.name,
          status: "created",
        },
      ]);
      await deps.events.append({
        spaceId: run.spaceId,
        threadId: thread.id,
        botId: bot.id,
        runId: run.id,
        type: "bot.spawned",
        payload: { childBotId: spawned.botId, name: spawned.name },
      });
    } catch (error) {
      getLogger().error("spawned bot notification", error);
    }
    return spawned;
  },
  async list_fleet(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await listFleet(await fleetPrepareDeps(deps, ctx.run), ctx.fleetRun, args));
  },
  async organize_bot(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await organizeBot({ ...deps, runSecrets: ctx.secrets }, ctx.fleetRun, args));
  },
  // Replay hands these the canonical request stored with the approved effect.
  async create_group(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await createFleetGroup(deps, ctx.fleetRun, args));
  },
  async update_group(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await updateFleetGroup(deps, ctx.fleetRun, args));
  },
  async set_child_instructions(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await setChildInstructions(deps, ctx.fleetRun, args));
  },
  async set_child_bot_model(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const modelDeps = { ...(await fleetPrepareDeps(deps, run)), events: deps.events };
    return call.finish(await setChildBotModel(modelDeps, ctx.fleetRun, args));
  },
  async create_child_routine(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    return call.finish(await createChildRoutine(deps, ctx.fleetRun, args));
  },
  async update_bot(ctx, call) {
    const { deps, run, bot, thread, context } = ctx;
    const { args } = call;
    if (argumentGiven(args.bot_id)) {
      return call.finish(
        await updateChildBot({ ...deps, runSecrets: ctx.secrets }, ctx.fleetRun, args),
      );
    }
    // A held change (see prepareOwnBotUpdate) runs only once the owner or Auto Review approves it.
    if (typeof args.previousInstructions === "string") {
      if ((call.nextApprovedTool !== call.name && !call.bypassApproval) || !call.claimedEffect)
        return call.finish({ error: "This instruction change needs the owner's approval." });
      // A request stored before the baseline kept a fresh read as its expected text. Without
      // the marker it must not commit, whatever the resumed checkpoint restored.
      if (args.previousInstructionsFromBaseline !== true)
        return call.finish({ error: OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR });
      return call.finish(
        await commitOwnInstructions(ctx, {
          instructions: String(args.instructions),
          reason: String(args.reason),
          previousInstructions: args.previousInstructions,
        }),
      );
    }
    const { instructions, model, thinkingLevel, readAloud, voice, ...profile } = args;
    const modelDeps = await fleetPrepareDeps(deps, run);
    const live = await deps.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: {
        name: true,
        description: true,
        instructions: true,
        color: true,
        notifyOnFinish: true,
        dailyCheckIns: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
        autoSpeak: true,
        voiceId: true,
      },
    });
    // `instructions_offset` pages through long instructions on a read; it is not a write field.
    const instructionsOffsetArg = args.instructions_offset ?? args.instructionsOffset;
    const writeArgs = { ...args, instructions_offset: undefined, instructionsOffset: undefined };
    const read = !Object.values(writeArgs).some(argumentGiven);
    let readOffset = 0;
    // A paged read that also filled in other fields is still a read: a change never pages.
    // Name what was left out, so a real change can be sent again without the offset.
    let ignored: string | undefined;
    if (argumentGiven(instructionsOffsetArg)) {
      const parsedOffset = Number(instructionsOffsetArg);
      if (!Number.isInteger(parsedOffset) || parsedOffset < 0)
        return call.finish({ error: "instructions_offset must be a whole number of 0 or more." });
      readOffset = parsedOffset;
      ignored = ignoredFieldsNote(writeArgs);
    }
    if (read || ignored) {
      // A read does not rebase the baseline: the text it returns has not shaped a model
      // generation yet, and a truncated read would guard on text the model never saw.
      if (readOffset > 0 && readOffset >= live.instructions.length)
        return call.finish({ error: "instructions_offset is past the end of your instructions." });
      const settings = await readOwnBotSettings(modelDeps, run, live, readOffset);
      return call.finish(
        ignored && settings && typeof settings === "object" && !("error" in settings)
          ? { ...settings, ignoredFields: ignored }
          : settings,
      );
    }
    const settings = await prepareOwnBotSettings(
      modelDeps,
      run,
      live,
      { model, thinkingLevel, readAloud, voice },
      () => listDefaultVoices(deps, run, context),
    );
    if ("error" in settings) return call.finish(settings);
    const before = BotSettingsValuesSchema.parse(
      Object.fromEntries(
        Object.keys(settings.data).map((key) => [key, live[key as keyof typeof settings.data]]),
      ),
    );
    // The profile goes first, so a rejected field leaves everything else unchanged for a retry.
    const updated = Object.values(profile).some(argumentGiven)
      ? await updateOwnBotFromTool(deps, run, thread.id, bot, profile, context)
      : undefined;
    if (updated && "error" in updated) return call.finish(updated);
    if (
      Object.entries(settings.data).some(
        ([key, value]) => before[key as keyof typeof before] !== value,
      )
    ) {
      try {
        await commitBotUpdate({
          prisma: deps.prisma,
          notify: (threadId, seq) => deps.events.notify(threadId, seq),
          spaceId: run.spaceId,
          threadId: thread.id,
          botId: bot.id,
          emitBotUpdated: true,
          expectedSettings: before,
          data: settings.data,
        });
      } catch (error) {
        if (!isRecordNotFound(error)) throw error;
        return call.finish({ error: "Your settings changed meanwhile; read them and try again." });
      }
      await publishMessage(deps, run, "bot", [
        {
          kind: "ask",
          text: "Settings updated",
          status: "answered",
          settingsUpdate: { botId: bot.id, before, after: settings.data },
        },
      ]).catch((error) => getLogger().error("settings update card", error));
    }
    if (argumentGiven(instructions)) {
      const set = await commitOwnInstructions(ctx, {
        instructions: String(instructions),
        reason: "Set in chat",
        // The text the model worked from, not a fresh read: a change that landed since the
        // attempt started conflicts instead of being overwritten, and a checkpoint that
        // predates the baseline makes the commit itself refuse.
        previousInstructions: ctx.state.ownInstructionsBaseline,
      });
      if ("error" in set)
        return call.finish({
          error: `${updated || Object.keys(settings.data).length ? "Your other changes were saved, but your instructions were not: " : ""}${set.error}`,
        });
    }
    return call.finish({
      ok: true,
      ...updated,
      ...(settings.data.modelId !== undefined
        ? { model: `${settings.data.modelProvider}/${settings.data.modelId}` }
        : {}),
      ...(settings.data.thinkingLevel !== undefined
        ? { thinkingLevel: settings.data.thinkingLevel ?? "default" }
        : {}),
      ...(settings.data.autoSpeak !== undefined ? { readAloud: settings.data.autoSpeak } : {}),
      ...(settings.data.voiceId !== undefined ? { voice: settings.data.voiceId ?? "default" } : {}),
      ...(argumentGiven(instructions) ? { instructions: "updated" } : {}),
    });
  },
  archive_bot: archiveBot,
};
