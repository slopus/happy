import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";

/** Scalar columns the sidebar preview and its older-page fallback both read. */
export interface SidebarPreviewMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  runId: string | null;
  clientNonce: string | null;
  createdAt: Date;
}

/**
 * One indexed read of the newest `limit` messages per thread. A nested `take`
 * on `findMany` is applied in memory and would load every message.
 */
export async function withNewestThreadMessages<T extends { thread: { id: string } | null }>(
  prisma: PrismaClient,
  parents: T[],
  limit: number,
) {
  const threadIds = parents.flatMap((parent) => (parent.thread ? [parent.thread.id] : []));
  const loaded =
    threadIds.length === 0
      ? []
      : await prisma.$queryRaw<SidebarPreviewMessage[]>(Prisma.sql`
          SELECT m.id, m."threadId", m.seq, m.role, m.blocks, m."botId",
            m."replyToMessageId", m."replyQuote", m."runId", m."clientNonce", m."createdAt"
          FROM unnest(${threadIds}::text[]) AS t(id)
          CROSS JOIN LATERAL (
            SELECT id, "threadId", seq, role, blocks, "botId", "replyToMessageId", "replyQuote",
              "runId", "clientNonce", "createdAt"
            FROM messages
            WHERE "threadId" = t.id
            ORDER BY seq DESC
            LIMIT ${limit}
          ) m
          ORDER BY m."threadId", m.seq DESC
        `);
  const opened = (await contentEncryptionOf(prisma)?.openRows("Message", loaded)) ?? loaded;
  const byThread = new Map<string, SidebarPreviewMessage[]>();
  for (const row of opened) {
    const list = byThread.get(row.threadId);
    if (list) list.push(row);
    else byThread.set(row.threadId, [row]);
  }
  return parents.map((parent) => ({
    ...parent,
    thread: parent.thread
      ? { ...parent.thread, messages: byThread.get(parent.thread.id) ?? [] }
      : null,
  }));
}
