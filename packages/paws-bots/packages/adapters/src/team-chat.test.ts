import type { BackgroundJob, JobTransaction } from "@rakazo/adapter-kit";
import {
  messagingReplyJob,
  messagingReplyJobKey,
  teamChatAmbientJob,
  teamChatEngageJob,
  teamChatEngageJobKey,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { teamChatAmbientPrompt, teamChatPrompt } from "@rakazo/core";
import type { Prisma, PrismaClient, SendUserMessageInput, SendUserMessageResult } from "@rakazo/db";
import { SendClaimLostError, SpaceDeletionInProgressError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { inboundDeliveryClientNonce, messagingWakeIdempotencyKey } from "./inbound-delivery.js";
import {
  TEAM_CHAT_ENGAGE_BACKUP_MS,
  TEAM_CHAT_ROUTING_MS,
  TeamChat,
  teamChatAttachmentNonce,
} from "./team-chat.js";
import type { TeamChatEngagementDecision, TeamChatEngagementInput } from "./team-chat-judge.js";

const DEBOUNCE_MS = 10_000;
const HOUR_MS = 60 * 60_000;

type Where = Record<string, unknown>;
type FindArgs = { where?: Where; orderBy?: Record<string, "asc" | "desc">; take?: number };

interface ExternalMessageRow {
  id: string;
  externalConversationId: string;
  providerEventId: string;
  kind: string;
  senderId: string;
  senderName: string;
  senderIsBot: boolean;
  content: string;
  status: string;
  engagementReason: string | null;
  judgedAt: Date | null;
  batchContext: string | null;
  threadMessageId: string | null;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ThreadMessage {
  id: string;
  threadId: string;
  clientNonce: string | undefined;
  blocks: MessageBlock[];
  prompt: string;
  runId: string | null;
  seq: number;
}

function equal(a: unknown, b: unknown): boolean {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
}

/** The subset of Prisma's where clauses TeamChat uses, applied to plain rows. */
function matches(row: object, where: Where = {}): boolean {
  const record = row as Record<string, unknown>;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    if (key === "NOT") return !matches(row, condition as Where);
    if (!(key in record) && key.includes("_")) return matches(row, condition as Where);
    const value = record[key];
    if (condition === null || typeof condition !== "object" || condition instanceof Date)
      return equal(value, condition);
    const operator = condition as Where;
    if ("in" in operator) return (operator.in as unknown[]).includes(value);
    if ("lt" in operator) return (value as Date).getTime() < (operator.lt as Date).getTime();
    if ("not" in operator) return !equal(value, operator.not);
    return value !== null && typeof value === "object" && matches(value, operator);
  });
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x).localeCompare(String(y));
}

function query<T extends object>(rows: T[], { where, orderBy, take }: FindArgs = {}): T[] {
  const found = rows.filter((row) => matches(row, where));
  const [key, direction] = Object.entries(orderBy ?? {})[0] ?? [];
  if (key)
    found.sort(
      (a, b) => compare((a as Where)[key], (b as Where)[key]) * (direction === "desc" ? -1 : 1),
    );
  return structuredClone(found.slice(0, take));
}

function setup(
  options: {
    conversation?: Partial<{
      conversationId: string;
      teamChatAmbientEnabled: boolean | null;
      teamChatRules: string | null;
      automatedSenderPolicies: unknown;
    }>;
    bot?: Partial<{ teamChatAmbientEnabled: boolean; teamChatRules: string }>;
    /** null leaves the judge out, as when no model is configured for it. */
    judge?: ((input: TeamChatEngagementInput) => Promise<TeamChatEngagementDecision>) | null;
    isInstallationActive?: (installationId: string) => Promise<boolean>;
  } = {},
) {
  const conversation = {
    id: "conversation-1",
    provider: "slack",
    conversationId: "slack:C-1",
    displayName: "launch" as string | null,
    spaceId: "space-1",
    botId: "bot-1",
    userId: "owner-1",
    thread: { id: "thread-1" },
    teamChatAmbientEnabled: null as boolean | null,
    teamChatRules: null as string | null,
    automatedSenderPolicies: {} as unknown,
    ...options.conversation,
  };
  const bot = {
    id: "bot-1",
    spaceId: "space-1",
    userId: "owner-1",
    name: "Chief",
    modelProvider: null,
    modelId: null,
    teamChatAmbientEnabled: true,
    teamChatRules: "Help with launches.",
    archivedAt: null,
    ...options.bot,
  };
  const externalMessages = new Map<string, ExternalMessageRow>();
  const threadMessages = new Map<string, ThreadMessage>();
  const runs = new Map<string, { id: string; status: string }>();
  const artifacts: Array<Record<string, unknown>> = [];
  const jobs = new Map<string, BackgroundJob>();
  const state = {
    spaceDeleting: false,
    /** Runs inside a run send just before its claim, like a commit racing it. */
    beforeClaim: undefined as (() => void) | undefined,
  };

  const withRelations = (row: ExternalMessageRow) => ({
    ...row,
    externalConversation: conversation,
    run: row.runId ? (runs.get(row.runId) ?? null) : null,
  });
  const withTranscriptOf = (message: ThreadMessage) => ({
    ...message,
    externalTranscriptFor:
      [...externalMessages.values()].find((row) => row.threadMessageId === message.id) ?? null,
  });
  const change = (row: ExternalMessageRow, data: object) =>
    Object.assign(row, data, { updatedAt: new Date() });
  const tables = {
    externalConversation: {
      findUnique: async ({ where }: FindArgs) => query([conversation], { where })[0] ?? null,
    },
    bot: { findFirst: async ({ where }: FindArgs) => query([bot], { where })[0] ?? null },
    externalMessage: {
      findUnique: async ({ where }: FindArgs) =>
        query([...externalMessages.values()].map(withRelations), { where })[0] ?? null,
      findFirst: async (args: FindArgs) =>
        query([...externalMessages.values()].map(withRelations), args)[0] ?? null,
      findMany: async (args: FindArgs) =>
        query([...externalMessages.values()].map(withRelations), args),
      groupBy: async ({ where }: { by: ["senderId"]; where: Where }) =>
        [
          ...new Set(
            query([...externalMessages.values()].map(withRelations), { where }).map(
              (row) => row.senderId,
            ),
          ),
        ].map((senderId) => ({ senderId })),
      update: async ({ where, data }: { where: { id: string }; data: object }) => {
        const row = externalMessages.get(where.id);
        if (!row) throw new Error(`No external message ${where.id}`);
        return structuredClone(change(row, data));
      },
      updateMany: async ({ where, data }: { where: Where; data: object }) => {
        const hits = [...externalMessages.values()].filter((row) =>
          matches(withRelations(row), where),
        );
        for (const row of hits) change(row, data);
        return { count: hits.length };
      },
    },
    message: {
      findUnique: async ({ where }: FindArgs) =>
        query([...threadMessages.values()], { where })[0] ?? null,
      findMany: async (args: FindArgs) =>
        query([...threadMessages.values()].map(withTranscriptOf), args),
    },
    artifact: { findMany: async (args: FindArgs) => query(artifacts, args) },
    // The conversation's ambient scheduling lock.
    $executeRaw: async () => 0,
    /** Each digest sender's latest decision in a conversation. */
    $queryRaw: async (_sql: TemplateStringsArray, senders: string[], conversationId: string) =>
      senders.map((senderId) => ({
        senderId,
        judgedAt:
          [...externalMessages.values()]
            .filter(
              (row) =>
                row.externalConversationId === conversationId &&
                row.senderId === senderId &&
                row.senderIsBot &&
                row.judgedAt,
            )
            .map((row) => row.judgedAt!)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      })),
  };
  const prisma = {
    ...tables,
    $transaction: <T>(fn: (tx: typeof tables) => Promise<T>) => fn(tables),
  };
  const sendTransaction = { ...tables, label: "send transaction" };

  let sequence = 0;
  const seed = (clientNonce: string, fields: Partial<ThreadMessage> = {}): ThreadMessage => {
    sequence += 1;
    const message = {
      id: `message-${sequence}`,
      threadId: conversation.thread.id,
      clientNonce,
      blocks: [],
      prompt: "",
      runId: null,
      seq: sequence,
      ...fields,
    };
    threadMessages.set(message.id, message);
    return message;
  };
  const sendUserMessage = vi.fn(
    async (input: SendUserMessageInput): Promise<SendUserMessageResult> => {
      const replay = [...threadMessages.values()].find(
        (message) =>
          message.threadId === input.threadId && message.clientNonce === input.clientNonce,
      );
      if (replay)
        return { messageId: replay.id, runId: replay.runId, seq: replay.seq, taskId: null };
      if (input.createRun !== false && state.spaceDeleting)
        throw new SpaceDeletionInProgressError();
      const seq = sequence + 1;
      const runId = input.createRun === false ? null : `run-${seq}`;
      if (input.claim) {
        state.beforeClaim?.();
        const claimed = await input.claim(sendTransaction as unknown as Prisma.TransactionClient, {
          messageId: `message-${seq}`,
          runId,
        });
        if (!claimed) throw new SendClaimLostError();
      }
      const message = seed(input.clientNonce ?? "", {
        threadId: input.threadId,
        blocks: input.blocks,
        prompt: input.prompt,
        runId,
      });
      if (runId) runs.set(runId, { id: runId, status: "running" });
      return { messageId: message.id, runId, seq: message.seq, taskId: null };
    },
  );

  const schedule = (job: BackgroundJob) => {
    const key = job.replaceKey ?? job.name;
    if (!(job.keepExisting && jobs.has(key))) jobs.set(key, job);
  };
  const publisher = {
    enqueue: vi.fn(async (job: BackgroundJob) => schedule(job)),
    enqueueIn: vi.fn(async (_tx: JobTransaction, job: BackgroundJob) => schedule(job)),
    cancel: vi.fn(async (key: string) => {
      jobs.delete(key);
    }),
    cancelIn: vi.fn(async (_tx: JobTransaction, key: string) => {
      jobs.delete(key);
    }),
  };
  const decide = vi.fn<(input: TeamChatEngagementInput) => Promise<TeamChatEngagementDecision>>(
    options.judge ?? (async () => ({ act: false, reason: "Small talk." })),
  );
  const teamChat = new TeamChat({
    prisma: prisma as unknown as PrismaClient,
    events: { sendUserMessage },
    jobs: publisher,
    judge: options.judge === null ? undefined : { decide },
    isInstallationActive: options.isInstallationActive,
    ambientDebounceMs: DEBOUNCE_MS,
  });

  let recorded = 0;
  /** Records a message as the bridge does, with the job that backs it up. */
  const record = (fields: Partial<ExternalMessageRow> = {}): ExternalMessageRow => {
    recorded += 1;
    const row: ExternalMessageRow = {
      id: `external-${recorded}`,
      externalConversationId: conversation.id,
      providerEventId: `Ev-${recorded}`,
      kind: "mention",
      senderId: "U-1",
      senderName: "Ada",
      senderIsBot: false,
      content: `Message ${recorded}`,
      status: "received",
      engagementReason: null,
      judgedAt: null,
      batchContext: null,
      threadMessageId: null,
      runId: null,
      createdAt: new Date(Date.now() - 60_000 + recorded),
      updatedAt: new Date(),
      ...fields,
    };
    externalMessages.set(row.id, row);
    if (["received", "deferred", "queueing"].includes(row.status)) {
      const due = row.status === "deferred" ? TEAM_CHAT_ROUTING_MS : TEAM_CHAT_ENGAGE_BACKUP_MS;
      schedule(teamChatEngageJob(row.id, new Date(Date.now() + due)));
    }
    return row;
  };

  return {
    teamChat,
    tables,
    sendTransaction,
    publisher,
    jobs,
    runs,
    artifacts,
    threadMessages,
    conversation,
    state,
    decide,
    sendUserMessage,
    record,
    ambient: (fields: Partial<ExternalMessageRow> = {}) =>
      record({ kind: "ambient", status: "observed", ...fields }),
    row: (id: string) => externalMessages.get(id),
    view: (id: string) => structuredClone(withRelations(externalMessages.get(id)!)),
    change: (id: string, data: Partial<ExternalMessageRow>) =>
      change(externalMessages.get(id)!, data),
    transcript: (row: ExternalMessageRow, blocks: MessageBlock[]) => {
      row.threadMessageId = seed(`teamchat-transcript:slack:${row.providerEventId}`, {
        blocks,
      }).id;
    },
    /** The message a routine wake leaves in the thread, under the message's wake nonce. */
    wakeRoutine: (row: ExternalMessageRow) =>
      seed(
        inboundDeliveryClientNonce(
          "messaging",
          conversation.botId,
          messagingWakeIdempotencyKey(conversation.provider, row.providerEventId),
        ),
        { runId: "run-routine" },
      ),
    seed,
    transcripts: () =>
      sendUserMessage.mock.calls.flatMap(([input]) => (input.createRun === false ? [input] : [])),
    runSends: () =>
      sendUserMessage.mock.calls.flatMap(([input]) => (input.createRun === false ? [] : [input])),
    continued: () =>
      [...jobs.values()].flatMap((job) => (job.name === "run.continue" ? [job.payload.runId] : [])),
    statuses: (...rows: ExternalMessageRow[]) =>
      rows.map((row) => externalMessages.get(row.id)?.status),
  };
}

const file = (n: number): MessageBlock => ({
  kind: "file",
  artifactId: `document-${n}`,
  name: `report-${n}.pdf`,
  mimeType: "application/pdf",
  size: 3,
});

describe("TeamChat.startAgentRun", () => {
  it("claims the message and removes its backup job in the transaction that starts the run", async () => {
    const chat = setup();
    const message = chat.record({ content: "Can you review the launch plan?" });

    await chat.teamChat.startAgentRun(message.id, ["received"]);

    const runId = chat.row(message.id)?.runId;
    expect(chat.row(message.id)).toMatchObject({ status: "running", runId: expect.any(String) });
    expect(chat.continued()).toEqual([runId]);
    expect(chat.publisher.cancelIn).toHaveBeenCalledExactlyOnceWith(
      chat.sendTransaction,
      teamChatEngageJobKey(message.id),
    );
    expect(chat.jobs.has(teamChatEngageJobKey(message.id))).toBe(false);
    const [send] = chat.runSends();
    expect(send).toMatchObject({
      prompt: teamChatPrompt("slack", "Ada", "Can you review the launch plan?"),
      clientNonce: "teamchat:slack:Ev-1",
      trigger: "messaging",
      linkMessageToRun: true,
      allowParallelRun: true,
    });
    // Anything else that tries to take the message now, such as a routine, loses.
    await expect(
      send?.claim?.(chat.sendTransaction as unknown as Prisma.TransactionClient, {
        messageId: "message-other",
        runId: "run-other",
      }),
    ).resolves.toBe(false);
    expect(chat.row(message.id)?.runId).toBe(runId);
  });

  it("mirrors the message into the thread before its run", async () => {
    const chat = setup();
    const message = chat.record();

    await chat.teamChat.startAgentRun(message.id, ["received"]);

    expect(
      chat.sendUserMessage.mock.calls.map(([input]) => [
        input.createRun ?? true,
        input.clientNonce,
      ]),
    ).toEqual([
      [false, "teamchat-transcript:slack:Ev-1"],
      [true, "teamchat:slack:Ev-1"],
    ]);
    expect(chat.row(message.id)?.threadMessageId).toBe("message-1");
  });

  it("starts nothing when a routine wake claims the message first", async () => {
    const chat = setup();
    const message = chat.record();
    chat.state.beforeClaim = () =>
      chat.change(message.id, { status: "ignored", engagementReason: "message_routine_wake" });

    await expect(chat.teamChat.startAgentRun(message.id, ["received"])).resolves.toBeUndefined();

    expect(chat.row(message.id)).toMatchObject({ status: "ignored", runId: null });
    expect(chat.runs.size).toBe(0);
    expect(chat.continued()).toEqual([]);
  });

  it("drops a message for a Space being deleted and keeps its transcript", async () => {
    const chat = setup();
    const message = chat.record();
    chat.state.spaceDeleting = true;

    await chat.teamChat.startAgentRun(message.id, ["received"]);

    expect(chat.row(message.id)).toMatchObject({
      status: "ignored",
      runId: null,
      threadMessageId: expect.any(String),
    });
    expect(chat.jobs.size).toBe(0);
  });

  it("links the run of a send that committed without its claim", async () => {
    const chat = setup();
    const message = chat.record();
    chat.seed("teamchat:slack:Ev-1", { runId: "run-earlier" });

    await chat.teamChat.startAgentRun(message.id, ["received"]);

    expect(chat.row(message.id)).toMatchObject({ status: "running", runId: "run-earlier" });
    expect(chat.continued()).toEqual(["run-earlier"]);
    expect(chat.jobs.has(teamChatEngageJobKey(message.id))).toBe(false);
    expect(chat.runs.size).toBe(0);
  });

  it("ignores a message a routine already woke for instead of answering it twice", async () => {
    const chat = setup();
    const message = chat.record({ status: "deferred" });
    chat.wakeRoutine(message);

    await chat.teamChat.startAgentRun(message.id, ["deferred"]);

    expect(chat.row(message.id)).toMatchObject({
      status: "ignored",
      engagementReason: "message_routine_wake",
      runId: null,
    });
    expect(chat.sendUserMessage).not.toHaveBeenCalled();
    expect(chat.jobs.size).toBe(0);
  });

  it.each(["running", "deferred", "ignored"])(
    "leaves a message that is %s instead of received alone",
    async (status) => {
      const chat = setup();
      const message = chat.record({ status, runId: status === "running" ? "run-1" : null });
      const before = structuredClone(chat.row(message.id));

      await chat.teamChat.startAgentRun(message.id, ["received"]);

      expect(chat.sendUserMessage).not.toHaveBeenCalled();
      expect(chat.row(message.id)).toEqual(before);
    },
  );

  it.each([false, true])(
    "attaches the newest files of the messages its batch answers (stored before batches listed them: %s)",
    async (legacy) => {
      const chat = setup();
      const first = chat.record({ status: "ignored" });
      const second = chat.record({ status: "ignored" });
      const unrelated = chat.record({ status: "ignored" });
      const trigger = chat.record();
      chat.change(trigger.id, {
        batchContext: legacy
          ? "Answer the thread."
          : JSON.stringify({
              messageIds: [first.id, second.id, trigger.id],
              prompt: "Answer the thread.",
            }),
      });
      chat.transcript(first, [file(1), file(2)]);
      chat.transcript(second, [file(3), file(4)]);
      chat.transcript(unrelated, [file(9)]);
      chat.transcript(trigger, [{ kind: "text", text: "See these" }, file(5), file(6)]);

      await chat.teamChat.startAgentRun(trigger.id, ["received"]);

      expect(chat.runSends()).toEqual([
        expect.objectContaining({
          prompt: "Answer the thread.",
          blocks: [
            { kind: "text", text: "Answer the thread." },
            ...(legacy ? [file(5), file(6)] : [file(3), file(4), file(5), file(6)]),
          ],
        }),
      ]);
    },
  );
});

describe("TeamChat.mirrorTranscript", () => {
  it.each([false, true])(
    "recovers a file-only message with the files an earlier attempt stored (stored: %s)",
    async (stored) => {
      const chat = setup();
      const message = chat.record({ content: "" });
      const artifact = {
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 3,
        spaceId: "space-1",
        userId: "owner-1",
        botId: "bot-1",
        groupId: null,
        clientNonce: teamChatAttachmentNonce(message.id, 0),
      };
      // Another bot's upload under the same nonce is not this message's file.
      chat.artifacts.push({ ...artifact, id: "file-other", botId: "bot-2" });
      if (stored) chat.artifacts.push(artifact);

      await chat.teamChat.mirrorTranscript(chat.view(message.id));

      expect(chat.transcripts()).toEqual([
        expect.objectContaining({
          clientNonce: `teamchat-transcript:slack:${message.providerEventId}`,
          blocks: stored
            ? [
                {
                  kind: "file",
                  artifactId: "file-1",
                  name: "report.pdf",
                  mimeType: "application/pdf",
                  size: 3,
                },
              ]
            : [{ kind: "text", text: "[file (unavailable)]" }],
        }),
      ]);
      expect(chat.row(message.id)?.threadMessageId).toBe("message-1");
    },
  );

  it.each(["write", "link"])(
    "completes a transcript an earlier attempt left unfinished (%s failed)",
    async (failure) => {
      const chat = setup();
      const message = chat.record({ content: "Status?" });
      if (failure === "write")
        chat.sendUserMessage.mockRejectedValueOnce(new Error("write failed"));
      else
        vi.spyOn(chat.tables.externalMessage, "update").mockRejectedValueOnce(
          new Error("link failed"),
        );

      await expect(chat.teamChat.mirrorTranscript(chat.view(message.id))).rejects.toThrow(
        `${failure} failed`,
      );
      expect(chat.row(message.id)?.threadMessageId).toBeNull();
      await chat.teamChat.mirrorTranscript(chat.view(message.id));

      const visible = [...chat.threadMessages.values()];
      expect(visible).toEqual([
        expect.objectContaining({ blocks: [{ kind: "text", text: "Status?" }] }),
      ]);
      expect(chat.row(message.id)?.threadMessageId).toBe(visible[0]?.id);
    },
  );
});

describe("TeamChat.routeToAgent and drop", () => {
  it("hands a deferred mention to the agent", async () => {
    const chat = setup();
    const message = chat.record({ status: "deferred" });

    await chat.teamChat.routeToAgent(message.id, "mention");

    expect(chat.row(message.id)?.status).toBe("running");
    expect(chat.continued()).toEqual([chat.row(message.id)?.runId]);
    expect(chat.jobs.has(teamChatEngageJobKey(message.id))).toBe(false);
  });

  it("returns a deferred ambient message to its conversation's next decision", async () => {
    const chat = setup();
    const message = chat.record({ kind: "ambient", status: "deferred" });
    const before = Date.now();

    await chat.teamChat.routeToAgent(message.id, "ambient");

    expect(chat.row(message.id)?.status).toBe("observed");
    expect([...chat.jobs.keys()]).toEqual([`team_chat.ambient:${chat.conversation.id}`]);
    const decision = chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`);
    expect(decision?.availableAt?.getTime()).toBeGreaterThanOrEqual(before + DEBOUNCE_MS);
    expect(chat.sendUserMessage).not.toHaveBeenCalled();
  });

  it.each(["mention", "ambient"])(
    "leaves a %s message a routine already claimed alone",
    async (kind) => {
      const chat = setup();
      const message = chat.record({
        kind,
        status: "ignored",
        engagementReason: "message_routine_wake",
      });

      await chat.teamChat.routeToAgent(message.id, kind);

      expect(chat.row(message.id)).toMatchObject({
        status: "ignored",
        engagementReason: "message_routine_wake",
      });
      expect(chat.sendUserMessage).not.toHaveBeenCalled();
      expect(chat.jobs.size).toBe(0);
    },
  );

  it("drops a deferred message without answering it, and leaves an answered one alone", async () => {
    const chat = setup();
    const deferred = chat.record({ status: "deferred" });
    const answered = chat.record({ status: "running", runId: "run-1" });

    await chat.teamChat.drop(deferred.id, ["deferred"]);
    await chat.teamChat.drop(answered.id, ["deferred"]);

    expect(chat.statuses(deferred, answered)).toEqual(["ignored", "running"]);
    expect(chat.jobs.size).toBe(0);
    expect(chat.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("TeamChat.engageJob", () => {
  it.each(["received", "queueing"])(
    "answers a %s message whose receiving process stopped",
    async (status) => {
      const chat = setup();
      const message = chat.record({ status });

      await chat.teamChat.engageJob(message.id);

      expect(chat.row(message.id)).toMatchObject({
        status: "running",
        threadMessageId: "message-1",
      });
      expect(chat.continued()).toEqual([chat.row(message.id)?.runId]);
      expect(chat.jobs.has(teamChatEngageJobKey(message.id))).toBe(false);
    },
  );

  it.each([
    ["mention", "running"],
    ["ambient", "observed"],
  ])("hands a deferred %s message to the agent once routing's time is up", async (kind, status) => {
    const chat = setup();
    const message = chat.record({ kind, status: "deferred" });

    await chat.teamChat.engageJob(message.id);

    expect(chat.row(message.id)?.status).toBe(status);
    expect(chat.runSends()).toHaveLength(kind === "ambient" ? 0 : 1);
    expect(chat.jobs.has(teamChatEngageJobKey(message.id))).toBe(false);
  });

  it("leaves a deferred message to the routine that woke for it", async () => {
    const chat = setup();
    const woken = chat.record({ status: "deferred" });
    chat.wakeRoutine(woken);
    const claimed = chat.record({ status: "ignored", engagementReason: "message_routine_wake" });

    await chat.teamChat.engageJob(woken.id);
    await chat.teamChat.engageJob(claimed.id);

    expect(chat.statuses(woken, claimed)).toEqual(["ignored", "ignored"]);
    expect(chat.row(woken.id)?.engagementReason).toBe("message_routine_wake");
    expect(chat.runSends()).toEqual([]);
  });

  it.each([
    [true, "running"],
    [false, "ignored"],
  ])(
    "answers a connected workspace only while it has the bot (installed: %s)",
    async (installed, status) => {
      const isInstallationActive = vi.fn(async () => installed);
      const chat = setup({
        conversation: { conversationId: "slack~install-a:C-1" },
        isInstallationActive,
      });
      const message = chat.record();

      await chat.teamChat.engageJob(message.id);

      expect(isInstallationActive).toHaveBeenCalledWith("install-a");
      expect(chat.row(message.id)?.status).toBe(status);
      expect(chat.runSends()).toHaveLength(installed ? 1 : 0);
      expect(chat.jobs.has(teamChatEngageJobKey(message.id))).toBe(false);
    },
  );

  it("does nothing for a message that no longer exists", async () => {
    const chat = setup();

    await expect(chat.teamChat.engageJob("external-gone")).resolves.toBeUndefined();

    expect(chat.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("TeamChat.ambientJob", () => {
  it.each([
    [false, null, false],
    [true, false, false],
    [false, true, true],
    [true, null, true],
  ])(
    "follows the room's ambient setting over the bot's (bot: %s, room: %s)",
    async (botEnabled, roomEnabled, judged) => {
      const chat = setup({
        bot: { teamChatAmbientEnabled: botEnabled },
        conversation: { teamChatAmbientEnabled: roomEnabled },
      });
      const message = chat.ambient();

      await chat.teamChat.ambientJob(chat.conversation.id);

      expect(chat.decide).toHaveBeenCalledTimes(judged ? 1 : 0);
      expect(chat.row(message.id)).toMatchObject({ status: "ignored", judgedAt: expect.any(Date) });
      expect(chat.runSends()).toEqual([]);
    },
  );

  it("starts one run for the message the judge picks, with the rest as its context", async () => {
    const chat = setup({
      judge: async (input) => ({
        act: true,
        reason: "Asked about a date.",
        askedByEventId: input.messages[1]?.eventId,
      }),
    });
    const morning = chat.ambient({ senderName: "Pat", content: "Morning" });
    const question = chat.ambient({ content: "When does it ship?" });
    const thanks = chat.ambient({ content: "Thanks" });
    const judged = [morning, question, thanks];

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "slack:C-1",
        channelName: "launch",
        // A room without its own instructions follows the bot's.
        rules: "Help with launches.",
        messages: judged.map((message) => ({
          eventId: message.providerEventId,
          senderId: message.senderId,
          senderName: message.senderName,
          content: message.content,
        })),
      }),
    );
    const prompt = teamChatAmbientPrompt({
      provider: "slack",
      channelId: "slack:C-1",
      channelName: "launch",
      rules: "Help with launches.",
      reason: "Asked about a date.",
      messages: judged.map(({ senderId, senderName, content }) => ({
        senderId,
        senderName,
        content,
      })),
    });
    expect(chat.statuses(morning, question, thanks)).toEqual(["ignored", "running", "ignored"]);
    expect(chat.row(question.id)?.engagementReason).toBe("Asked about a date.");
    expect(JSON.parse(chat.row(question.id)?.batchContext ?? "{}")).toEqual({
      messageIds: judged.map(({ id }) => id),
      prompt,
    });
    expect(chat.runSends()).toEqual([expect.objectContaining({ prompt })]);
    expect(chat.continued()).toEqual([chat.row(question.id)?.runId]);
    expect(chat.jobs.has(teamChatEngageJobKey(question.id))).toBe(false);
    expect(judged.every(({ id }) => chat.row(id)?.threadMessageId)).toBe(true);
  });

  it("answers the latest message when the judge names none it was shown", async () => {
    const chat = setup({ judge: async () => ({ act: true, askedByEventId: "Ev-unknown" }) });
    const first = chat.ambient();
    const latest = chat.ambient();

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.statuses(first, latest)).toEqual(["ignored", "running"]);
  });

  it.each(["declines", "is unavailable"])(
    "ignores the conversation when the judge %s",
    async (judge) => {
      const chat = setup({ judge: judge === "declines" ? undefined : null });
      const messages = [chat.ambient(), chat.ambient()];

      await chat.teamChat.ambientJob(chat.conversation.id);

      expect(chat.statuses(...messages)).toEqual(["ignored", "ignored"]);
      expect(chat.runSends()).toEqual([]);
    },
  );

  it("acts on an actionable automated sender without asking the judge", async () => {
    const chat = setup({
      conversation: {
        automatedSenderPolicies: { "deploy-bot": { name: "Deploy", mode: "action" } },
      },
    });
    const alert = chat.ambient({
      senderId: "deploy-bot",
      senderName: "Deploy Bot",
      senderIsBot: true,
      content: "Deploy failed",
    });
    const reply = chat.ambient({ content: "Looking" });

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide).not.toHaveBeenCalled();
    expect(chat.statuses(alert, reply)).toEqual(["running", "ignored"]);
    expect(chat.row(alert.id)?.engagementReason).toBe("Deploy Bot is configured as actionable.");
  });

  it("ignores automated senders with no policy or an ignore policy", async () => {
    const chat = setup({
      conversation: {
        automatedSenderPolicies: {
          "muted-bot": { name: "Muted", mode: "ignore" },
          "member-bot": { name: "Member", mode: "user" },
        },
      },
    });
    const noisy = chat.ambient({ senderId: "noisy-bot", senderIsBot: true });
    const muted = chat.ambient({ senderId: "muted-bot", senderIsBot: true });
    const member = chat.ambient({ senderId: "member-bot", senderIsBot: true });
    const person = chat.ambient();

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide.mock.calls.map(([input]) => input.messages.map((m) => m.eventId))).toEqual([
      [member.providerEventId, person.providerEventId],
    ]);
    expect(chat.statuses(noisy, muted, member, person)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
    ]);
  });

  it("decides a digest sender's messages only once its period has passed", async () => {
    const chat = setup({
      conversation: {
        automatedSenderPolicies: {
          "digest-bot": { name: "Digest", mode: "rollup", rollupHours: 6 },
        },
      },
    });
    const lastJudgedAt = new Date(Date.now() - 2 * HOUR_MS);
    const earlier = chat.record({
      kind: "ambient",
      status: "ignored",
      senderId: "digest-bot",
      senderIsBot: true,
      judgedAt: lastJudgedAt,
    });
    const digest = chat.ambient({ senderId: "digest-bot", senderIsBot: true });

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide).not.toHaveBeenCalled();
    expect(chat.row(digest.id)?.status).toBe("observed");
    expect(chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`)?.availableAt).toEqual(
      new Date(lastJudgedAt.getTime() + 6 * HOUR_MS),
    );

    chat.change(earlier.id, { judgedAt: new Date(Date.now() - 7 * HOUR_MS) });
    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide.mock.calls.map(([input]) => input.messages.map((m) => m.eventId))).toEqual([
      [digest.providerEventId],
    ]);
    expect(chat.row(digest.id)?.status).toBe("ignored");
  });

  it("decides the digest senders that are due, then the next one once its period passes", async () => {
    const chat = setup({
      conversation: {
        automatedSenderPolicies: {
          "due-bot": { name: "Due", mode: "rollup", rollupHours: 6 },
          "later-bot": { name: "Later", mode: "rollup", rollupHours: 6 },
        },
      },
    });
    const laterJudgedAt = new Date(Date.now() - 2 * HOUR_MS);
    chat.record({
      kind: "ambient",
      status: "ignored",
      senderId: "later-bot",
      senderIsBot: true,
      judgedAt: laterJudgedAt,
    });
    const due = chat.ambient({ senderId: "due-bot", senderIsBot: true });
    const later = chat.ambient({ senderId: "later-bot", senderIsBot: true });

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide.mock.calls.map(([input]) => input.messages.map((m) => m.eventId))).toEqual([
      [due.providerEventId],
    ]);
    expect(chat.statuses(due, later)).toEqual(["ignored", "observed"]);
    expect(chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`)?.availableAt).toEqual(
      new Date(laterJudgedAt.getTime() + 6 * HOUR_MS),
    );
  });

  it("decides everything else on the next pass while digests that are not due wait out of the batch", async () => {
    const chat = setup({
      conversation: {
        automatedSenderPolicies: {
          "due-bot": { name: "Due", mode: "rollup", rollupHours: 6 },
          "later-bot": { name: "Later", mode: "rollup", rollupHours: 6 },
        },
      },
    });
    const laterJudgedAt = new Date(Date.now() - 2 * HOUR_MS);
    chat.record({
      kind: "ambient",
      status: "ignored",
      senderId: "later-bot",
      senderIsBot: true,
      judgedAt: laterJudgedAt,
    });
    const digests = Array.from({ length: 200 }, (_, index) =>
      chat.ambient({ senderId: index % 2 ? "later-bot" : "due-bot", senderIsBot: true }),
    );
    const people = Array.from({ length: 20 }, () => chat.ambient());
    const next = () => chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`)?.availableAt;

    // A full batch of due digests, then the rest on the next pass, at once.
    await chat.teamChat.ambientJob(chat.conversation.id);
    expect(next()!.getTime()).toBeLessThanOrEqual(Date.now());
    await chat.teamChat.ambientJob(chat.conversation.id);

    const due = digests.filter((message) => message.senderId === "due-bot");
    const later = digests.filter((message) => message.senderId === "later-bot");
    expect(new Set(chat.statuses(...due, ...people))).toEqual(new Set(["ignored"]));
    expect(new Set(chat.statuses(...later))).toEqual(new Set(["observed"]));
    expect(chat.decide.mock.calls.at(-1)![0].messages.map((m) => m.eventId)).toEqual(
      people.map(({ providerEventId }) => providerEventId),
    );
    expect(next()).toEqual(new Date(laterJudgedAt.getTime() + 6 * HOUR_MS));
  });

  it("leaves digests that are not due out of the batch, and comes back when the first is due", async () => {
    const chat = setup({
      conversation: {
        automatedSenderPolicies: {
          "later-bot": { name: "Later", mode: "rollup", rollupHours: 6 },
        },
      },
    });
    const judgedAt = new Date(Date.now() - 2 * HOUR_MS);
    chat.record({
      kind: "ambient",
      status: "ignored",
      senderId: "later-bot",
      senderIsBot: true,
      judgedAt,
    });
    for (let index = 0; index < 101; index += 1)
      chat.ambient({ senderId: "later-bot", senderIsBot: true });

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide).not.toHaveBeenCalled();
    expect(chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`)?.availableAt).toEqual(
      new Date(judgedAt.getTime() + 6 * HOUR_MS),
    );
  });

  it("ignores a room's waiting digests at once when the bot no longer answers there", async () => {
    const chat = setup({
      conversation: {
        teamChatAmbientEnabled: false,
        automatedSenderPolicies: {
          "later-bot": { name: "Later", mode: "rollup", rollupHours: 6 },
        },
      },
    });
    chat.record({
      kind: "ambient",
      status: "ignored",
      senderId: "later-bot",
      senderIsBot: true,
      judgedAt: new Date(Date.now() - HOUR_MS),
    });
    const digest = chat.ambient({ senderId: "later-bot", senderIsBot: true });

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.row(digest.id)?.status).toBe("ignored");
    expect(chat.jobs.has(`team_chat.ambient:${chat.conversation.id}`)).toBe(false);
  });

  it("keeps a message that arrives during a decision on its own quiet window", async () => {
    let arrive = () => {};
    const chat = setup({
      conversation: {
        automatedSenderPolicies: {
          "later-bot": { name: "Later", mode: "rollup", rollupHours: 6 },
        },
      },
      judge: async () => {
        arrive();
        return { act: false, reason: "Small talk." };
      },
    });
    chat.record({
      kind: "ambient",
      status: "ignored",
      senderId: "later-bot",
      senderIsBot: true,
      judgedAt: new Date(Date.now() - HOUR_MS),
    });
    chat.ambient({ senderId: "later-bot", senderIsBot: true });
    chat.ambient();
    let late: { createdAt: Date } | undefined;
    arrive = () => {
      late ??= chat.ambient({ createdAt: new Date() });
    };

    await chat.teamChat.ambientJob(chat.conversation.id);

    // Not the waiting digest's due time, hours away.
    expect(chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`)?.availableAt).toEqual(
      new Date(late!.createdAt.getTime() + DEBOUNCE_MS),
    );
  });

  it("waits until the conversation has been quiet before deciding", async () => {
    const chat = setup();
    const createdAt = new Date(Date.now() - 1_000);
    const message = chat.ambient({ createdAt });

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide).not.toHaveBeenCalled();
    expect(chat.row(message.id)?.status).toBe("observed");
    expect(chat.jobs.get(`team_chat.ambient:${chat.conversation.id}`)?.availableAt).toEqual(
      new Date(createdAt.getTime() + DEBOUNCE_MS),
    );
  });

  it("decides a long backlog a batch at a time, judging the latest twenty", async () => {
    const chat = setup({ judge: async () => ({ act: true }) });
    const backlog = Array.from({ length: 101 }, () => chat.ambient());
    const judged = backlog.slice(80, 100);

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide.mock.calls.map(([input]) => input.messages.map((m) => m.eventId))).toEqual([
      judged.map(({ providerEventId }) => providerEventId),
    ]);
    const trigger = backlog[99]!;
    expect(chat.row(trigger.id)?.status).toBe("running");
    expect(JSON.parse(chat.row(trigger.id)?.batchContext ?? "{}").messageIds).toEqual(
      judged.map(({ id }) => id),
    );
    expect(new Set(chat.statuses(...backlog.slice(0, 99)))).toEqual(new Set(["ignored"]));
    expect(chat.row(backlog[100]!.id)?.status).toBe("observed");
    expect(chat.jobs.has(`team_chat.ambient:${chat.conversation.id}`)).toBe(true);
  });

  it("ignores a workspace that removed the bot without judging", async () => {
    const chat = setup({ conversation: { conversationId: "slack~install-a:C-1" } });
    const message = chat.ambient();

    await chat.teamChat.ambientJob(chat.conversation.id);

    expect(chat.decide).not.toHaveBeenCalled();
    expect(chat.row(message.id)?.status).toBe("ignored");
    expect(chat.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("TeamChat.sweepStalled", () => {
  it("gives stalled messages their job back and leaves waiting jobs and recent messages alone", async () => {
    const chat = setup();
    const now = new Date();
    const stalledAt = new Date(now.getTime() - 10 * 60_000);
    const received = chat.record({ status: "received", updatedAt: stalledAt });
    const deferred = chat.record({ status: "deferred", updatedAt: stalledAt });
    chat.ambient({ updatedAt: stalledAt });
    chat.record({ status: "running", runId: "run-done", updatedAt: stalledAt });
    chat.record({ status: "running", runId: "run-busy", updatedAt: stalledAt });
    const recent = chat.record({ status: "received" });
    chat.runs.set("run-done", { id: "run-done", status: "completed" });
    chat.runs.set("run-busy", { id: "run-busy", status: "running" });
    chat.jobs.delete(teamChatEngageJobKey(received.id));
    chat.jobs.delete(teamChatEngageJobKey(recent.id));
    const waiting = chat.jobs.get(teamChatEngageJobKey(deferred.id));

    await chat.teamChat.sweepStalled(now);

    const recover = {
      keepExisting: true,
      replaceLockedBefore: new Date(now.getTime() - 5 * 60_000),
    };
    expect(Object.fromEntries(chat.jobs)).toEqual({
      [teamChatEngageJobKey(received.id)]: { ...teamChatEngageJob(received.id, now), ...recover },
      [teamChatEngageJobKey(deferred.id)]: waiting,
      [`team_chat.ambient:${chat.conversation.id}`]: {
        ...teamChatAmbientJob(chat.conversation.id, now),
        ...recover,
      },
      [messagingReplyJobKey("run-done")]: { ...messagingReplyJob("run-done", now), ...recover },
    });
  });
});
