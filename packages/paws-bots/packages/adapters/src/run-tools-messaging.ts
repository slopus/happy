import { posix } from "node:path";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  isBackgroundRunTrigger,
  redactSecrets,
  resolveBotAddress,
} from "@rakazo/core";
import {
  connectAgent,
  messageConnectedAgent,
  respondAgentConnection,
} from "./agent-connections.js";
import { startBackgroundHelper } from "./background-helpers.js";
import { messageBot } from "./bot-messages.js";
import { endCallFromTool, requestUserCall } from "./call-request.js";
import { normalizeWorkspacePath, resolveBotWorkspacePath } from "./computer-support.js";
import { handoffToGroupBot } from "./group-handoff.js";
import type { RunContext } from "./run-context.js";
import {
  canPostLongTaskHeadsUp,
  canPublishDurableProgress,
  flushProgress,
  progressSinceBudgetStart,
  publishInterimMessage,
  publishMidTurnNarration,
  showNarrationStatus,
} from "./run-progress.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import type { AttachmentBlock } from "./run-tools-files.js";
import { readWorkspaceFile, saveWorkspaceFile } from "./run-tools-files.js";
import {
  clampUserProgressMessage,
  isProgressMessageTruncated,
  MID_TURN_PROGRESS_MIN_TURN_AGE_MS,
  messageUserMaxLength,
  midTurnProgressBudgetUsed,
} from "./user-progress.js";

const ZIP_HELPS = new Set(["file not found or unreadable", "unsupported attachment type"]);

/** `recipientId` is the bot the files were prepared for; delivery must go to that same bot. */
type SentFiles = { files: AttachmentBlock[]; sharedPaths: string[]; recipientId?: string };

/**
 * Files a bot passes by path to another bot. A recipient on the same computer reads them
 * where they are. One elsewhere, or one that cannot be told apart, gets saved copies, filed
 * under the chat that shows them: its own, or the group's for a handoff. Every file is read
 * before any is saved, so a bad path leaves nothing behind.
 */
async function prepareSentFiles(
  ctx: RunContext,
  call: ToolCall,
  recipient: { botId?: string; name?: string; groupId?: string },
): Promise<{ error: string } | SentFiles> {
  const raw = call.args.files;
  if (raw === undefined || raw === null) return { files: [], sharedPaths: [] };
  if (!Array.isArray(raw) || raw.some((path) => typeof path !== "string" || !path.trim())) {
    return { error: "files must be a list of file paths" };
  }
  const paths = [...new Set(raw.map((path: string) => path.trim()))];
  if (!paths.length) return { files: [], sharedPaths: [] };
  if (paths.length > ATTACHMENT_MAX_COUNT) {
    return { error: `send at most ${ATTACHMENT_MAX_COUNT} files; zip the rest into one file` };
  }
  const target = await findRecipient(ctx, recipient);
  if (!target) return { error: "no bot found with that id or name. Nothing was sent." };
  const { bot } = ctx;
  if (
    bot.computerId &&
    !bot.computerSwitching &&
    !target.computerSwitching &&
    target.computerId === bot.computerId
  )
    return withRecipient(await sharedFiles(ctx, call, paths), target.id);
  const read: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const path of paths) {
    const file = await readWorkspaceFile(ctx, call, path);
    if ("error" in file) {
      // The recipient has its own computer, so a folder or raw source file has to travel zipped.
      const hint = ZIP_HELPS.has(file.error) ? "; zip it and send the zip" : "";
      return { error: `${path}: ${file.error}${hint}. Nothing was sent.` };
    }
    read.push({ path, bytes: file.bytes });
  }
  const owner = recipient.groupId
    ? { botId: bot.id, groupId: recipient.groupId }
    : { botId: target.id };
  const files: AttachmentBlock[] = [];
  for (const file of read) {
    try {
      files.push((await saveWorkspaceFile(ctx, call, file.path, file.bytes, owner)).block);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "could not save the file";
      return { error: `${file.path}: ${reason}. Nothing was sent.` };
    }
  }
  return { files, sharedPaths: [], recipientId: target.id };
}

function withRecipient(prepared: { error: string } | SentFiles, recipientId: string) {
  return "error" in prepared ? prepared : { ...prepared, recipientId };
}

/** The bot a message or handoff names, among the sender's bots or the group's members. */
async function findRecipient(
  ctx: RunContext,
  recipient: { botId?: string; name?: string; groupId?: string },
) {
  const { run, deps, bot } = ctx;
  const candidates = await deps.prisma.bot.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      archivedAt: null,
      ...(recipient.groupId ? { groupMembers: { some: { groupId: recipient.groupId } } } : {}),
    },
    select: { id: true, name: true, computerId: true, computerSwitching: true },
  });
  const target = resolveBotAddress(candidates, recipient);
  return target && target.id !== bot.id ? target : undefined;
}

/** Paths on the shared computer, checked to exist, as any bot on it can address them. */
async function sharedFiles(
  ctx: RunContext,
  call: ToolCall,
  paths: string[],
): Promise<{ error: string } | SentFiles> {
  let computer: Awaited<ReturnType<typeof ctx.computer.get>>;
  try {
    computer = await ctx.computer.get("tool", call.name);
  } catch {
    return { error: "could not reach your computer. Nothing was sent." };
  }
  const sharedPaths: string[] = [];
  for (const path of paths) {
    let stored: string;
    try {
      stored = normalizeWorkspacePath(resolveBotWorkspacePath(ctx.computer.mode, ctx.bot.id, path));
    } catch {
      return { error: `${path}: path is outside the computer. Nothing was sent.` };
    }
    const parent = posix.dirname(stored);
    // A folder that does not exist fails to list on real computers too, so a listing error
    // cannot be told apart from a wrong path; the error names both.
    const entries = await ctx.deps.sandbox
      .listFiles(computer, parent === "." ? "" : parent, ctx.context)
      .catch(() => undefined);
    if (!entries) {
      return {
        error: `${path}: not found, or your computer could not be read. Nothing was sent.`,
      };
    }
    if (!stored || !entries.some((entry) => normalizeWorkspacePath(entry.path) === stored)) {
      return { error: `${path}: not found. Nothing was sent.` };
    }
    // A path is shown verbatim, so one that holds a secret is refused rather than shown redacted.
    if (redactSecrets(stored, ctx.secrets) !== stored) {
      return { error: "one of the paths can't be shared. Nothing was sent." };
    }
    sharedPaths.push(stored);
  }
  return { files: [], sharedPaths };
}

/**
 * Checked before any file is read or copied: shared paths are added to the message, so a blank
 * one must be caught first, and an oversized one would leave copies behind for nothing.
 */
function messageError(ctx: RunContext, message: unknown): string | undefined {
  const text = redactSecrets(String(message ?? ""), ctx.secrets).trim();
  if (!text) return "message is required";
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return BOT_MESSAGE_TOO_LONG;
}

/**
 * The message as delivered: shared paths are listed where the recipient reads its task. The list
 * counts toward the message limit, so a message it would push over is refused with the room left.
 */
function deliveredMessage(
  ctx: RunContext,
  message: unknown,
  sharedPaths: string[],
): { error: string } | { message: string } {
  const text = redactSecrets(String(message ?? ""), ctx.secrets);
  if (!sharedPaths.length) return { message: text };
  const list = `\n\nFiles on our shared computer:\n${sharedPaths.map((path) => `- ${path}`).join("\n")}`;
  const room = BOT_MESSAGE_MAX_LENGTH - list.length;
  if (text.trim().length > room) {
    return {
      error: `with the file list added, the message must stay under ${Math.max(room, 0)} characters. Nothing was sent.`,
    };
  }
  return { message: `${text.trim()}${list}` };
}

/** Messages to the user, other bots and connected agents, and calls. */
export const messagingTools: ToolHandlers = {
  async call_user(ctx, call) {
    const { deps, run, thread } = ctx;
    const { args } = call;
    if (
      ctx.source.messagingChannelRun ||
      thread.groupId ||
      ctx.source.voiceCall ||
      isBackgroundRunTrigger(run.trigger)
    ) {
      return call.finish({ error: "Calls require a one-to-one chat." });
    }
    return call.finish(
      await requestUserCall(deps, run, {
        reason: String(args.reason ?? ""),
        opening: String(args.opening ?? ""),
      }),
    );
  },
  async end_call(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    return call.finish(
      await endCallFromTool(
        deps,
        run,
        thread.id,
        bot.id,
        args,
        ctx.source.callClientNonce,
        ctx.source.callEndRun,
      ),
    );
  },
  async request_takeover() {
    return { ok: true };
  },
  async run_subagent(ctx, call) {
    const { args } = call;
    if (args.background === true) {
      return call.finish(
        await startBackgroundHelper(ctx, {
          name:
            String(args.name ?? "helper")
              .trim()
              .slice(0, 80) || "helper",
          task: redactSecrets(String(args.task ?? "").trim(), ctx.secrets),
          instructions: redactSecrets(String(args.instructions ?? "").trim(), ctx.secrets),
          modelProvider: String(args.model_provider ?? "").trim(),
          modelId: String(args.model_id ?? "").trim(),
          executionId: call.executionId,
          effectKey: call.effectKey,
        }),
      );
    }
    return {
      ok: true,
      result: String(args.task ?? "done."),
    };
  },
  async message_user(ctx, call) {
    const { args } = call;
    const { reply } = ctx.state;
    const rawMessage = redactSecrets(String(args.message ?? ""), ctx.secrets);
    const maxLength = messageUserMaxLength();
    const text = clampUserProgressMessage(rawMessage, maxLength);
    if (!text) return call.finish({ error: "message is required" });
    const truncated = isProgressMessageTruncated(rawMessage, maxLength);
    await flushProgress(ctx);
    // Text written before an answer to the person's mid-task message doesn't use up the
    // allowance meant for that answer.
    const answering = reply.steeringReplyPending;
    reply.steeringReplyPending = false;
    await showNarrationStatus(ctx, await publishMidTurnNarration(ctx));
    // A mid-task message handled meanwhile may have granted a new allowance; keep it.
    reply.steeringReplyPending ||= answering;
    if (
      ctx.replyMode === "chat" &&
      !canPublishDurableProgress(reply) &&
      !canPostLongTaskHeadsUp(ctx)
    ) {
      return call.finish({
        ok: true,
        note: midTurnProgressBudgetUsed(progressSinceBudgetStart(reply))
          ? "This update was not posted. The chat already has enough interim messages for this run. Do not send more progress updates — keep working and put everything in your final reply."
          : `This update was not posted because the turn just started. Keep working and put anything the person needs in your final reply. Once the turn has run ${MID_TURN_PROGRESS_MIN_TURN_AGE_MS / 1000} seconds, a later update can be posted.`,
      });
    }
    await publishInterimMessage(ctx, text, true);
    // The person already has this message; notes written before it are no longer a missing answer.
    if (ctx.replyMode === "messages") {
      reply.workingNotes.length = 0;
      reply.lastDiscardedMidTurnNarration = "";
    }
    return call.finish(
      truncated
        ? {
            ok: true,
            truncated: true,
            note: `This progress update was cut off at ${maxLength} characters and the user only saw the truncated version above — it did NOT deliver your full content. message_user is for short interim beats only, never the final answer. Put your complete answer in your normal final reply instead of relying on this truncated update.`,
          }
        : { ok: true },
    );
  },
  async message_bot(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    const invalid = messageError(ctx, args.message);
    if (invalid) return call.finish({ error: invalid });
    const stored = await prepareSentFiles(ctx, call, {
      botId: args.bot_id ? String(args.bot_id) : undefined,
      name: args.confirm_name ? String(args.confirm_name) : undefined,
    });
    if ("error" in stored) return call.finish({ error: stored.error });
    const delivered = deliveredMessage(ctx, args.message, stored.sharedPaths);
    if ("error" in delivered) return call.finish({ error: delivered.error });
    const sent = await messageBot(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        bot_id: stored.recipientId ?? (args.bot_id ? String(args.bot_id) : undefined),
        confirm_name: stored.recipientId
          ? undefined
          : args.confirm_name
            ? String(args.confirm_name)
            : undefined,
        message: delivered.message,
        intent: args.intent as "request" | "result" | "question" | "status" | "fyi" | undefined,
        deliveryKey: effectKey,
        files: stored.files,
      },
    );
    if (!sent.ok) return call.finish({ error: sent.error });
    return call.finish({
      ok: true,
      botId: sent.botId,
      name: sent.name,
      note: sent.note,
    });
  },
  async connect_agent(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const result = await connectAgent(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      { address: args.address ? String(args.address) : undefined },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async respond_agent_connection(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const result = await respondAgentConnection(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        accept: Boolean(args.accept),
        connectionId: String(args.connection_id ?? ""),
        connectionVersion: Number(args.connection_version ?? 0),
      },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async message_agent(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    const result = await messageConnectedAgent(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        address: args.address ? String(args.address) : undefined,
        message: redactSecrets(String(args.message ?? ""), ctx.secrets),
        deliveryKey: effectKey,
      },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async handoff_to_bot(ctx, call) {
    const { deps, run, thread } = ctx;
    const { args, effectKey } = call;
    const groupId = args.group_id ? String(args.group_id).trim() : thread.groupId;
    if (!groupId) return call.finish({ error: "group_id is required outside a group chat" });
    const invalid = messageError(ctx, args.message);
    if (invalid) return call.finish({ error: invalid });
    const stored = await prepareSentFiles(ctx, call, {
      botId: args.bot_id ? String(args.bot_id) : undefined,
      name: args.confirm_name ? String(args.confirm_name) : undefined,
      groupId,
    });
    if ("error" in stored) return call.finish({ error: stored.error });
    const delivered = deliveredMessage(ctx, args.message, stored.sharedPaths);
    if ("error" in delivered) return call.finish({ error: delivered.error });
    const result = await handoffToGroupBot(deps, run, groupId, {
      bot_id: stored.recipientId ?? (args.bot_id ? String(args.bot_id) : undefined),
      confirm_name: stored.recipientId
        ? undefined
        : args.confirm_name
          ? String(args.confirm_name)
          : undefined,
      message: delivered.message,
      deliveryKey: effectKey,
      files: stored.files,
    });
    if ("ok" in result && result.ok && thread.groupId) ctx.state.handedOff = true;
    return call.finish(result);
  },
};
