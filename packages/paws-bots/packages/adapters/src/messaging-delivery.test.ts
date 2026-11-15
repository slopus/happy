import type {
  AdapterContext,
  BackgroundJob,
  JobTransaction,
  MessagingInstallProvider,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import {
  MESSAGING_SEND_MAX_ATTEMPTS,
  messagingReplyJob,
  messagingReplyJobKey,
  messagingSendJobKey,
  RetryJobLaterError,
} from "@rakazo/adapter-kit";
import {
  CHAT_APP_ASK_NOTE,
  CHAT_APP_TAKEOVER_NOTE,
  TAKEOVER_COMPUTER_PENDING_STATE,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { SpaceDeletionInProgressError } from "@rakazo/db";
import type { Adapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface, MessagingSendError } from "./chat-sdk-surface.js";
import { InstalledMessagingSurface } from "./installed-messaging-surface.js";
import type { MessagingDeliveryDeps, OutboundLane, OutboundRow } from "./messaging-delivery.js";
import {
  applyMessagingOutboundStatus,
  MESSAGING_DM_OUTBOUND_CAP,
  MESSAGING_SEND_BACKUP_MS,
  MESSAGING_SEND_STALE_MS,
  MESSAGING_SEND_TIMEOUT_MS,
  MessagingDelivery,
} from "./messaging-delivery.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";
import { userProgressClientNonce } from "./user-progress.js";

type Where = Record<string, unknown>;

type OutboundRecord = {
  id: string;
  idempotencyKey: string;
  kind: string;
  identityId: string | null;
  threadId: string | null;
  body: string;
  status: string;
  providerHandle: string | null;
  claimedAt?: Date | null;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MessageRecord = {
  id: string;
  threadId: string;
  runId: string | null;
  role: string;
  seq: number;
  clientNonce: string | null;
  blocks: unknown[];
  replyToMessageId: string | null;
};

type IdentityRecord = {
  id: string;
  botId: string;
  userId: string;
  spaceId: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  outboundSinceInbound: number;
};

type Reply = { id: string; blocks: unknown[]; clientNonce?: string };

function createWorld() {
  const bot = (name: string, userId: string, spaceId: string) => ({
    name,
    userId,
    spaceId,
    crossSpaceCommunication: true,
    archivedAt: null as Date | null,
  });
  return {
    users: new Map([
      ["user-1", { name: "Alice Owner", deactivatedAt: null as Date | null }],
      ["user-2", { name: "Bob Peer", deactivatedAt: null as Date | null }],
      ["user-9", { name: "Carol Requester", deactivatedAt: null as Date | null }],
    ]),
    bots: new Map([
      ["bot-1", bot("Assistant", "user-1", "ws-1")],
      ["bot-2", bot("Helper", "user-2", "ws-2")],
      ["bot-9", bot("Scout", "user-9", "ws-9")],
    ]),
    identities: [
      {
        id: "mi-1",
        botId: "bot-1",
        userId: "user-1",
        spaceId: "ws-1",
        provider: "sendblue",
        address: "+15551234567",
        dmThreadId: "sendblue:dm-1",
        outboundSinceInbound: 0,
      },
      {
        id: "mi-2",
        botId: "bot-2",
        userId: "user-2",
        spaceId: "ws-2",
        provider: "sendblue",
        address: "+15553333333",
        dmThreadId: "sendblue:dm-2",
        outboundSinceInbound: 0,
      },
    ] as IdentityRecord[],
    threads: [
      { id: "thread-1", botId: "bot-1", userId: "user-1", nextMessageSeq: 100, nextEventSeq: 100 },
      { id: "thread-2", botId: "bot-2", userId: "user-2", nextMessageSeq: 100, nextEventSeq: 100 },
      // bot-1's thread for one team-chat conversation.
      {
        id: "thread-slack",
        botId: "bot-1",
        userId: "user-1",
        nextMessageSeq: 100,
        nextEventSeq: 100,
        conversationBotId: "bot-1",
      },
    ] as Array<{
      id: string;
      botId: string;
      userId: string;
      nextMessageSeq: number;
      nextEventSeq: number;
      conversationBotId?: string;
    }>,
    runs: [] as Array<{
      id: string;
      botId: string;
      threadId: string;
      userId: string;
      trigger: string;
      status: string;
      sourceMessageId: string | null;
      messagingMirroredAt: Date | null;
      /** The previous release's marker for a delegated reply it posted itself. */
      teamChatMirroredAt?: Date | null;
    }>,
    messages: [] as MessageRecord[],
    externalMessages: [] as Array<{
      id: string;
      runId: string;
      kind: string;
      status: string;
      replyThreadId: string | null;
      externalConversation: { conversationId: string };
    }>,
    channels: [{ id: "ch-1", provider: "sendblue", threadId: "sendblue:grp-1", name: "Family" }],
    channelMembers: [
      { channelId: "ch-1", identityId: "mi-1", status: "approved" },
      { channelId: "ch-1", identityId: "mi-2", status: "approved" },
    ],
    artifacts: [] as Array<{
      id: string;
      spaceId: string;
      userId: string;
      name: string;
      mimeType: string;
      storageKey: string;
    }>,
    /** agent_connections status by `requesterBotId:targetBotId`. */
    connections: new Map<string, string>(),
    outbound: [] as OutboundRecord[],
    events: [] as Array<Record<string, unknown>>,
  };
}

type World = ReturnType<typeof createWorld>;

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matchesValue(value: unknown, condition: unknown): boolean {
  if (condition === null) return value == null;
  if (condition instanceof Date) return compare(value, condition) === 0;
  if (typeof condition !== "object") return value === condition;
  const bound = condition as { in?: unknown[]; not?: unknown; lt?: unknown; gt?: unknown };
  return (
    (bound.in === undefined || bound.in.includes(value)) &&
    (bound.not === undefined || !matchesValue(value, bound.not)) &&
    (bound.lt === undefined || compare(value, bound.lt) < 0) &&
    (bound.gt === undefined || compare(value, bound.gt) > 0)
  );
}

/** The where shapes the delivery queries use: equality, null, in/not/lt/gt, OR, AND and NOT. */
function matches(record: object, where: Where = {}): boolean {
  const fields = record as Record<string, unknown>;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((part) => matches(record, part));
    if (key === "AND") return (condition as Where[]).every((part) => matches(record, part));
    if (key === "NOT") return !matches(record, condition as Where);
    return matchesValue(fields[key], condition);
  });
}

function bySendOrder(a: OutboundRecord, b: OutboundRecord) {
  return compare(a.createdAt, b.createdAt) || compare(a.id, b.id);
}

function copy<T extends object>(record: T | undefined): T | null {
  return record ? { ...record } : null;
}

function applyData(record: object, data: Where) {
  const fields = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    fields[key] =
      value !== null && typeof value === "object" && "increment" in value
        ? (fields[key] as number) + (value as { increment: number }).increment
        : value;
  }
}

function updateAll(records: object[], where: Where, data: Where) {
  const matched = records.filter((record) => matches(record, where));
  for (const record of matched) applyData(record, data);
  return { count: matched.length };
}

function createJobs() {
  const scheduled = new Map<string, BackgroundJob>();
  const add = async (job: BackgroundJob) => {
    scheduled.set(job.replaceKey ?? job.name, job);
  };
  const remove = async (key: string) => {
    scheduled.delete(key);
  };
  return {
    scheduled,
    enqueue: vi.fn(add),
    enqueueIn: vi.fn((_tx: JobTransaction, job: BackgroundJob) => add(job)),
    cancel: vi.fn(remove),
    cancelIn: vi.fn((_tx: JobTransaction, key: string) => remove(key)),
  };
}

/** An in-memory database for what delivery reads and writes; a failed transaction rolls back. */
function createPrisma(world: World, jobs: ReturnType<typeof createJobs>) {
  let outboundIds = 0;
  const messageView = (message: MessageRecord) => {
    const replyTo = world.messages.find((candidate) => candidate.id === message.replyToMessageId);
    return {
      ...message,
      thread: { userId: world.threads.find((thread) => thread.id === message.threadId)!.userId },
      replyTo: replyTo ? { runId: replyTo.runId } : null,
    };
  };
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const user = world.users.get(where.id);
        return user ? { id: where.id, ...user } : null;
      }),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const bot = world.bots.get(where.id);
        return bot ? { id: where.id, ...bot } : null;
      }),
    },
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const run = world.runs.find((candidate) => candidate.id === where.id);
        if (!run) return null;
        return {
          ...run,
          sourceMessage: copy(world.messages.find((message) => message.id === run.sourceMessageId)),
          bot: { name: world.bots.get(run.botId)!.name },
          thread: {
            externalConversation: (() => {
              const thread = world.threads.find((candidate) => candidate.id === run.threadId);
              return thread?.conversationBotId ? { botId: thread.conversationBotId } : null;
            })(),
          },
          externalMessage: copy(world.externalMessages.find((message) => message.runId === run.id)),
        };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Where }) =>
        updateAll(world.runs, where, data),
      ),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        world.messages
          .filter((message) => matches(message, where))
          .sort((a, b) => a.seq - b.seq)
          .map((message) => ({ ...message })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        copy(
          world.messages
            .filter((message) => matches(message, where))
            .sort((a, b) => b.seq - a.seq)[0],
        ),
      ),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; threadId_clientNonce?: { threadId: string; clientNonce: string } };
        }) => {
          const unique = where.threadId_clientNonce;
          const message = world.messages.find((candidate) =>
            unique
              ? candidate.threadId === unique.threadId &&
                candidate.clientNonce === unique.clientNonce
              : candidate.id === where.id,
          );
          return message ? messageView(message) : null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Partial<MessageRecord> }) => {
        const message = {
          id: `ctx-${world.messages.length + 1}`,
          runId: null,
          replyToMessageId: null,
          clientNonce: null,
          ...data,
        } as MessageRecord;
        world.messages.push(message);
        return { ...message };
      }),
    },
    thread: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.threads.find((thread) => matches(thread, where))),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Where }) => {
        const thread = world.threads.find((candidate) => candidate.id === where.id)!;
        applyData(thread, data);
        return { ...thread };
      }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Where }) => {
        const event = { id: `evt-${world.events.length + 1}`, createdAt: new Date(), ...data };
        world.events.push(event);
        return { ...event };
      }),
    },
    messagingIdentity: {
      findUnique: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.identities.find((identity) => matches(identity, where))),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Where }) => {
        const identity = world.identities.find((candidate) => candidate.id === where.id)!;
        applyData(identity, data);
        return { ...identity };
      }),
    },
    messagingChannel: {
      findUnique: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.channels.find((channel) => matches(channel, where))),
      ),
    },
    messagingChannelMember: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        world.channelMembers.filter((member) => matches(member, where)),
      ),
    },
    artifact: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.artifacts.find((artifact) => matches(artifact, where))),
      ),
    },
    externalMessage: {
      findUnique: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.externalMessages.find((message) => matches(message, where))),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Where }) =>
        updateAll(world.externalMessages, where, data),
      ),
    },
    messagingOutbound: {
      aggregate: vi.fn(async ({ where }: { where: Where }) => {
        const times = world.outbound
          .filter((row) => matches(row, where))
          .map((row) => row.createdAt.getTime());
        return { _max: { createdAt: times.length ? new Date(Math.max(...times)) : null } };
      }),
      createManyAndReturn: vi.fn(async ({ data }: { data: Array<Partial<OutboundRecord>> }) => {
        const created: Array<{ id: string }> = [];
        for (const item of data) {
          if (world.outbound.some((row) => row.idempotencyKey === item.idempotencyKey)) continue;
          outboundIds += 1;
          const row = {
            id: `out-${String(outboundIds).padStart(3, "0")}`,
            identityId: null,
            threadId: null,
            status: "pending",
            providerHandle: null,
            sourceMessageId: null,
            createdAt: new Date(),
            ...item,
            updatedAt: new Date(),
          } as OutboundRecord;
          world.outbound.push(row);
          created.push({ id: row.id });
        }
        return created;
      }),
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.outbound.filter((row) => matches(row, where)).sort(bySendOrder)[0]),
      ),
      findUnique: vi.fn(async ({ where }: { where: Where }) =>
        copy(world.outbound.find((row) => matches(row, where))),
      ),
      findMany: vi.fn(
        async ({ where, distinct }: { where: Where; distinct?: Array<keyof OutboundRecord> }) => {
          const seen = new Set<string>();
          return world.outbound
            .filter((row) => matches(row, where))
            .sort(bySendOrder)
            .filter((row) => {
              if (!distinct) return true;
              const key = distinct.map((field) => String(row[field])).join("|");
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((row) => ({ ...row }));
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Where }) => {
        const row = world.outbound.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("Record to update not found.");
        applyData(row, { updatedAt: new Date(), ...data });
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Where }) =>
        updateAll(world.outbound, where, { updatedAt: new Date(), ...data }),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const kept = world.outbound.filter((row) => !matches(row, where));
        const count = world.outbound.length - kept.length;
        world.outbound.splice(0, Infinity, ...kept);
        return { count };
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      // The previous release's relay marker; a run without the key models the dropped column.
      if (sql.includes("teamChatMirroredAt")) {
        const run = world.runs.find((candidate) => candidate.id === values[0]);
        return run
          ? [{ tracked: "teamChatMirroredAt" in run, relayed: Boolean(run.teamChatMirroredAt) }]
          : [];
      }
      if (sql.includes("FROM bots")) {
        return [...new Set(values as string[])].sort().flatMap((id) => {
          const bot = world.bots.get(id);
          return bot ? [{ id, ...bot }] : [];
        });
      }
      // The conversation's identity or channel row lock.
      if (sql.includes("FOR UPDATE") && !sql.includes("agent_connections")) return [];
      if (sql.includes("agent_connections")) {
        const status = world.connections.get(`${values[0]}:${values[1]}`);
        return status ? [{ status }] : [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes(`SET "teamChatMirroredAt"`)) {
        const run = world.runs.find((candidate) => candidate.id === values[0]);
        if (run) run.teamChatMirroredAt = new Date();
      }
      return 1;
    }),
  };
  const $transaction = vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
    const saved = structuredClone({
      outbound: world.outbound,
      messages: world.messages,
      events: world.events,
      externalMessages: world.externalMessages,
      runs: world.runs,
    });
    const savedJobs = [...jobs.scheduled];
    try {
      return await fn(prisma);
    } catch (error) {
      for (const key of Object.keys(saved) as Array<keyof typeof saved>)
        (world[key] as unknown[]).splice(0, Infinity, ...saved[key]);
      jobs.scheduled.clear();
      for (const [key, job] of savedJobs) jobs.scheduled.set(key, job);
      throw error;
    }
  });
  return Object.assign(prisma, { $transaction });
}

const PLATFORMS: MessagingPlatformDescriptor[] = [
  { provider: "sendblue", capabilities: { direct: true, groups: true, receipt: "typing" } },
  {
    provider: "telegram",
    capabilities: { direct: true, groups: false, receipt: null, files: true },
  },
];

function createSurface() {
  let handles = 0;
  const sendToThread = vi.fn(
    async (
      _request: MessagingSendRequest,
      _context: AdapterContext,
    ): Promise<MessagingSendResult> => {
      handles += 1;
      return { handle: `handle-${handles}` };
    },
  );
  const openDirectThread = vi.fn(
    async (_provider: string, address: string, _context: AdapterContext) =>
      `sendblue:opened:${address}`,
  );
  const messaging: MessagingSurface = {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { providers: PLATFORMS.map((platform) => platform.provider) },
    }),
    platforms: () => PLATFORMS,
    handleWebhook: () => null,
    onInbound: () => undefined,
    sendToThread,
    openDirectThread,
    acknowledge: vi.fn(async () => undefined),
  };
  return { messaging, sendToThread, openDirectThread };
}

const bytes = (storageKey: string) => new TextEncoder().encode(storageKey);

function setup(options: { messaging?: MessagingSurface } = {}) {
  const world = createWorld();
  const jobs = createJobs();
  const prisma = createPrisma(world, jobs);
  const surface = createSurface();
  const events = {
    sendUserMessage: vi.fn(async (_input: Record<string, unknown>) => ({
      messageId: "msg-wake",
      runId: "run-wake",
      seq: 4,
    })),
    notify: vi.fn(async (_threadId: string, _seq: number) => undefined),
  };
  const artifacts = {
    get: vi.fn(async (storageKey: string, _context: AdapterContext) => bytes(storageKey)),
  };
  const delivery = new MessagingDelivery({
    prisma: prisma as unknown as PrismaClient,
    messaging: options.messaging ?? surface.messaging,
    events: events as unknown as MessagingDeliveryDeps["events"],
    jobs,
    artifacts,
  });
  return {
    ...surface,
    world,
    jobs,
    prisma,
    events,
    artifacts,
    delivery,
    /** Records rows in a caller's transaction, as inbound handlers do, without sending them. */
    record: (lane: OutboundLane, rows: OutboundRow[]) =>
      delivery.recordIn(prisma as unknown as Prisma.TransactionClient, lane, rows),
  };
}

type Setup = ReturnType<typeof setup>;

function threadOf(world: World, botId: string): string {
  return world.threads.find((thread) => thread.botId === botId)!.id;
}

function addReply(world: World, runId: string, reply: Reply) {
  const run = world.runs.find((candidate) => candidate.id === runId)!;
  world.messages.push({
    id: reply.id,
    threadId: run.threadId,
    runId,
    role: "bot",
    seq: world.messages.length + 1,
    clientNonce: reply.clientNonce ?? null,
    blocks: reply.blocks,
    replyToMessageId: null,
  });
}

/** A run with the message that started it (`src-<id>`) and the bot's replies. */
function addRun(
  world: World,
  input: {
    id?: string;
    botId?: string;
    threadId?: string;
    userId?: string;
    trigger?: string;
    status?: string;
    source?: unknown[];
    replyTo?: string;
    replies?: Reply[];
  } = {},
) {
  const id = input.id ?? "run-1";
  const botId = input.botId ?? "bot-1";
  const threadId = input.threadId ?? threadOf(world, botId);
  world.messages.push({
    id: `src-${id}`,
    threadId,
    runId: null,
    role: "user",
    seq: world.messages.length + 1,
    clientNonce: null,
    blocks: input.source ?? [{ kind: "text", text: "hi" }],
    replyToMessageId: input.replyTo ?? null,
  });
  world.runs.push({
    id,
    botId,
    threadId,
    userId: input.userId ?? "user-1",
    trigger: input.trigger ?? "messaging",
    status: input.status ?? "completed",
    sourceMessageId: `src-${id}`,
    messagingMirroredAt: null,
  });
  for (const reply of input.replies ?? []) addReply(world, id, reply);
}

const text = (id: string, value: string): Reply => ({
  id,
  blocks: [{ kind: "text", text: value }],
});

/** A message_user update or another interim message a running run posted. */
const interim = (id: string, value: string): Reply => ({
  ...text(id, value),
  clientNonce: userProgressClientNonce("run-1"),
});

function seedRow(world: World, row: Partial<OutboundRecord> & { id: string }) {
  world.outbound.push({
    idempotencyKey: `key:${row.id}`,
    kind: "group",
    identityId: null,
    threadId: "t-a",
    body: row.id,
    status: "pending",
    providerHandle: null,
    sourceMessageId: null,
    createdAt: new Date(1_000),
    updatedAt: new Date(),
    ...row,
  });
}

const dm: OutboundLane = { identityId: "mi-1" };
const threadLane = (threadId: string): OutboundLane => ({ identityId: null, threadId });
const post = (threadId: string, body: string): OutboundRow => ({
  idempotencyKey: `${threadId}:${body}`,
  kind: "group",
  threadId,
  body,
});

const TELEGRAM = { provider: "telegram", address: "123", dmThreadId: "telegram:123" };
const WHATSAPP = { provider: "whatsapp", address: "15551234567", dmThreadId: "whatsapp:p:1" };
const attempt = (number: number) => ({ number, max: MESSAGING_SEND_MAX_ATTEMPTS });
const lastAttempt = attempt(MESSAGING_SEND_MAX_ATTEMPTS);

function linkProvider(world: World, identity: Partial<IdentityRecord>) {
  Object.assign(world.identities[0]!, identity);
}

const inSendOrder = (t: Setup) => [...t.world.outbound].sort(bySendOrder);
/** A claimed row is marked sent before its handle is known; anything else by its status. */
const statuses = (t: Setup) =>
  inSendOrder(t).map((row) =>
    row.status === "sent" && row.providerHandle === null ? "in-flight" : row.status,
  );
const requests = (t: Setup) => t.sendToThread.mock.calls.map(([request]) => request);
const bodies = (t: Setup) =>
  requests(t).map((request) =>
    request.attachment ? `file:${request.attachment.name}` : request.body,
  );
const backupJob = (t: Setup, outboundId: string) =>
  t.jobs.scheduled.get(messagingSendJobKey(outboundId));
const sendJobs = (t: Setup) =>
  [...t.jobs.scheduled.values()].filter((job) => job.name === "messaging.send");

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("deliverRun to a 1:1 chat", () => {
  it("sends a chat run's reply to its owner's conversation and settles its jobs", async () => {
    const t = setup();
    addRun(t.world, { replies: [text("m-1", "Hello from your bot")] });
    t.jobs.scheduled.set(messagingReplyJobKey("run-1"), messagingReplyJob("run-1"));
    const before = Date.now();

    await t.delivery.deliverRun("run-1");

    expect(requests(t)).toEqual([
      { threadId: "sendblue:dm-1", body: "Hello from your bot", idempotencyKey: "msg:m-1" },
    ]);
    const [row] = t.world.outbound;
    expect(t.world.outbound).toEqual([
      expect.objectContaining({
        idempotencyKey: "msg:m-1",
        kind: "dm",
        identityId: "mi-1",
        status: "sent",
        providerHandle: "handle-1",
        sourceMessageId: "m-1",
      }),
    ]);
    // Recorded with a backup job, which the direct send removed again.
    const [, backup] = t.jobs.enqueueIn.mock.calls[0]!;
    expect(backup).toEqual(
      expect.objectContaining({ name: "messaging.send", payload: { outboundId: row!.id } }),
    );
    expect(backup.availableAt!.getTime()).toBeGreaterThanOrEqual(before + MESSAGING_SEND_BACKUP_MS);
    expect(t.jobs.cancelIn).toHaveBeenCalledWith(expect.anything(), messagingSendJobKey(row!.id));
    expect([...t.jobs.scheduled.keys()]).toEqual([]);
    expect(t.world.identities[0]!.outboundSinceInbound).toBe(1);
    expect(t.world.runs[0]!.messagingMirroredAt).toEqual(expect.any(Date));
  });

  it("sends a page the bot named as its title, never as an app-only page link", async () => {
    const t = setup();
    addRun(t.world, {
      replies: [
        {
          id: "m-1",
          blocks: [
            { kind: "text", text: "I made a [Test dashboard](page:cm123) for you." },
            { kind: "page", pageId: "cm123", version: 1, title: "Test dashboard" },
          ],
        },
      ],
    });
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(["I made a Test dashboard for you."]);
  });

  it.each([
    ["does not name the page", "Done.", ["Plan", "Done."]],
    ["names the page", "Here is [Plan](page:cm123).", ["Here is Plan."]],
    // A link shown inside a code example names nothing, so the card's title still goes.
    [
      "only shows a link in a code example",
      "Write `[Plan](page:cm123)` to link it.",
      ["Plan", "Write `[Plan](page:cm123)` to link it."],
    ],
    [
      "names the page and also shows the link as code",
      "Open [Plan](page:cm123), or write `[Plan](page:cm123)`.",
      ["Open Plan, or write `[Plan](page:cm123)`."],
    ],
  ])("sends a page card's title only when the reply %s", async (_label, reply, expected) => {
    const t = setup();
    addRun(t.world, {
      replies: [
        { id: "m-1", blocks: [{ kind: "page", pageId: "cm123", version: 1, title: "Plan" }] },
        text("m-2", reply),
      ],
    });
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(expected);
  });

  it("opens the conversation once and caches it when the identity has none", async () => {
    const t = setup();
    t.world.identities[0]!.dmThreadId = null;
    addRun(t.world, { replies: [text("m-1", "first"), text("m-2", "second")] });
    await t.delivery.deliverRun("run-1");

    expect(t.openDirectThread).toHaveBeenCalledExactlyOnceWith(
      "sendblue",
      "+15551234567",
      expect.anything(),
    );
    expect(t.world.identities[0]!.dmThreadId).toBe("sendblue:opened:+15551234567");
    expect(requests(t).map(({ threadId, body }) => [threadId, body])).toEqual([
      ["sendblue:opened:+15551234567", "first"],
      ["sendblue:opened:+15551234567", "second"],
    ]);
  });

  it("sends a reply once, however often its run is delivered", async () => {
    const t = setup();
    addRun(t.world, { replies: [text("m-1", "only once")] });
    await t.delivery.deliverRun("run-1");
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(["only once"]);
    expect(t.world.outbound).toHaveLength(1);
  });

  it("sends a running run's interim messages without marking the run delivered", async () => {
    const t = setup();
    addRun(t.world, {
      status: "running",
      replies: [
        interim("m-1", "Checking flights now."),
        { id: "m-2", blocks: [{ kind: "steps", steps: [] }] },
        interim("m-3", "Found two options."),
      ],
    });
    t.jobs.scheduled.set(messagingReplyJobKey("run-1"), messagingReplyJob("run-1"));
    await t.delivery.deliverRun("run-1", { progress: true });

    expect(bodies(t)).toEqual(["Checking flights now.", "Found two options."]);
    // Delivered still means the reply is out, and the reply's backup job still waits for it.
    expect(t.world.runs[0]!.messagingMirroredAt).toBeNull();
    expect(t.jobs.scheduled.has(messagingReplyJobKey("run-1"))).toBe(true);

    addReply(t.world, "run-1", text("m-4", "Booked the cheaper one."));
    t.world.runs[0]!.status = "completed";
    await t.delivery.deliverRun("run-1");

    expect(inSendOrder(t).map((row) => row.idempotencyKey)).toEqual([
      "msg:m-1",
      "msg:m-3",
      "msg:m-4",
    ]);
    expect(bodies(t)).toEqual([
      "Checking flights now.",
      "Found two options.",
      "Booked the cheaper one.",
    ]);
    expect(t.world.runs[0]!.messagingMirroredAt).toEqual(expect.any(Date));
    expect(t.jobs.scheduled.has(messagingReplyJobKey("run-1"))).toBe(false);
  });

  it("holds a card, a file and everything after them for the end of the run", async () => {
    const t = setup();
    linkProvider(t.world, TELEGRAM);
    t.world.artifacts.push({
      id: "art-1",
      spaceId: "ws-1",
      userId: "user-1",
      name: "budget.csv",
      mimeType: "text/csv",
      storageKey: "key-1",
    });
    addRun(t.world, {
      status: "running",
      replies: [
        interim("m-1", "Planning the trip."),
        { id: "m-2", blocks: [{ kind: "page", pageId: "p-1", title: "Trip plan" }] },
        interim("m-3", "Sent you the plan, now the budget."),
        { id: "m-4", blocks: [{ kind: "file", artifactId: "art-1", name: "budget.csv" }] },
        interim("m-5", "Sent the budget too."),
      ],
    });
    await t.delivery.deliverRun("run-1", { progress: true });
    expect(bodies(t)).toEqual(["Planning the trip."]);

    // The reply links the page, so its card never goes as a stray title.
    addReply(t.world, "run-1", text("m-6", "Your [Trip plan](page:p-1) is ready."));
    await t.delivery.deliverRun("run-1", { progress: true });
    t.world.runs[0]!.status = "completed";
    await t.delivery.deliverRun("run-1");

    expect(inSendOrder(t).map((row) => [row.idempotencyKey, row.body])).toEqual([
      ["msg:m-1", "Planning the trip."],
      ["msg:m-3", "Sent you the plan, now the budget."],
      ["msg:m-4:file:art-1", ""],
      ["msg:m-5", "Sent the budget too."],
      ["msg:m-6", "Your Trip plan is ready."],
    ]);
    expect(bodies(t)).toEqual([
      "Planning the trip.",
      "Sent you the plan, now the budget.",
      "file:budget.csv",
      "Sent the budget too.",
      "Your Trip plan is ready.",
    ]);
  });

  it("sends a long interim message's parts once when the run's reply follows", async () => {
    const t = setup();
    linkProvider(t.world, TELEGRAM);
    addRun(t.world, {
      status: "running",
      replies: [interim("m-1", `${"x".repeat(4_200)} TAIL-MARK`)],
    });
    await t.delivery.deliverRun("run-1", { progress: true });
    expect(inSendOrder(t).map((row) => row.idempotencyKey)).toEqual(["msg:m-1", "msg:m-1:2"]);

    addReply(t.world, "run-1", text("m-2", "Done."));
    await t.delivery.deliverRun("run-1", { progress: true });
    t.world.runs[0]!.status = "completed";
    await t.delivery.deliverRun("run-1");

    expect(inSendOrder(t).map((row) => row.idempotencyKey)).toEqual([
      "msg:m-1",
      "msg:m-1:2",
      "msg:m-2",
    ]);
    expect(bodies(t)).toHaveLength(3);
    expect(bodies(t).join("")).toContain("TAIL-MARK");
  });

  it.each([
    ["a group run", { source: [{ kind: "channel_message", channelId: "ch-1", hop: 0 }] }],
    ["an in-app run", { trigger: "user" }],
    ["a delegated run", { trigger: "bot_message" }],
  ])("sends no interim messages for %s", async (_label, run) => {
    const t = setup();
    addRun(t.world, { ...run, status: "running", replies: [interim("m-1", "Working on it.")] });
    await t.delivery.deliverRun("run-1", { progress: true });

    expect(t.world.outbound).toEqual([]);
    expect(t.sendToThread).not.toHaveBeenCalled();
  });

  it("sends a question the run waits on as text, with its options numbered", async () => {
    const t = setup();
    addRun(t.world, {
      status: "waiting_input",
      replies: [
        text("m-1", "Two places are open."),
        {
          id: "ask-1",
          blocks: [
            {
              kind: "ask",
              text: "Which one should I book?",
              detail: "Both are free at 7pm.",
              status: "pending",
              actions: [
                { id: "a", label: "Luigi's" },
                { id: "b", label: "Noodle Bar" },
              ],
            },
          ],
        },
      ],
    });

    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual([
      "Two places are open.",
      [
        "Which one should I book?",
        "Both are free at 7pm.",
        "1. Luigi's",
        "2. Noodle Bar",
        CHAT_APP_ASK_NOTE,
      ].join("\n"),
    ]);
  });

  it("sends an approval's question without its card buttons, and nothing for an answered one", async () => {
    const t = setup();
    addRun(t.world, {
      status: "waiting_input",
      replies: [
        {
          id: "ask-1",
          blocks: [
            {
              kind: "ask",
              text: "Old question",
              status: "answered",
              actions: [{ id: "a", label: "Yes" }],
            },
          ],
        },
        {
          id: "ask-2",
          blocks: [
            {
              kind: "ask",
              text: "Send the email to Sam?",
              approvalEffectId: "effect-1",
              status: "pending",
              actions: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        },
      ],
    });

    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual([`Send the email to Sam?\n${CHAT_APP_ASK_NOTE}`]);
  });

  it("keeps an approval's detail in the app and skips a question its ended run cannot use", async () => {
    const approval = setup();
    addRun(approval.world, {
      status: "waiting_input",
      replies: [
        {
          id: "ask-1",
          blocks: [
            {
              kind: "ask",
              text: "Run this command?",
              detail: "rm -rf ~/projects/old",
              approvalEffectId: "effect-1",
              status: "pending",
            },
          ],
        },
      ],
    });
    await approval.delivery.deliverRun("run-1");
    expect(bodies(approval)).toEqual([`Run this command?\n${CHAT_APP_ASK_NOTE}`]);

    const cancelled = setup();
    addRun(cancelled.world, {
      status: "cancelled",
      replies: [
        text("m-1", "Two places are open."),
        {
          id: "ask-1",
          blocks: [{ kind: "ask", text: "Which one should I book?", status: "pending" }],
        },
      ],
    });
    await cancelled.delivery.deliverRun("run-1");
    expect(bodies(cancelled)).toEqual(["Two places are open."]);
  });

  it("sends a request to take over the bot's screen as text", async () => {
    const t = setup();
    addRun(t.world, {
      status: "waiting_input",
      replies: [
        {
          id: "takeover-1",
          blocks: [
            {
              kind: "computer",
              state: TAKEOVER_COMPUTER_PENDING_STATE,
              text: "Please solve the captcha.",
            },
          ],
        },
      ],
    });

    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual([`Please solve the captcha.\n${CHAT_APP_TAKEOVER_NOTE}`]);
  });

  it("leaves in-app runs and bots without a linked chat in the app", async () => {
    const inApp = setup();
    addRun(inApp.world, { trigger: "user", replies: [text("m-1", "Hello")] });
    await inApp.delivery.deliverRun("run-1");
    expect(inApp.world.outbound).toEqual([]);

    const unlinked = setup();
    unlinked.world.identities = [];
    addRun(unlinked.world, { replies: [text("m-1", "Hello")] });
    await unlinked.delivery.deliverRun("run-1");
    expect(unlinked.world.outbound).toEqual([]);
    expect(unlinked.sendToThread).not.toHaveBeenCalled();
  });

  it("sends a delegated run's reply to its owner's chat", async () => {
    const t = setup();
    addRun(t.world, { trigger: "bot_message", replies: [text("m-1", "Hello from your bot")] });
    await t.delivery.deliverRun("run-1");

    expect(requests(t)).toEqual([
      { threadId: "sendblue:dm-1", body: "Hello from your bot", idempotencyKey: "msg:m-1" },
    ]);
  });

  it.each(["messaging", "bot_message"])(
    "keeps another Space member's %s run on the bot out of the linked person's chat",
    async (trigger) => {
      const t = setup();
      addRun(t.world, { trigger, userId: "user-2", replies: [text("m-1", "For user 2")] });
      await t.delivery.deliverRun("run-1");

      expect(t.world.outbound).toEqual([]);
      expect(t.sendToThread).not.toHaveBeenCalled();
    },
  );

  it("holds sendblue messages at the consecutive-outbound cap until the person replies", async () => {
    const t = setup();
    t.world.identities[0]!.outboundSinceInbound = MESSAGING_DM_OUTBOUND_CAP;
    addRun(t.world, { replies: [text("m-1", "Hello from your bot")] });
    await t.delivery.deliverRun("run-1");

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["pending"]);
    const id = t.world.outbound[0]!.id;

    // Its backup job finds the cap still reached and looks again later.
    await t.delivery.sendJob(id, attempt(1));
    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["pending"]);
    expect(backupJob(t, id)!.availableAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

    // The person's reply resets the count, and the inbound handler sends what waited.
    t.world.identities[0]!.outboundSinceInbound = 0;
    await t.delivery.send([dm]);
    expect(bodies(t)).toEqual(["Hello from your bot"]);
    expect(statuses(t)).toEqual(["sent"]);
    expect(sendJobs(t)).toEqual([]);
  });

  it("does not apply the sendblue cap to other providers", async () => {
    const t = setup();
    linkProvider(t.world, {
      provider: "slack",
      address: "U123",
      outboundSinceInbound: MESSAGING_DM_OUTBOUND_CAP,
    });
    addRun(t.world, { replies: [text("m-1", "Hello from your bot")] });
    await t.delivery.deliverRun("run-1");

    expect(t.world.outbound).toEqual([
      expect.objectContaining({ kind: "dm", status: "sent", providerHandle: "handle-1" }),
    ]);
  });

  it("fails what was queued for a person who has since been deactivated", async () => {
    const t = setup();
    t.world.identities[0]!.dmThreadId = null;
    const [id] = await t.record(dm, [
      {
        idempotencyKey: "late:1",
        kind: "dm",
        identityId: "mi-1",
        body: "a reply queued before deactivation",
      },
    ]);
    t.world.users.get("user-1")!.deactivatedAt = new Date();
    await t.delivery.send([dm]);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(t.openDirectThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["failed"]);
    expect(t.jobs.cancelIn).toHaveBeenCalledWith(expect.anything(), messagingSendJobKey(id!));
    expect(sendJobs(t)).toEqual([]);
  });

  it("does not post a group reply queued by a person who has since been deactivated", async () => {
    const t = setup();
    addRun(t.world, { replies: [text("m-1", "a group reply")] });
    await t.record(threadLane("group-thread"), [
      {
        ...post("group-thread", "a group reply queued before deactivation"),
        sourceMessageId: "m-1",
      },
    ]);
    t.world.users.get("user-1")!.deactivatedAt = new Date();
    await t.delivery.send([threadLane("group-thread")]);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["failed"]);
  });

  it("fails a message with nowhere to go instead of keeping it queued", async () => {
    const t = setup();
    seedRow(t.world, { id: "nowhere", kind: "dm", threadId: null });
    seedRow(t.world, { id: "unlinked", kind: "dm", identityId: "mi-gone", threadId: null });
    await t.delivery.sendJob("nowhere", attempt(1));
    await t.delivery.send([{ identityId: "mi-gone" }]);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(t.world.outbound.map((row) => row.status)).toEqual(["failed", "failed"]);
  });
});

describe("connect invites", () => {
  const invite: OutboundRow = {
    idempotencyKey: "connect:bot-9:bot-1",
    kind: "dm",
    identityId: "mi-1",
    body: "Scout wants to connect. Reply YES to allow, NO to decline.",
  };

  function pendingInvite() {
    const t = setup();
    t.world.connections.set("bot-9:bot-1", "pending");
    return t;
  }

  it("sends an invite while its connection is pending", async () => {
    const t = pendingInvite();
    await t.delivery.record(dm, [invite]);

    expect(requests(t)).toEqual([{ threadId: "sendblue:dm-1", body: invite.body }]);
    expect(t.world.outbound).toEqual([
      expect.objectContaining({ status: "sent", providerHandle: "handle-1" }),
    ]);
    expect(t.world.identities[0]!.outboundSinceInbound).toBe(1);
    expect(sendJobs(t)).toEqual([]);
  });

  it.each<[string, (t: Setup) => void]>([
    ["the connection was revoked", (t) => t.world.connections.set("bot-9:bot-1", "revoked")],
    ["the connection is gone", (t) => t.world.connections.clear()],
    [
      "its requester was deactivated",
      (t) => {
        t.world.users.get("user-9")!.deactivatedAt = new Date();
      },
    ],
    [
      "its requester's Space opted out of other Spaces",
      (t) => {
        t.world.bots.get("bot-9")!.crossSpaceCommunication = false;
      },
    ],
  ])("does not send an invite when %s", async (_label, change) => {
    const t = pendingInvite();
    change(t);
    await t.delivery.record(dm, [invite]);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["failed"]);
    expect(sendJobs(t)).toEqual([]);
  });

  it("does not send an invite whose row a revoke deleted before the lock", async () => {
    const t = pendingInvite();
    t.prisma.messagingOutbound.findUnique.mockImplementationOnce(async () => {
      t.world.outbound.splice(0, Infinity);
      return null;
    });
    await t.delivery.record(dm, [invite]);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(t.world.outbound).toEqual([]);
  });

  it("records an invite whose provider call failed as failed, and never resends it", async () => {
    const t = pendingInvite();
    t.sendToThread.mockRejectedValueOnce(new Error("provider down"));
    await t.delivery.record(dm, [invite]);

    expect(t.sendToThread).toHaveBeenCalledOnce();
    // Failed, not sent: a YES or NO never answers a request that may not have arrived.
    expect(t.world.outbound).toEqual([
      expect.objectContaining({ status: "failed", providerHandle: null }),
    ]);
    expect(t.world.identities[0]!.outboundSinceInbound).toBe(0);
    expect(sendJobs(t)).toEqual([]);
  });

  it("leaves an invite to its backup job when the database is down before the provider call", async () => {
    const t = pendingInvite();
    const query = t.prisma.$queryRaw.getMockImplementation()!;
    t.prisma.$queryRaw.mockImplementation(async (strings, ...values) => {
      if (strings.join("").includes("agent_connections"))
        throw Object.assign(new Error("cannot execute SELECT in a read-only transaction"), {
          code: "25006",
        });
      return query(strings, ...values);
    });
    await t.delivery.record(dm, [invite]).catch(() => undefined);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).not.toContain("failed");
    expect(sendJobs(t)).toHaveLength(1);
  });

  it("never resends an invite when its transaction times out", async () => {
    const t = pendingInvite();
    const query = t.prisma.$queryRaw.getMockImplementation()!;
    t.prisma.$queryRaw.mockImplementation(async (strings, ...values) => {
      if (strings.join("").includes("agent_connections"))
        throw new Error("Transaction API error: Transaction already closed");
      return query(strings, ...values);
    });
    await t.delivery.record(dm, [invite]);

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["failed"]);
    expect(sendJobs(t)).toEqual([]);
  });
});

describe("applyMessagingOutboundStatus", () => {
  it("maps terminal provider statuses onto rows by handle", async () => {
    const t = setup();
    seedRow(t.world, { id: "a", status: "sent", providerHandle: "h-1" });
    seedRow(t.world, { id: "b", status: "sending", providerHandle: "h-2" });
    seedRow(t.world, { id: "c", status: "sending", providerHandle: "h-3" });
    for (const [handle, status] of [
      ["h-1", "ERROR"],
      ["h-2", "DELIVERED"],
      ["h-3", "QUEUED"],
    ]) {
      await applyMessagingOutboundStatus(t.prisma as unknown as PrismaClient, {
        type: "status",
        provider: "sendblue",
        handle: handle!,
        status: status!,
      });
    }

    expect(t.world.outbound.map((row) => row.status)).toEqual(["failed", "sent", "sending"]);
  });
});

describe("deliverRun to a group", () => {
  function groupRun(
    world: World,
    replies: Reply[],
    block: Record<string, unknown> = {},
    id = "run-1",
  ) {
    addRun(world, {
      id,
      replies,
      source: [
        {
          kind: "channel_message",
          provider: "sendblue",
          channelId: "ch-1",
          fromAddress: "+15559990000",
          fromLabel: "Dana",
          text: "group hi",
          hop: 0,
          ...block,
        },
      ],
    });
  }

  const peerContext = (t: Setup) =>
    t.world.messages.filter((message) => message.threadId === "thread-2");
  const wakes = (t: Setup) =>
    [...t.jobs.scheduled.values()].filter((job) => job.name === "run.continue");

  it("posts the reply with its owner's name and gives peer bots the post as context", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "found it")]);
    await t.delivery.deliverRun("run-1");

    expect(requests(t)).toEqual([
      { threadId: "sendblue:grp-1", body: "Alice's agent: found it", idempotencyKey: "msg:m-1" },
    ]);
    expect(t.world.outbound).toEqual([
      expect.objectContaining({
        idempotencyKey: "msg:m-1",
        kind: "group",
        identityId: null,
        threadId: "sendblue:grp-1",
        status: "sent",
      }),
    ]);
    // Peer context: appended without a run, carrying the next hop.
    expect(peerContext(t)).toEqual([
      expect.objectContaining({
        role: "user",
        clientNonce: "messaging-peer:m-1:bot-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice's agent",
            text: "found it",
            hop: 1,
          },
        ],
      }),
    ]);
    expect(t.world.events).toEqual([
      expect.objectContaining({ threadId: "thread-2", type: "thread.message.created" }),
    ]);
    expect(t.events.notify).toHaveBeenCalledWith("thread-2", expect.any(Number));
    expect(t.events.sendUserMessage).not.toHaveBeenCalled();
    expect(wakes(t)).toEqual([]);
  });

  it("keeps a privately answered run out of the group and its peers, however often delivered", async () => {
    const t = setup();
    groupRun(t.world, [
      {
        id: "ask-1",
        blocks: [{ kind: "ask", text: "Details?", status: "answered", answer: "Private detail" }],
      },
      text("reply-1", "Reply containing private detail"),
    ]);
    await t.delivery.deliverRun("run-1");
    await t.delivery.deliverRun("run-1");

    expect(t.world.outbound).toEqual([]);
    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(peerContext(t)).toEqual([]);
    expect(t.events.sendUserMessage).not.toHaveBeenCalled();
  });

  it("still posts a reply alongside an unanswered ask", async () => {
    const t = setup();
    groupRun(t.world, [
      { id: "ask-1", blocks: [{ kind: "ask", text: "Details?", status: "pending" }] },
      text("reply-1", "Public update"),
    ]);
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(["Alice's agent: Public update"]);
  });

  it("splits a long reply into platform-sized parts that keep the tail", async () => {
    const t = setup();
    linkProvider(t.world, TELEGRAM);
    groupRun(t.world, [text("m-1", `${"x".repeat(4_200)} TAIL-MARK`)]);
    await t.delivery.deliverRun("run-1");

    const rows = inSendOrder(t);
    expect(rows.map((row) => row.idempotencyKey)).toEqual(["msg:m-1", "msg:m-1:2"]);
    expect(rows.every((row) => row.body.length <= 4_096)).toBe(true);
    expect(rows[0]!.body.startsWith("Alice's agent: ")).toBe(true);
    expect(rows.map((row) => row.body).join("")).toContain("TAIL-MARK");
    expect(rows.map((row) => row.status)).toEqual(["sent", "sent"]);
    expect(requests(t)).toEqual(
      rows.map((row) => ({
        threadId: "sendblue:grp-1",
        body: row.body,
        idempotencyKey: row.idempotencyKey,
      })),
    );
  });

  it("orders a run's messages strictly", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "checking"), text("m-2", "here is the answer")]);
    await t.delivery.deliverRun("run-1");

    const rows = inSendOrder(t);
    expect(rows.map((row) => [row.idempotencyKey, row.body])).toEqual([
      ["msg:m-1", "Alice's agent: checking"],
      ["msg:m-2", "Alice's agent: here is the answer"],
    ]);
    expect(rows[1]!.createdAt.getTime()).toBeGreaterThan(rows[0]!.createdAt.getTime());
  });

  it("keeps a later reply's whole range after an earlier reply's, even on a clock tie", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const t = setup();
      linkProvider(t.world, TELEGRAM);
      const reply = (marker: string) => `${marker}${marker.repeat(4_100)}`;
      groupRun(t.world, [text("m-1", reply("1"))], {}, "run-1");
      groupRun(t.world, [text("m-2", reply("2"))], {}, "run-2");
      await t.delivery.deliverRun("run-1");
      await t.delivery.deliverRun("run-2");

      const timesOf = (messageId: string) =>
        t.world.outbound
          .filter((row) => row.sourceMessageId === messageId)
          .map((row) => row.createdAt.getTime());
      expect(timesOf("m-1")).toHaveLength(2);
      expect(Math.min(...timesOf("m-2"))).toBeGreaterThan(Math.max(...timesOf("m-1")));
      const sent = bodies(t);
      const lastFirst = sent.findLastIndex((body) => body.includes("1"));
      expect(sent.findIndex((body) => body.includes("2"))).toBeGreaterThan(lastFirst);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the source transport on peer context", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "found it")], { transport: "SMS" });
    await t.delivery.deliverRun("run-1");

    expect(peerContext(t)).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ kind: "channel_message", transport: "SMS", hop: 1 })],
      }),
    ]);
  });

  it("wakes an @-mentioned peer bot with a run, keeping the source transport", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "@Helper what do you think?")], { transport: "RCS" });
    await t.delivery.deliverRun("run-1");

    expect(t.events.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        spaceId: "ws-2",
        threadId: "thread-2",
        botId: "bot-2",
        userId: "user-2",
        trigger: "messaging",
        crossSpaceSenderBotId: "bot-1",
        clientNonce: "messaging-peer:m-1:bot-2",
        prompt: `[Group "Family" — Alice's agent]: @Helper what do you think?`,
        blocks: [expect.objectContaining({ kind: "channel_message", transport: "RCS", hop: 1 })],
      }),
    );
    expect(wakes(t)).toEqual([
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-wake" } }),
    ]);
    expect(peerContext(t)).toEqual([]);
  });

  it("wakes an @-mentioned peer whatever the casing", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "@helper ping")]);
    await t.delivery.deliverRun("run-1");

    expect(t.events.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-2", clientNonce: "messaging-peer:m-1:bot-2" }),
    );
  });

  it("skips a mentioned peer whose Space is being deleted", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "@Helper what do you think?")]);
    t.events.sendUserMessage.mockRejectedValueOnce(new SpaceDeletionInProgressError());
    await t.delivery.deliverRun("run-1");

    expect(t.events.sendUserMessage).toHaveBeenCalledOnce();
    expect(wakes(t)).toEqual([]);
    expect(statuses(t)).toEqual(["sent"]);
  });

  it("keeps a reply by a since-deactivated person's bot out of the group and its peers", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "@Helper what do you think?")]);
    t.world.users.get("user-1")!.deactivatedAt = new Date();
    await t.delivery.deliverRun("run-1");

    expect(t.world.outbound).toEqual([]);
    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(peerContext(t)).toEqual([]);
    expect(t.events.sendUserMessage).not.toHaveBeenCalled();
  });

  it("leaves a deactivated peer's bot out of the fan-out", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "@Helper what do you think?")]);
    t.world.users.get("user-2")!.deactivatedAt = new Date();
    await t.delivery.deliverRun("run-1");

    expect(t.sendToThread).toHaveBeenCalledOnce();
    expect(peerContext(t)).toEqual([]);
    expect(t.events.sendUserMessage).not.toHaveBeenCalled();
    expect(wakes(t)).toEqual([]);
  });

  it("only gives peers context once the hop budget is spent", async () => {
    const t = setup();
    groupRun(t.world, [text("m-1", "@Helper again?")], { hop: 6 });
    await t.delivery.deliverRun("run-1");

    expect(t.events.sendUserMessage).not.toHaveBeenCalled();
    expect(wakes(t)).toEqual([]);
    expect(peerContext(t)).toEqual([
      expect.objectContaining({
        clientNonce: "messaging-peer:m-1:bot-2",
        blocks: [expect.objectContaining({ hop: 7 })],
      }),
    ]);
  });

  it.each(["bot-1", "bot-2"])(
    "gives a peer neither context nor a wake when %s keeps to its own Space",
    async (blockedBot) => {
      const t = setup();
      t.world.bots.get(blockedBot)!.crossSpaceCommunication = false;
      groupRun(t.world, [text("m-1", "@Helper private reply")]);
      await t.delivery.deliverRun("run-1");

      expect(peerContext(t)).toEqual([]);
      expect(t.events.sendUserMessage).not.toHaveBeenCalled();
      expect(bodies(t)).toEqual(["Alice's agent: @Helper private reply"]);
    },
  );
});

describe("deliverRun for team chat", () => {
  const teamThread = "slack:C1:1700.1";

  function teamChatRun(
    world: World,
    input: { kind?: string; status?: string; replies?: Reply[]; messageStatus?: string } = {},
  ) {
    addRun(world, { status: input.status ?? "completed", replies: input.replies ?? [] });
    world.externalMessages.push({
      id: "em-1",
      runId: "run-1",
      kind: input.kind ?? "direct",
      status: input.messageStatus ?? "running",
      replyThreadId: "1700.1",
      externalConversation: { conversationId: "slack:C1" },
    });
  }

  it("answers once, in the thread the message came from, and never in the bot's 1:1 chat", async () => {
    const t = setup();
    teamChatRun(t.world, { replies: [text("m-1", "Here is the summary.")] });
    await t.delivery.deliverRun("run-1");
    await t.delivery.deliverRun("run-1");

    expect(requests(t)).toEqual([
      {
        threadId: teamThread,
        body: "Here is the summary.",
        idempotencyKey: "external-message:em-1",
      },
    ]);
    expect(t.world.outbound).toEqual([
      expect.objectContaining({
        idempotencyKey: "external-message:em-1",
        kind: "team",
        identityId: null,
        threadId: teamThread,
        sourceMessageId: "m-1",
        status: "sent",
      }),
    ]);
    expect(t.world.externalMessages[0]!.status).toBe("delivered");
    expect(sendJobs(t)).toEqual([]);
  });

  it("records nothing for progress or before the run ends", async () => {
    const t = setup();
    teamChatRun(t.world, { status: "running", replies: [interim("m-1", "Looking into it.")] });
    await t.delivery.deliverRun("run-1", { progress: true });
    await t.delivery.deliverRun("run-1");

    expect(t.world.outbound).toEqual([]);
    expect(t.world.externalMessages[0]!.status).toBe("running");
  });

  const failure = "Assistant could not complete that request. Open Rakazo for details.";
  it.each([
    ["a run that failed", "direct", "failed", [["external-message:em-1:failure", failure]]],
    [
      "a run that was cancelled",
      "direct",
      "cancelled",
      [["external-message:em-1:failure", failure]],
    ],
    [
      "a run that wrote nothing",
      "direct",
      "completed",
      [["external-message:em-1", "Assistant completed the request without a written reply."]],
    ],
    ["an ambient run that chose silence", "ambient", "completed", []],
    ["an ambient run that failed", "ambient", "failed", []],
  ])("answers a message after %s", async (_label, kind, status, expected) => {
    const t = setup();
    teamChatRun(t.world, {
      kind,
      status,
      replies: status === "completed" ? [{ id: "m-1", blocks: [] }] : [],
    });
    await t.delivery.deliverRun("run-1");

    expect(t.world.outbound.map((row) => [row.idempotencyKey, row.body])).toEqual(expected);
    expect(bodies(t)).toEqual(expected.map(([, body]) => body));
    expect(t.world.externalMessages[0]!.status).toBe("delivered");
  });

  it("records nothing when another process already answered the message", async () => {
    const t = setup();
    teamChatRun(t.world, {
      messageStatus: "delivered",
      replies: [text("m-1", "Here is the summary.")],
    });
    await t.delivery.deliverRun("run-1");

    expect(t.world.outbound).toEqual([]);
    expect(t.sendToThread).not.toHaveBeenCalled();
  });
});

describe("delegated team-chat replies", () => {
  /**
   * A team-chat message started run-a in bot-1's conversation thread. It delegated to bot-2
   * (run-b), whose answer came back as run-c: bot-1's bot_message run in that same thread.
   */
  function delegationChain(
    world: World,
    input: { status?: string; replies?: Reply[]; threadId?: string } = {},
  ) {
    addRun(world, {
      id: "run-a",
      threadId: "thread-slack",
      replies: [text("a-msg", "Asking around.")],
    });
    world.externalMessages.push({
      id: "em-1",
      runId: "run-a",
      kind: "direct",
      status: "delivered",
      replyThreadId: "1700.1",
      externalConversation: { conversationId: "slack:C1" },
    });
    addRun(world, {
      id: "run-b",
      botId: "bot-2",
      userId: "user-2",
      trigger: "bot_message",
      replyTo: "a-msg",
      replies: [text("b-msg", "Three flights found.")],
    });
    addRun(world, {
      id: "run-c",
      threadId: input.threadId ?? "thread-slack",
      trigger: "bot_message",
      status: input.status ?? "completed",
      replyTo: "b-msg",
      replies: input.replies ?? [text("c-msg", "Helper found three flights.")],
    });
  }

  const summary = (t: Setup) =>
    t.world.outbound.map((row) => [
      row.idempotencyKey,
      row.identityId ?? row.threadId,
      row.body,
      row.status,
    ]);

  it("answers once in the thread the chain started in, and in its owner's chat", async () => {
    const t = setup();
    delegationChain(t.world);
    await t.delivery.deliverRun("run-c");
    await t.delivery.deliverRun("run-c");

    expect(summary(t)).toEqual([
      ["msg:c-msg", "mi-1", "Helper found three flights.", "sent"],
      ["team-chat-run:run-c", "slack:C1:1700.1", "Helper found three flights.", "sent"],
    ]);
    expect(t.world.outbound[1]).toEqual(
      expect.objectContaining({ kind: "team", sourceMessageId: "c-msg" }),
    );
    expect(t.sendToThread).toHaveBeenCalledTimes(2);
  });

  it("says in the thread when the delegated run failed", async () => {
    const t = setup();
    delegationChain(t.world, { status: "failed", replies: [] });
    await t.delivery.deliverRun("run-c");

    expect(summary(t)).toEqual([
      [
        "team-chat-run:run-c",
        "slack:C1:1700.1",
        "Assistant could not complete the delegated request. Open Rakazo for details.",
        "sent",
      ],
    ]);
  });

  it.each<[string, (world: World) => void]>([
    [
      "wrote nothing",
      (world) => delegationChain(world, { replies: [{ id: "c-msg", blocks: [] }] }),
    ],
    ["was cancelled", (world) => delegationChain(world, { status: "cancelled", replies: [] })],
    [
      "did not start in team chat",
      (world) => {
        delegationChain(world);
        world.externalMessages = [];
      },
    ],
    // A continuation in the bot's private thread may have read its owner's memory.
    [
      "ran in the bot's private thread",
      (world) => delegationChain(world, { threadId: "thread-1" }),
    ],
  ])("posts nothing to team chat when the delegated run %s", async (_label, arrange) => {
    const t = setup();
    arrange(t.world);
    await t.delivery.deliverRun("run-c");

    expect(t.world.outbound.filter((row) => row.kind === "team")).toEqual([]);
  });

  it("never relays another bot's run, which answered with its own context", async () => {
    const t = setup();
    delegationChain(t.world);
    await t.delivery.deliverRun("run-b");

    expect(t.world.outbound.filter((row) => row.kind === "team")).toEqual([]);
  });
});

describe("a claimed send and its backup job", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for a provider call past its timeout instead of abandoning it, and records it sent", async () => {
    vi.useFakeTimers();
    const t = setup();
    const [id] = await t.record(threadLane("t-a"), [post("t-a", "slow")]);
    let signal: AbortSignal | undefined;
    t.sendToThread.mockImplementationOnce(async (_request, context) => {
      // A provider that cannot take the abort signal keeps going past the timeout.
      signal = context.signal;
      await new Promise((resolve) => setTimeout(resolve, MESSAGING_SEND_TIMEOUT_MS + 20_000));
      return { handle: "late" };
    });
    const sending = t.delivery.send([threadLane("t-a")]);
    await vi.advanceTimersByTimeAsync(MESSAGING_SEND_TIMEOUT_MS + 20_000);
    await sending;

    // Its backup job finds the message sent and sends nothing more.
    await t.delivery.sendJob(id!, attempt(1));
    expect({ sends: t.sendToThread.mock.calls.length, status: statuses(t) }).toEqual({
      sends: 1,
      status: ["sent"],
    });
    expect(t.world.outbound[0]!.providerHandle).toBe("late");
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves a call still running at its deadline to the backup job, which only resends once the claim is stale", async () => {
    vi.useFakeTimers();
    const t = setup();
    const [id] = await t.record(threadLane("t-a"), [post("t-a", "hung")]);
    t.sendToThread.mockImplementationOnce(() => new Promise<MessagingSendResult>(() => {}));
    const sending = t.delivery.send([threadLane("t-a")]);
    await vi.advanceTimersByTimeAsync(MESSAGING_SEND_STALE_MS);
    await sending;
    expect(statuses(t)).toEqual(["in-flight"]);

    // Too early: the claim is not stale yet, so the job looks again later.
    t.world.outbound[0]!.updatedAt = new Date(Date.now() - MESSAGING_SEND_STALE_MS + 1_000);
    await t.delivery.sendJob(id!, attempt(1));
    expect(t.sendToThread).toHaveBeenCalledOnce();

    t.world.outbound[0]!.updatedAt = new Date(Date.now() - MESSAGING_SEND_STALE_MS - 1);
    await t.delivery.sendJob(id!, attempt(1));
    expect({ sends: t.sendToThread.mock.calls.length, status: statuses(t) }).toEqual({
      sends: 2,
      status: ["sent"],
    });
  });

  it("holds the conversation behind its own stale claim until the backup job resends it", async () => {
    const t = setup();
    const stale = new Date(Date.now() - MESSAGING_SEND_STALE_MS - 1_000);
    // This release claimed the first message, then its sender died.
    seedRow(t.world, {
      id: "a-1",
      status: "sent",
      providerHandle: null,
      claimedAt: stale,
      updatedAt: stale,
    });
    seedRow(t.world, { id: "a-2", createdAt: new Date(1_001) });
    await t.delivery.send([threadLane("t-a")]);
    expect({ sends: bodies(t), status: statuses(t) }).toEqual({
      sends: [],
      status: ["in-flight", "pending"],
    });

    await t.delivery.sendJob("a-1", attempt(1));
    expect({ sends: bodies(t), status: statuses(t) }).toEqual({
      sends: ["a-1", "a-2"],
      status: ["sent", "sent"],
    });
    expect(t.world.outbound.map((row) => row.claimedAt)).toEqual([null, null]);
  });

  it("gives its own stale claim whose job gave up a new job, never the previous release's", async () => {
    const t = setup();
    const old = new Date(Date.now() - 10 * 60_000);
    seedRow(t.world, {
      id: "ours",
      threadId: "t-a",
      status: "sent",
      providerHandle: null,
      claimedAt: old,
      updatedAt: old,
    });
    seedRow(t.world, {
      id: "theirs",
      threadId: "t-b",
      status: "sent",
      providerHandle: null,
      updatedAt: old,
    });
    await t.delivery.sweepStalled();
    expect(sendJobs(t).map((job) => job.payload)).toEqual([{ outboundId: "ours" }]);

    await t.delivery.sendJob("ours", attempt(1));
    expect(bodies(t)).toEqual(["ours"]);
  });

  it("retries the bookkeeping of a message that went out instead of leaving it to be sent again", async () => {
    vi.useFakeTimers();
    const t = setup();
    const [id] = await t.record(threadLane("t-a"), [post("t-a", "accepted")]);
    const updateMany = t.prisma.messagingOutbound.updateMany.getMockImplementation()!;
    let failures = 2;
    t.prisma.messagingOutbound.updateMany.mockImplementation(async (args) => {
      // Saving the handle, after the claim.
      if ("providerHandle" in (args.data as object) && failures-- > 0)
        throw new Error("Connection terminated unexpectedly");
      return updateMany(args);
    });
    const sending = t.delivery.send([threadLane("t-a")]);
    await vi.advanceTimersByTimeAsync(10_000);
    await sending;

    expect({
      sends: t.sendToThread.mock.calls.length,
      status: statuses(t),
      backup: backupJob(t, id!),
    }).toEqual({ sends: 1, status: ["sent"], backup: undefined });
  });

  it("records a send that lands after its deadline against its own claim, so nothing is resent", async () => {
    vi.useFakeTimers();
    const t = setup();
    const [id, next] = await t.record(threadLane("t-a"), [
      post("t-a", "very slow"),
      post("t-a", "after it"),
    ]);
    t.sendToThread.mockImplementationOnce(async () => {
      // Past the claim's deadline, before it goes stale.
      await new Promise((resolve) => setTimeout(resolve, MESSAGING_SEND_STALE_MS - 5_000));
      return { handle: "late" };
    });
    const sending = t.delivery.send([threadLane("t-a")]);
    await vi.advanceTimersByTimeAsync(MESSAGING_SEND_STALE_MS - 9_000);
    await sending;
    expect(statuses(t)).toEqual(["in-flight", "pending"]);

    // It lands: recorded, its job removed, and the conversation carries on.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(statuses(t)).toEqual(["sent", "sent"]));
    await t.delivery.sendJob(id!, attempt(1));
    expect({
      bodies: bodies(t),
      handle: t.world.outbound[0]!.providerHandle,
      jobs: [backupJob(t, id!), backupJob(t, next!)],
    }).toEqual({ bodies: ["very slow", "after it"], handle: "late", jobs: [undefined, undefined] });
  });

  it("leaves a late send's result alone once its backup job has taken the claim over", async () => {
    vi.useFakeTimers();
    const t = setup();
    const [id] = await t.record(threadLane("t-a"), [post("t-a", "raced")]);
    let land!: () => void;
    t.sendToThread.mockImplementationOnce(
      () =>
        new Promise<MessagingSendResult>((resolve) => {
          land = () => resolve({ handle: "first" });
        }),
    );
    const sending = t.delivery.send([threadLane("t-a")]);
    await vi.advanceTimersByTimeAsync(MESSAGING_SEND_STALE_MS);
    await sending;
    // The claim went stale; the backup job takes it over and sends.
    t.world.outbound[0]!.updatedAt = new Date(Date.now() - MESSAGING_SEND_STALE_MS - 1);
    await t.delivery.sendJob(id!, attempt(1));
    land();
    await vi.advanceTimersByTimeAsync(1_000);

    // The backup job's handle stands; the late "first" result changes nothing.
    expect({ handle: t.world.outbound[0]!.providerHandle, sends: bodies(t) }).toEqual({
      handle: "handle-1",
      sends: ["raced", "raced"],
    });
  });

  it("claims by compare-and-set, so a message another release claimed meanwhile is not sent", async () => {
    const t = setup();
    await t.record(threadLane("t-a"), [post("t-a", "contested")]);
    const updateMany = t.prisma.messagingOutbound.updateMany.getMockImplementation()!;
    t.prisma.messagingOutbound.updateMany.mockImplementationOnce(async (args) => {
      // The previous release's drain marks the row sent between the read and the claim.
      t.world.outbound[0]!.status = "sent";
      return updateMany(args);
    });
    await t.delivery.send([threadLane("t-a")]);

    expect(t.sendToThread).not.toHaveBeenCalled();
  });
});

describe("when a send fails", () => {
  it("moves a cleanly failed message's backup job up to now and holds the rest of the conversation", async () => {
    const t = setup();
    const before = Date.now();
    const [first, second] = await t.record(threadLane("t-a"), [
      post("t-a", "a-1"),
      post("t-a", "a-2"),
    ]);
    t.sendToThread.mockRejectedValueOnce(new Error("messaging provider 500"));
    const secondBackupAt = backupJob(t, second!)!.availableAt!.getTime();
    await t.delivery.send([threadLane("t-a")]);

    expect(t.sendToThread).toHaveBeenCalledOnce();
    expect(statuses(t)).toEqual(["retry", "pending"]);
    expect(t.world.outbound[0]!.providerHandle).toBeNull();
    const retry = backupJob(t, first!)!.availableAt!.getTime();
    expect(retry).toBeGreaterThanOrEqual(before);
    expect(retry).toBeLessThanOrEqual(Date.now());
    expect(backupJob(t, second!)!.availableAt!.getTime()).toBe(secondBackupAt);
  });

  it("moves the backup job to the provider's retry-after", async () => {
    const t = setup();
    const [id] = await t.record(threadLane("t-a"), [post("t-a", "a-1")]);
    t.sendToThread.mockRejectedValueOnce(
      new MessagingSendError(new Error("rate limited"), { permanent: false, retryAfterMs: 30_000 }),
    );
    const before = Date.now();
    await t.delivery.send([threadLane("t-a")]);

    expect(statuses(t)).toEqual(["retry"]);
    const retry = backupJob(t, id!)!.availableAt!.getTime();
    expect(retry).toBeGreaterThanOrEqual(before + 30_000);
    expect(retry).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("fails a permanently rejected message at once and moves on", async () => {
    const t = setup();
    await t.record(threadLane("t-a"), [post("t-a", "a-1"), post("t-a", "a-2")]);
    t.sendToThread.mockRejectedValueOnce(
      new MessagingSendError(new Error("channel_not_found"), {
        permanent: true,
        retryAfterMs: null,
      }),
    );
    await t.delivery.send([threadLane("t-a")]);

    expect(bodies(t)).toEqual(["a-1", "a-2"]);
    expect(statuses(t)).toEqual(["failed", "sent"]);
    expect(sendJobs(t)).toEqual([]);
  });

  it("fails a team-chat reply whose workspace was removed on its first try, without retries", async () => {
    const surface = vi.fn();
    const installed = new InstalledMessagingSurface(
      { get: vi.fn(async () => null), getById: vi.fn(async () => null), removeWorkspace: vi.fn() },
      { provider: "slack", surface } as unknown as MessagingInstallProvider,
    );
    const t = setup({ messaging: installed });
    const lane = threadLane("slack~removed:C1:1700.1");
    const [id] = await t.record(lane, [post("slack~removed:C1:1700.1", "could not complete")]);

    await t.delivery.sendJob(id!, attempt(1));

    expect(statuses(t)).toEqual(["failed"]);
    expect(sendJobs(t)).toEqual([]);
    expect(surface).not.toHaveBeenCalled();
  });

  it("hands a failure inside the backup job back to the job queue", async () => {
    const t = setup();
    const [head] = await t.record(threadLane("t-a"), [post("t-a", "a-1"), post("t-a", "a-2")]);
    t.world.outbound[0]!.status = "retry";

    t.sendToThread.mockRejectedValueOnce(new Error("messaging provider 500"));
    await expect(t.delivery.sendJob(head!, attempt(2))).rejects.toThrow("messaging provider 500");
    expect(statuses(t)).toEqual(["retry", "pending"]);

    // A provider's retry-after goes back with it.
    t.sendToThread.mockRejectedValueOnce(
      new MessagingSendError(new Error("rate limited"), { permanent: false, retryAfterMs: 5_000 }),
    );
    const retried = t.delivery.sendJob(head!, attempt(3));
    await expect(retried).rejects.toBeInstanceOf(RetryJobLaterError);
    await expect(retried).rejects.toMatchObject({ delayMs: 5_000 });
    expect(statuses(t)).toEqual(["retry", "pending"]);
    expect(t.sendToThread).toHaveBeenCalledTimes(2);
  });

  it("gives a message up on its last attempt and sends what waited behind it", async () => {
    const t = setup();
    const [head] = await t.record(threadLane("t-a"), [post("t-a", "a-1"), post("t-a", "a-2")]);
    t.world.outbound[0]!.status = "retry";
    t.sendToThread.mockRejectedValueOnce(new Error("messaging provider 500"));
    await t.delivery.sendJob(head!, lastAttempt);

    expect(bodies(t)).toEqual(["a-1", "a-2"]);
    expect(statuses(t)).toEqual(["failed", "sent"]);
    expect(sendJobs(t)).toEqual([]);
  });

  it("does nothing for a backup job whose message is settled or gone", async () => {
    const t = setup();
    seedRow(t.world, { id: "done", status: "sent" });
    seedRow(t.world, { id: "given-up", status: "failed" });
    await t.delivery.sendJob("done", attempt(1));
    await t.delivery.sendJob("given-up", attempt(1));
    await t.delivery.sendJob("missing", attempt(1));

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(t.world.outbound.map((row) => row.status)).toEqual(["sent", "failed"]);
  });

  it("checks back later when an earlier message holds the conversation", async () => {
    const t = setup();
    const [, second] = await t.record(threadLane("t-a"), [post("t-a", "a-1"), post("t-a", "a-2")]);
    t.world.outbound[0]!.status = "retry";
    t.jobs.scheduled.delete(messagingSendJobKey(second!));
    const before = Date.now();
    await t.delivery.sendJob(second!, attempt(1));

    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["retry", "pending"]);
    expect(backupJob(t, second!)!.availableAt!.getTime()).toBeGreaterThanOrEqual(
      before + MESSAGING_SEND_BACKUP_MS,
    );
  });

  it("leaves a message to its backup job when moving the job up fails", async () => {
    const t = setup();
    const [id] = await t.record(threadLane("t-a"), [post("t-a", "a-1")]);
    t.sendToThread.mockRejectedValueOnce(new Error("messaging provider 500"));
    t.jobs.enqueueIn.mockRejectedValueOnce(new Error("queue down"));
    await t.delivery.send([threadLane("t-a")]);

    // The failure's transaction rolled back: the claim stands, and so does the backup job.
    expect(statuses(t)).toEqual(["in-flight"]);
    expect(backupJob(t, id!)!.availableAt!.getTime()).toBeGreaterThan(Date.now());

    // When it fires, the claim is stale and the job takes over the abandoned send.
    t.world.outbound[0]!.updatedAt = new Date(Date.now() - MESSAGING_SEND_STALE_MS - 1);
    await t.delivery.sendJob(id!, attempt(1));
    expect(bodies(t)).toEqual(["a-1", "a-1"]);
    expect(statuses(t)).toEqual(["sent"]);
    expect(sendJobs(t)).toEqual([]);
  });

  it.each(["group", "intro", "text", "attachment"])(
    "retries %s when the provider fails before accepting it",
    async (kind) => {
      const t = setup();
      linkProvider(t.world, TELEGRAM);
      t.world.artifacts.push({
        id: "art-1",
        spaceId: "ws-1",
        userId: "user-1",
        name: "chart.png",
        mimeType: "image/png",
        storageKey: "chart",
      });
      const direct = kind === "text" || kind === "attachment";
      const lane = direct ? dm : threadLane("telegram:group");
      const [id] = await t.record(lane, [
        {
          idempotencyKey: kind === "attachment" ? "msg:m-1:file:art-1" : "msg:m-1",
          kind: direct ? "dm" : kind,
          ...(direct ? { identityId: "mi-1" } : { threadId: "telegram:group" }),
          body: kind === "attachment" ? "" : "Hello",
        },
      ]);
      t.sendToThread.mockRejectedValueOnce(new Error("provider unavailable"));
      await t.delivery.send([lane]);
      expect(statuses(t)).toEqual(["retry"]);
      expect(backupJob(t, id!)!.availableAt!.getTime()).toBeLessThanOrEqual(Date.now());

      await t.delivery.sendJob(id!, attempt(1));
      expect(t.sendToThread).toHaveBeenCalledTimes(2);
      expect(statuses(t)).toEqual(["sent"]);
      expect(sendJobs(t)).toEqual([]);
    },
  );
});

describe("accepted sends whose bookkeeping fails", () => {
  it.each(["text", "attachment"])(
    "does not resend an accepted %s when its counter cannot be saved",
    async (kind) => {
      const t = setup();
      linkProvider(t.world, TELEGRAM);
      t.world.artifacts.push({
        id: "art-1",
        spaceId: "ws-1",
        userId: "user-1",
        name: "chart.png",
        mimeType: "image/png",
        storageKey: "chart",
      });
      const [id] = await t.record(dm, [
        {
          idempotencyKey: kind === "attachment" ? "msg:m-1:file:art-1" : "msg:m-1",
          kind: "dm",
          identityId: "mi-1",
          body: kind === "attachment" ? "" : "Hello",
        },
      ]);
      t.prisma.messagingIdentity.update.mockRejectedValueOnce(new Error("bookkeeping unavailable"));
      await t.delivery.send([dm]);
      await t.delivery.sendJob(id!, attempt(1));

      expect(t.sendToThread).toHaveBeenCalledOnce();
      expect(t.world.outbound).toEqual([
        expect.objectContaining({ status: "sent", providerHandle: "handle-1" }),
      ]);
      expect(sendJobs(t)).toEqual([]);
    },
  );
});

describe("conversation order", () => {
  const part = (letter: string) => letter.repeat(3000);
  const longReply = [part("a"), part("b"), part("c")].join("\n\n");

  it.each([
    WHATSAPP,
    TELEGRAM,
    { provider: "telegram-work", address: "123", dmThreadId: "telegram-work:123" },
  ])("sends a long $provider reply as one message per sized part", async (identity) => {
    const t = setup();
    linkProvider(t.world, identity);
    addRun(t.world, { replies: [text("m-1", longReply)] });
    await t.delivery.deliverRun("run-1");

    expect(inSendOrder(t).map((row) => [row.idempotencyKey, row.body, row.status])).toEqual([
      ["msg:m-1", part("a"), "sent"],
      ["msg:m-1:2", part("b"), "sent"],
      ["msg:m-1:3", part("c"), "sent"],
    ]);
    expect(t.world.outbound.every((row) => row.sourceMessageId === "m-1")).toBe(true);
  });

  it("re-sends only the parts that failed, in order", async () => {
    const t = setup();
    linkProvider(t.world, WHATSAPP);
    addRun(t.world, { replies: [text("m-1", longReply)] });
    t.sendToThread
      .mockResolvedValueOnce({ handle: "wamid.1" })
      .mockRejectedValueOnce(new Error("WhatsApp API error"));
    await t.delivery.deliverRun("run-1");

    // The third part waits behind the failed second one.
    expect(statuses(t)).toEqual(["sent", "retry", "pending"]);

    await t.delivery.sendJob(inSendOrder(t)[1]!.id, attempt(1));
    expect(bodies(t)).toEqual([part("a"), part("b"), part("b"), part("c")]);
    expect(statuses(t)).toEqual(["sent", "sent", "sent"]);
  });

  it.each([
    ["in flight in this release or the previous one (sent, no handle yet)", "sent", null, false],
    ["sent", "sent", "wamid.1", true],
    ["failed for good", "failed", null, true],
  ])("a later part whose first part is %s is sent: %s", async (_label, status, handle, sent) => {
    const t = setup();
    linkProvider(t.world, WHATSAPP);
    const row = { kind: "dm", identityId: "mi-1", threadId: null, sourceMessageId: "m-1" };
    seedRow(t.world, {
      ...row,
      id: "p-1",
      idempotencyKey: "msg:m-1",
      status,
      providerHandle: handle,
    });
    seedRow(t.world, {
      ...row,
      id: "p-2",
      idempotencyKey: "msg:m-1:2",
      createdAt: new Date(1_001),
    });
    await t.delivery.send([dm]);

    expect(bodies(t)).toEqual(sent ? ["p-2"] : []);
    expect(t.world.outbound[1]!.status).toBe(sent ? "sent" : "pending");
  });

  it("drains every conversation for the previous release's job, past one held by a retry", async () => {
    const t = setup();
    seedRow(t.world, { id: "first", threadId: "t-held", status: "retry" });
    seedRow(t.world, { id: "second", threadId: "t-held", createdAt: new Date(1_001) });
    seedRow(t.world, { id: "elsewhere", threadId: "t-other", createdAt: new Date(1_002) });
    seedRow(t.world, {
      id: "earlier dm",
      kind: "dm",
      identityId: "mi-1",
      threadId: null,
      createdAt: new Date(1_003),
    });
    await t.delivery.drainAll();

    expect(requests(t).map(({ threadId, body }) => [threadId, body])).toEqual(
      expect.arrayContaining([
        ["t-other", "elsewhere"],
        ["sendblue:dm-1", "earlier dm"],
      ]),
    );
    expect(t.sendToThread).toHaveBeenCalledTimes(2);
    expect(t.world.outbound.map((row) => row.status)).toEqual(["retry", "pending", "sent", "sent"]);
  });

  it("sends separate conversations without waiting for a slow one", async () => {
    const t = setup();
    await t.record(threadLane("t-slow"), [post("t-slow", "slow-1")]);
    await t.record(threadLane("t-fast"), [post("t-fast", "fast-1")]);
    const slow = gate();
    t.sendToThread.mockImplementation(async (request) => {
      if (request.body === "slow-1") await slow.opened;
      return { handle: `handle-${request.body}` };
    });

    const sending = t.delivery.send([threadLane("t-slow"), threadLane("t-fast")]);
    // The fast conversation is out before the slow one answers.
    await vi.waitFor(() => expect(statuses(t)).toEqual(["in-flight", "sent"]));
    slow.open();
    await sending;

    expect(statuses(t)).toEqual(["sent", "sent"]);
  });

  it("keeps one conversation in order while its first send is running", async () => {
    const t = setup();
    await t.record(threadLane("t-a"), [post("t-a", "a-1"), post("t-a", "a-2")]);
    const first = gate();
    t.sendToThread.mockImplementationOnce(async () => {
      await first.opened;
      return { handle: "h-1" };
    });

    const sending = t.delivery.send([threadLane("t-a")]);
    await vi.waitFor(() => expect(t.sendToThread).toHaveBeenCalledOnce());
    // Claimed before it went out, so another sender leaves the conversation to this one.
    expect(statuses(t)).toEqual(["in-flight", "pending"]);
    await t.delivery.send([threadLane("t-a")]);
    expect(t.sendToThread).toHaveBeenCalledOnce();

    first.open();
    await sending;
    expect(bodies(t)).toEqual(["a-1", "a-2"]);
    expect(statuses(t)).toEqual(["sent", "sent"]);
  });

  it("orders messages recorded at the same instant by id", async () => {
    const t = setup();
    seedRow(t.world, { id: "z-2" });
    seedRow(t.world, { id: "a-1" });
    await t.delivery.send([threadLane("t-a")]);

    expect(bodies(t)).toEqual(["a-1", "z-2"]);
  });

  it("leaves a conversation alone while another process sends its first message", async () => {
    const t = setup();
    seedRow(t.world, { id: "a-1", status: "sent", providerHandle: null });
    seedRow(t.world, { id: "a-2", createdAt: new Date(1_001) });
    await t.delivery.send([threadLane("t-a")]);

    // Overtaking would reorder the conversation, so the later message waits too.
    expect(t.sendToThread).not.toHaveBeenCalled();
    expect(statuses(t)).toEqual(["in-flight", "pending"]);
  });

  it("sends a reply recorded while the conversation's previous send was running", async () => {
    const t = setup();
    await t.record(threadLane("t-a"), [post("t-a", "a-1")]);
    t.sendToThread.mockImplementationOnce(async () => {
      // A reply recorded meanwhile, whose own send found the conversation busy.
      await t.record(threadLane("t-a"), [post("t-a", "a-2")]);
      await t.delivery.send([threadLane("t-a")]);
      return { handle: "h-1" };
    });
    await t.delivery.send([threadLane("t-a")]);

    expect(bodies(t)).toEqual(["a-1", "a-2"]);
    expect(statuses(t)).toEqual(["sent", "sent"]);
  });
});

describe("replies the previous release delivered", () => {
  it("does not resend a 1:1 reply the previous release mirrored under the same key", async () => {
    const t = setup();
    linkProvider(t.world, TELEGRAM);
    addRun(t.world, { replies: [text("m-1", "already out")] });
    t.world.runs[0]!.messagingMirroredAt = new Date();
    seedRow(t.world, {
      id: "old-1",
      idempotencyKey: "msg:m-1",
      kind: "dm",
      identityId: "mi-1",
      threadId: null,
      status: "sent",
      providerHandle: "h-old",
    });
    await t.delivery.deliverRun("run-1");

    expect({ rows: t.world.outbound.length, sends: bodies(t) }).toEqual({ rows: 1, sends: [] });
  });

  /** A run in a team-chat thread that another bot's team-chat run delegated to. */
  function delegated(t: Setup, marker: Date | null | "dropped") {
    addRun(t.world, {
      id: "run-a",
      threadId: "thread-slack",
      replies: [text("a-msg", "Asking around.")],
    });
    t.world.externalMessages.push({
      id: "em-1",
      runId: "run-a",
      kind: "direct",
      status: "delivered",
      replyThreadId: null,
      externalConversation: { conversationId: "slack:C1" },
    });
    addRun(t.world, {
      id: "run-b",
      threadId: "thread-slack",
      trigger: "bot_message",
      replyTo: "a-msg",
      replies: [text("b-msg", "Found it.")],
    });
    if (marker !== "dropped") t.world.runs[1]!.teamChatMirroredAt = marker;
  }
  const teamSends = (t: Setup) =>
    requests(t).filter((request) => request.threadId.startsWith("slack:"));

  it("skips a delegated reply the previous release posted, from any job", async () => {
    const t = setup();
    delegated(t, new Date());
    await t.delivery.deliverRun("run-b");

    expect(t.world.outbound.filter((row) => row.kind === "team")).toEqual([]);
    expect(teamSends(t)).toEqual([]);
  });

  it("marks a delegated reply it relays, so the previous release does not post it too", async () => {
    const t = setup();
    delegated(t, null);
    await t.delivery.deliverRun("run-b");

    expect(teamSends(t)).toEqual([expect.objectContaining({ threadId: "slack:C1" })]);
    expect(t.world.runs[1]!.teamChatMirroredAt).toBeInstanceOf(Date);
    // Its run-end job, or a second process, finds the marker and records nothing more.
    await t.delivery.deliverRun("run-b");
    expect(t.world.outbound.filter((row) => row.kind === "team")).toHaveLength(1);
    expect(teamSends(t)).toHaveLength(1);
  });

  it("finds the carried row once the marker column is gone", async () => {
    for (const carried of [true, false]) {
      const t = setup();
      delegated(t, "dropped");
      if (carried)
        seedRow(t.world, {
          id: "relayed:run-b",
          idempotencyKey: "team-chat-run:run-b",
          kind: "team",
          threadId: null,
          body: "",
          status: "sent",
          providerHandle: "",
        });
      await t.delivery.deliverRun("run-b");

      expect(teamSends(t)).toHaveLength(carried ? 0 : 1);
    }
  });
});

describe("the Chat SDK surface and the send's abort signal", () => {
  it("does not start a post once the send's time is up", async () => {
    const postMessage = vi.fn(async () => ({ id: "m-1", threadId: "slack:C1", raw: {} }));
    const messaging = new ChatSdkMessagingSurface([
      {
        provider: "slack",
        capabilities: { direct: true, groups: true, receipt: null },
        adapter: {
          name: "slack",
          userName: "bot",
          initialize: async () => undefined,
          handleWebhook: async () => new Response("ok"),
          postMessage,
          encodeThreadId: (data: { id: string }) => `slack:${data.id}`,
          decodeThreadId: (threadId: string) => ({ id: threadId.slice("slack:".length) }),
        } as unknown as Adapter,
      },
    ]);
    const signal = AbortSignal.abort(new Error("send timed out"));
    await expect(
      messaging.sendToThread(
        { threadId: "slack:C1", body: "too late" },
        { operationId: "op", traceId: "op", spaceId: "", userId: "", signal },
      ),
    ).rejects.toThrow("send timed out");
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("WhatsApp rendered outbound delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function deliver(body: string, failSend?: number) {
    const sends: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as { text: { body: string } };
        sends.push(payload.text.body);
        if (sends.length === failSend) {
          return Response.json({ error: { message: "temporary error", code: 1 } }, { status: 500 });
        }
        return Response.json({ messages: [{ id: `wamid.${sends.length}` }] });
      }),
    );
    const messaging = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        whatsappAccessToken: "test-token",
        whatsappPhoneNumberId: "123",
        whatsappAppSecret: "test-secret",
        whatsappVerifyToken: "test-verify",
      }),
    );
    const t = setup({ messaging });
    linkProvider(t.world, { ...WHATSAPP, dmThreadId: "whatsapp:123:15551234567" });
    addRun(t.world, { replies: [text("m-1", body)] });
    await t.delivery.deliverRun("run-1");
    return { t, sends };
  }
  const intact = (body: string) => body.length <= 4096 && !/\p{Cs}/u.test(body);

  it("splits before Markdown rendering pushes an emoji across the limit", async () => {
    // Rendering expands this auto-link so the emoji would begin at UTF-16 offset 4095.
    const link = `www.${"a".repeat(2000)}.test`;
    const body = `${link} ${"x".repeat(65)}😀zzz`;
    expect(body.length).toBeLessThan(4096);

    const { t, sends } = await deliver(body, 2);

    expect(t.world.outbound).toHaveLength(2);
    expect(sends).toHaveLength(2);
    expect(sends.every(intact)).toBe(true);
    expect(sends.join(" ")).toContain("😀zzz");
    expect(statuses(t)).toEqual(["sent", "retry"]);

    await t.delivery.sendJob(inSendOrder(t)[1]!.id, attempt(1));

    expect(sends.slice(2)).toEqual([sends[1]]);
    expect(statuses(t)).toEqual(["sent", "sent"]);
  });

  it("sends a table that renders past the limit as one request per queued part", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| ${i} | x | 😀 |`);
    const body = [
      "| n | text | mood |",
      "| - | - | - |",
      `| - | ${"w".repeat(40)} | - |`,
      ...rows,
    ].join("\n");
    expect(body.length).toBeLessThan(4096);

    const { t, sends } = await deliver(body);

    expect(t.world.outbound.length).toBeGreaterThan(1);
    expect(sends).toHaveLength(t.world.outbound.length);
    expect(sends.every(intact)).toBe(true);
    expect(t.world.outbound.every((row) => row.status === "sent")).toBe(true);
  });
});

describe("files", () => {
  const chart = {
    id: "art-1",
    spaceId: "ws-1",
    userId: "user-1",
    name: "chart.png",
    mimeType: "image/png",
    storageKey: "key-1",
  };
  const report = {
    id: "art-2",
    spaceId: "ws-1",
    userId: "user-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    storageKey: "key-2",
  };
  const image = { kind: "image", artifactId: "art-1", mimeType: "image/png", name: "chart.png" };
  const reply: Reply = {
    id: "m-1",
    blocks: [
      { kind: "text", text: "Here you go" },
      image,
      {
        kind: "file",
        artifactId: "art-2",
        mimeType: "application/pdf",
        name: "report.pdf",
        size: 5,
      },
    ],
  };

  function withFiles(artifacts = [chart, report]) {
    const t = setup();
    linkProvider(t.world, TELEGRAM);
    t.world.artifacts.push(...artifacts);
    return t;
  }

  it("sends a reply's image and file after its text, one message each", async () => {
    const t = withFiles();
    addRun(t.world, { replies: [reply] });
    await t.delivery.deliverRun("run-1");

    expect(requests(t)).toEqual([
      { threadId: "telegram:123", body: "Here you go", idempotencyKey: "msg:m-1" },
      {
        threadId: "telegram:123",
        body: "",
        idempotencyKey: "msg:m-1:file:art-1",
        attachment: { name: "chart.png", mimeType: "image/png", data: bytes("key-1") },
      },
      {
        threadId: "telegram:123",
        body: "",
        idempotencyKey: "msg:m-1:file:art-2",
        attachment: { name: "report.pdf", mimeType: "application/pdf", data: bytes("key-2") },
      },
    ]);
    expect(inSendOrder(t).map((row) => [row.idempotencyKey, row.status])).toEqual([
      ["msg:m-1", "sent"],
      ["msg:m-1:file:art-1", "sent"],
      ["msg:m-1:file:art-2", "sent"],
    ]);
    // Bytes come from the artifact store, read in the artifact's own Space.
    expect(t.artifacts.get).toHaveBeenCalledWith(
      "key-1",
      expect.objectContaining({ spaceId: "ws-1", userId: "user-1" }),
    );
  });

  it("sends a reply that is only a file", async () => {
    const t = withFiles();
    addRun(t.world, { replies: [{ id: "m-1", blocks: [image] }] });
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(["file:chart.png"]);
  });

  it("sends only the text on platforms that cannot send files", async () => {
    const t = setup();
    t.world.artifacts.push(chart, report);
    addRun(t.world, { replies: [reply] });
    await t.delivery.deliverRun("run-1");

    expect(requests(t)).toEqual([
      { threadId: "sendblue:dm-1", body: "Here you go", idempotencyKey: "msg:m-1" },
    ]);
    expect(t.world.outbound).toHaveLength(1);
    expect(t.artifacts.get).not.toHaveBeenCalled();
  });

  it("retries a failed file without sending the text again", async () => {
    const t = withFiles();
    addRun(t.world, { replies: [reply] });
    t.sendToThread
      .mockResolvedValueOnce({ handle: "text-1" })
      .mockRejectedValueOnce(new Error("Telegram 500"));
    await t.delivery.deliverRun("run-1");

    // The second file waits behind the failed first one.
    expect(statuses(t)).toEqual(["sent", "retry", "pending"]);

    await t.delivery.sendJob(inSendOrder(t)[1]!.id, attempt(1));
    expect(bodies(t)).toEqual([
      "Here you go",
      "file:chart.png",
      "file:chart.png",
      "file:report.pdf",
    ]);
    expect(statuses(t)).toEqual(["sent", "sent", "sent"]);
  });

  it("sends a notice in place of a file that fails for good, ahead of what was queued after it", async () => {
    const t = withFiles();
    addRun(t.world, {
      replies: [
        { id: "m-1", blocks: [{ kind: "text", text: "Here you go" }, image] },
        text("m-2", "Later reply"),
      ],
    });
    t.sendToThread
      .mockResolvedValueOnce({ handle: "text-1" })
      .mockRejectedValueOnce(new Error("Telegram 500"));
    await t.delivery.deliverRun("run-1");
    expect(statuses(t)).toEqual(["sent", "retry", "pending"]);
    const file = inSendOrder(t)[1]!;

    t.sendToThread.mockRejectedValueOnce(new Error("Telegram 500"));
    await t.delivery.sendJob(file.id, lastAttempt);

    expect(bodies(t)).toEqual([
      "Here you go",
      "file:chart.png",
      "file:chart.png",
      'Could not send "chart.png".',
      "Later reply",
    ]);
    const rows = inSendOrder(t);
    expect(rows.map((row) => [row.idempotencyKey, row.status])).toEqual([
      ["msg:m-1", "sent"],
      ["msg:m-1:file:art-1", "failed"],
      ["msg:m-1:file:art-1:notice", "sent"],
      ["msg:m-2", "sent"],
    ]);
    expect(rows[2]).toEqual(
      expect.objectContaining({
        kind: "dm",
        identityId: "mi-1",
        sourceMessageId: "m-1",
        createdAt: file.createdAt,
      }),
    );
    expect(t.jobs.enqueueIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "messaging.send", payload: { outboundId: rows[2]!.id } }),
    );
    expect(sendJobs(t)).toEqual([]);
  });

  it("sends the notice at once when the provider rejects a file for good", async () => {
    const t = withFiles();
    addRun(t.world, {
      replies: [{ id: "m-1", blocks: [{ kind: "text", text: "Here you go" }, image] }],
    });
    t.sendToThread.mockResolvedValueOnce({ handle: "text-1" }).mockRejectedValueOnce(
      new MessagingSendError(new Error("file too large"), {
        permanent: true,
        retryAfterMs: null,
      }),
    );
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(["Here you go", "file:chart.png", 'Could not send "chart.png".']);
    expect(statuses(t)).toEqual(["sent", "failed", "sent"]);
  });

  it("fails a file whose artifact is gone or belongs to another Space, without a notice", async () => {
    const t = withFiles([{ ...chart, spaceId: "ws-2" }]);
    addRun(t.world, { replies: [reply] });
    await t.delivery.deliverRun("run-1");

    expect(bodies(t)).toEqual(["Here you go"]);
    expect(statuses(t)).toEqual(["sent", "failed", "failed"]);
    expect(t.artifacts.get).not.toHaveBeenCalled();
  });
});
