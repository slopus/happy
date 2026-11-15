import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  BackgroundJobPayloads,
  CloudAgentSnapshot,
} from "@rakazo/adapter-kit";
import {
  CloudAgentRequestRejected,
  CloudAgentRetryLater,
  runContinueJob,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import type { CloudAgent } from "@rakazo/db";
import { appendEventInTransaction, Prisma, THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CloudAgentDeps } from "./cloud-agent-service.js";
import { cloudAgentBlock, cloudAgentFor, enqueueCloudAgent } from "./cloud-agent-service.js";
import { cloudAgentLaunchSchema, cloudAgentPromptSchema } from "./cloud-agent-tools.js";

const FOLLOWUP_SETTLE_MS = 5 * 60_000;

/** Reconcile one persisted intent. A fenced lease serializes remote mutations. */
export async function pollCloudAgent(
  deps: CloudAgentDeps,
  payload: BackgroundJobPayloads["cloud_agent.poll"],
) {
  const stored = await deps.prisma.cloudAgent.findUnique({ where: { id: payload.agentId } });
  if (!stored?.nextPollAt) return;
  const connection = await cloudAgentFor(deps, stored);
  if (!connection) return;
  const token = randomUUID();
  const claimed = await deps.prisma.cloudAgent.updateMany({
    where: {
      id: stored.id,
      version: stored.version,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 90_000) },
  });
  if (!claimed.count) return;
  const agent = { ...stored, leaseToken: token };
  const context: AdapterContext = {
    operationId: agent.id,
    traceId: agent.id,
    spaceId: agent.spaceId,
    userId: agent.userId,
    botId: agent.botId,
    signal: AbortSignal.timeout(60_000),
  };
  const provider = connection.provider;
  try {
    const [card, member, bot] = await Promise.all([
      deps.prisma.message.findFirst({
        where: { id: agent.messageId ?? "", threadId: agent.threadId },
        select: { id: true },
      }),
      deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: agent.spaceId, userId: agent.userId } },
        select: { id: true },
      }),
      deps.prisma.bot.findFirst({
        where: { id: agent.botId, spaceId: agent.spaceId, archivedAt: null },
      }),
    ]);
    const abandoned = !card || !member || !bot;
    if ((abandoned || agent.cancelRequested) && !agent.remoteId && !agent.launchDispatched) {
      await finishPoll(
        deps,
        agent,
        { status: "cancelled", cancelRequested: false, launchRequest: {} },
        abandoned,
      );
      return;
    }
    if (!agent.remoteId) {
      // A refused launch created nothing remote, so a later cancel has nothing to stop.
      if (agent.status !== "running") {
        await finishPoll(deps, agent, {}, abandoned);
        return;
      }
      // Write dispatch intent before I/O; a crash replays the same idempotent create.
      const marked = await deps.prisma.cloudAgent.updateMany({
        where: fence(agent),
        data: { launchDispatched: true },
      });
      if (!marked.count) return;
      const request = cloudAgentLaunchSchema.parse(agent.launchRequest);
      try {
        const snapshot = await provider.launch({ ...request, idempotencyKey: agent.id }, context);
        await finishPoll(
          deps,
          agent,
          {
            ...snapshotData(snapshot),
            remoteId: snapshot.id,
            launchRequest: {},
            cancelRequested: abandoned || agent.cancelRequested,
          },
          abandoned,
        );
      } catch (error) {
        if (!(error instanceof CloudAgentRequestRejected)) throw error;
        await finishPoll(
          deps,
          agent,
          { status: rejectedStatus(error), launchRequest: {} },
          abandoned,
        );
      }
      return;
    }
    const dispatchedAt = agent.followup ? agent.followupDispatchedAt : null;
    // An ambiguous follow-up appears in the newest-first run list once accepted.
    // The client abandons its request long before this window ends, so a run that
    // still has not appeared was never accepted and can be resent or dropped.
    const unsent =
      dispatchedAt !== null && Date.now() - dispatchedAt.getTime() >= FOLLOWUP_SETTLE_MS;
    if (abandoned || agent.cancelRequested) {
      if (agent.followup && !dispatchedAt) {
        await finishPoll(
          deps,
          agent,
          { status: "cancelled", followup: Prisma.DbNull, cancelRequested: false },
          abandoned,
        );
        return;
      }
      const snapshot = await provider.cancel(
        agent.remoteId,
        context,
        dispatchedAt ? undefined : (agent.latestRunId ?? undefined),
      );
      const pending = dispatchedAt !== null && snapshot.latestRunId === agent.latestRunId;
      if (pending && !unsent) {
        // An old terminal run cannot confirm cancellation of a run that may still appear.
        await retryPoll(deps, agent);
        return;
      }
      await finishPoll(
        deps,
        agent,
        {
          ...(pending ? { status: "cancelled" } : snapshotData(snapshot)),
          cancelRequested: !pending && snapshot.status === "running",
          followup: Prisma.DbNull,
          followupDispatchedAt: null,
        },
        abandoned,
      );
      return;
    }
    if (agent.followup) {
      if (dispatchedAt) {
        // Follow-ups have no idempotency key: resend only once the run list has settled.
        const snapshot = await provider.get(agent.remoteId, context);
        if (snapshot.latestRunId === agent.latestRunId) {
          await retryPoll(deps, agent, undefined, unsent ? { followupDispatchedAt: null } : {});
          return;
        }
        await finishPoll(deps, agent, {
          ...snapshotData(snapshot),
          followup: Prisma.DbNull,
          followupDispatchedAt: null,
        });
      } else {
        const marked = await deps.prisma.cloudAgent.updateMany({
          where: fence(agent),
          data: { followupDispatchedAt: new Date() },
        });
        if (!marked.count) return;
        try {
          const snapshot = await provider.reply(
            agent.remoteId,
            cloudAgentPromptSchema.parse(agent.followup),
            context,
          );
          if (!snapshot.latestRunId || snapshot.latestRunId === agent.latestRunId)
            throw new Error("Cloud agent follow-up did not identify a new run");
          await finishPoll(deps, agent, {
            ...snapshotData(snapshot),
            followup: Prisma.DbNull,
            followupDispatchedAt: null,
          });
        } catch (error) {
          if (error instanceof CloudAgentRetryLater) {
            // A refused request was never accepted, so the next poll resends it.
            await retryPoll(deps, agent, error.retryAfterMs, { followupDispatchedAt: null });
            return;
          }
          if (!(error instanceof CloudAgentRequestRejected)) throw error;
          await finishPoll(deps, agent, {
            status: rejectedStatus(error),
            followup: Prisma.DbNull,
            followupDispatchedAt: null,
          });
        }
      }
      return;
    }
    // A specific run cannot regress to stale agent-level metadata after a follow-up.
    const snapshot = await provider.get(agent.remoteId, context, agent.latestRunId ?? undefined);
    await finishPoll(deps, agent, snapshotData(snapshot));
  } catch (error) {
    if (error instanceof CloudAgentRequestRejected && error.reason !== "invalid") {
      // The remote agent or run is gone. Polling it again can never succeed.
      await finishPoll(deps, agent, {
        status:
          agent.cancelRequested && error.reason === "not_found"
            ? "cancelled"
            : rejectedStatus(error),
        followup: Prisma.DbNull,
        followupDispatchedAt: null,
      });
      return;
    }
    // Provider response bodies and secrets never enter logs, cards, or model context.
    if (error instanceof CloudAgentRetryLater && error.reason === "credential")
      getLogger().warn("cloud agent credential rejected; check the provider connection");
    else getLogger().warn("cloud agent operation deferred to reconciliation");
    await retryPoll(
      deps,
      agent,
      error instanceof CloudAgentRetryLater ? error.retryAfterMs : undefined,
    );
  } finally {
    // A concurrent user action can change version while remote I/O is in flight.
    // Release only our lease, preserving that action's pending intent and due date.
    await deps.prisma.cloudAgent.updateMany({
      where: { id: agent.id, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

function fence(agent: CloudAgent) {
  return { id: agent.id, version: agent.version, leaseToken: agent.leaseToken };
}

function snapshotData(snapshot: CloudAgentSnapshot): Prisma.CloudAgentUpdateManyMutationInput {
  return {
    title: snapshot.title,
    status: snapshot.status,
    url: cloudAgentHttpsUrl(snapshot.url) ?? "",
    branch: snapshot.branch,
    prUrl: snapshot.prUrl ? (cloudAgentHttpsUrl(snapshot.prUrl) ?? "") : undefined,
    latestRunId: snapshot.latestRunId,
  };
}

function rejectedStatus(error: CloudAgentRequestRejected) {
  return error.reason === "expired" ? "expired" : "failed";
}

async function retryPoll(
  deps: CloudAgentDeps,
  agent: CloudAgent,
  retryAfterMs?: number,
  data: Prisma.CloudAgentUpdateManyMutationInput = {},
) {
  const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(agent.errorCount, 4));
  // Honor a provider's Retry-After, bounded so one response cannot park an agent for long.
  const delay =
    retryAfterMs === undefined ? backoff : Math.min(15 * 60_000, Math.max(backoff, retryAfterMs));
  const nextPollAt = new Date(Date.now() + delay);
  const saved = await deps.prisma.cloudAgent.updateMany({
    where: fence(agent),
    data: {
      ...data,
      nextPollAt,
      errorCount: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (saved.count) await enqueueCloudAgent(deps, agent.id, nextPollAt);
}

async function finishPoll(
  deps: CloudAgentDeps,
  agent: CloudAgent,
  data: Prisma.CloudAgentUpdateManyMutationInput,
  abandoned = false,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat: thread first, then message/run changes.
    const thread = await tx.thread.updateMany({
      where: {
        id: agent.threadId,
        spaceId: agent.spaceId,
      },
      data: { nextEventSeq: { increment: 0 } },
    });
    const message = thread.count
      ? await tx.message.findFirst({
          where: {
            id: agent.messageId ?? "",
            threadId: agent.threadId,
          },
        })
      : null;
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: agent.spaceId, userId: agent.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: agent.botId, spaceId: agent.spaceId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    const detached = abandoned || !message || !member || !bot;
    const status = typeof data.status === "string" ? data.status : agent.status;
    const terminal = status !== "running";
    const cancelRequested =
      !terminal && (detached || data.cancelRequested === true || agent.cancelRequested);
    const nextPollAt = terminal ? null : new Date(Date.now() + 5_000);
    const updated = await tx.cloudAgent.updateMany({
      where: fence(agent),
      data: {
        ...data,
        cancelRequested,
        nextPollAt,
        errorCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (!updated.count) return null;
    const saved = await tx.cloudAgent.findUniqueOrThrow({ where: { id: agent.id } });
    let seq: number | undefined;
    let wakeRunId: string | undefined;
    if (message && !detached) {
      const nextBlock = cloudAgentBlock(saved);
      const blocks = (message.blocks as MessageBlock[]).map((block) =>
        block.kind === "cloud_agent" && block.agentId === agent.id ? nextBlock : block,
      );
      if (JSON.stringify(blocks) !== JSON.stringify(message.blocks)) {
        await tx.message.update({ where: { id: message.id }, data: { blocks } });
        const event = await appendEventInTransaction(tx, {
          spaceId: agent.spaceId,
          threadId: agent.threadId,
          botId: agent.botId,
          type: "thread.cloud_agent",
          payload: { messageId: message.id, ...nextBlock },
        });
        seq = event.seq;
      }
      if (terminal && saved.wakeGeneration < saved.generation) {
        // Provider text is untrusted. Wake with local identity and status only.
        const summary = `Cloud agent ${agent.id} is ${status}. Use cloud_agent_status to inspect its result.`;
        const task = await tx.task.create({
          data: {
            spaceId: agent.spaceId,
            botId: agent.botId,
            threadId: agent.threadId,
            userId: agent.userId,
            prompt: summary,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: agent.spaceId,
            botId: agent.botId,
            threadId: agent.threadId,
            userId: agent.userId,
            taskId: task.id,
            status: "queued",
            trigger: "cloud_agent",
            clientNonce: `cloud-agent-wake-run:${agent.id}:${saved.generation}`,
          },
        });
        await tx.cloudAgent.update({
          where: { id: agent.id },
          data: { wakeGeneration: saved.generation },
        });
        wakeRunId = run.id;
      }
    }
    return { seq, wakeRunId, nextPollAt };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return;
  if (committed.seq !== undefined)
    await deps.events.notify(agent.threadId, committed.seq).catch(() => undefined);
  if (committed.wakeRunId) {
    // The existing run reconciler recovers a queued wake after an enqueue failure.
    await deps.jobs.enqueue(runContinueJob(committed.wakeRunId)).catch(() => {
      getLogger().warn("cloud agent wake deferred to reconciliation");
    });
  }
  if (committed.nextPollAt) await enqueueCloudAgent(deps, agent.id, committed.nextPollAt);
}
