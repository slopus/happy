import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  MessagingInboundMessage,
  MessagingSurface,
  TeamChatInboundMessage,
  TeamChatMessageKind,
  TeamChatSendRequest,
  TeamChatSendResult,
} from "@rakazo/adapter-kit";

/** Map a Chat SDK inbound message into a team-chat event, or null if empty. */
export function toTeamChatInbound(event: MessagingInboundMessage): TeamChatInboundMessage | null {
  const mediaUrl = event.attachments?.length ? "" : event.mediaUrl?.trim();
  const mediaLine = mediaUrl ? `\n${mediaUrl}` : "";
  const content = `${event.content}${mediaLine}`.trim();
  if (!content && !event.attachments?.length) return null;

  const kind: TeamChatMessageKind = event.isDirect
    ? "direct"
    : (event.kind ?? (looksLikeMention(event.content, event.channelName) ? "mention" : "ambient"));

  return {
    eventId: event.handle,
    workspaceId: event.workspaceId ?? event.provider,
    kind,
    conversationKey: event.conversationKey ?? event.threadId,
    conversationId: event.threadId,
    conversationName: event.channelName ?? undefined,
    participantNames: event.participantNames?.length
      ? event.participantNames
      : event.participants.length
        ? event.participants
        : undefined,
    replyThreadId: event.replyThreadId ?? null,
    senderId: event.from,
    senderName: event.fromLabel?.trim() || event.from,
    senderIsBot: event.senderIsBot,
    content,
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
  };
}

function looksLikeMention(content: string, channelName: string | null): boolean {
  if (channelName == null && !content.includes("@")) return false;
  return /(^|\s)@[\w.-]+/.test(content);
}

/**
 * Chat SDK Slack thread ids are `slack:CHANNEL:threadTs`. Team-chat stores the
 * room conversation id separately from the in-channel reply thread, so outbound
 * sends must recombine them when a reply thread is present.
 */
export function resolveMessagingThreadId(
  conversationId: string,
  replyThreadId: string | null,
): string {
  if (!replyThreadId) return conversationId;
  if (conversationId.endsWith(`:${replyThreadId}`)) return conversationId;
  const parts = conversationId.split(":");
  // provider:channel[:existingTs] → provider:channel:replyThreadId
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0]}:${parts[1]}:${replyThreadId}`;
  }
  return `${conversationId}:${replyThreadId}`;
}

export const TEAM_CHAT_THREAD_HISTORY_LIMIT = 50;
const THREAD_HISTORY_TIMEOUT_MS = 1_000;

export function createMessagingTeamChatHistory(
  messaging: MessagingSurface,
): ((message: TeamChatInboundMessage) => Promise<TeamChatInboundMessage[]>) | undefined {
  const fetchThreadHistory = messaging.fetchThreadHistory?.bind(messaging);
  if (!fetchThreadHistory) return undefined;
  return async (message) => {
    if (!message.replyThreadId) return [];
    const operationId = `team-chat-history:${randomUUID()}`;
    const history = await fetchThreadHistory(
      resolveMessagingThreadId(message.conversationId, message.replyThreadId),
      { before: message.eventId, limit: TEAM_CHAT_THREAD_HISTORY_LIMIT },
      {
        operationId,
        traceId: operationId,
        spaceId: "",
        userId: "",
        signal: AbortSignal.timeout(THREAD_HISTORY_TIMEOUT_MS),
      },
    );
    return history.flatMap((event) => {
      const mapped = toTeamChatInbound(event);
      if (!mapped) return [];
      return [
        {
          ...mapped,
          kind: "ambient" as const,
          workspaceId: message.workspaceId,
          conversationKey: message.conversationKey,
          conversationId: message.conversationId,
          conversationName: message.conversationName,
          replyThreadId: message.replyThreadId,
        },
      ];
    });
  };
}

export function createMessagingTeamChatSender(
  messaging: MessagingSurface,
): (request: TeamChatSendRequest) => Promise<TeamChatSendResult> {
  return async (request) => {
    const operationId = request.idempotencyKey
      ? `team-chat-send:${request.idempotencyKey}`
      : `team-chat-send:${randomUUID()}`;
    const context: AdapterContext = {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: new AbortController().signal,
    };
    const sent = await messaging.sendToThread(
      {
        threadId: resolveMessagingThreadId(request.conversationId, request.replyThreadId),
        body: request.content,
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      },
      context,
    );
    return { handle: sent.handle };
  };
}
