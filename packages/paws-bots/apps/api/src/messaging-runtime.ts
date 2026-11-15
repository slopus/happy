import type {
  ArtifactStore,
  JobPublisher,
  MessagingInboundEvent,
  MessagingSurface,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { MessagingDelivery, MessagingInstallations, TeamChat } from "@rakazo/adapters";
import { applyMessagingOutboundStatus, createMessagingTeamChatHistory } from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { storeInboundAttachment } from "./artifacts.js";
import type { AppEnv } from "./env.js";
import { createMessagingInboundHandler } from "./messaging-inbound.js";
import { createMessagingReceipts } from "./messaging-receipts.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { createTeamChatInboundHandler } from "./team-chat-inbound.js";
import { prefersTeamChatSurface } from "./team-chat-startup.js";
import { transcribeInboundVoice } from "./voice.js";

/** Messaging and team chat for one API process; `stop` ends polling and receipts. */
export async function startMessagingRuntime({
  app,
  prisma,
  events,
  jobs,
  sandbox,
  secrets,
  artifacts,
  env,
  messaging,
  messagingInstallations,
  delivery,
  teamChat,
}: {
  app: Hono;
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancelIn">;
  sandbox: SandboxProvider;
  secrets: SecretStore;
  artifacts: ArtifactStore;
  env: AppEnv;
  messaging: MessagingSurface;
  messagingInstallations: MessagingInstallations | undefined;
  delivery: MessagingDelivery;
  teamChat: TeamChat;
}): Promise<{ stop: () => Promise<void> }> {
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let clearMessagingRetryDelay: (() => void) | undefined;
  const receipts = createMessagingReceipts(messaging);
  const storeAttachment: Parameters<typeof createMessagingInboundHandler>[0]["storeAttachment"] = ({
    spaceId,
    userId,
    ...input
  }) =>
    storeInboundAttachment(
      { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
      { spaceId, userId },
      input,
    );
  const inboundDeps = {
    prisma,
    events,
    jobs,
    delivery,
    sandbox,
    provision: (request, policyEnv) => provisionMessagingIdentity(prisma, request, policyEnv),
    openSignup: env.messagingOpenSignup,
    signupPolicy: {
      signupsEnabled: env.signupsEnabled,
      signupAllowlist: env.signupAllowlist,
    },
    acknowledge: receipts.acknowledge,
    storeAttachment,
    transcribe: ({ spaceId, userId, audio, mimeType, signal }) =>
      transcribeInboundVoice(
        {
          prisma,
          secrets,
          env: { mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint },
        },
        { spaceId, userId },
        { audio, mimeType, signal },
      ),
  } satisfies Parameters<typeof createMessagingInboundHandler>[0];
  const inbound = createMessagingInboundHandler(inboundDeps);
  const handleTeamChatInbound = createTeamChatInboundHandler(inboundDeps, inbound, teamChat);
  const bridges = new Map<string, TeamChatBridge>();
  /** One bridge per bot and connected workspace; it holds no timers, so it is never stopped. */
  const bridgeFor = (botId: string, installation?: { id: string; workspaceId: string }) => {
    const key = installation?.id ?? `static:${botId}`;
    let bridge = bridges.get(key);
    if (!bridge) {
      bridge = new TeamChatBridge({
        prisma,
        teamChat,
        jobs,
        fetchThreadHistory: createMessagingTeamChatHistory(messaging),
        storeAttachment,
        providerId: "slack",
        botId,
        workspaceId: installation?.workspaceId,
        isAvailable: installation
          ? async () => Boolean(await messagingInstallations?.isActive(installation.id))
          : undefined,
        acknowledge: receipts.acknowledge,
      });
      bridges.set(key, bridge);
    }
    return bridge;
  };
  const handleInbound = async (event: MessagingInboundEvent) => {
    if (event.type !== "message") {
      await applyMessagingOutboundStatus(prisma, event);
      return;
    }
    if (event.installationBotId && !event.isDirect) {
      if (!event.installationId || !event.workspaceId) return;
      await handleTeamChatInbound(
        bridgeFor(event.installationBotId, {
          id: event.installationId,
          workspaceId: event.workspaceId,
        }),
        event,
      );
      return;
    }
    if (
      !event.installationBotId &&
      env.teamChatBotId &&
      prefersTeamChatSurface(event, env.teamChatBotId)
    ) {
      await handleTeamChatInbound(bridgeFor(env.teamChatBotId), event);
      return;
    }
    await inbound(event);
  };
  messaging.onInbound((event) => runAsSystem("messaging inbound", () => handleInbound(event)));
  mountMessagingWebhookRoutes(app, { messaging });
  // Start polling adapters now rather than on the first webhook or send; a second poller
  // elsewhere would fight this one for Telegram's single getUpdates slot. Bounded retries
  // cover transient startup failures, otherwise polling-only bots stay dark.
  const messagingInitTask = (async () => {
    const delayMs = [0, 2_000, 10_000];
    for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
      if (messagingStopped) return;
      if (delayMs[attempt]! > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs[attempt]);
          clearMessagingRetryDelay = () => {
            clearTimeout(timer);
            clearMessagingRetryDelay = undefined;
            resolve();
          };
        });
        clearMessagingRetryDelay = undefined;
      }
      if (messagingStopped) return;
      try {
        await messaging.initialize?.();
        return;
      } catch (error) {
        getLogger().error(
          attempt === delayMs.length - 1
            ? "messaging surface initialize failed"
            : "messaging surface initialize failed; retrying",
          error,
        );
      }
    }
  })();
  return {
    stop: async () => {
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      receipts.stop();
      await messagingInitTask.catch(() => undefined);
      await messaging.shutdown?.();
    },
  };
}
