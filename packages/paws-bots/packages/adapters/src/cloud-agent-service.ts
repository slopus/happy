import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { cloudAgentPollJob } from "@rakazo/adapter-kit";
import { cloudAgentBlockFromPayload } from "@rakazo/core";
import type { CloudAgent, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  CloudAgentActor,
  CloudAgentConnection,
  UserCloudAgents,
} from "./cloud-agent-factory.js";
import { cloudAgentsEnabled, USER_CLOUD_AGENT_KEY_PREFIX } from "./cloud-agent-factory.js";
import { cloudAgentLaunchSchema, cloudAgentReplySchema } from "./cloud-agent-tools.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

export interface CloudAgentDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify">;
  cloudAgent: CloudAgentConnection | null | undefined;
  userCloudAgents?: UserCloudAgents;
  runLease?: ExecutorDeps["runLease"];
}

type Connections = Partial<Pick<CloudAgentDeps, "cloudAgent" | "userCloudAgents">>;

/** Where an actor's new agents run: their own connected environment, else the deployment's. */
export async function cloudAgentForActor(
  deps: Connections,
  actor: CloudAgentActor & { botIds?: string[] },
) {
  const own = await deps.userCloudAgents?.forActor(actor).catch((error: unknown) => {
    getLogger().warn("cloud_agent.user_connections_unavailable", { error });
    return null;
  });
  return own ?? (cloudAgentsEnabled(deps.cloudAgent, actor.spaceId) ? deps.cloudAgent! : null);
}

/** Everywhere the actor's agents may send work: each environment they connected, and the deployment's. */
export async function cloudAgentsForActor(deps: Connections, actor: CloudAgentActor) {
  const own =
    (await deps.userCloudAgents?.listForActor(actor).catch((error: unknown) => {
      getLogger().warn("cloud_agent.user_connections_unavailable", { error });
      return null;
    })) ?? [];
  return cloudAgentsEnabled(deps.cloudAgent, actor.spaceId) ? [...own, deps.cloudAgent!] : own;
}

/** The connection an agent was launched on, while it may still be used for it. */
export async function cloudAgentFor(
  deps: Connections,
  agent: Pick<CloudAgent, "providerKey"> & CloudAgentActor,
) {
  if (deps.cloudAgent?.key === agent.providerKey)
    return cloudAgentsEnabled(deps.cloudAgent, agent.spaceId) ? deps.cloudAgent : null;
  const { spaceId, userId } = agent;
  return (await deps.userCloudAgents?.forKey(agent.providerKey, { spaceId, userId })) ?? null;
}

export function cloudAgentBlock(agent: CloudAgent) {
  return cloudAgentBlockFromPayload({ ...agent, agentId: agent.id });
}

/** Queue an intent only after scope and owner checks. The worker owns remote I/O. */
export async function executeCloudAgentTool(
  /** `deployment`: the deployment's connection when the run's own is the user's environment. */
  deps: CloudAgentDeps & { deployment?: CloudAgentConnection | null },
  context: AdapterContext & { botId: string },
  run: { id: string; threadId: string },
  name: string,
  args: Record<string, unknown>,
) {
  const connection = cloudAgentsEnabled(deps.cloudAgent, context.spaceId) ? deps.cloudAgent : null;
  const cleanup = name === "cloud_agent_status" || name === "cloud_agent_cancel";
  if (!connection && !cleanup) {
    return { error: "Cloud agents are not configured for this space." };
  }
  let agent: CloudAgent;
  if (name === "cloud_agent_launch") {
    const request = cloudAgentLaunchSchema.parse(args);
    const result = await deps.prisma.$transaction(async (tx) => {
      // Serialize with clearThread before creating either the intent or its card.
      await tx.thread.update({
        where: { id: run.threadId, spaceId: context.spaceId },
        data: { nextMessageSeq: { increment: 0 } },
      });
      const existing = await tx.cloudAgent.findUnique({
        where: { operationKey: context.operationId },
      });
      if (existing) {
        if (existing.spaceId !== context.spaceId || existing.userId !== context.userId) {
          throw new Error("Cloud agent operation scope changed");
        }
        // A retry returns the agent it started even when new agents now go elsewhere, as after a
        // T3 Code grant lapsed; the agent's poll reaches it through its own provider key.
        return { agent: existing };
      }
      const created = await tx.cloudAgent.create({
        data: {
          operationKey: context.operationId,
          providerKey: connection!.key,
          spaceId: context.spaceId,
          userId: context.userId,
          botId: context.botId,
          threadId: run.threadId,
          title: request.prompt.split(/\r?\n/, 1)[0]!.slice(0, 80),
          launchRequest: request,
        },
      });
      const blocks = [cloudAgentBlock(created)];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: context.botId,
        runId: run.id,
        role: "bot",
        blocks,
        lease: runLeaseFor(deps, run.id),
      });
      const saved = await tx.cloudAgent.update({
        where: { id: created.id },
        data: { messageId: message.id },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: run.id,
        lease: runLeaseFor(deps, run.id),
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return {
        agent: saved,
        seq: event.seq,
        firstResponseRunId: event.firstResponse ? run.id : undefined,
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    agent = result.agent;
    if (result.seq !== undefined)
      await deps.events
        .notify(run.threadId, result.seq, result.firstResponseRunId)
        .catch(() => undefined);
  } else {
    const owned = await deps.prisma.cloudAgent.findFirst({
      where: {
        id: String(args.id).trim(),
        // The actor's agents wherever they run, not only where new agents go.
        OR: [
          ...(connection ? [{ providerKey: connection.key }] : []),
          { providerKey: { startsWith: USER_CLOUD_AGENT_KEY_PREFIX } },
          ...(deps.deployment && cloudAgentsEnabled(deps.deployment, context.spaceId)
            ? [{ providerKey: deps.deployment.key }]
            : []),
        ],
        spaceId: context.spaceId,
        userId: context.userId,
      },
    });
    if (!owned) return { error: "Unknown cloud agent." };
    agent = owned;
    if (name === "cloud_agent_reply") {
      if (agent.providerKey.startsWith(USER_CLOUD_AGENT_KEY_PREFIX)) {
        // A follow-up stays with the bot whose identity the worker will reauthorize.
        if (
          agent.botId !== context.botId ||
          !(await deps.userCloudAgents?.forKey(agent.providerKey, {
            spaceId: context.spaceId,
            userId: context.userId,
            botIds: [context.botId],
          }))
        )
          return { error: "Unknown cloud agent." };
      }

      if (
        agent.status === "running" ||
        agent.followup ||
        agent.cancelRequested ||
        !agent.remoteId
      ) {
        return { error: "Wait for the current cloud agent operation to finish." };
      }
      const { id: _id, ...followup } = cloudAgentReplySchema.parse(args);
      const updated = await deps.prisma.cloudAgent.updateMany({
        where: { id: agent.id, version: agent.version },
        data: {
          followup,
          followupDispatchedAt: null,
          status: "running",
          generation: { increment: 1 },
          version: { increment: 1 },
          nextPollAt: new Date(),
          errorCount: 0,
        },
      });
      if (!updated.count) return { error: "Cloud agent changed; check its status and try again." };
    } else if (name === "cloud_agent_cancel") {
      await deps.prisma.cloudAgent.update({
        where: { id: agent.id },
        data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: new Date() },
      });
    }
    agent = await deps.prisma.cloudAgent.findUniqueOrThrow({ where: { id: agent.id } });
  }
  // A status read only reports the row; queueing here would cut a backoff or Retry-After short
  // and could move back a poll that a cancel or follow-up just queued.
  if (agent.nextPollAt && name !== "cloud_agent_status") await enqueueCloudAgent(deps, agent.id);
  const { kind: _kind, agentId, ...snapshot } = cloudAgentBlock(agent);
  return {
    id: agentId,
    ...snapshot,
    ...(agent.cancelRequested ? { cancellationPending: true } : {}),
    ...(agent.followupDispatchedAt ? { followupPending: true } : {}),
  };
}

/** The row is the outbox; queue failure leaves recoverable intent for the reconciler. */
export async function enqueueCloudAgent(
  deps: Pick<CloudAgentDeps, "jobs">,
  agentId: string,
  availableAt?: Date,
) {
  await deps.jobs.enqueue(cloudAgentPollJob({ agentId }, availableAt)).catch(() => {
    getLogger().warn("cloud agent scheduling deferred to reconciliation");
  });
}

export async function reconcileCloudAgents(
  deps: Pick<CloudAgentDeps, "prisma" | "jobs" | "cloudAgent" | "userCloudAgents">,
) {
  const keys = [
    ...(deps.cloudAgent
      ? [
          {
            providerKey: deps.cloudAgent.key,
            ...(deps.cloudAgent.spaceId ? { spaceId: deps.cloudAgent.spaceId } : {}),
          },
        ]
      : []),
    ...(deps.userCloudAgents ? [{ providerKey: { startsWith: USER_CLOUD_AGENT_KEY_PREFIX } }] : []),
  ];
  if (!keys.length) return;
  const due = await deps.prisma.cloudAgent.findMany({
    where: { OR: keys, nextPollAt: { lte: new Date() } },
    orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const agent of due) await enqueueCloudAgent(deps, agent.id);
}
