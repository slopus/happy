import type { Actor, MessageBlock } from "@rakazo/contracts";
import { QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  availableInSpace,
  IsolationError,
  withTransactionRetry,
} from "@rakazo/db";
import { requireBotThread } from "./bot-thread.js";

export type McpApprovalDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
};

export type McpApprovalResolution = {
  botId: string;
  serverId: string;
  status: "connected" | "dismissed";
  /** The chat whose cards should resolve; defaults to the bot's own thread. */
  threadId?: string;
};

export type McpApprovalDecision = {
  /** Whether this decision may create the bot's assignment. */
  assign: boolean;
  /** Whether it closed an open card, rather than repeating a decision. */
  resolved: boolean;
};

export type ThreadSeq = {
  threadId: string;
  seq: number;
};

type ApprovalBlock = Extract<MessageBlock, { kind: "mcp_approval" }>;

function isApproval(block: MessageBlock, serverId: string): block is ApprovalBlock {
  return block.kind === "mcp_approval" && block.serverId === serverId;
}

function isOpen(block: ApprovalBlock): boolean {
  return block.status !== "connected" && block.status !== "dismissed";
}

async function threadsForDecision(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
): Promise<ApprovalThread[]> {
  // Threads are shared by the space, but a card is about one member's own server:
  // only that member resolves it.
  const server = await deps.prisma.mcpServer.findFirst({
    where: { id: input.serverId, ...availableInSpace(actor) },
    select: { id: true },
  });
  if (!server) return [];
  if (!input.threadId) return threadsForBot(deps.prisma, actor, input.botId);
  const member = await deps.prisma.thread.findMany({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      OR: [{ botId: input.botId }, { group: { members: { some: { botId: input.botId } } } }],
    },
    select: { id: true, botId: true },
  });
  if (member.length > 0) return member;
  // A bot removed from a group leaves its card behind. The bot still has to
  // belong to this space; the fallback never opens another bot's direct chat.
  try {
    await requireBotThread(deps, actor, input.botId);
  } catch (error) {
    if (error instanceof IsolationError) return [];
    throw error;
  }
  return deps.prisma.thread.findMany({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      groupId: { not: null },
    },
    select: { id: true, botId: true },
  });
}

type ApprovalThread = { id: string; botId: string | null };

async function threadsForBot(
  db: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  botId: string,
): Promise<ApprovalThread[]> {
  return db.thread.findMany({
    where: {
      spaceId: actor.spaceId,
      OR: [{ botId }, { groupId: { not: null }, messages: { some: { botId } } }],
    },
    select: { id: true, botId: true },
  });
}

async function rewriteCards(
  tx: Prisma.TransactionClient,
  actor: Actor,
  threads: ApprovalThread[],
  input: { botId?: string; serverId: string; status: ApprovalBlock["status"] },
  selectable: (block: ApprovalBlock) => boolean,
): Promise<{ seqs: ThreadSeq[]; flipped: number; dismissed: boolean; connected: boolean }> {
  const seqs: ThreadSeq[] = [];
  let flipped = 0;
  let dismissed = false;
  let connected = false;
  for (const thread of threads) {
    const messages = await tx.message.findMany({
      where: { threadId: thread.id },
      select: { id: true, botId: true, blocks: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    for (const message of messages) {
      if (message.botId && message.botId !== input.botId) continue;
      const blocks = message.blocks as MessageBlock[];
      const matching = blocks.filter((block): block is ApprovalBlock =>
        isApproval(block, input.serverId),
      );
      if (matching.length === 0) continue;
      for (const block of matching) {
        if (block.status === "dismissed") dismissed = true;
        else if (block.status === "connected") connected = true;
      }
      if (!matching.some(selectable)) continue;
      const next = blocks.map((block) =>
        isApproval(block, input.serverId) && selectable(block)
          ? { ...block, status: input.status }
          : block,
      );
      await tx.message.update({ where: { id: message.id }, data: { blocks: next } });
      flipped += 1;
      const eventBotId = message.botId ?? thread.botId ?? input.botId;
      if (!eventBotId) continue;
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId: eventBotId,
        type: "thread.message.updated",
        payload: { messageId: message.id, role: "bot", blocks: next },
      });
      seqs.push({ threadId: thread.id, seq: event.seq });
    }
  }
  return { seqs, flipped, dismissed, connected };
}

/** Flip every open mcp_approval card for this server. The read, the writes,
    and `effect` share one serializable transaction. A card decision (one that
    passes threadId) sees `assign: false` when a dismissal already won, so that
    race does not create an assignment. Settings approval omits threadId and
    still assigns. */
export async function resolveMcpApprovalCards<T>(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
  effect?: (tx: Prisma.TransactionClient, decision: McpApprovalDecision) => Promise<T>,
): Promise<T | undefined> {
  const threads = await threadsForDecision(deps, actor, input);
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const selectable =
          input.threadId === undefined
            ? (block: ApprovalBlock) => block.status !== "connected"
            : isOpen;
        const painted = await rewriteCards(tx, actor, threads, input, selectable);
        const dismissalWon =
          input.threadId !== undefined &&
          painted.flipped === 0 &&
          !painted.connected &&
          painted.dismissed;
        const assign = !dismissalWon;
        const resolved = painted.flipped > 0;
        const value = effect ? await effect(tx, { assign, resolved }) : undefined;
        return { seqs: painted.seqs, value };
      },
      { isolationLevel: "Serializable" },
    ),
  );
  for (const event of committed.seqs) await deps.events.notify(event.threadId, event.seq);
  return committed.value;
}

/** A removed assignment must not leave its card saying the server is connected.
    Pass `tx` to commit the repaint with the assignment change; otherwise this
    notifies after its own transaction. */
export async function revertConnectedMcpApprovals(
  deps: McpApprovalDeps,
  actor: Actor,
  input: { botId: string; serverId: string; status: "pending" | "dismissed" },
  tx?: Prisma.TransactionClient,
): Promise<ThreadSeq[]> {
  const selectable = (block: ApprovalBlock) =>
    input.status === "dismissed" ? block.status !== "dismissed" : block.status === "connected";
  const paint = (client: Prisma.TransactionClient, threads: ApprovalThread[]) =>
    rewriteCards(client, actor, threads, input, selectable).then((painted) => painted.seqs);
  if (tx) return paint(tx, await threadsForBot(tx, actor, input.botId));
  const threads = await threadsForBot(deps.prisma, actor, input.botId);
  const seqs = await withTransactionRetry(() =>
    deps.prisma.$transaction((client) => paint(client, threads), {
      isolationLevel: "Serializable",
    }),
  );
  for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
  return seqs;
}

async function closeServerCards(
  client: Prisma.TransactionClient,
  actor: Actor,
  serverId: string,
): Promise<ThreadSeq[]> {
  const messages = await client.message.findMany({
    where: {
      thread: { spaceId: actor.spaceId },
      blocks: { array_contains: [{ kind: "mcp_approval", serverId }] },
    },
    select: {
      id: true,
      botId: true,
      blocks: true,
      threadId: true,
      thread: { select: { botId: true } },
    },
  });
  const seqs: ThreadSeq[] = [];
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (!blocks.some((block) => isApproval(block, serverId) && block.status !== "dismissed")) {
      continue;
    }
    const next = blocks.map((block) =>
      isApproval(block, serverId) && block.status !== "dismissed"
        ? { ...block, status: "dismissed" as const }
        : block,
    );
    await client.message.update({ where: { id: message.id }, data: { blocks: next } });
    const eventBotId = message.botId ?? message.thread?.botId;
    if (!eventBotId) continue;
    const event = await appendEventInTransaction(client, {
      spaceId: actor.spaceId,
      threadId: message.threadId,
      botId: eventBotId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: next },
    });
    seqs.push({ threadId: message.threadId, seq: event.seq });
  }
  return seqs;
}

/** Deleting a server closes every approval card for it, including cards that
    were never assigned. */
export async function dismissMcpServerApprovals(
  deps: McpApprovalDeps,
  actor: Actor,
  serverId: string,
  tx?: Prisma.TransactionClient,
): Promise<ThreadSeq[]> {
  if (tx) return closeServerCards(tx, actor, serverId);
  const seqs = await withTransactionRetry(() =>
    deps.prisma.$transaction((client) => closeServerCards(client, actor, serverId), {
      isolationLevel: "Serializable",
    }),
  );
  for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
  return seqs;
}

function mcpConnectedPrompt(name: string): string {
  return `The user just connected the MCP server ${JSON.stringify(name)} from its approval card, so its tools are available now. Carry on with what they asked for. If nothing is left to do, confirm in one short sentence.`;
}

/** Approving a card in a chat is the user's turn: queue a hidden-prompt run (like
    a call's hang-up) so the bot carries on with the server's tools instead of
    waiting for another message. Skipped while the bot is busy in that chat, no
    longer in it, or archived along with the chat. Returns the run to enqueue. */
export async function queueMcpConnectedRun(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: { botId: string; serverId: string; threadId: string },
): Promise<string | null> {
  const thread = await tx.thread.findFirst({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      OR: [
        { botId: input.botId },
        { group: { archivedAt: null, members: { some: { botId: input.botId } } } },
      ],
    },
    select: { id: true },
  });
  if (!thread) return null;
  const [bot, busy, server] = await Promise.all([
    tx.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true },
    }),
    tx.run.findFirst({
      where: {
        threadId: thread.id,
        botId: input.botId,
        status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
      },
      select: { id: true },
    }),
    tx.mcpServer.findFirst({
      where: { id: input.serverId, ...availableInSpace(actor) },
      select: { name: true },
    }),
  ]);
  if (!bot || busy || !server) return null;
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId: input.botId,
      threadId: thread.id,
      userId: actor.userId,
      prompt: mcpConnectedPrompt(server.name),
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId: input.botId,
      threadId: thread.id,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "user",
    },
    select: { id: true },
  });
  return run.id;
}
