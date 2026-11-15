import type { JobPublisher, MessagingInboundMessage, SandboxProvider } from "@rakazo/adapter-kit";
import { runContinueJob, teamChatEngageJobKey } from "@rakazo/adapter-kit";
import type { MessagingDelivery, OutboundLane } from "@rakazo/adapters";
import { MESSAGING_DM_OUTBOUND_CAP, messagingWakeIdempotencyKey } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT, isAttachmentAudioMimeType } from "@rakazo/contracts";
import type { MessagingCommand } from "@rakazo/core";
import {
  displayName,
  messageBlockForArtifact,
  normalizeVoiceTranscript,
  parseMessagingCommand,
  promptTextForAttachments,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type {
  MessagingIdentityRequest,
  Prisma,
  PrismaClient,
  ProvisionedMessagingIdentity,
  SignupPolicyEnv,
  ThreadEvents,
} from "@rakazo/db";
import {
  accountDeactivated,
  createThreadMessage,
  crossSpaceCommunicationAllowed,
  normalizeMessagingLinkCode,
  redeemMessagingLinkCode,
  SendClaimLostError,
  SpaceDeletionInProgressError,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { InboundAttachmentStore } from "./inbound-attachments.js";
import { storeInboundAttachments } from "./inbound-attachments.js";
import type { MessagingReceipts } from "./messaging-receipts.js";
import { cancelThreadRuns, finishThreadStop, STOPPED_BY_MESSAGE_NOTE } from "./thread-stop.js";
import {
  deliverWebhookEvent,
  formatUntrustedDeliveryPayload,
  inboundEventName,
} from "./webhook-inbound.js";

export interface MessagingInboundDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue" | "cancelIn">;
  /** Records the replies this line sends, and sends them straight away. */
  delivery: Pick<MessagingDelivery, "recordIn" | "send">;
  sandbox: SandboxProvider;
  provision: (
    request: MessagingIdentityRequest,
    env: SignupPolicyEnv,
  ) => Promise<ProvisionedMessagingIdentity>;
  /**
   * Poke-style open line: unknown senders auto-provision their own account.
   * Off by default — strangers' runs would bill the deployment model key.
   */
  openSignup: boolean;
  signupPolicy: SignupPolicyEnv;
  acknowledge?: MessagingReceipts["acknowledge"];
  storeAttachment?: InboundAttachmentStore;
  /**
   * Transcribes inbound audio with the bot owner's voice provider. On null or
   * a throw only the file reference is delivered. `signal` aborts when the
   * budget runs out.
   */
  transcribe?: (input: {
    spaceId: string;
    userId: string;
    audio: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
}

/** A stored inbound attachment, with spoken words when audio was transcribed. */
type StoredAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  transcript?: string;
};

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
};

/**
 * Inbound routing. 1:1 messages are messages to the sender's own bot (with
 * provisioning on first contact and the YES/NO/LEAVE/STOP owner commands).
 * Group messages drive channel discovery — upsert channel + members, DM
 * invites to linked owners, one intro when strangers are present — and
 * fan out to every approved member bot's own thread.
 */
export function createMessagingInboundHandler(deps: MessagingInboundDeps) {
  return async (event: MessagingInboundMessage): Promise<void> => {
    if (!event.isDirect) {
      await handleChannelEvent(deps, event);
      return;
    }
    await handleDirectEvent(deps, event).catch(droppedWhileDeleting);
  };
}

/** A Space being deleted takes no messages; failing would only make the provider redeliver. */
function droppedWhileDeleting(error: unknown): void {
  if (!(error instanceof SpaceDeletionInProgressError)) throw error;
  getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
}

async function handleDirectEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  // Media that only the provider can download (Telegram file_id fetches) rides
  // along in event.attachments; CDN media keeps riding along as text.
  const attachments = event.attachments ?? [];
  const text = [event.content, event.mediaUrl].filter(Boolean).join("\n");

  const where = { provider_address: { provider: event.provider, address: event.from } } as const;
  const existing = await deps.prisma.messagingIdentity.findUnique({ where });
  if (existing && event.installationSpaceId && existing.spaceId !== event.installationSpaceId)
    return;
  // A deactivated person's chat apps act for nobody: no commands, messages or links.
  if (existing && (await accountDeactivated(deps.prisma, existing.userId))) return;
  if (existing) {
    const command = parseMessagingCommand(event.content);
    const releasesHeld = existing.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP;
    // Read what a YES or NO answers before the held replies below go out: one
    // of them may be a request the person had not seen when they replied. A
    // redelivery of the reply that already released them answers nothing.
    const prompt =
      (command === "approve" || command === "decline") && existing.capReleaseHandle !== event.handle
        ? await latestPrompt(deps, existing)
        : null;
    // Any reply — even a content-free reaction — ends the consecutive-
    // outbound streak, but only real text wakes the bot. The conversation
    // id is refreshed from the webhook so outbound always has a thread.
    await deps.prisma.messagingIdentity.update({
      where: { id: existing.id },
      data: {
        outboundSinceInbound: 0,
        lastInboundAt: new Date(),
        dmThreadId: event.threadId,
        ...(releasesHeld ? { capReleaseHandle: event.handle } : {}),
      },
    });
    // Replies held behind the consecutive-outbound cap can go now.
    if (releasesHeld) await deps.delivery.send([{ identityId: existing.id }]);
    if (!text && attachments.length === 0) return;
    // Owner commands are only parsed in the verified 1:1 conversation.
    if (command === "stop") {
      // Only a bare "stop" is the command; one carrying media is delivered as a message.
      if (attachments.length === 0 && !event.mediaUrl) {
        await stopOwnerWork(deps, existing, event);
        return;
      }
    } else if (command && (await applyOwnerCommand(deps, existing, command, prompt))) return;
    // A linked sender pasting a fresh code re-points this address at another
    // of their bots (only their own codes apply).
    if (await tryRedeemLinkCode(deps, event)) return;
  } else {
    // Unlinked senders: a valid link code binds this address to its issuer's
    // account and bot; otherwise the line is silent unless the deployment
    // explicitly runs as an open Poke-style signup line.
    if (await tryRedeemLinkCode(deps, event)) return;
    if (!deps.openSignup || event.installationSpaceId) return;
    // Media-only delivery is for linked identities; retain text-based signup.
    if (!text) return;
  }

  let ids: ProvisionedMessagingIdentity;
  if (existing) {
    const thread = await deps.prisma.thread.findFirst({ where: { botId: existing.botId } });
    if (!thread) throw new Error(`messaging identity ${existing.id} has no thread`);
    ids = {
      provider: existing.provider,
      address: existing.address,
      userId: existing.userId,
      spaceId: existing.spaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  } else {
    ids = await deps.provision(
      {
        provider: event.provider,
        address: event.from,
        dmThreadId: event.threadId,
        displayName: event.fromLabel ? sanitizeMessagingLabel(event.fromLabel) : null,
      },
      deps.signupPolicy,
    );
  }

  const stored = await storeInboundMedia(deps, ids, event);

  // Message-trigger routines own the delivery when configured. Do not also
  // start a normal messaging continue for the same inbound handle.
  if (
    await wakeMessageRoutines(deps, ids, event, {
      artifacts: stored.artifacts,
      unavailable: stored.unavailable,
    })
  )
    return;
  const body = [text, ...stored.unavailable].filter(Boolean).join("\n");
  const sent = await deps.events.sendUserMessage({
    spaceId: ids.spaceId,
    threadId: ids.threadId,
    botId: ids.botId,
    userId: ids.userId,
    // The address is verified as this person\'s, so the line is theirs.
    authorUserId: ids.userId,
    blocks: [
      ...(body ? [{ kind: "text" as const, text: body }] : []),
      ...stored.artifacts.map((artifact) => messageBlockForArtifact(artifact)),
    ],
    prompt: promptTextForAttachments(body, stored.artifacts),
    trigger: "messaging",
    clientNonce: `messaging:${event.provider}:${event.handle}`,
  });
  if (sent.runId) {
    const runId = sent.runId;
    deps.acknowledge?.(event.threadId, event.handle, async () => {
      const run = await deps.prisma.run.findUnique({
        where: { id: runId },
        select: { status: true, messagingMirroredAt: true },
      });
      if (!run) return false;
      // A failed or cancelled run may never be mirrored, and no reply is coming.
      if (run.status === "failed" || run.status === "cancelled") return true;
      if (!run.messagingMirroredAt) return false;
      // Recording only queues the reply. It has gone out once none of this
      // run's recorded rows are still waiting to be sent.
      const replies = await deps.prisma.message.findMany({
        where: { runId, role: "bot" },
        select: { id: true },
      });
      if (replies.length === 0) return true;
      const unsent = await deps.prisma.messagingOutbound.count({
        where: {
          sourceMessageId: { in: replies.map((reply) => reply.id) },
          // Not out yet: waiting, or claimed (sent with no handle yet).
          OR: [{ status: { not: "sent" } }, { providerHandle: null }],
        },
      });
      return unsent === 0;
    });
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("messaging inbound run enqueue error", error);
    });
  }
}

/** Time for all voice note transcripts of one inbound message; files are delivered without them after it. */
const VOICE_TRANSCRIBE_BUDGET_MS = 20_000;

/**
 * How far a roster's platform time may run ahead of the server's clock and still count
 * as the roster's version; further ahead the event applies its membership unversioned.
 */
const ROSTER_TIME_SKEW_MS = 5 * 60_000;

/** Download provider-held files into thread artifacts, then transcribe voice notes. */
async function storeInboundMedia(
  deps: MessagingInboundDeps,
  ids: ProvisionedMessagingIdentity,
  event: MessagingInboundMessage,
) {
  const { stored, unavailable } = await storeInboundAttachments(
    deps.storeAttachment,
    ids,
    event.attachments ?? [],
    {
      clientNonce: (index) => `messaging-attachment:${event.provider}:${event.handle}:${index}`,
      limit: ATTACHMENT_MAX_COUNT,
      downloadDeadline: Date.now() + 2_000,
    },
  );
  // Transcribe only after every download, so a slow transcription cannot use up the
  // download deadline of the attachments that follow it. One short budget covers all
  // transcripts, so the webhook is answered before the provider retries it.
  const transcribeDeadline = Date.now() + VOICE_TRANSCRIBE_BUDGET_MS;
  const artifacts: StoredAttachment[] = [];
  for (const { artifact, bytes } of stored) {
    artifacts.push(await withVoiceTranscript(deps, ids, artifact, bytes, transcribeDeadline));
  }
  return { artifacts, unavailable };
}

/**
 * Best-effort transcript for a stored audio attachment. No provider, oversize
 * audio or a failed call leaves the artifact unchanged, so the message is
 * still delivered with the file reference.
 */
async function withVoiceTranscript(
  deps: MessagingInboundDeps,
  ids: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId">,
  artifact: StoredAttachment,
  bytes: Uint8Array | undefined,
  deadline: number,
): Promise<StoredAttachment> {
  if (!deps.transcribe || !bytes || !isAttachmentAudioMimeType(artifact.mimeType)) return artifact;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return artifact;
  // The timer both stops waiting and cancels the provider call, so a stalled
  // request does not keep running after the message is delivered without it.
  const cancel = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      cancel.abort();
      resolve(null);
    }, remaining);
  });
  const call = deps
    .transcribe({
      spaceId: ids.spaceId,
      userId: ids.userId,
      audio: bytes,
      mimeType: artifact.mimeType,
      signal: cancel.signal,
    })
    .catch((error) => {
      // Reason only: the audio and the transcript never reach the log.
      getLogger().warn("messaging attachment transcription failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const transcript = await Promise.race([call, timedOut]).finally(() => clearTimeout(timer));
  // Normalized once here, so the direct prompt and the routine payload carry the same bounded text.
  const normalized = normalizeVoiceTranscript(transcript);
  return normalized ? { ...artifact, transcript: normalized } : artifact;
}

/** Wake provider-neutral message routines through the same approval boundary as webhooks. */
export async function wakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma" | "events" | "jobs">,
  target: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId" | "botId" | "threadId">,
  event: MessagingInboundMessage,
  options?: {
    /** Wake clientNonce prefix; must match TeamChatBridge.providerId when event.provider differs. */
    deliveryProvider?: string;
    artifacts?: StoredAttachment[];
    unavailable?: string[];
    /**
     * TeamChat external message id. The wake claims the deferred message in the
     * transaction that starts its run, so the agent can never also answer it.
     * Returns true when the agent already had it.
     */
    externalMessageId?: string;
  },
): Promise<boolean> {
  const routines = await deps.prisma.routine.findMany({
    where: {
      botId: target.botId,
      spaceId: target.spaceId,
      // The wake runs as the identity's person, so only their own routines may ride on it.
      userId: target.userId,
      active: true,
      messageProvider: event.provider,
    },
    select: {
      id: true,
      name: true,
      prompt: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (routines.length === 0) return false;

  const provider = inboundEventName(event.provider);
  const prompt = formatUntrustedDeliveryPayload(`[Messaging Event: ${provider}]`, {
    provider: event.provider,
    kind: event.isDirect ? "direct" : "channel",
    handle: event.handle,
    from: event.from,
    fromLabel: event.fromLabel,
    channelName: event.channelName,
    content: event.content,
    mediaUrl: event.mediaUrl,
    ...(options?.unavailable?.length ? { unavailable: options.unavailable } : {}),
    ...(event.attachments?.length
      ? {
          files: event.attachments.map(({ name, mimeType, size }) => ({
            name,
            mimeType,
            size,
          })),
        }
      : {}),
    ...(options?.artifacts?.some((artifact) => artifact.transcript)
      ? {
          voiceTranscripts: options.artifacts
            .filter((artifact) => artifact.transcript)
            .map((artifact) => ({ name: artifact.name, transcript: artifact.transcript })),
        }
      : {}),
  });
  const externalMessageId = options?.externalMessageId;
  try {
    await deliverWebhookEvent(
      { events: deps.events, jobs: deps.jobs },
      {
        bot: { id: target.botId, spaceId: target.spaceId, userId: target.userId },
        threadId: target.threadId,
      },
      {
        prompt,
        artifacts: options?.artifacts,
        routines,
        source: "messaging",
        idempotencyKey: messagingWakeIdempotencyKey(
          options?.deliveryProvider ?? event.provider,
          event.handle,
        ),
        // TeamChat channel wakes may share a live thread with an active chat run.
        allowParallelRun: true,
        ...(externalMessageId
          ? {
              claim: async (tx: Prisma.TransactionClient) => {
                const claimed = await tx.externalMessage.updateMany({
                  where: { id: externalMessageId, status: "deferred" },
                  data: { status: "ignored", engagementReason: "message_routine_wake" },
                });
                if (claimed.count !== 1) return false;
                await deps.jobs.cancelIn(tx, teamChatEngageJobKey(externalMessageId));
                return true;
              },
            }
          : {}),
      },
    );
  } catch (error) {
    if (error instanceof SendClaimLostError) return true;
    throw error;
  }
  return true;
}

/**
 * TeamChat engagement can still receive the message, but unattended
 * message-routine wakes reuse the personal-line approval boundary:
 * linked identity for DMs; approved channel member when we have membership
 * state; otherwise a linked identity so public-channel strangers cannot start
 * active routines.
 */
export async function teamChatSenderCanWakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma">,
  event: MessagingInboundMessage,
): Promise<boolean> {
  if (event.senderIsBot) return false;

  const linkedIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { id: true, userId: true },
  });
  // A deactivated person counts as unlinked: like anyone in the workspace, never as themselves.
  if (linkedIdentity && (await accountDeactivated(deps.prisma, linkedIdentity.userId)))
    return false;

  if (event.isDirect) return Boolean(linkedIdentity);

  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { threadId: event.threadId },
    select: { id: true },
  });
  if (channel) {
    const member = await deps.prisma.messagingChannelMember.findUnique({
      where: { channelId_address: { channelId: channel.id, address: event.from } },
      select: { status: true },
    });
    return member?.status === "approved";
  }

  // Pure TeamChat workspace rooms have no personal membership ledger.
  // Still require a linked sender before waking message routines.
  return Boolean(linkedIdentity);
}

/**
 * Returns true when the message was exactly a link code that redeemed:
 * the address is now bound to the issuer's chosen bot and a confirmation
 * DM is on its way. An invalid or expired code falls through silently —
 * for linked senders it reads as a normal message, for strangers nothing
 * happens (no oracle, no reply spam).
 */
async function tryRedeemLinkCode(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<boolean> {
  const code = normalizeMessagingLinkCode(event.content);
  if (!code) return false;
  const redeemed = await redeemMessagingLinkCode(
    deps.prisma,
    {
      code,
      provider: event.provider,
      address: event.from,
      dmThreadId: event.threadId,
      spaceId: event.installationSpaceId,
      installationId: event.installationId,
    },
    async (tx, linked) => {
      const bot = await tx.bot.findUnique({
        where: { id: linked.botId },
        select: { name: true },
      });
      await writeConfirmation(
        deps,
        tx,
        { id: linked.identityId },
        linked.confirmationKey,
        `Linked. Messages here now reach "${bot?.name ?? "your agent"}".`,
      );
    },
  );
  if (!redeemed) return false;
  await deps.delivery.send([{ identityId: redeemed.identityId }]);
  return true;
}

/**
 * The owner's "stop", an owner command like YES/NO/LEAVE: Stop for their bot's chat, always
 * answered by text. The answer's row, written first, is this delivery's receipt, so a
 * redelivered or concurrent copy finds it and changes nothing.
 */
async function stopOwnerWork(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  event: MessagingInboundMessage,
): Promise<void> {
  const thread = await deps.prisma.thread.findFirstOrThrow({
    where: { botId: identity.botId },
    select: { id: true },
  });
  const key = `command:stop:${identity.id}:${event.handle}`;
  const target = { kind: "bot", botId: identity.botId, threadId: thread.id } as const;
  const stop = await deps.prisma.$transaction(async (tx) => {
    const receipt = await deps.delivery.recordIn(tx, { identityId: identity.id }, [
      { idempotencyKey: key, kind: "dm", identityId: identity.id, body: "Nothing is running." },
    ]);
    if (receipt.length === 0) return null;
    const stop = await cancelThreadRuns(identity, target, { botId: identity.botId })(tx);
    if (stop.runIds.length) {
      await tx.messagingOutbound.update({
        where: { idempotencyKey: key },
        data: { body: STOPPED_BY_MESSAGE_NOTE },
      });
    }
    return stop;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await deps.delivery.send([{ identityId: identity.id }]);
  if (stop?.runIds.length) await finishThreadStop(deps, identity, target, stop);
}

/** The newest message this line sent the person, as it stood when their reply arrived. */
function latestPrompt(deps: MessagingInboundDeps, identity: IdentityRow) {
  return deps.prisma.messagingOutbound.findFirst({
    where: { identityId: identity.id, kind: "dm" },
    orderBy: { createdAt: "desc" },
    select: { idempotencyKey: true, createdAt: true, status: true, providerHandle: true },
  });
}

type LatestPrompt = Awaited<ReturnType<typeof latestPrompt>>;

/** How long a channel invite or connection request can be answered by text. */
export const TEXT_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one request a bare YES or NO answers: the request whose prompt was the newest message this
 * line had sent the person when the reply arrived, confirmed delivered within the answer window
 * and still pending. Anything
 * said since, by the bot or the product, makes the reply an ordinary message. So does a newest
 * message that is still on its way or failed: the person may have seen it, so no older prompt may
 * take the reply in its place.
 */
async function answeredRequest(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  latest: LatestPrompt,
) {
  if (
    latest?.status !== "sent" ||
    latest.providerHandle === null ||
    Date.now() - latest.createdAt.getTime() > TEXT_ANSWER_WINDOW_MS
  ) {
    return null;
  }
  const [kind, first, second] = latest.idempotencyKey.split(":");
  if (kind === "invite" && first && second === identity.id) {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { channelId: first, identityId: identity.id, status: "invited" },
    });
    return membership ? ({ kind: "channel", membership } as const) : null;
  }
  if (kind === "connect" && first && second === identity.botId) {
    const connection = await deps.prisma.agentConnection.findFirst({
      where: { requesterBotId: first, targetBotId: identity.botId, status: "pending" },
    });
    return connection ? ({ kind: "connection", connection } as const) : null;
  }
  return null;
}

/** Returns true when the command matched a pending item and was handled. */
async function applyOwnerCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  command: Exclude<MessagingCommand, "stop">,
  prompt: LatestPrompt,
): Promise<boolean> {
  if (command === "leave") {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { identityId: identity.id, status: "approved" },
      orderBy: { updatedAt: "desc" },
    });
    if (!membership) return false;
    // One transaction, so a failed confirmation leaves the membership as it
    // was and a redelivered LEAVE cannot move on to the next group.
    const claimed = await deps.prisma.$transaction(async (tx) => {
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: membership.id, status: "approved" },
        data: { status: "left" },
      });
      // State changed under us (e.g. swept out and re-invited): treat the
      // text as a normal message rather than overwriting the newer state.
      if (count === 0) return false;
      await writeConfirmation(
        deps,
        tx,
        identity,
        `command:leave:${membership.id}`,
        "You've left the channel. Your agent will no longer post there. The group chat itself is unchanged.",
      );
      return true;
    });
    if (!claimed) return false;
    await deps.delivery.send([{ identityId: identity.id }]);
    return true;
  }

  const target = await answeredRequest(deps, identity, prompt);
  if (!target) return false;
  const approved = command === "approve";

  if (target.kind === "channel") {
    const key = `command:${command}:${target.membership.id}`;
    const claimed = await deps.prisma.$transaction(async (tx) => {
      // The claim holds the membership row lock through commit, so the
      // participant sweep can never interleave with the confirmation write.
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: target.membership.id, status: "invited" },
        data: { status: approved ? "approved" : "declined" },
      });
      // Swept out or answered elsewhere since the read: not ours to write.
      if (count === 0) return false;
      await writeConfirmation(
        deps,
        tx,
        identity,
        key,
        approved
          ? "You're in. Your agent will now see and reply to that group."
          : "No problem, your agent will stay out of that group.",
      );
      return true;
    });
    if (!claimed) return false;
    await deps.delivery.send([{ identityId: identity.id }]);
    return true;
  }

  const connectedKey = `command:connected:${target.connection.id}`;
  const requesterIdentity = approved
    ? await deps.prisma.messagingIdentity.findUnique({
        where: { botId: target.connection.requesterBotId },
      })
    : null;
  const key = `command:${command}:${target.connection.id}`;
  const claimed = await deps.prisma.$transaction(async (tx) => {
    // The claim holds the connection row lock through commit, so a revoke
    // can never interleave with the confirmation writes.
    if (
      approved &&
      !(await crossSpaceCommunicationAllowed(tx, target.connection.requesterBotId, identity.botId))
    )
      return false;
    const { count } = await tx.agentConnection.updateMany({
      where: { id: target.connection.id, status: "pending" },
      data: { status: approved ? "approved" : "declined" },
    });
    // Revoked or answered elsewhere since the read: not ours to write.
    if (count === 0) return false;
    const confirmations = [
      {
        identity,
        key,
        body: approved
          ? "Connection approved. Your agents can now message each other."
          : "Connection declined.",
      },
      ...(requesterIdentity
        ? [
            {
              identity: requesterIdentity,
              key: connectedKey,
              body: "Your connection request was accepted. Your agents can now message each other.",
            },
          ]
        : []),
    ];
    // In one order every writer agrees on, so two answers cannot deadlock on the two chats.
    for (const confirmation of confirmations.toSorted((a, b) =>
      a.identity.id.localeCompare(b.identity.id),
    ))
      await writeConfirmation(deps, tx, confirmation.identity, confirmation.key, confirmation.body);
    return true;
  });
  if (!claimed) return false;
  await deps.delivery.send([
    { identityId: identity.id },
    ...(requesterIdentity ? [{ identityId: requesterIdentity.id }] : []),
  ]);
  return true;
}

/** Replaces the prior cycle's row, which would otherwise suppress the new confirmation. */
async function writeConfirmation(
  deps: Pick<MessagingInboundDeps, "delivery">,
  tx: Prisma.TransactionClient,
  identity: { id: string },
  key: string,
  body: string,
): Promise<void> {
  await deps.delivery.recordIn(
    tx,
    { identityId: identity.id },
    [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
    { replace: true },
  );
}

async function handleChannelEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const channelName = event.channelName ? sanitizeMessagingLabel(event.channelName) : null;
  const channel = await deps.prisma.messagingChannel.upsert({
    where: { threadId: event.threadId },
    create: { provider: event.provider, threadId: event.threadId, name: channelName },
    update: channelName ? { name: channelName } : {},
  });

  // Telegram reports departures one service message at a time; a rosterless
  // platform has no sweep, so this delta is the only removal signal. Our own
  // bot leaving ends every membership: nothing more is delivered there. The
  // event itself carries no conversation — no intro, no run — and it runs before
  // member discovery, so a departing sender is never invited or announced.
  if (event.departures) {
    // Leaving the chat ends membership in every conversation of it: forum topics
    // are channels of their own (`<provider>:<chat>:<topic>`) on the same mount.
    const chat = event.threadId.split(":").slice(0, 2).join(":");
    const chatChannels = await deps.prisma.messagingChannel.findMany({
      where: {
        provider: event.provider,
        OR: [{ threadId: chat }, { threadId: { startsWith: `${chat}:` } }],
      },
      select: { id: true },
    });
    // The query includes this channel: its thread id is the chat or one of its topics.
    const channelIds = chatChannels.map((row) => row.id);
    await deps.prisma.messagingChannelMember.updateMany({
      where: event.departures.botLeft
        ? { channelId: { in: channelIds }, status: { in: ["invited", "approved"] } }
        : {
            channelId: { in: channelIds },
            address: { in: event.departures.addresses },
            status: { in: ["invited", "approved"] },
          },
      data: { status: "left" },
    });
    return;
  }

  // A deactivated sender's message does nothing: no invitations, memberships or relays.
  const sender = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { userId: true },
  });
  if (sender && (await accountDeactivated(deps.prisma, sender.userId))) return;

  const participants = [...event.participants];
  if (!participants.includes(event.from)) participants.push(event.from);

  // Roster membership changes go with the roster's own version, under the channel's
  // row lock. A webhook retry can deliver a roster older than one a newer event
  // already settled, and without the lock an older handler could pass the version
  // check, pause, and then sweep members the newer roster had just settled. Whichever
  // handler takes the lock first records its roster time — equal times conflict too —
  // and a handler whose roster is not newer than the recorded one changes no
  // membership at all: no sweep, no re-invite, no discovery. Invitations are
  // announced only after the transaction commits.
  // The roster time is the platform's clock, which can run ahead of ours. Within a
  // small skew it stays the version, so ordering and redeliveries behave as usual.
  // Further ahead the time is bogus and the event's roster is distrusted whole, on
  // every delivery alike: it changes no membership — no discovery, no invites, no
  // sweep — and records no time, so it can never settle or unsettle members, and a
  // far-future time can never sit ahead of every later real roster and freeze it.
  const eventRosterAt = event.participants.length > 0 ? event.rosterAt : undefined;
  const rosterTimeRejected =
    eventRosterAt !== undefined && eventRosterAt.getTime() > Date.now() + ROSTER_TIME_SKEW_MS;
  const rosterAt = rosterTimeRejected ? undefined : eventRosterAt;
  const invited: IdentityRow[] = [];
  const invites: OutboundInvite[] = [];
  let hasUnlinked = false;
  await deps.prisma.$transaction(async (tx) => {
    // A rejected time distrusts the event's membership entirely; its message content,
    // if any, still flows below as for any message.
    if (rosterTimeRejected) return;
    await tx.$queryRaw`SELECT id FROM messaging_channels WHERE id = ${channel.id} FOR UPDATE`;
    if (rosterAt) {
      const settled = await tx.messagingChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { rosterSeenAt: true },
      });
      if (settled.rosterSeenAt && rosterAt <= settled.rosterSeenAt) return;
      await tx.messagingChannel.update({
        where: { id: channel.id },
        data: { rosterSeenAt: rosterAt },
      });
    }
    for (const address of participants) {
      const identity = await tx.messagingIdentity.findUnique({
        where: { provider_address: { provider: event.provider, address } },
      });
      const member = await tx.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address } },
      });
      if (member) {
        // Compare against the current identity, not just null: unlinking
        // deletes the identity row but leaves this FK-free column pointing at
        // the dead id, so a re-link would otherwise never reattach and the
        // member would sit in the channel unreachable by every lookup.
        if (identity && member.identityId !== identity.id) {
          await tx.messagingChannelMember.update({
            where: { id: member.id },
            data: { identityId: identity.id },
          });
          if (member.status === "invited") {
            if (await queueInvite(tx, channel, identity, invites)) invited.push(identity);
          }
        }
        if (member.status === "left") {
          // Back in the group: restart the approval cycle.
          await tx.messagingChannelMember.update({
            where: { id: member.id },
            data: { status: "invited" },
          });
          if (identity) {
            if (await queueInvite(tx, channel, identity, invites)) invited.push(identity);
          }
        }
        if (!identity) hasUnlinked = true;
        continue;
      }
      // Upsert, not create: concurrent group webhooks race on the unique key.
      await tx.messagingChannelMember.upsert({
        where: { channelId_address: { channelId: channel.id, address } },
        create: {
          channelId: channel.id,
          address,
          identityId: identity?.id ?? null,
          status: "invited",
        },
        update: {},
      });
      if (identity) {
        if (await queueInvite(tx, channel, identity, invites)) invited.push(identity);
      } else hasUnlinked = true;
    }

    // Someone removed from the group must stop receiving its content.
    // A webhook without a participants roster says nothing about membership —
    // never sweep on partial data.
    if (event.participants.length > 0) {
      await tx.messagingChannelMember.updateMany({
        where: {
          channelId: channel.id,
          address: { notIn: participants },
          status: { in: ["invited", "approved"] },
        },
        data: { status: "left" },
      });
    }
    // In one order every writer agrees on, so two groups inviting the same people cannot
    // deadlock on their conversations.
    for (const invite of invites.toSorted((a, b) => a.identityId.localeCompare(b.identityId)))
      await deps.delivery.recordIn(tx, { identityId: invite.identityId }, [invite], {
        replace: true,
      });
  });
  for (const identity of invited) await announceInvite(deps, channel, identity);
  if (invites.length > 0)
    await deps.delivery.send(invites.map(({ identityId }) => ({ identityId })));

  if (hasUnlinked && !channel.introPostedAt) {
    const lane: OutboundLane = { identityId: null, threadId: channel.threadId };
    await deps.prisma.$transaction(async (tx) => {
      await deps.delivery.recordIn(tx, lane, [
        {
          idempotencyKey: `intro:${channel.id}`,
          kind: "intro",
          threadId: channel.threadId,
          body: "Hi. This line hosts Rakazo personal agents. Some people in this group haven't messaged it yet; send any message to this line first if you want your own agent here.",
        },
      ]);
      await tx.messagingChannel.update({
        where: { id: channel.id },
        data: { introPostedAt: new Date() },
      });
    });
    await deps.delivery.send([lane]);
  }

  // A service message (a pin, a join) carries nothing for a bot to read.
  if (!event.content.trim() && !event.mediaUrl && !event.attachments?.length) return;

  // Only approved owners' bots participate.
  const senderMember = await deps.prisma.messagingChannelMember.findUnique({
    where: { channelId_address: { channelId: channel.id, address: event.from } },
  });
  if (senderMember?.status !== "approved") return;

  const senderIdentity = senderMember.identityId
    ? await deps.prisma.messagingIdentity.findUnique({ where: { id: senderMember.identityId } })
    : null;
  const fromLabel = senderIdentity
    ? await ownerFirstName(deps.prisma, senderIdentity.userId, event.from)
    : event.from;

  const approved = await deps.prisma.messagingChannelMember.findMany({
    where: { channelId: channel.id, status: "approved", identityId: { not: null } },
  });
  const block: MessageBlock = {
    kind: "channel_message",
    provider: event.provider,
    ...(event.transport ? { transport: event.transport } : {}),
    channelId: channel.id,
    fromAddress: event.from,
    fromLabel,
    text: event.content,
    hop: 0,
  };
  const prompt = `[Group "${channel.name ?? "group"}", ${fromLabel}]: ${event.content}`;
  for (const member of approved) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { id: member.identityId! },
    });
    if (!identity || (await accountDeactivated(deps.prisma, identity.userId))) continue;
    const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
    if (!thread) continue;
    const target = {
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: identity.botId,
      threadId: thread.id,
    };
    // One member's Space being deleted must not keep the message from the others.
    try {
      if (await wakeMessageRoutines(deps, target, event)) continue;
      // Group runs carry only text; a bare photo would start an empty prompt.
      if (!event.content.trim()) continue;

      const sent = await deps.events.sendUserMessage({
        spaceId: identity.spaceId,
        threadId: thread.id,
        botId: identity.botId,
        userId: identity.userId,
        blocks: [block],
        prompt,
        trigger: "messaging",
        clientNonce: `messaging:${event.provider}:${event.handle}`,
      });
      if (sent.runId) {
        await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
          getLogger().error("messaging channel fan-out enqueue error", error);
        });
      }
    } catch (error) {
      droppedWhileDeleting(error);
    }
  }
}

type OutboundInvite = { idempotencyKey: string; kind: "dm"; identityId: string; body: string };

/**
 * A returning member restarts the approval cycle, so the invite replaces the prior one, which
 * would otherwise leave them with no prompt to answer.
 */
async function queueInvite(
  db: Pick<PrismaClient, "user">,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
  invites: OutboundInvite[],
): Promise<boolean> {
  // A deactivated person is not invited anywhere.
  if (await accountDeactivated(db, identity.userId)) return false;
  const name = channel.name ?? "a group chat";
  const idempotencyKey = `invite:${channel.id}:${identity.id}`;
  if (invites.some((invite) => invite.idempotencyKey === idempotencyKey)) return true;
  invites.push({
    idempotencyKey,
    kind: "dm",
    identityId: identity.id,
    body: `"${name}" was linked to your Rakazo agent. Reply YES to let your agent join the conversation there, or NO to stay out.`,
  });
  return true;
}

async function announceInvite(
  deps: MessagingInboundDeps,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
): Promise<void> {
  const name = channel.name ?? "a group chat";
  const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
  if (thread) {
    const note = await createThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "system",
      blocks: [
        {
          kind: "meta",
          text: `You were added to the group chat "${name}". Reply YES in this conversation to join it with your agent.`,
        },
      ],
    });
    await deps.events.notify(thread.id, note.seq).catch(() => undefined);
  }
}

async function ownerFirstName(
  prisma: PrismaClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = displayName(user?.name, "").split(/\s+/)[0];
  return first ? sanitizeMessagingLabel(first) : fallback;
}
