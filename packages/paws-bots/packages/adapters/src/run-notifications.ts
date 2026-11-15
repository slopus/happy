import type { NotificationMessage } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  displayName,
  isBackgroundRunTrigger,
  plainTextFromMarkdown,
  redactSecrets,
  truncatedPlainText,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { countUnreadInboxChats, membersSnoozing } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { notificationIdentity } from "./notification-identity.js";
import { messageBlocksText } from "./run-replies.js";

const COMPLETION_NOTIFICATION_MAX_CHARS = 180;
const NOTIFY_RECIPIENTS_AT_ONCE = 5;

export async function runNotificationsEnabled(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
): Promise<boolean> {
  return (await runNotice(prisma, run)).enabled;
}

async function runNotice(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
  routineId?: string | null,
): Promise<{
  enabled: boolean;
  groupId: string | null;
  bot?: { id: string; name: string; color: string; avatarSet: string };
}> {
  // A routine carries its own notify setting, which decides on its failures.
  const routine = routineId
    ? await prisma.routine.findUnique({ where: { id: routineId }, select: { notify: true } })
    : null;
  const source = await prisma.run.findFirst({
    where: {
      botId: run.botId,
      threadId: run.threadId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
    select: {
      bot: { select: { id: true, name: true, color: true, avatarSet: true, notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });
  if (!source) return { enabled: false, groupId: null };
  return {
    enabled: routine ? routine.notify : Boolean(source.thread.groupId || source.bot.notifyOnFinish),
    groupId: source.thread.groupId,
    bot: source.bot,
  };
}

export async function notifyRun(
  deps: ExecutorDeps,
  run: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
    routineId?: string | null;
  },
  message: NotificationMessage,
  options: { retryOnFailure?: boolean } = {},
) {
  if (
    (!deps.notifications && !deps.events.publishChatAlert) ||
    (isBackgroundRunTrigger(run.trigger) && message.kind !== "help" && message.kind !== "takeover")
  )
    return;
  const routineId = message.kind === "failure" ? run.routineId : null;
  const notice = await runNotice(deps.prisma, run, routineId).catch((error) => {
    if (options.retryOnFailure) throw error;
    getLogger().error("notification preference lookup", error);
    return null;
  });
  if (!notice?.enabled) return;
  // A reply is news to everyone in the Space. Only the person whose run it is can answer its
  // questions, take its screen, or fix what made it fail, and a reply to another bot is theirs.
  const recipients =
    message.kind === "completion" && run.trigger !== "bot_message"
      ? await spaceMemberIds(deps.prisma, run.spaceId).catch((error) => {
          if (options.retryOnFailure) throw error;
          getLogger().error("notification recipients", error);
          return [run.userId];
        })
      : [run.userId];
  await deliverChatNotice(deps, {
    spaceId: run.spaceId,
    recipients,
    message,
    groupId: notice.groupId,
    bot: notice.bot,
    retryOnFailure: options.retryOnFailure,
  });
}

/**
 * Another member's message in a chat: everyone else in the Space hears about it, as they would a
 * reply. Nothing goes to the person who wrote it, or anywhere when the chat is muted.
 */
export async function notifyMemberMessage(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "notifications">,
  input: { spaceId: string; threadId: string; authorUserId: string; text: string },
) {
  if (!deps.notifications && !deps.events.publishChatAlert) return;
  const recipients = (await spaceMemberIds(deps.prisma, input.spaceId)).filter(
    (userId) => userId !== input.authorUserId,
  );
  if (!recipients.length) return;
  const [thread, author] = await Promise.all([
    deps.prisma.thread.findFirst({
      where: { id: input.threadId, spaceId: input.spaceId, externalConversationId: null },
      select: {
        bot: {
          select: { id: true, name: true, color: true, avatarSet: true, notifyOnFinish: true },
        },
        group: {
          select: {
            name: true,
            members: {
              orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
              take: 1,
              select: { botId: true },
            },
          },
        },
        groupId: true,
      },
    }),
    deps.prisma.user.findUnique({ where: { id: input.authorUserId }, select: { name: true } }),
  ]);
  const botId = thread?.bot?.id ?? thread?.group?.members[0]?.botId;
  if (!thread || !botId || (!thread.groupId && !thread.bot?.notifyOnFinish)) return;
  const chatName = thread.group?.name ?? thread.bot?.name ?? "";
  const authorName = displayName(author?.name ?? "", "Someone");
  await deliverChatNotice(deps, {
    spaceId: input.spaceId,
    recipients,
    message: {
      // Reads like a reply: new in the chat, nothing to act on.
      kind: "completion",
      title: displayName(chatName, "Chat"),
      body: completionNotificationPreview(`${authorName}: ${input.text}`),
      botId,
      threadId: input.threadId,
    },
    groupId: thread.groupId,
    bot: thread.groupId ? undefined : (thread.bot ?? undefined),
  });
}

/** Everyone in the Space. Leaving it ends their notifications from it. */
async function spaceMemberIds(prisma: PrismaClient, spaceId: string): Promise<string[]> {
  const members = await prisma.spaceMember.findMany({
    where: { spaceId },
    select: { userId: true },
  });
  return members.map((member) => member.userId);
}

/** Alerts open apps and pushes to each recipient's devices, with their own unread count. */
async function deliverChatNotice(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "notifications">,
  input: {
    spaceId: string;
    recipients: string[];
    message: NotificationMessage;
    groupId: string | null;
    bot?: { id: string; name: string; color: string; avatarSet: string };
    retryOnFailure?: boolean;
  },
) {
  const { spaceId, message, groupId, bot } = input;
  // News in a chat waits for whoever snoozed it. Questions, takeovers and failures still reach
  // the person whose run it is: the chat is hidden, so this is how they would hear of it.
  const snoozing =
    message.kind === "completion"
      ? await membersSnoozing(deps.prisma, message.threadId, input.recipients).catch((error) => {
          // A retried delivery waits for the answer; otherwise everyone hears, rather than no one.
          if (input.retryOnFailure) throw error;
          getLogger().error("snoozed chat lookup", error);
          return new Set<string>();
        })
      : new Set<string>();
  const recipients = input.recipients.filter((userId) => !snoozing.has(userId));
  for (const userId of recipients) {
    publishChatAlert(deps.events, { spaceId, userId }, message, groupId);
  }
  const notifications = deps.notifications;
  if (!notifications || !recipients.length) return;
  const sender = bot && (await notificationIdentity(bot));
  const deliver = async (userId: string) => {
    // The icon shows what the inbox shows: unread chats across the user's Spaces. Without a
    // count the push leaves the badge as it is.
    const badge = await countUnreadInboxChats(deps.prisma, { spaceId, userId }).catch((error) => {
      getLogger().error("unread chat count", error);
      return undefined;
    });
    return notifications
      .send(
        {
          ...message,
          ...(sender ? { sender } : {}),
          ...(groupId ? { groupId } : {}),
          ...(badge === undefined ? {} : { badge }),
        },
        {
          operationId: "notify",
          traceId: message.botId,
          spaceId,
          userId,
          botId: message.botId,
          signal: new AbortController().signal,
        },
      )
      .then(
        () => undefined,
        (error: unknown) => {
          getLogger().error("run notification", error);
          return { error };
        },
      );
  };
  // A few members at a time, so a large Space does not take the whole connection pool at once.
  const failures: Array<{ error: unknown } | undefined> = [];
  for (let start = 0; start < recipients.length; start += NOTIFY_RECIPIENTS_AT_ONCE) {
    const batch = recipients.slice(start, start + NOTIFY_RECIPIENTS_AT_ONCE);
    failures.push(...(await Promise.all(batch.map(deliver))));
  }
  const failed = failures.find((failure) => failure !== undefined);
  if (failed && input.retryOnFailure) throw failed.error;
}

/** Open apps alert from the same message. Not awaited, so it never holds up the push. */
export function publishChatAlert(
  events: Pick<ThreadEvents, "publishChatAlert"> | undefined,
  run: { spaceId: string; userId: string },
  message: NotificationMessage,
  groupId: string | null,
) {
  void (async () =>
    events?.publishChatAlert?.(run.userId, {
      kind: message.kind,
      title: truncatePlainText(message.title, COMPLETION_NOTIFICATION_MAX_CHARS),
      body: truncatePlainText(message.body, COMPLETION_NOTIFICATION_MAX_CHARS),
      spaceId: run.spaceId,
      botId: message.botId,
      threadId: message.threadId,
      ...(groupId ? { groupId } : {}),
    }))().catch((error) => getLogger().error("chat alert publish", error));
}

export function runSendsFinishNotification(trigger: string): boolean {
  // A background helper's result is announced by the turn that passes it on.
  return (
    trigger !== "created" &&
    trigger !== BACKGROUND_HELPER_TRIGGER &&
    !isBackgroundRunTrigger(trigger)
  );
}

/** User-facing text for completion notifications; empty when only tool/step activity remains. */
export function completionNotificationBody(assembled: string, blocks: MessageBlock[]): string {
  if (assembled) return assembled;
  return messageBlocksText(blocks);
}

/** Push body: Markdown stripped, then truncated so a cut cannot land inside a marker. */
export function completionNotificationPreview(text: string): string {
  return truncatedPlainText(text, COMPLETION_NOTIFICATION_MAX_CHARS);
}

/** A secret card can ask for a code or a login, so the title stays generic and the label short. */
export function secretAskNotification(botName: string, label: string, runSecrets: string[]) {
  // Strip and redact before shortening so no protected value is left half-shown.
  const text = plainTextFromMarkdown(redactSecrets(label, runSecrets), { maxSource: Infinity });
  const body = truncatePlainText(
    redactSecrets(text, runSecrets),
    COMPLETION_NOTIFICATION_MAX_CHARS,
  );
  return { title: `${botName} needs an answer`, body };
}

export function completionMarksUnread(
  trigger: string,
  text: string,
  userFacingPeerReply = false,
): boolean {
  if (trigger === "bot_message") return userFacingPeerReply;
  if (isBackgroundRunTrigger(trigger)) return false;
  return (trigger !== "routine" && trigger !== "reaction") || Boolean(text);
}

export function subagentMarksUnread(
  trigger: string,
  status: "running" | "completed" | "failed",
  userFacingPeerReply = false,
) {
  if (isBackgroundRunTrigger(trigger)) return false;
  return (
    status === "failed" ||
    (trigger === "bot_message" && userFacingPeerReply) ||
    (trigger !== "routine" && trigger !== "bot_message")
  );
}
