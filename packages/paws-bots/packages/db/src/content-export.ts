import type { Prisma, PrismaClient } from "./client.js";
import { historyMessageText } from "./history-text.js";

export interface ContentExportFilter {
  spaceId?: string;
  threadId?: string;
  /** The bot's own thread, its messages in other threads, and its memory. */
  botId?: string;
}

export type ContentExportRecord =
  | {
      type: "thread";
      id: string;
      spaceId: string;
      userId: string;
      botId: string | null;
      groupId: string | null;
      createdAt: string;
      historyCompactionSummary: string | null;
    }
  | {
      type: "message";
      id: string;
      spaceId: string;
      threadId: string;
      seq: number;
      role: string;
      botId: string | null;
      createdAt: string;
      /** The conversational text of the blocks, for reading without parsing them. */
      text: string;
      blocks: Prisma.JsonValue;
    }
  | {
      type: "memory_document";
      id: string;
      spaceId: string;
      userId: string;
      botId: string | null;
      scope: string;
      path: string;
      revision: number;
      updatedAt: string;
      content: string;
    }
  | {
      type: "memory_revision";
      id: string;
      spaceId: string;
      documentId: string;
      revision: number;
      sourceThreadId: string | null;
      createdAt: string;
      content: string;
    };

const PAGE = 200;

/**
 * Decrypted content for operators, read through the encrypting client: threads
 * (with their compacted summary) each followed by their messages, then memory
 * documents each followed by their revisions. Read-only. Callers run it under a
 * system database context, since it reads across users.
 */
export async function* exportContent(
  prisma: PrismaClient,
  filter: ContentExportFilter = {},
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<ContentExportRecord> {
  const { spaceId, threadId, botId } = filter;
  const threadWhere: Prisma.ThreadWhereInput = {
    ...(spaceId ? { spaceId } : {}),
    ...(threadId ? { id: threadId } : {}),
    ...(botId ? { OR: [{ botId }, { messages: { some: { botId } } }] } : {}),
  };
  for (let cursor = ""; ; ) {
    options.signal?.throwIfAborted();
    const threads = await prisma.thread.findMany({
      where: { ...threadWhere, id: threadId ?? { gt: cursor } },
      orderBy: { id: "asc" },
      take: PAGE,
      select: {
        id: true,
        spaceId: true,
        userId: true,
        botId: true,
        groupId: true,
        createdAt: true,
        historyCompactionSummary: true,
      },
    });
    for (const thread of threads) {
      // In another bot's or a group's thread, only the bot's own messages, and not
      // the thread's summary, which covers everyone's.
      const foreign = Boolean(botId) && thread.botId !== botId;
      yield {
        type: "thread",
        ...thread,
        createdAt: thread.createdAt.toISOString(),
        historyCompactionSummary: foreign ? null : thread.historyCompactionSummary,
      };
      const own = foreign ? { botId } : {};
      for (let seq = -1; ; ) {
        options.signal?.throwIfAborted();
        const messages = await prisma.message.findMany({
          where: { threadId: thread.id, seq: { gt: seq }, ...own },
          orderBy: { seq: "asc" },
          take: PAGE,
          select: {
            id: true,
            threadId: true,
            seq: true,
            role: true,
            botId: true,
            createdAt: true,
            blocks: true,
          },
        });
        for (const message of messages)
          yield {
            type: "message",
            ...message,
            spaceId: thread.spaceId,
            createdAt: message.createdAt.toISOString(),
            text: historyMessageText(message.blocks),
          };
        if (messages.length < PAGE) break;
        seq = messages.at(-1)!.seq;
      }
    }
    if (threadId || threads.length < PAGE) break;
    cursor = threads.at(-1)!.id;
  }
  // Memory belongs to a space, user or bot, not to a thread.
  if (threadId) return;
  for (let cursor = ""; ; ) {
    options.signal?.throwIfAborted();
    const documents = await prisma.memoryDocument.findMany({
      where: { id: { gt: cursor }, ...(spaceId ? { spaceId } : {}), ...(botId ? { botId } : {}) },
      orderBy: { id: "asc" },
      take: PAGE,
      select: {
        id: true,
        spaceId: true,
        userId: true,
        botId: true,
        scope: true,
        path: true,
        revision: true,
        updatedAt: true,
        content: true,
      },
    });
    for (const document of documents) {
      yield { type: "memory_document", ...document, updatedAt: document.updatedAt.toISOString() };
      for (let revision = -1; ; ) {
        options.signal?.throwIfAborted();
        const revisions = await prisma.memoryRevision.findMany({
          where: { documentId: document.id, revision: { gt: revision } },
          orderBy: { revision: "asc" },
          take: PAGE,
          select: {
            id: true,
            documentId: true,
            revision: true,
            sourceThreadId: true,
            createdAt: true,
            content: true,
          },
        });
        for (const row of revisions)
          yield {
            type: "memory_revision",
            ...row,
            spaceId: document.spaceId,
            createdAt: row.createdAt.toISOString(),
          };
        if (revisions.length < PAGE) break;
        revision = revisions.at(-1)!.revision;
      }
    }
    if (documents.length < PAGE) break;
    cursor = documents.at(-1)!.id;
  }
}
