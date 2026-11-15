import type {
  JobPublisher,
  MessagingInboundAttachment,
  TeamChatInboundMessage,
} from "@rakazo/adapter-kit";
import { teamChatEngageJob } from "@rakazo/adapter-kit";
import type { TeamChat } from "@rakazo/adapters";
import {
  TEAM_CHAT_ENGAGE_BACKUP_MS,
  TEAM_CHAT_ROUTING_MS,
  teamChatAttachmentNonce,
} from "@rakazo/adapters";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { storeInboundAttachments } from "./inbound-attachments.js";
import type { MessagingReceipts } from "./messaging-receipts.js";

export interface TeamChatBridgeDeps {
  prisma: PrismaClient;
  teamChat: Pick<TeamChat, "mirrorTranscript" | "startAgentRun" | "scheduleAmbientIn">;
  jobs: Pick<JobPublisher, "enqueueIn">;
  fetchThreadHistory?: (message: TeamChatInboundMessage) => Promise<TeamChatInboundMessage[]>;
  storeAttachment?: InboundAttachmentStore;
  providerId: string;
  botId: string;
  workspaceId?: string;
  isAvailable?: () => Promise<boolean>;
  acknowledge?: MessagingReceipts["acknowledge"];
}

type TargetBot = { id: string; spaceId: string; userId: string };

export type TeamChatInboundTarget = {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  externalMessageId: string;
  /** Routine routing owns the message until it settles or its time runs out. */
  deferred: boolean;
};

/**
 * One workspace's team chat for one bot, as seen by the API process its webhooks reach. Each
 * message is recorded with the job that backs it up, mirrored into the bot's Rakazo thread, and
 * answered at once: a direct message or mention starts its agent run here, an ambient one waits
 * for its conversation's scheduled decision, and a deferred one goes to routine routing first.
 */
export class TeamChatBridge {
  private readonly threadBackfills = new Map<string, Promise<void>>();
  private target: Promise<TargetBot> | undefined;

  constructor(private readonly deps: TeamChatBridgeDeps) {}

  /** Provider used for ExternalConversation rows and routine wake nonces. */
  get providerId(): string {
    return this.deps.providerId;
  }

  async receive(
    message: TeamChatInboundMessage,
    options: { defer?: boolean } = {},
  ): Promise<TeamChatInboundTarget> {
    if (this.deps.workspaceId && message.workspaceId !== this.deps.workspaceId)
      throw new Error("Messaging workspace mismatch");
    if (this.deps.isAvailable && !(await this.deps.isAvailable()))
      throw new Error("Messaging workspace unavailable");
    await this.backfillThreadHistory(message);
    const conversation = await this.upsertConversation(message);
    const status = options.defer
      ? "deferred"
      : message.kind === "ambient"
        ? "observed"
        : "received";
    const recorded = await this.record(conversation, message, status);
    if (message.kind !== "ambient") {
      const externalMessageId = recorded.id;
      this.deps.acknowledge?.(message.conversationId, message.eventId, () =>
        this.handled(externalMessageId),
      );
    }
    if (!recorded.threadMessageId) {
      const files = await this.storeFiles(recorded.id, conversation, message.attachments ?? []);
      await this.deps.teamChat.mirrorTranscript(
        { ...recorded, externalConversation: conversation },
        files,
      );
    }
    if (recorded.status === "received")
      await this.deps.teamChat.startAgentRun(recorded.id, ["received"]);
    return {
      spaceId: conversation.spaceId,
      userId: conversation.userId,
      botId: conversation.botId,
      threadId: conversation.thread.id,
      externalMessageId: recorded.id,
      deferred: recorded.status === "deferred",
    };
  }

  /**
   * Records a live message and its backup job together. A redelivered message keeps its row; a
   * message an earlier thread backfill recorded as history becomes live.
   */
  private async record(
    conversation: { id: string },
    message: TeamChatInboundMessage,
    status: "received" | "observed" | "deferred",
  ) {
    const write = () =>
      this.deps.prisma.$transaction(async (tx) => {
        const key = {
          externalConversationId_providerEventId: {
            externalConversationId: conversation.id,
            providerEventId: message.eventId,
          },
        };
        const existing = await tx.externalMessage.findUnique({ where: key });
        if (existing && existing.engagementReason !== "thread_history") return existing;
        const recorded = existing
          ? await tx.externalMessage.update({
              where: { id: existing.id },
              data: { kind: message.kind, status, engagementReason: null, judgedAt: null },
            })
          : await tx.externalMessage.create({
              data: {
                externalConversationId: conversation.id,
                providerEventId: message.eventId,
                kind: message.kind,
                senderId: message.senderId,
                senderName: message.senderName,
                senderIsBot: message.senderIsBot ?? false,
                content: message.content,
                replyThreadId: message.replyThreadId,
                status,
              },
            });
        await this.scheduleIn(tx, recorded.id, conversation.id, status);
        return recorded;
      });
    // Two deliveries of one event can both miss the row; the second then finds the first's.
    return write().catch((error: unknown) => {
      if (isUniqueViolation(error)) return write();
      throw error;
    });
  }

  private async scheduleIn(
    tx: Prisma.TransactionClient,
    externalMessageId: string,
    conversationId: string,
    status: "received" | "observed" | "deferred",
  ): Promise<void> {
    if (status === "observed") {
      await this.deps.teamChat.scheduleAmbientIn(tx, conversationId);
      return;
    }
    const due = status === "deferred" ? TEAM_CHAT_ROUTING_MS : TEAM_CHAT_ENGAGE_BACKUP_MS;
    await this.deps.jobs.enqueueIn(
      tx,
      teamChatEngageJob(externalMessageId, new Date(Date.now() + due)),
    );
  }

  /** Whether the message's answer has gone out, or nobody will answer it. */
  private async handled(externalMessageId: string): Promise<boolean> {
    const row = await this.deps.prisma.externalMessage.findUnique({
      where: { id: externalMessageId },
      select: { status: true },
    });
    if (row?.status === "ignored" || row?.status === "cancelled") return true;
    if (row?.status !== "delivered") return false;
    const unsent = await this.deps.prisma.messagingOutbound.count({
      where: {
        idempotencyKey: {
          in: [
            `external-message:${externalMessageId}`,
            `external-message:${externalMessageId}:failure`,
          ],
        },
        // Not out yet: waiting, or claimed (sent with no handle yet).
        OR: [{ status: { not: "sent" } }, { providerHandle: null }],
      },
    });
    return unsent === 0;
  }

  private async storeFiles(
    externalMessageId: string,
    conversation: { spaceId: string; userId: string; botId: string },
    attachments: MessagingInboundAttachment[],
    limit = ATTACHMENT_MAX_COUNT,
    downloadDeadline?: number,
  ) {
    const { stored, unavailable } = await storeInboundAttachments(
      this.deps.storeAttachment,
      conversation,
      attachments,
      {
        clientNonce: (index) => teamChatAttachmentNonce(externalMessageId, index),
        limit,
        downloadDeadline,
      },
    );
    return { artifacts: stored.map(({ artifact }) => artifact), unavailable };
  }

  private async backfillThreadHistory(message: TeamChatInboundMessage): Promise<void> {
    if (!message.replyThreadId) return;
    const key = JSON.stringify([
      this.deps.providerId,
      message.workspaceId,
      message.conversationKey,
      message.replyThreadId,
    ]);
    const pending = this.threadBackfills.get(key);
    if (pending) return pending;
    const fetchThreadHistory = this.deps.fetchThreadHistory;
    if (!fetchThreadHistory || message.kind === "ambient") return;
    const backfill = (async () => {
      if (await this.knowsReplyThread(message)) return;
      const downloadDeadline = Date.now() + 2_000;
      try {
        await this.receiveHistory(await fetchThreadHistory(message), downloadDeadline);
      } catch (error) {
        getLogger().warn("team chat thread history was not loaded", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.threadBackfills.set(key, backfill);
    try {
      await backfill;
    } finally {
      this.threadBackfills.delete(key);
    }
  }

  private async knowsReplyThread(message: TeamChatInboundMessage): Promise<boolean> {
    const replyThreadId = message.replyThreadId;
    if (!replyThreadId || replyThreadId === message.eventId) return true;
    const known = await this.deps.prisma.externalMessage.findFirst({
      where: {
        OR: [{ providerEventId: replyThreadId }, { replyThreadId }],
        externalConversation: {
          provider: this.deps.providerId,
          workspaceId: message.workspaceId,
          externalKey: message.conversationKey,
        },
      },
      select: { id: true },
    });
    return known !== null;
  }

  /** The earlier messages of a thread the bot joins, recorded as transcript-only history. */
  private async receiveHistory(
    messages: TeamChatInboundMessage[],
    downloadDeadline: number,
  ): Promise<void> {
    const first = messages[0];
    if (!first) return;
    const conversation = await this.upsertConversation(first);
    const fileLimits = newestFirstFileLimits(messages, ATTACHMENT_MAX_COUNT);
    for (const [index, message] of messages.entries()) {
      const recorded = await this.deps.prisma.externalMessage.upsert({
        where: {
          externalConversationId_providerEventId: {
            externalConversationId: conversation.id,
            providerEventId: message.eventId,
          },
        },
        create: {
          externalConversationId: conversation.id,
          providerEventId: message.eventId,
          kind: message.kind,
          senderId: message.senderId,
          senderName: message.senderName,
          senderIsBot: message.senderIsBot ?? false,
          content: message.content,
          replyThreadId: message.replyThreadId,
          status: "ignored",
          engagementReason: "thread_history",
          judgedAt: new Date(),
        },
        update: {},
      });
      if (recorded.threadMessageId) continue;
      const files = await this.storeFiles(
        recorded.id,
        conversation,
        message.attachments ?? [],
        fileLimits[index],
        downloadDeadline,
      );
      await this.deps.teamChat.mirrorTranscript(
        { ...recorded, externalConversation: conversation },
        files,
      );
    }
  }

  private loadTarget(): Promise<TargetBot> {
    this.target ??= this.deps.prisma.bot
      .findFirst({
        where: { id: this.deps.botId, archivedAt: null },
        select: { id: true, spaceId: true, userId: true },
      })
      .then((bot) => {
        if (!bot) throw new Error(`Team chat target bot ${this.deps.botId} was not found`);
        return bot;
      });
    // A failed lookup is tried again by the next message.
    this.target.catch(() => {
      this.target = undefined;
    });
    return this.target;
  }

  private async upsertConversation(message: TeamChatInboundMessage) {
    const target = await this.loadTarget();
    const conversation = await this.deps.prisma.externalConversation.upsert({
      where: {
        spaceId: target.spaceId,
        botId: target.id,
        provider_workspaceId_externalKey: {
          provider: this.deps.providerId,
          workspaceId: message.workspaceId,
          externalKey: message.conversationKey,
        },
      },
      create: {
        provider: this.deps.providerId,
        workspaceId: message.workspaceId,
        externalKey: message.conversationKey,
        conversationId: message.conversationId,
        displayName: message.conversationName,
        participantNames: message.participantNames ?? [],
        spaceId: target.spaceId,
        botId: target.id,
        userId: target.userId,
        thread: { create: { spaceId: target.spaceId, userId: target.userId } },
      },
      update: {
        conversationId: message.conversationId,
        ...(message.conversationName ? { displayName: message.conversationName } : {}),
        ...(message.participantNames?.length ? { participantNames: message.participantNames } : {}),
      },
      include: { thread: { select: { id: true } } },
    });
    if (
      conversation.botId !== target.id ||
      conversation.spaceId !== target.spaceId ||
      !conversation.thread
    ) {
      throw new Error("Team chat conversation belongs to a different Rakazo target");
    }
    return { ...conversation, thread: conversation.thread };
  }
}

/** Splits a file budget across messages, giving the newest ones their files first. */
function newestFirstFileLimits(
  messages: ReadonlyArray<{ attachments?: readonly unknown[] }>,
  budget: number,
): number[] {
  let remaining = budget;
  return messages
    .toReversed()
    .map((message) => {
      const limit = Math.min(message.attachments?.length ?? 0, remaining);
      remaining -= limit;
      return limit;
    })
    .toReversed();
}
