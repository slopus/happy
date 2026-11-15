import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  crossSpaceCommunicationAllowed,
  isUniqueViolation,
  runAsSystem,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { currentBotMessageHop } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { MessagingDelivery } from "./messaging-delivery.js";
import { runLeaseFor } from "./run-messages.js";

export interface AgentConnectionDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  messagingDelivery?: Pick<MessagingDelivery, "recordIn" | "send">;
  runLease?: ExecutorDeps["runLease"];
}

type ConnectionRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};

type Result =
  | { ok: true; status?: string; botId?: string; name?: string; note?: string }
  | { ok: false; error: string };

/**
 * Bot-to-bot 1:1 connections across Spaces. A request is pending until
 * the target's owner approves (text command or respond_agent_connection);
 * messages ride the existing internal bot-message machinery and never
 * transit iMessage.
 */
export function connectAgent(...args: Parameters<typeof requestConnection>): Promise<Result> {
  // The target is found by address on the whole deployment and invited in its own Space.
  return runAsSystem("request an agent connection in another Space", () =>
    requestConnection(...args),
  );
}

async function requestConnection(
  deps: AgentConnectionDeps,
  _run: ConnectionRun,
  sender: { id: string; name: string },
  input: { address?: string },
): Promise<Result> {
  const address = input.address?.trim();
  if (!address) return { ok: false, error: "address is required" };
  const requesterIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: sender.id },
  });
  // Connection invites are a messaging-surface feature; a bot whose owner
  // never messaged the deployment cannot open them.
  const delivery = deps.messagingDelivery;
  if (!requesterIdentity || !delivery) {
    return { ok: false, error: "only chat-linked agents can use agent connections" };
  }
  // Scoped to the requester's own platform: addresses are only unique per
  // provider, and a cross-provider match could route the invite to a
  // different person who happens to share the address string.
  const targetIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: requesterIdentity.provider, address } },
  });
  // One generic answer for unknown and unavailable addresses: the tool is
  // reachable by every bot on the deployment, so it must not enumerate
  // which addresses are registered.
  if (!targetIdentity) return { ok: false, error: "no agent can be reached at that address" };
  if (targetIdentity.botId === sender.id) {
    return { ok: false, error: "a bot cannot connect to itself" };
  }
  const target = await deps.prisma.bot.findUnique({
    where: { id: targetIdentity.botId },
    select: { id: true, name: true, archivedAt: true },
  });
  if (!target || target.archivedAt) {
    return { ok: false, error: "no agent can be reached at that address" };
  }

  if (!(await crossSpaceCommunicationAllowed(deps.prisma, sender.id, target.id))) {
    return { ok: false, error: "no agent can be reached at that address" };
  }

  const existing = await deps.prisma.agentConnection.findUnique({
    where: {
      requesterBotId_targetBotId: { requesterBotId: sender.id, targetBotId: target.id },
    },
  });
  if (existing?.status === "approved") {
    return { ok: true, status: "approved" };
  }
  if (existing?.status === "pending") {
    return { ok: true, status: "pending" };
  }

  const requesterOwner = requesterIdentity
    ? await deps.prisma.user.findUnique({
        where: { id: requesterIdentity.userId },
        select: { name: true },
      })
    : null;
  const requesterFirst = sanitizeMessagingLabel(
    requesterOwner?.name.trim().split(/\s+/)[0] || "Someone",
  );

  const inviteKey = `connect:${sender.id}:${target.id}`;
  const inviteBody = `${requesterFirst}'s agent (${sanitizeMessagingLabel(sender.name)}) wants to connect with your agent. Reply YES to allow, NO to decline.`;

  // Claim + invite in one locked transaction so a concurrent revoke cannot
  // leave a pending invite after the connection is already revoked.
  let claimed: Awaited<ReturnType<typeof claimConnection>>;
  const claimConnection = () =>
    deps.prisma.$transaction(async (tx) => {
      if (!(await crossSpaceCommunicationAllowed(tx, sender.id, target.id))) {
        return { ok: false as const, error: "no agent can be reached at that address" };
      }
      if (existing) {
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM agent_connections WHERE id = ${existing.id} FOR UPDATE
        `;
        const status = locked[0]?.status;
        if (status === "approved" || status === "pending") {
          return { ok: true as const, status };
        }
        // Only reopen the status we observed. A concurrent revoke of a declined
        // row would show up here as revoked and must win.
        if (status !== existing.status) {
          return { ok: false as const, error: "connection changed; try again" };
        }
        await tx.agentConnection.update({
          where: { id: existing.id },
          data: { status: "pending", requestVersion: { increment: 1 } },
        });
      } else {
        try {
          await tx.agentConnection.create({
            data: { requesterBotId: sender.id, targetBotId: target.id, status: "pending" },
          });
        } catch (error) {
          // Two first-time connects can both miss the pre-read; the unique key
          // serializes them. PostgreSQL aborts the interactive transaction on
          // P2002, so recovery must happen outside — rethrow a marker.
          if (!isUniqueViolation(error)) throw error;
          throw new ConnectCreateRaceError();
        }
      }
      // Fresh approval cycle: the old invite row would swallow the new request.
      await delivery.recordIn(
        tx,
        { identityId: targetIdentity.id },
        [
          {
            idempotencyKey: inviteKey,
            kind: "dm",
            identityId: targetIdentity.id,
            body: inviteBody,
          },
        ],
        { replace: true },
      );
      return { ok: true as const, status: "pending" as const };
    });

  try {
    claimed = await claimConnection();
  } catch (error) {
    if (!(error instanceof ConnectCreateRaceError)) throw error;
    const current = await deps.prisma.agentConnection.findUnique({
      where: {
        requesterBotId_targetBotId: { requesterBotId: sender.id, targetBotId: target.id },
      },
    });
    if (current?.status === "approved" || current?.status === "pending") {
      return { ok: true, status: current.status };
    }
    return { ok: false, error: "connection changed; try again" };
  }

  if (!claimed.ok) return claimed;
  if (claimed.status !== "pending") return { ok: true, status: claimed.status };

  await delivery.send([{ identityId: targetIdentity.id }]);
  return { ok: true, status: "pending" };
}

/** Capture the exact request and requester shown on the owner's approval card. */
export function prepareAgentConnectionResponse(
  prisma: PrismaClient,
  targetBotId: string,
  accept: boolean,
) {
  return runAsSystem("prepare an agent connection response for its target bot", async () => {
    const pending = await prisma.agentConnection.findFirst({
      where: { targetBotId, status: "pending" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, requestVersion: true, requesterBotId: true },
    });
    if (!pending) return null;
    const [requester, identity] = await Promise.all([
      prisma.bot.findUnique({ where: { id: pending.requesterBotId }, select: { name: true } }),
      prisma.messagingIdentity.findUnique({
        where: { botId: pending.requesterBotId },
        select: { address: true, provider: true },
      }),
    ]);
    if (!requester || !identity) return null;
    return {
      accept,
      connection_id: pending.id,
      connection_version: pending.requestVersion,
      requester_name: requester.name,
      requester_address: identity.address,
      requester_provider: identity.provider,
    };
  });
}

/** The target bot answers a pending request on its owner's instruction. */
export function respondAgentConnection(
  ...args: Parameters<typeof respondToConnection>
): Promise<Result> {
  return runAsSystem("respond to an agent connection in another Space", () =>
    respondToConnection(...args),
  );
}

async function respondToConnection(
  deps: AgentConnectionDeps,
  _run: ConnectionRun,
  sender: { id: string; name: string },
  input: { accept: boolean; connectionId: string; connectionVersion: number },
): Promise<Result> {
  const pending = await deps.prisma.agentConnection.findFirst({
    where: {
      targetBotId: sender.id,
      status: "pending",
      id: input.connectionId,
      requestVersion: input.connectionVersion,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!pending) return { ok: false, error: "no pending connection request" };
  const status = input.accept ? "approved" : "declined";
  const count = await deps.prisma.$transaction(async (tx) => {
    if (
      input.accept &&
      !(await crossSpaceCommunicationAllowed(tx, pending.requesterBotId, sender.id))
    )
      return 0;
    const result = await tx.agentConnection.updateMany({
      where: { id: pending.id, status: "pending", requestVersion: input.connectionVersion },
      data: { status },
    });
    return result.count;
  });
  // A revoke landing between the read and this write wins; never overwrite it.
  if (count === 0) return { ok: false, error: "connection request is no longer pending" };
  return { ok: true, status };
}

/**
 * Mirror of messageBot across Spaces: the target is resolved through an
 * approved connection instead of the sender's Space roster.
 */
export function messageConnectedAgent(
  ...args: Parameters<typeof deliverToConnectedAgent>
): Promise<Result> {
  // Delivery writes the message, task and run into the connected agent's Space.
  return runAsSystem("deliver a message to a connected agent in another Space", () =>
    deliverToConnectedAgent(...args),
  );
}

async function deliverToConnectedAgent(
  deps: AgentConnectionDeps,
  run: ConnectionRun,
  sender: { id: string; name: string },
  input: { address?: string; message: string; deliveryKey?: string },
): Promise<Result> {
  const message = clampBotMessage(String(input.message ?? ""));
  if (!message) return { ok: false, error: "message is required" };
  const address = input.address?.trim();
  if (!address) return { ok: false, error: "address is required" };

  const senderIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: sender.id },
  });
  if (!senderIdentity) {
    return { ok: false, error: "only chat-linked agents can use agent connections" };
  }

  // Provider-scoped for the same reason as connect_agent: an address match
  // on another platform could belong to someone else entirely.
  const targetIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: senderIdentity.provider, address } },
  });
  // One generic answer for unknown and unconnected addresses, mirroring
  // connect_agent: the tool must not enumerate registered addresses.
  if (!targetIdentity) return { ok: false, error: "no agent can be reached at that address" };
  if (targetIdentity.botId === sender.id) {
    return { ok: false, error: "a bot cannot message itself" };
  }

  const connection = await approvedConnectionBetween(deps.prisma, sender.id, targetIdentity.botId);
  if (!connection) {
    return { ok: false, error: "no agent can be reached at that address" };
  }

  const hop = nextBotMessageHop(
    await currentBotMessageHop(deps.prisma, run.sourceMessageId ?? null),
  );
  if (botMessageHopExhausted(hop)) {
    return {
      ok: false,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const target = await deps.prisma.bot.findUnique({
    where: { id: targetIdentity.botId },
    select: { id: true, name: true, archivedAt: true, thread: { select: { id: true } } },
  });
  if (!target || target.archivedAt || !target.thread) {
    return { ok: false, error: "that agent is not available" };
  }
  const targetThreadId = target.thread.id;
  const deliveryKey = input.deliveryKey ? `agent-message:${input.deliveryKey}` : undefined;
  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message });

  let committed!: Awaited<ReturnType<typeof deliverTx>>;
  const deliverTx = () =>
    deps.prisma.$transaction(async (tx) => {
      if (deliveryKey) {
        const already = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
          select: { id: true },
        });
        if (already) return { replayed: true as const };
      }
      for (const threadId of [run.threadId, targetThreadId].sort()) {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      }
      if (!(await crossSpaceCommunicationAllowed(tx, sender.id, target.id))) {
        return { ok: false as const, error: "no agent can be reached at that address" };
      }
      const senderStillRunning = await tx.run.findFirst({
        where: { id: run.id, status: "running" },
        select: { id: true },
      });
      if (!senderStillRunning)
        return { ok: false as const, error: "source run is no longer active" };
      // Lock the connection row for the rest of the transaction: a revoke's
      // update blocks behind this lock, so delivery never commits after a
      // committed revocation (pattern: teaching-session.ts skill lock).
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM agent_connections WHERE id = ${connection.id} FOR UPDATE
      `;
      if (locked[0]?.status !== "approved") {
        return { ok: false as const, error: "connection is no longer approved" };
      }

      const inboundBlock: MessageBlock = {
        kind: "bot_message_received",
        fromBotId: sender.id,
        fromBotName: sender.name,
        text: message,
        hop,
      };
      const outboundBlock: MessageBlock = {
        kind: "bot_message_sent",
        toBotId: target.id,
        toBotName: target.name,
        text: message,
      };
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: targetThreadId,
        role: "user",
        blocks: [inboundBlock],
        clientNonce: deliveryKey,
      });
      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks: [outboundBlock],
        botId: run.botId,
        runId: run.id,
        lease: runLeaseFor(deps, run.id),
      });
      const task = await tx.task.create({
        data: {
          spaceId: targetIdentity.spaceId,
          botId: target.id,
          threadId: targetThreadId,
          userId: targetIdentity.userId,
          prompt: wakePrompt,
          status: "queued",
        },
      });
      const nextRun = await tx.run.create({
        data: {
          spaceId: targetIdentity.spaceId,
          botId: target.id,
          threadId: targetThreadId,
          taskId: task.id,
          userId: targetIdentity.userId,
          status: "queued",
          trigger: "bot_message",
          sourceMessageId: inbound.id,
        },
        select: { id: true },
      });
      await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
      const inboundEvent = await appendEventInTransaction(tx, {
        spaceId: targetIdentity.spaceId,
        threadId: targetThreadId,
        botId: target.id,
        type: "thread.message.created",
        runId: nextRun.id,
        payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
      });
      const outboundEvent = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: run.id,
        lease: runLeaseFor(deps, run.id),
        payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
      });
      return {
        runId: nextRun.id,
        targetEventSeq: inboundEvent.seq,
        senderEventSeq: outboundEvent.seq,
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  try {
    committed = await deliverTx();
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) {
        return {
          ok: true,
          botId: target.id,
          name: target.name,
          note: `Already sent to ${target.name} in this turn; it was not sent again.`,
        };
      }
    }
    throw error;
  }

  if ("replayed" in committed) {
    return {
      ok: true,
      botId: target.id,
      name: target.name,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    };
  }
  if ("ok" in committed) {
    return { ok: false as const, error: committed.error ?? "delivery failed" };
  }

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch(() => undefined);
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch(() => undefined);
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    getLogger().error("agent connection message enqueue", error);
  });
  return {
    ok: true,
    botId: target.id,
    name: target.name,
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message.`,
  };
}

/** Marker: unique create raced; recover outside the aborted PG transaction. */
class ConnectCreateRaceError extends Error {
  constructor() {
    super("connect create race");
    this.name = "ConnectCreateRaceError";
  }
}

async function approvedConnectionBetween(
  prisma: Pick<PrismaClient, "agentConnection">,
  botA: string,
  botB: string,
): Promise<{ id: string } | null> {
  return prisma.agentConnection.findFirst({
    where: {
      status: "approved",
      OR: [
        { requesterBotId: botA, targetBotId: botB },
        { requesterBotId: botB, targetBotId: botA },
      ],
    },
    select: { id: true },
  });
}
