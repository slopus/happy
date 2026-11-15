import type { AgentRunRequest, AgentRuntimeEvent, BackgroundJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  partialReplyClientNonce,
  RunHistoryWriteError,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { PARTIAL_REPLY_NOTE } from "./automated-messages.js";
import { loadBotMessageContext, returnBotMessageOutcome } from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import type * as ModelVisionModule from "./model-vision.js";
import type * as RunNotificationsModule from "./run-notifications.js";
import { notifyRun } from "./run-notifications.js";
import { GROUP_UNADDRESSED_REPLY_GUIDANCE, messagesModeReplyGuidance } from "./run-replies.js";
import { PEER_NOTHING_NEW_REPLY } from "./silent-reply.js";
import { MID_TURN_PROGRESS_MIN_TURN_AGE_MS, userProgressClientNonce } from "./user-progress.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const vision = vi.hoisted(() => ({ seesImages: false }));
vi.mock("./model-vision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVisionModule>()),
  modelAcceptsImageInput: () => vision.seesImages,
}));

vi.mock("./run-notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunNotificationsModule>()),
  notifyRun: vi.fn(async () => undefined),
}));

vi.mock("./bot-messages.js", () => ({
  loadBotMessageContext: vi.fn(async () => ({
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "FYI",
    intent: "fyi",
    hop: 1,
    repliesToRequest: false,
  })),
  returnBotMessageOutcome: vi.fn(async () => undefined),
}));

async function runTurn(
  finalText: string,
  silent = true,
  narration: string | string[] = "I will check that.",
  secrets: string[] = [],
  intent: "fyi" | "request" | "question" = "fyi",
  options: {
    trigger?: string;
    doneText?: string;
    splitText?: boolean;
    priorProgressText?: string;
    runtimeEvents?: AgentRuntimeEvent[];
    runtimeFailure?: boolean;
    runtimeError?: Error;
    runtimeCancel?: boolean;
    failHelperId?: string;
    failMessageOnce?: boolean;
    history?: Array<{ id: string; seq: number; role: string; text: string; clientNonce?: string }>;
    /** When the run started; defaults to now, a turn too fresh for interim messages. */
    startedAt?: Date;
    /** Runs each scripted tool call through the executor, as a real runtime does. */
    executeTools?: boolean;
    /** A hand-written runtime, for orderings a flat event list can't express. */
    runtime?: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;
    /** Lets a test hold an event write open, to land runtime events while it waits. */
    appendGate?: (event: AppendEventInput) => Promise<void> | undefined;
    /** The computer has a screen and a page browser, and the model can see. */
    graphical?: boolean;
    replyMode?: "chat" | "messages";
    /** The run belongs to a group chat; `optional` is whether the send named nobody. */
    group?: { optional: boolean; namedWhileRunning?: boolean };
    /** The run already put a message in the chat, such as an ask card answered by its button. */
    priorBotMessage?: boolean;
    /** A messaging run from a 1:1 chat instead of a group channel. */
    directChat?: boolean;
    /** The peer message answers a request this bot sent, so the user reads the reply. */
    repliesToRequest?: boolean;
  } = {},
) {
  vi.mocked(loadBotMessageContext).mockResolvedValue({
    kind: "bot_message_received",
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "Look again",
    intent,
    hop: 1,
    repliesToRequest: options.repliesToRequest ?? false,
  });
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? (silent ? "bot_message" : "user"),
    sourceMessageId: "source-1",
    leaseFence: 0,
    groupReplyOptional: options.group?.optional ?? false,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    // A later message that names the member reaches the run while it works.
    if (options.group?.namedWhileRunning) run.groupReplyOptional = false;
    if (options.runtime) {
      yield* options.runtime(request);
      return;
    }
    if (options.runtimeEvents) {
      for (const event of options.runtimeEvents) {
        yield event;
        if (options.executeTools && event.type === "tool") {
          await request.executeTool?.(event.name, event.args, event.executionId);
        }
      }
      if (options.runtimeCancel) {
        run.status = "cancelled";
        yield { type: "done" as const };
      }
      if (options.runtimeFailure) {
        throw options.runtimeError ?? new Error("fixture runtime failure");
      }
      return;
    }
    const narrations = Array.isArray(narration) ? narration : [narration];
    for (const [index, text] of narrations.entries()) {
      for (const chunk of options.splitText ? [...text] : [text]) {
        yield { type: "text" as const, text: chunk };
      }
      yield {
        type: "tool" as const,
        name: "read_file",
        args: {},
        executionId: `call-${index + 1}`,
      };
    }
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: options.doneText ?? narrations.join("") + finalText };
  });
  const messages: { blocks: MessageBlock[] }[] = [];
  const savedEvents: AppendEventInput[] = [];
  let failMessage = options.failMessageOnce;
  const prisma = {
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        name: "Team",
        members: [
          { bot: { id: "bot-1", name: "Assistant", description: null } },
          { bot: { id: "bot-2", name: "Other", description: null } },
        ],
      })),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        replyMode: options.replyMode ?? "chat",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      update: vi.fn(async () => ({
        nextMessageSeq: messages.length + 1,
        nextEventSeq: savedEvents.length + 1,
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: options.group ? "group-1" : null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
        if (
          data.type === "thread.subagent" &&
          (data.payload as { status?: string; agentId?: string }).status === "failed" &&
          (data.payload as { agentId?: string }).agentId === options.failHelperId
        )
          throw new Error("fixture settlement unavailable");
        savedEvents.push(data);
        return { ...data, seq: savedEvents.length };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        if (failMessage) {
          failMessage = false;
          throw new Error("fixture message unavailable");
        }
        messages.push(data);
        return { ...data, id: `message-${messages.length}` };
      }),
      findMany: vi.fn(async ({ where }: { where: { runId?: string } }) =>
        !where.runId && options.history
          ? options.history.toReversed().map((message) => ({
              ...message,
              threadId: run.threadId,
              botId: message.role === "bot" ? run.botId : null,
              runId: null,
              blocks: [{ kind: "text", text: message.text }],
              createdAt: new Date("2026-10-24T08:00:00.000Z"),
              replyToMessageId: null,
              replyQuote: null,
              replyTo: null,
              clientNonce: message.clientNonce ?? null,
              steeringMessages: [],
            }))
          : where.runId === run.id && options.priorProgressText
            ? [
                {
                  blocks: [{ kind: "text", text: options.priorProgressText }],
                  clientNonce: userProgressClientNonce(run.id),
                },
              ]
            : [],
      ),
      findUnique: vi.fn(async () =>
        run.trigger === "messaging" && !options.directChat
          ? { blocks: [{ kind: "channel_message", channelId: "channel-1" }] }
          : null,
      ),
      findFirst: vi.fn(async ({ where }: { where?: { runId?: string; role?: string } } = {}) =>
        options.priorBotMessage && where?.runId === run.id && where.role === "bot"
          ? { id: "ask-1" }
          : null,
      ),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Look again",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${data.idempotencyKey}`,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const messageCount = messages.length;
      const eventCount = savedEvents.length;
      try {
        return await fn(prisma);
      } catch (error) {
        messages.length = messageCount;
        savedEvents.length = eventCount;
        throw error;
      }
    }),
  };
  const finalizeRun = vi.fn(async (_input: { blocks: MessageBlock[]; markUnread?: boolean }) => ({
    continuationRunId: null,
  }));
  const append = vi.fn(async (event: AppendEventInput) => {
    await options.appendGate?.(event);
    return appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event);
  });
  const pauseRunForInput = vi.fn(async () => ({ continuationRunId: null }));
  const jobs = { enqueue: vi.fn(async (_job: BackgroundJob) => undefined) };
  const messagingDelivery = {
    deliverRun: vi.fn(async (_runId: string, _options?: { progress?: boolean }) => undefined),
  };
  vision.seesImages = options.graphical ?? false;
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: options.graphical ?? false } }),
      observe: async () => ({
        frameId: "frame-1",
        width: 1,
        height: 1,
        image: new Uint8Array([0]),
      }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append, finalizeRun, pauseRunForInput, notify: vi.fn(async () => undefined) },
    jobs,
    messagingDelivery,
    secrets,
    ...(options.graphical
      ? {
          browser: {
            describe: () => ({ capabilities: { page: true } }),
            snapshot: async () => ({
              url: "https://example.test/",
              title: "Example",
              tree: "",
              elements: [],
            }),
          },
        }
      : {}),
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  if (!options.runtimeFailure)
    expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  return {
    finalizeRun,
    append,
    pauseRunForInput,
    messages,
    savedEvents,
    prisma,
    runtimeRun,
    run,
    messagingDelivery,
  };
}

/** Notes saved on the final reply's steps, in order. */
function stepNotes(finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) {
  return finalizeRun.mock.calls[0]![0].blocks.flatMap((block) =>
    block.kind === "steps" ? block.steps.flatMap((step) => (step.note ? [step.note] : [])) : [],
  );
}

describe.each(["routine", "reaction", "bot_message", "messaging"])(
  "held-back narration on %s runs",
  (trigger) => {
    it("restores the last non-empty narration as a normal final reply", async () => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun, append } = await runTurn(
        "",
        true,
        ["I will check that.", "  The draft is posted.  ", "   "],
        [],
        "fyi",
        { trigger },
      );
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: "completed",
          markUnread: trigger !== "bot_message",
        }),
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "The draft is posted." }],
      );
      expect(append.mock.calls.map(([event]) => event.type)).not.toContain(
        "thread.message.created",
      );
      if (trigger === "bot_message") {
        expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          "The draft is posted.",
          "result",
        );
      }
    });

    it("keeps a non-empty post-tool final", async () => {
      const { finalizeRun } = await runTurn("Checked: all clear.", true, undefined, [], "fyi", {
        trigger,
      });
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "Checked: all clear." }],
      );
    });

    it.each([
      { narration: ["I will check that.", "NO_RESPONSE"], doneText: "" },
      { narration: ["NO_RESPONSE", "The draft is posted."], doneText: "" },
      { narration: ["I will check that. NO_RESPONSE"], doneText: "" },
      { narration: ["NO_RESPONSENO_RESPONSE"], doneText: "" },
      { narration: ["The draft is posted."], doneText: "NO_RESPONSE" },
    ])("respects explicit silence in any turn: %j", async ({ narration, doneText }) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun } = await runTurn("", true, narration, [], "fyi", {
        trigger,
        doneText,
        splitText: true,
      });
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [],
      );
      expect(returnBotMessageOutcome).not.toHaveBeenCalled();
    });

    it("respects an explicit silent final", async () => {
      const { finalizeRun } = await runTurn("NO_RESPONSE", true, undefined, [], "fyi", { trigger });
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [],
      );
    });

    it("does not confuse an identifier with the silence token across chunks", async () => {
      const { finalizeRun } = await runTurn(
        "",
        true,
        "NO_RESPONSE_POLICY is configured.",
        [],
        "fyi",
        {
          trigger,
          splitText: true,
        },
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "NO_RESPONSE_POLICY is configured." }],
      );
    });
  },
);

it("redacts restored narration", async () => {
  const { finalizeRun } = await runTurn(
    "",
    true,
    "The fake-secret-value is configured.",
    ["fake-secret-value"],
    "fyi",
    { trigger: "routine" },
  );
  expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual([
    { kind: "text", text: "The [redacted] is configured." },
  ]);
});

it("does not restore narration already published as durable progress", async () => {
  const { finalizeRun } = await runTurn("", true, "The draft is posted.", [], "fyi", {
    trigger: "reaction",
    priorProgressText: "The draft is posted.",
  });
  expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual([]);
});

it("keeps background ticket runs silent", async () => {
  const { finalizeRun } = await runTurn("", true, undefined, [], "fyi", { trigger: "tickets" });
  expect(finalizeRun.mock.calls[0]![0].blocks).toEqual([]);
});

describe("held-back narration on peer requests", () => {
  it.each(["request", "question"] as const)(
    "saves the last non-empty narration as the final result for an empty %s reply",
    async (intent) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun, append } = await runTurn(
        "",
        true,
        ["I will check that.", "  The draft is posted.  ", "   "],
        [],
        intent,
      );
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "completed" }),
      );
      expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
        [{ kind: "text", text: "The draft is posted." }],
      );
      expect(append.mock.calls.map(([event]) => event.type)).not.toContain(
        "thread.message.created",
      );
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "The draft is posted.",
        "result",
      );

      // A worker stopping after finalizeRun leaves only these saved blocks for retry.
      vi.mocked(returnBotMessageOutcome).mockClear();
      const terminalRun = {
        id: "run-1",
        status: "completed",
        botId: "bot-1",
        bot: { name: "Assistant" },
      };
      const reconciler = createJobReconciler({
        prisma: {
          run: {
            findMany: vi.fn(async ({ where }: { where: { trigger?: string } }) =>
              where.trigger === "bot_message" ? [terminalRun] : [],
            ),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          routine: { findMany: vi.fn(async () => []) },
          computer: { findMany: vi.fn(async () => []) },
          messagingOutbound: { findFirst: vi.fn(async () => null) },
          message: {
            findMany: vi.fn(async () => [
              { blocks: finalizeRun.mock.calls[0]![0].blocks, clientNonce: null },
            ]),
          },
        },
        jobs: { enqueue: vi.fn() },
        events: {},
      } as unknown as Parameters<typeof createJobReconciler>[0]);
      await reconciler.reconcileOnce();
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        terminalRun,
        { id: "bot-1", name: "Assistant" },
        "The draft is posted.",
        "result",
        { forceUnread: false },
      );
    },
  );
});

describe("withheld narration on short reply-producing turns", () => {
  // A short pre-tool note now becomes the working line, so it stays in the reply only when
  // no final text follows (it used to be kept before a final as well).
  it.each(["", "Checked: all clear."])("keeps pre-tool text with final %j", async (finalText) => {
    const { finalizeRun } = await runTurn(finalText, false);
    const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toBe(finalText || "I will check that.");
  });
});

describe("text from separate assistant turns", () => {
  // The note now leaves the live text for the working line, so what streams after it is the
  // final text alone; the redactor's held-back copy of the note is not streamed again.
  it("streams the break when the redactor holds all pre-tool text", async () => {
    const narration = "I will check that.";
    const finalText = "Checked: all clear.";
    const { append } = await runTurn(finalText, false, narration, [
      "fake-secret-longer-than-the-entire-reply-for-redactor-buffering",
    ]);
    const payloads = append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress")
      .map((event) => event.payload as { text?: string; delta?: string; reset?: boolean });
    const reset = payloads.findIndex((payload) => payload.reset);
    expect(payloads[reset]).toMatchObject({ text: narration });
    const after = payloads
      .slice(reset + 1)
      .map((payload) => payload.text ?? payload.delta ?? "")
      .join("");
    expect(after).toBe(finalText);
  });
});

describe("notes that can't be posted as messages", () => {
  const finalText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
  const progress = (append: Awaited<ReturnType<typeof runTurn>>["append"]) =>
    append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress" || event.type === "agent.tool.called");
  const sentTexts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );

  it("leaves a fresh turn's note out of the reply and shows it as the working line", async () => {
    const { finalizeRun, append } = await runTurn("Checked: all clear.", false);
    expect(finalText(finalizeRun)).toBe("Checked: all clear.");
    const events = progress(append);
    const tool = events.findIndex((event) => event.type === "agent.tool.called");
    // The streamed note is replaced by the working line once the step starts.
    expect(events[tool + 1]).toMatchObject({
      type: "thread.progress",
      payload: { reset: true, text: "I will check that.", activity: true },
    });
  });

  it("keeps the last note as the reply when nothing comes after the last step", async () => {
    const { finalizeRun } = await runTurn("", false);
    expect(finalText(finalizeRun)).toBe("I will check that.");
  });

  it("posts three notes on a long turn and shows the rest only as the working line", async () => {
    const notes = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."];
    const { finalizeRun, append, messages } = await runTurn("All done.", false, notes, [], "fyi", {
      startedAt: new Date(Date.now() - 120_000),
    });
    expect(sentTexts(messages)).toEqual(["One.", "Two.", "Three."]);
    expect(finalText(finalizeRun)).toBe("All done.");
    const statuses = progress(append)
      .filter((event) => (event.payload as { reset?: boolean }).reset)
      .map((event) => (event.payload as { text: string }).text);
    expect(statuses).toEqual(["Four.", "Five.", "Six."]);
  });

  it.each([
    "Checking the totals.",
    `Opening the supplier portal ${"and checking every invoice ".repeat(4)}now.`,
    "The report is at https://example.com/reports/7",
    "Run `npm test` before merging.",
    "Totals:\n- March: 4\n- April: 7",
    "The total is $42.",
  ])("keeps text written before a step out of the reply, on that step: %j", async (narration) => {
    const { finalizeRun, append } = await runTurn("Done.", false, narration);
    expect(finalText(finalizeRun)).toBe("Done.");
    expect(stepNotes(finalizeRun)).toEqual([narration]);
    expect(progress(append).some((event) => (event.payload as { reset?: boolean }).reset)).toBe(
      true,
    );
  });

  it("keeps an answer written before the last step and replies with what follows it", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "The meeting is with Anna." },
        { type: "tool", name: "save_event", args: {}, executionId: "call-1" },
        { type: "text", text: "Saved." },
        { type: "done", text: "" },
      ],
    });
    expect(finalText(finalizeRun)).toBe("Saved.");
    expect(finalizeRun.mock.calls[0]![0].blocks).toContainEqual({
      kind: "steps",
      steps: [
        {
          label: "Save event",
          tool: "save_event",
          count: 1,
          note: "The meeting is with Anna.",
          // What the call was made with, for a later turn to replay.
          calls: [{ arguments: "{}" }],
        },
      ],
    });
  });

  it("brings every working-line note back, in order, when nothing follows the last step", async () => {
    const { finalizeRun } = await runTurn("", false, ["Paragraph A.", "Paragraph B."]);
    expect(finalText(finalizeRun)).toBe("Paragraph A.\n\nParagraph B.");
    expect(stepNotes(finalizeRun)).toEqual([]);
  });

  it("keeps a long answer written before a closing step whole", async () => {
    const answer = `Here is the summary. ${"Every supplier was checked against the order. ".repeat(15)}`;
    const { finalizeRun } = await runTurn("", false, answer);
    expect(answer.length).toBeGreaterThan(500);
    expect(finalText(finalizeRun).trim()).toBe(answer.trim());
  });

  it("never cuts long text into a message, even once messages may be posted", async () => {
    const long =
      `Here is what I found so far. ${"Each supplier matched the order totals. ".repeat(15)}`.trim();
    const { finalizeRun, messages } = await runTurn(
      "Done.",
      false,
      [long, "Saving the file."],
      [],
      "fyi",
      {
        startedAt: new Date(Date.now() - 120_000),
      },
    );
    expect(long.length).toBeGreaterThan(500);
    // The long text stays whole on its step; the short one after it is posted on its own.
    expect(sentTexts(messages)).toEqual(["Saving the file."]);
    expect(stepNotes(finalizeRun)).toEqual([long]);
    expect(finalText(finalizeRun)).toBe("Done.");
  });

  it("redacts notes like the reply", async () => {
    const { finalizeRun, append } = await runTurn("Done.", false, "The fake-secret-value is set.", [
      "fake-secret-value",
    ]);
    expect(stepNotes(finalizeRun)).toEqual(["The [redacted] is set."]);
    expect(JSON.stringify(append.mock.calls)).not.toContain("fake-secret-value");
  });

  it.each([
    ["once messages may be posted", new Date(Date.now() - 120_000)],
    ["on a fresh turn", undefined],
  ])("hides the rest of a secret split across two steps, %s", async (_, startedAt) => {
    const { finalizeRun, append, messages } = await runTurn(
      "Done.",
      false,
      ["The token is hunter", " abcxyz saved."],
      ["hunter abcxyz"],
      "fyi",
      { startedAt },
    );
    const shown = JSON.stringify([append.mock.calls, messages, stepNotes(finalizeRun)]);
    expect(shown).not.toContain("abcxyz");
    expect(shown).toContain("[redacted] saved.");
  });

  it("keeps tool status lines from replacing the note until the bot writes again", async () => {
    const { append } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Checking the totals." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "progress", text: "Reading totals.csv", activity: true },
        { type: "text", text: "They match." },
        { type: "done", text: "Checking the totals.They match." },
      ],
    });
    const lines = progress(append)
      .filter((event) => event.type === "thread.progress")
      .map((event) => event.payload as { text?: string; activity?: boolean });
    expect(lines.some((line) => line.text === "Reading totals.csv")).toBe(false);
    expect(lines.at(-1)).toMatchObject({ text: "They match." });
  });

  it("shows the next step's status line once a step starts without a note of its own", async () => {
    const { append } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Checking the totals." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "tool", name: "read_file", args: {}, executionId: "call-2" },
        { type: "progress", text: "Reading march.csv", activity: true },
        { type: "text", text: "They match." },
        { type: "done", text: "Checking the totals.They match." },
      ],
    });
    // The live view drops the note when the next step starts, so that step's status shows.
    const lines = progress(append)
      .filter((event) => event.type === "thread.progress")
      .map((event) => event.payload as { text?: string; activity?: boolean });
    expect(lines).toContainEqual({ text: "Reading march.csv", activity: true });
  });

  it("tells the bot whether a message_user update it can't post can be retried", async () => {
    const update = async ({
      startedAt,
      earlier = [],
      steerAt = -1,
    }: {
      startedAt?: Date;
      earlier?: string[];
      steerAt?: number;
    } = {}) => {
      let result: unknown;
      const { messages } = await runTurn("", false, undefined, [], "fyi", {
        startedAt,
        runtime: async function* (request) {
          for (const [index, message] of [...earlier, "On it, checking now."].entries()) {
            const executionId = `call-${index}`;
            if (index === steerAt) yield { type: "steered", fromRunUser: true };
            yield { type: "tool", name: "message_user", args: { message }, executionId };
            result = await request.executeTool!("message_user", { message }, executionId);
          }
          yield { type: "text", text: "Done." };
          yield { type: "done", text: "" };
        },
      });
      return { result, sent: sentTexts(messages) };
    };
    const notYet = {
      ok: true,
      note: `This update was not posted because the turn just started. Keep working and put anything the person needs in your final reply. Once the turn has run ${MID_TURN_PROGRESS_MIN_TURN_AGE_MS / 1000} seconds, a later update can be posted.`,
    };
    const stop = {
      ok: true,
      note: "This update was not posted. The chat already has enough interim messages for this run. Do not send more progress updates — keep working and put everything in your final reply.",
    };
    expect(await update()).toEqual({ result: notYet, sent: [] });

    const earlier = ["One.", "Two.", "Three."];
    const longTurn = new Date(Date.now() - 120_000);
    expect(await update({ startedAt: longTurn, earlier })).toEqual({ result: stop, sent: earlier });
    // The person's message restarts the budget, so after the answer the turn is fresh again.
    expect(
      await update({ startedAt: longTurn, earlier: [...earlier, "Yes, still on it."], steerAt: 3 }),
    ).toEqual({ result: notYet, sent: [...earlier, "Yes, still on it."] });
  });

  it("posts one heads-up at once once a fresh turn calls a browser or desktop tool", async () => {
    const sent = async (trigger: string, step: string, graphical = true) => {
      const { messages } = await runTurn("", false, undefined, [], "fyi", {
        trigger,
        graphical,
        runtime: async function* (request) {
          await request.executeTool!(step, {}, "call-0").catch(() => undefined);
          for (const [index, message] of [
            "This will take a few minutes.",
            "Still going.",
          ].entries())
            await request.executeTool!("message_user", { message }, `call-${index + 1}`);
          yield { type: "text", text: "Done." };
          yield { type: "done", text: "" };
        },
      });
      return sentTexts(messages);
    };
    const headsUp = ["This will take a few minutes."];
    expect(await sent("user", "computer_observe")).toEqual(headsUp);
    expect(await sent("messaging", "browser_snapshot")).toEqual(headsUp);
    // Other steps, tools this computer lacks, and runs nobody is waiting on keep the
    // fresh-turn rule.
    expect(await sent("user", "shell")).toEqual([]);
    expect(await sent("user", "browser_snapshot", false)).toEqual([]);
    for (const trigger of ["routine", "webhook", "reaction", "bot_message"])
      expect(await sent(trigger, "browser_snapshot")).toEqual([]);
  });
});

describe("interim messages in a chat app", () => {
  const sentOn = (delivery: Awaited<ReturnType<typeof runTurn>>["messagingDelivery"]) =>
    delivery.deliverRun.mock.calls;
  const texts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );

  it("sends each message_user on once it is posted, not when the run ends", async () => {
    const run = async (options: { trigger: string; directChat?: boolean }) => {
      const turn = await runTurn("", false, undefined, [], "fyi", {
        ...options,
        replyMode: "messages",
        runtime: async function* (request) {
          for (const [index, message] of ["Checking the logs.", "Still looking."].entries())
            await request.executeTool!("message_user", { message }, `call-${index + 1}`);
          yield { type: "text", text: "Found it." };
          yield { type: "done", text: "" };
        },
      });
      return { messages: texts(turn.messages), sends: sentOn(turn.messagingDelivery) };
    };
    const chat = await run({ trigger: "messaging", directChat: true });
    expect(chat.messages).toEqual(["Checking the logs.", "Still looking."]);
    expect(chat.sends).toEqual(Array(2).fill(["run-1", { progress: true }]));
    // A group run posts once, when it ends; an in-app run has no chat app to reach.
    const group = await run({ trigger: "messaging" });
    expect(group).toEqual({ messages: chat.messages, sends: [] });
    expect((await run({ trigger: "user" })).sends).toEqual([]);
  });

  it("sends a note posted on a long turn on at once", async () => {
    const { messages, messagingDelivery } = await runTurn(
      "All done.",
      false,
      ["Opening the report."],
      [],
      "fyi",
      { trigger: "messaging", directChat: true, startedAt: new Date(Date.now() - 120_000) },
    );
    expect(texts(messages)).toEqual(["Opening the report."]);
    expect(sentOn(messagingDelivery)).toEqual([["run-1", { progress: true }]]);
  });
});

describe("messages mode", () => {
  const messagesMode = { replyMode: "messages" as const };
  const finalText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
  const sentTexts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );

  it("tells the model its working text is private and only message_user reaches the person", async () => {
    const chat = await runTurn("Done.", false);
    const messages = await runTurn("Done.", false, undefined, [], "fyi", messagesMode);
    const instructions = (result: typeof chat) => result.runtimeRun.mock.calls[0]![0].instructions;
    expect(instructions(messages)).toContain(messagesModeReplyGuidance());
    expect(instructions(chat)).not.toContain(messagesModeReplyGuidance());
  });

  it("keeps text before and between steps on the steps, even on a long turn", async () => {
    const { finalizeRun, messages } = await runTurn(
      "All done.",
      false,
      ["Opening the report.", "Totals: March 4, April 7."],
      [],
      "fyi",
      { ...messagesMode, startedAt: new Date(Date.now() - 120_000) },
    );
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe("All done.");
    expect(stepNotes(finalizeRun)).toEqual(["Opening the report.", "Totals: March 4, April 7."]);
  });

  it("posts every message_user at once, on a fresh turn and past three", async () => {
    const updates = ["Starting.", "Found it.", "Checking totals.", "Almost there."];
    const { finalizeRun, messages } = await runTurn("", false, undefined, [], "fyi", {
      ...messagesMode,
      runtime: async function* (request) {
        for (const [index, message] of updates.entries())
          await request.executeTool!("message_user", { message }, `call-${index + 1}`);
        yield { type: "text", text: "Here is the answer." };
        yield { type: "done", text: "" };
      },
    });
    expect(sentTexts(messages)).toEqual(updates);
    expect(finalText(finalizeRun)).toBe("Here is the answer.");
  });

  it("shows the latest text as the reply when nothing follows the last step", async () => {
    const { finalizeRun } = await runTurn(
      "",
      false,
      ["Checking.", "The draft is posted."],
      [],
      "fyi",
      messagesMode,
    );
    expect(finalText(finalizeRun)).toBe("The draft is posted.");
    expect(stepNotes(finalizeRun)).toEqual(["Checking."]);
  });

  it("keeps text written before the person's message out of the reply", async () => {
    const { finalizeRun, messages } = await runTurn("", false, undefined, [], "fyi", {
      ...messagesMode,
      runtimeEvents: [
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Totals look off." },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Yes, the March total is 4." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe("Yes, the March total is 4.");
    expect(stepNotes(finalizeRun)).toEqual(["Totals look off."]);
  });

  it("adds no reply after a message_user that ends the turn", async () => {
    const { finalizeRun, messages } = await runTurn("", false, undefined, [], "fyi", {
      ...messagesMode,
      runtime: async function* (request) {
        yield { type: "text", text: "Found it, telling them now." };
        yield { type: "tool", name: "message_user", args: {}, executionId: "call-1" };
        await request.executeTool!("message_user", { message: "The total is 4." }, "call-1");
        yield { type: "done", text: "" };
      },
    });
    expect(sentTexts(messages)).toEqual(["The total is 4."]);
    expect(finalText(finalizeRun)).toBe("");
  });

  it("stays silent when the model chose silence", async () => {
    const { finalizeRun } = await runTurn("", false, ["Checking.", "NO_RESPONSE"], [], "fyi", {
      ...messagesMode,
      doneText: "",
    });
    expect(finalText(finalizeRun)).toBe("");
  });

  it.each(["routine", "reaction", "bot_message", "tickets"])(
    "leaves %s runs as they are",
    async (trigger) => {
      const turn = (replyMode: "chat" | "messages") =>
        runTurn("", true, ["I will check that.", "The draft is posted."], [], "fyi", {
          trigger,
          replyMode,
          startedAt: new Date(Date.now() - 120_000),
        });
      const chat = await turn("chat");
      const messages = await turn("messages");
      expect(messages.finalizeRun.mock.calls[0]![0].blocks).toEqual(
        chat.finalizeRun.mock.calls[0]![0].blocks,
      );
      expect(sentTexts(messages.messages)).toEqual(sentTexts(chat.messages));
      expect(messages.runtimeRun.mock.calls[0]![0].instructions).not.toContain(
        messagesModeReplyGuidance(),
      );
    },
  );
});

describe("text written before a question", () => {
  const sentTexts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );
  const ask = (text: string): AgentRuntimeEvent[] => [
    { type: "text", text },
    { type: "tool", name: "ask_user", args: {}, executionId: "ask-1" },
    { type: "ask", text: "Which order?", actions: [{ id: "choice-1", label: "Art first" }] },
  ];

  it("posts a long answer whole, ahead of the question, on a fresh turn", async () => {
    const answer =
      `Here is the estimate. ${"Each level takes one session to build. ".repeat(15)}`.trim();
    const { messages, pauseRunForInput, prisma, finalizeRun } = await runTurn(
      "",
      false,
      undefined,
      [],
      "fyi",
      { runtimeEvents: ask(answer) },
    );
    expect(answer.length).toBeGreaterThan(500);
    expect(sentTexts(messages)).toEqual([answer]);
    expect(pauseRunForInput).toHaveBeenCalledOnce();
    expect(pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [expect.objectContaining({ kind: "ask", text: "Which order?" })],
      }),
    );
    expect(prisma.message.create.mock.invocationCallOrder[0]).toBeLessThan(
      pauseRunForInput.mock.invocationCallOrder[0]!,
    );
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("brings back the notes held on earlier steps, in order", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "I looked at the level files." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        ...ask("Three pyramids are left."),
      ],
    });
    expect(sentTexts(messages)).toEqual([
      "I looked at the level files.\n\nThree pyramids are left.",
    ]);
  });

  it("posts only the latest text in messages mode", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      replyMode: "messages",
      runtimeEvents: [
        { type: "text", text: "I looked at the level files." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        ...ask("Three pyramids are left."),
      ],
    });
    expect(sentTexts(messages)).toEqual(["Three pyramids are left."]);
  });

  it("redacts the text like the reply", async () => {
    const { messages } = await runTurn("", false, undefined, ["fake-secret-value"], "fyi", {
      runtimeEvents: ask("The fake-secret-value is set."),
    });
    expect(sentTexts(messages)).toEqual(["The [redacted] is set."]);
  });

  it("posts nothing extra when the bot asks with no text before the question", async () => {
    const { messages, pauseRunForInput } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [
        { type: "tool", name: "ask_user", args: {}, executionId: "ask-1" },
        { type: "ask", text: "Which order?" },
      ],
    });
    expect(sentTexts(messages)).toEqual([]);
    expect(pauseRunForInput).toHaveBeenCalledOnce();
  });

  it("shows the content being decided on as plain text, redacted and capped", async () => {
    const detail = `To: person@example.test\nThe token is fake-secret-value.\n${"body ".repeat(1_200)}`;
    const { pauseRunForInput } = await runTurn("", false, "", ["fake-secret-value"], "fyi", {
      runtimeEvents: [
        { type: "tool", name: "ask_user", args: {}, executionId: "ask-1" },
        {
          type: "ask",
          text: "Send this email?",
          detail,
          actions: [
            { id: "choice-1", label: "Send it" },
            { id: "choice-2", label: "Show me first" },
          ],
        },
      ],
    });
    expect(pauseRunForInput).toHaveBeenCalledOnce();
    const blocks = (pauseRunForInput.mock.calls[0] as unknown as [{ blocks: MessageBlock[] }])[0]
      .blocks;
    const ask = blocks.find((block) => block.kind === "ask");
    expect(ask).toMatchObject({ text: "Send this email?", detailFormat: "text" });
    if (ask?.kind !== "ask") throw new Error("expected ask block");
    expect(ask.detail).toContain("To: person@example.test");
    expect(ask.detail).toContain("The token is [redacted].");
    expect(ask.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("keeps a detail-less ask block exactly as it was", async () => {
    const { pauseRunForInput } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [
        { type: "tool", name: "ask_user", args: {}, executionId: "ask-1" },
        { type: "ask", text: "Which order?", actions: [{ id: "choice-1", label: "Art first" }] },
      ],
    });
    expect(pauseRunForInput).toHaveBeenCalledOnce();
    expect(pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          {
            kind: "ask",
            text: "Which order?",
            detail: undefined,
            status: "pending",
            actions: [{ id: "choice-1", label: "Art first" }],
          },
        ],
      }),
    );
  });

  it("posts the text on runs that may finish silently", async () => {
    const { messages, pauseRunForInput } = await runTurn("", false, undefined, [], "fyi", {
      trigger: "reaction",
      runtimeEvents: ask("Three pyramids are left."),
    });
    expect(sentTexts(messages)).toEqual(["Three pyramids are left."]);
    expect(pauseRunForInput).toHaveBeenCalledOnce();
  });

  it("keeps the text out of chat on runs that hold narration back", async () => {
    const { messages, pauseRunForInput } = await runTurn("", true, undefined, [], "fyi", {
      runtimeEvents: ask("Three pyramids are left."),
    });
    expect(sentTexts(messages)).toEqual([]);
    expect(pauseRunForInput).toHaveBeenCalledOnce();
  });
});

describe("a message from the person while the bot works", () => {
  const sentTexts = (messages: Awaited<ReturnType<typeof runTurn>>["messages"]) =>
    messages.map((message) =>
      message.blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    );
  const finalText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");

  it("posts what came before it on its own and lets the next note answer at once", async () => {
    const { finalizeRun, messages } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Found three suppliers so far." },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Yes, I'm still on it." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Checking the fourth." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-2" },
        { type: "text", text: "All four checked." },
        { type: "done", text: "" },
      ],
    });
    // The turn is still fresh, yet the answer to the person is a message, then the budget
    // waits again: the next note stays a working line.
    expect(sentTexts(messages)).toEqual(["Found three suppliers so far.", "Yes, I'm still on it."]);
    expect(finalText(finalizeRun)).toBe("All four checked.");
  });

  it("posts a message_user answer to the person at once, even on a fresh turn", async () => {
    const answer = async (steered: boolean) =>
      (
        await runTurn("", false, undefined, [], "fyi", {
          executeTools: true,
          runtimeEvents: [
            ...(steered ? [{ type: "steered" as const, fromRunUser: true }] : []),
            {
              type: "tool",
              name: "message_user",
              args: { message: "Yes, still on it." },
              executionId: "call-1",
            },
            { type: "text", text: "All four checked." },
            { type: "done", text: "" },
          ],
        })
      ).messages;
    expect(sentTexts(await answer(true))).toEqual(["Yes, still on it."]);
    // Without the person's message the turn is too fresh for an interim message.
    expect(sentTexts(await answer(false))).toEqual([]);
  });

  it("keeps a plain answer with no step after it in the reply", async () => {
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Yes, still on it." },
        { type: "turn" },
        { type: "text", text: "All four checked." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe("Yes, still on it.\n\nAll four checked.");
  });

  it("keeps a long answer to the person in the reply, whole", async () => {
    const summary = `Full summary: ${"Supplier totals match the order. ".repeat(60)}`.trim();
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: summary },
        { type: "turn" },
        { type: "text", text: "That's everything." },
        { type: "done", text: "" },
      ],
    });
    expect(summary.length).toBeGreaterThan(1_900);
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe(`${summary}\n\nThat's everything.`);
  });

  it("keeps the immediate answer for message_user when the bot writes something before it", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      executeTools: true,
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Let me answer that." },
        {
          type: "tool",
          name: "message_user",
          args: { message: "Yes, still on it." },
          executionId: "call-1",
        },
        { type: "text", text: "All four checked." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["Yes, still on it."]);
  });

  it("keeps a long answer to the person whole on the step that follows it", async () => {
    const summary = `Full summary: ${"Supplier totals match the order. ".repeat(20)}`.trim();
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: summary },
        { type: "turn" },
        { type: "text", text: "Checking one more file." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    expect(summary.length).toBeGreaterThan(500);
    expect(sentTexts(messages)).toEqual([]);
    expect(stepNotes(finalizeRun)).toEqual([`${summary}\n\nChecking one more file.`]);
    expect(finalText(finalizeRun)).toBe("Done.");
  });

  it("keeps an allowance granted by a mid-task message that lands during message_user", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const statusWriting = new Promise<void>((resolve) => (reached = resolve));
    let holding = true;
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      // The status line for the text before message_user is held open, so the person's
      // message is handled while message_user is still running.
      appendGate: (event) => {
        if (!holding || !(event.payload as { reset?: boolean } | undefined)?.reset) return;
        reached();
        return gate;
      },
      runtime: async function* (request) {
        yield { type: "text", text: "Let me check." };
        const call = request.executeTool!("message_user", { message: "Working on it." }, "call-1");
        await statusWriting;
        yield { type: "steered", fromRunUser: true };
        holding = false;
        release();
        await call;
        yield { type: "text", text: "Yes, still on it." };
        yield { type: "tool", name: "read_file", args: {}, executionId: "call-2" };
        yield { type: "text", text: "Done." };
        yield { type: "done", text: "" };
      },
    });
    // The allowance the person's message granted mid-call isn't reset when the call ends: the
    // turn is still fresh, yet the message_user update is posted.
    expect(sentTexts(messages)).toEqual(["Working on it."]);
  });

  it("keeps messages from webhooks, external chats and other members on the normal budget", async () => {
    const steps = ["One.", "Two.", "Three.", "Four.", "Five."].flatMap((text, index) => [
      { type: "steered" as const, fromRunUser: false },
      { type: "text" as const, text },
      { type: "tool" as const, name: "read_file", args: {}, executionId: `call-${index}` },
    ]);
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      startedAt: new Date(Date.now() - 120_000),
      runtimeEvents: [...steps, { type: "text", text: "Done." }, { type: "done", text: "" }],
    });
    expect(sentTexts(messages)).toEqual(["One.", "Two.", "Three."]);
  });

  it("answers every message from the person, but restarts the budget at most once a minute", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Reply one." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Still checking." },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Reply two." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-2" },
        { type: "text", text: "Checking the last one." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-3" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    // Text that can't be posted when the next message arrives stays in the reply and goes out
    // with that answer; the unprompted note after it stays a working line on the fresh turn.
    expect(sentTexts(messages)).toEqual(["Reply one.", "Still checking.\n\nReply two."]);
  });

  it("posts what it wrote after one message on that message's allowance when another arrives", async () => {
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Reply one." },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Reply two." },
        { type: "tool", name: "read_file", args: {}, executionId: "call-1" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["Reply one.", "Reply two."]);
  });

  it("keeps an answer it can't post yet in the reply when another message arrives", async () => {
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      executeTools: true,
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        {
          type: "tool",
          name: "message_user",
          args: { message: "On it." },
          executionId: "call-1",
        },
        { type: "text", text: "Here is the full answer to your first question." },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "And the answer to the second." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["On it."]);
    expect(finalText(finalizeRun)).toBe(
      "Here is the full answer to your first question.\n\nAnd the answer to the second.",
    );
  });

  it("keeps a long answer in the reply, whole, when another message arrives", async () => {
    const summary = `Full summary: ${"Supplier totals match the order. ".repeat(60)}`.trim();
    const { messages, finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "steered", fromRunUser: true },
        { type: "text", text: summary },
        { type: "steered", fromRunUser: true },
        { type: "text", text: "And the answer to the second." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual([]);
    expect(finalText(finalizeRun)).toBe(`${summary}\n\nAnd the answer to the second.`);
  });

  it.each([
    ["the next message", { type: "steered" as const, fromRunUser: true }],
    [
      "the next step",
      { type: "tool" as const, name: "read_file", args: {}, executionId: "call-1" },
    ],
  ])("hides the rest of a secret split across an answer and %s", async (_, next) => {
    const { append, messages, finalizeRun } = await runTurn(
      "",
      false,
      undefined,
      ["hunter abcxyz"],
      "fyi",
      {
        runtimeEvents: [
          { type: "text", text: "The token is hunter" },
          { type: "steered", fromRunUser: true },
          { type: "text", text: " abcxyz saved." },
          next,
          { type: "text", text: "Done." },
          { type: "done", text: "" },
        ],
      },
    );
    expect(sentTexts(messages)).toEqual(["The token is hunter", "[redacted] saved."]);
    expect(JSON.stringify([append.mock.calls, messages, finalizeRun.mock.calls])).not.toContain(
      "abcxyz",
    );
  });

  it("answers a fourth message minutes apart without restarting the budget a fourth time", async () => {
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const { messages } = await runTurn("", false, undefined, [], "fyi", {
        runtime: async function* (request) {
          const send = (message: string) =>
            request.executeTool!("message_user", { message }, message);
          for (const index of [1, 2, 3, 4]) {
            clock += 120_000;
            yield { type: "steered", fromRunUser: true };
            await send(`Answer ${index}.`);
            clock += 61_000;
            await send(`Update ${index}a.`);
            await send(`Update ${index}b.`);
          }
          yield { type: "text", text: "Done." };
          yield { type: "done", text: "" };
        },
      });
      // Each of the first three messages restarts the budget: its answer plus two updates. The
      // fourth is answered, but its updates stay within the exhausted budget.
      expect(sentTexts(messages)).toEqual([
        ...[1, 2, 3].flatMap((index) => [
          `Answer ${index}.`,
          `Update ${index}a.`,
          `Update ${index}b.`,
        ]),
        "Answer 4.",
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it.each(["user", "messaging"])(
    "posts a message_user answer to each of four messages in one minute (%s)",
    async (trigger) => {
      const steps = [1, 2, 3, 4].flatMap((index) => [
        { type: "steered" as const, fromRunUser: true },
        {
          type: "tool" as const,
          name: "message_user",
          args: { message: `Answer ${index}.` },
          executionId: `answer-${index}`,
        },
        {
          type: "tool" as const,
          name: "message_user",
          args: { message: `Update ${index}.` },
          executionId: `update-${index}`,
        },
      ]);
      const { messages } = await runTurn("", false, undefined, [], "fyi", {
        trigger,
        executeTools: true,
        runtimeEvents: [...steps, { type: "text", text: "Done." }, { type: "done", text: "" }],
      });
      // Updates nobody asked for keep the 60-second wait; every answer is posted.
      expect(sentTexts(messages)).toEqual(["Answer 1.", "Answer 2.", "Answer 3.", "Answer 4."]);
    },
  );

  it("starts the interim-message budget again after it", async () => {
    const notes = ["One.", "Two.", "Three.", "Four."].flatMap((text, index) => [
      { type: "text" as const, text },
      { type: "tool" as const, name: "read_file", args: {}, executionId: `before-${index}` },
    ]);
    const { messages } = await runTurn("", false, undefined, [], "fyi", {
      startedAt: new Date(Date.now() - 120_000),
      runtimeEvents: [
        ...notes,
        { type: "steered", fromRunUser: true },
        { type: "text", text: "Switching to the new list." },
        { type: "tool", name: "read_file", args: {}, executionId: "after-1" },
        { type: "text", text: "Done." },
        { type: "done", text: "" },
      ],
    });
    expect(sentTexts(messages)).toEqual(["One.", "Two.", "Three.", "Switching to the new list."]);
  });
});

describe("text from assistant messages with no tool call between them", () => {
  it("keeps a paragraph break and leaves each message's deltas as streamed", async () => {
    const { finalizeRun, append } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Do" },
        { type: "text", text: "ne." },
        { type: "turn" },
        { type: "text", text: "That" },
        { type: "text", text: "'s it." },
        { type: "done", text: "Done.That's it." },
      ],
    });
    const saved = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    const streamed = append.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "thread.progress")
      .map((event) => {
        const payload = event.payload as { text?: string; delta?: string };
        return payload.text ?? payload.delta ?? "";
      })
      .join("");
    expect(saved).toBe("Done.\n\nThat's it.");
    expect(streamed).toBe("Done.\n\nThat's it.");
  });

  it("adds nothing when the next message already starts on a new line", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Done." },
        { type: "turn" },
        { type: "text", text: "\nThat's it." },
        { type: "done", text: "Done.\nThat's it." },
      ],
    });
    const saved = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(saved).toBe("Done.\nThat's it.");
  });
});

describe("a stray NO_RESPONSE on runs that must reply", () => {
  const savedText = (finalizeRun: Awaited<ReturnType<typeof runTurn>>["finalizeRun"]) =>
    finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");

  it("drops the sentinel a late follow-up message adds after a user run's final answer", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "Saved the PDF: /tmp/report.pdf" },
        { type: "turn" },
        { type: "text", text: "NO_" },
        { type: "text", text: "RESPONSE" },
        { type: "done", text: "Saved the PDF: /tmp/report.pdfNO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("Saved the PDF: /tmp/report.pdf");
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it("drops repeated sentinels glued onto a user run's final answer", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "The report is ready." },
        { type: "text", text: "NO_RESPONSENO_RESPONSENO_RESPONSE" },
        { type: "done", text: "The report is ready.NO_RESPONSENO_RESPONSENO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("The report is ready.");
  });

  it.each(["request", "question"] as const)(
    "tells the asker there is nothing new instead of relaying a bare sentinel (%s)",
    async (intent) => {
      vi.mocked(returnBotMessageOutcome).mockClear();
      const { finalizeRun } = await runTurn("NO_RESPONSE", true, undefined, [], intent, {
        trigger: "bot_message",
      });
      expect(savedText(finalizeRun)).toBe(PEER_NOTHING_NEW_REPLY);
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        PEER_NOTHING_NEW_REPLY,
        "result",
      );
    },
  );

  it("returns a peer request's result without the sentinel", async () => {
    vi.mocked(returnBotMessageOutcome).mockClear();
    const { finalizeRun } = await runTurn("", true, undefined, [], "request", {
      trigger: "bot_message",
      runtimeEvents: [
        { type: "text", text: "Done." },
        { type: "turn" },
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "Done.NO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("Done.");
    expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "Done.",
      "result",
    );
  });

  it.each(["Set the reply token to NO_RESPONSE and restart.", "NO_RESPONSE_POLICY is configured."])(
    "keeps the sentinel when it is part of the reply: %s",
    async (reply) => {
      const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
        runtimeEvents: [
          { type: "text", text: reply },
          { type: "done", text: reply },
        ],
      });
      expect(savedText(finalizeRun)).toBe(reply);
    },
  );

  it("leaves a sentinel-only user reply as it is today", async () => {
    const { finalizeRun } = await runTurn("", false, undefined, [], "fyi", {
      runtimeEvents: [
        { type: "text", text: "NO_RESPONSE" },
        { type: "done", text: "NO_RESPONSE" },
      ],
    });
    expect(savedText(finalizeRun)).toBe("NO_RESPONSE");
  });
});

describe("helper settlement", () => {
  const helper: AgentRuntimeEvent = {
    type: "subagent",
    agentId: "helper",
    name: "Helper",
    task: "Check",
    status: "running",
  };
  it.each(["pause", "finish", "failure", "cancel"])(
    "persists stopped helpers on %s",
    async (exit) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 2_000));
      const result = await runTurn("", false, "", [], "fyi", {
        runtimeEvents: [
          helper,
          ...(exit === "pause" ? [{ type: "ask" as const, text: "Continue?" }] : []),
        ],
        runtimeFailure: exit === "failure",
        runtimeCancel: exit === "cancel",
      }).finally(() => clock.mockRestore());
      const { savedEvents, messages, pauseRunForInput, finalizeRun } = result;
      const index = savedEvents.findIndex(
        (event) =>
          event.type === "thread.subagent" &&
          (event.payload as { status: string }).status === "failed",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(savedEvents[index]?.payload).toMatchObject({
        agentId: "helper",
        name: "Helper",
        task: "Check",
        status: "failed",
        result: "stopped",
      });
      expect(
        messages.flatMap((message) => message.blocks).filter((block) => block.kind === "subagent"),
      ).toEqual([
        expect.objectContaining({ agentId: "helper", status: "failed", result: "stopped" }),
      ]);
      if (exit === "pause") {
        expect(pauseRunForInput).toHaveBeenCalledOnce();
        expect(result.prisma.event.create.mock.invocationCallOrder[index]).toBeLessThan(
          pauseRunForInput.mock.invocationCallOrder[0]!,
        );
      } else if (exit !== "cancel") {
        expect(finalizeRun).toHaveBeenCalledOnce();
        expect(result.prisma.event.create.mock.invocationCallOrder[index]).toBeLessThan(
          finalizeRun.mock.invocationCallOrder[0]!,
        );
      }
    },
  );
  it("keeps ordinary history writes guarded after cancellation", async () => {
    const { prisma, append } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [helper],
      runtimeCancel: true,
    });
    await expect(
      append({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        type: "thread.subagent",
        payload: helper,
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await expect(
      createThreadMessageInTransaction(prisma as unknown as Prisma.TransactionClient, {
        threadId: "thread-1",
        runId: "run-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Late response" }],
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
  });
});

describe("helper cleanup recovery", () => {
  const helpers: AgentRuntimeEvent[] = ["unavailable", "available"].map((agentId) => ({
    type: "subagent",
    agentId,
    name: "Helper",
    task: "Check",
    status: "running",
  }));
  it("continues cleanup after a helper write fails and never rejects cancellation", async () => {
    const result = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: helpers,
      runtimeCancel: true,
      failHelperId: "unavailable",
    });
    expect(result.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ kind: "subagent", agentId: "available", status: "failed" }),
    );
  });
  it("retries a failed message atomically without duplicate stopped blocks", async () => {
    const result = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: helpers.slice(0, 1),
      failMessageOnce: true,
    });
    expect(
      result.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.kind === "subagent"),
    ).toHaveLength(1);
    expect(
      result.savedEvents.filter(
        (event) =>
          event.type === "thread.subagent" &&
          (event.payload as { status: string }).status === "failed",
      ),
    ).toHaveLength(1);
  });
});

describe("a run that fails partway through its reply", () => {
  const cut: AgentRuntimeEvent[] = [
    { type: "text", text: "Part one. " },
    { type: "text", text: "Part tw" },
  ];

  it("keeps the reply text the user saw as one message above the error", async () => {
    const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: cut,
      runtimeFailure: true,
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "failed",
        error: "fixture runtime failure",
        partialReply: [{ kind: "text", text: "Part one. Part tw" }],
      }),
    );
  });

  it("keeps the text with secrets redacted", async () => {
    const { finalizeRun } = await runTurn("", false, "", ["canary-secret-4471"], "fyi", {
      runtimeEvents: [{ type: "text", text: "The key is canary-secret-4471 and the" }],
      runtimeFailure: true,
    });
    const [input] = finalizeRun.mock.calls[0] as unknown as [{ partialReply: MessageBlock[] }];
    expect(JSON.stringify(input.partialReply)).not.toContain("canary-secret-4471");
    expect(input.partialReply).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("The key is") }),
    ]);
  });

  it.each(["routine", "bot_message"])(
    "keeps nothing on a %s run, which shows no reply live",
    async (trigger) => {
      const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
        trigger,
        runtimeEvents: cut,
        runtimeFailure: true,
      });
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.not.objectContaining({ partialReply: expect.anything() }),
      );
    },
  );

  it("keeps nothing when no reply text streamed", async () => {
    const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [],
      runtimeFailure: true,
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ partialReply: expect.anything() }),
    );
  });

  it("shows no database text, server path or stack in the run error", async () => {
    const database = Object.assign(
      new Error(
        [
          "",
          "Invalid `tx.run.findUnique()` invocation in",
          "/app/packages/db/src/events.ts:1604:40",
          "",
          "  1603 const run = await tx.run.findUnique({",
          "Transaction API error: Transaction already closed.",
        ].join("\n"),
      ),
      { name: "PrismaClientKnownRequestError" },
    );
    const { finalizeRun } = await runTurn("", false, "", [], "fyi", {
      runtimeEvents: [],
      runtimeFailure: true,
      runtimeError: database,
    });
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", error: "Internal server error" }),
    );
  });
});

describe("a kept partial reply in later history", () => {
  it("tells the model that reply was cut off, without changing other replies", async () => {
    const { runtimeRun } = await runTurn("Done.", false, [], [], "fyi", {
      history: [
        { id: "m1", seq: 1, role: "user", text: "Write the plan" },
        {
          id: "m2",
          seq: 2,
          role: "bot",
          text: "Part one. Part tw",
          clientNonce: partialReplyClientNonce("run-0"),
        },
        { id: "m3", seq: 3, role: "user", text: "continue" },
        { id: "m4", seq: 4, role: "bot", text: "A whole reply." },
      ],
    });
    const history = runtimeRun.mock.calls[0]?.[0].history ?? [];
    const content = (id: string) => history.find((entry) => entry.id === id)?.content;
    expect(content("m2")).toBe(`Part one. Part tw\n\n${PARTIAL_REPLY_NOTE}`);
    expect(content("m4")).toBe("A whole reply.");
  });
});

describe("public coarse thinking lifecycle", () => {
  it("coalesces explicit boundaries and keeps activity out of messages", async () => {
    const result = await runTurn("", false, "", [], "request", {
      runtimeEvents: [
        { type: "thinking", active: true },
        { type: "thinking", active: true },
        { type: "thinking", active: false },
        { type: "thinking", active: false },
        { type: "text", text: "Public answer." },
        { type: "done" },
      ],
    });
    const activity = result.savedEvents.filter((event) => event.type === "thread.meta");
    expect(activity.map(({ payload }) => payload)).toEqual([
      { activity: { thinking: true } },
      { activity: { thinking: false } },
    ]);
    expect(
      activity.every(
        ({ runId, threadId, botId }) =>
          runId === "run-1" && threadId === "thread-1" && botId === "bot-1",
      ),
    ).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain("thinking");
  });
  it.each<AgentRuntimeEvent>([
    { type: "text", text: "Public reply." },
    { type: "tool", name: "read_file", args: {}, executionId: "read-1" },
    { type: "progress", text: "Reading", activity: true },
    { type: "turn" },
    { type: "ask", text: "Which option?" },
    { type: "done" },
  ])("resets before $type even if a runtime omits its end marker", async (boundary) => {
    const result = await runTurn("", false, "", [], "request", {
      runtimeEvents: [{ type: "thinking", active: true }, boundary, { type: "done" }],
    });
    expect(
      result.savedEvents
        .filter((event) => event.type === "thread.meta")
        .map(({ payload }) => payload),
    ).toEqual([{ activity: { thinking: true } }, { activity: { thinking: false } }]);
  });
  it("resets on a runtime failure or exhausted iterator without a terminal marker", async () => {
    for (const runtimeFailure of [false, true]) {
      const result = await runTurn("", false, "", [], "request", {
        runtimeFailure,
        runtimeEvents: [{ type: "thinking", active: true }],
      });
      expect(
        result.savedEvents
          .filter((event) => event.type === "thread.meta")
          .map(({ payload }) => payload),
      ).toEqual([{ activity: { thinking: true } }, { activity: { thinking: false } }]);
    }
  });
  it("does not emit background thinking or accept arbitrary runtime metadata into public payloads", async () => {
    const privateMarker = {
      type: "thinking",
      active: true,
      text: "private fixture reasoning",
      partial: { content: "private" },
    } as AgentRuntimeEvent;
    const visible = await runTurn("", false, "", [], "request", {
      runtimeEvents: [privateMarker, { type: "done" }],
    });
    expect(
      visible.savedEvents
        .filter((event) => event.type === "thread.meta")
        .map(({ payload }) => payload),
    ).toEqual([{ activity: { thinking: true } }, { activity: { thinking: false } }]);
    expect(JSON.stringify(visible.savedEvents)).not.toContain("private fixture reasoning");
    const background = await runTurn("", true, "", [], "fyi", {
      trigger: "tickets",
      runtimeEvents: [privateMarker, { type: "done" }],
    });
    expect(background.savedEvents.some((event) => event.type === "thread.meta")).toBe(false);
  });
});

it("terminal cancellation wins over a runtime's open thinking marker", async () => {
  const result = await runTurn("", false, "", [], "request", {
    runtimeCancel: true,
    runtimeEvents: [{ type: "thinking", active: true }],
  });
  const payloads = result.savedEvents
    .filter((event) => event.type === "thread.meta")
    .map(({ payload }) => payload);
  expect(payloads[0]).toEqual({ activity: { thinking: true } });
  expect(result.finalizeRun).not.toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed" }),
  );
});

describe("a group member the message named nobody for", () => {
  const text = (value: string): AgentRuntimeEvent => ({ type: "text", text: value });
  const tool: AgentRuntimeEvent = {
    type: "tool",
    name: "read_file",
    args: {},
    executionId: "call-1",
  };
  const done: AgentRuntimeEvent = { type: "done" };

  function turn(optional: boolean, runtimeEvents: AgentRuntimeEvent[], splitText = false) {
    return runTurn("", false, "", [], "request", {
      group: { optional },
      runtimeEvents,
      splitText,
    });
  }

  function guidance(result: Awaited<ReturnType<typeof runTurn>>) {
    return result.runtimeRun.mock.calls[0]![0].instructions;
  }

  it("is told to decide before using tools, and ends silently on NO_RESPONSE", async () => {
    const result = await turn(true, [text("NO_RESPONSE"), done]);
    expect(guidance(result)).toContain(GROUP_UNADDRESSED_REPLY_GUIDANCE);
    expect(result.finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
    expect(result.messages).toEqual([]);
  });

  it("keeps a possible silent ending out of the chat when a follow-up steers it", async () => {
    const result = await turn(true, [
      text("NO_RESPONSE"),
      { type: "steered", fromRunUser: true },
      text("NO_RESPONSE"),
      done,
    ]);
    expect(result.messages).toEqual([]);
  });

  it("cannot hand off a message every member already received", async () => {
    const offered = async (optional: boolean) =>
      (
        (await turn(optional, [text("NO_RESPONSE"), done])).runtimeRun.mock.calls[0]![0].tools ?? []
      ).map((tool: { name: string }) => tool.name);
    expect(await offered(true)).not.toContain("handoff_to_bot");
    expect(await offered(false)).toContain("handoff_to_bot");
  });

  it("gets neither the guidance nor a silent ending when the message named it", async () => {
    const result = await turn(false, [text("NO_RESPONSE"), done]);
    expect(guidance(result)).not.toContain(GROUP_UNADDRESSED_REPLY_GUIDANCE);
    expect(result.finalizeRun.mock.calls[0]![0].blocks).not.toEqual([]);
    expect(result.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it("keeps the steps and unread mark when tools ran before NO_RESPONSE", async () => {
    const result = await turn(true, [tool, text("NO_RESPONSE"), done]);
    const [{ blocks, markUnread }] = result.finalizeRun.mock.calls[0]!;
    expect(blocks.map((block) => block.kind)).toEqual(["steps"]);
    expect(markUnread).toBe(true);
  });

  it("is not silent after it already posted a progress message", async () => {
    const result = await runTurn("", false, "", [], "request", {
      group: { optional: true },
      priorProgressText: "Let me check that for you.",
      runtimeEvents: [text("NO_RESPONSE"), done],
    });
    expect(result.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it.each([".", "…", "\u200c", " \n", "\u200c."])(
    "ends silently on a reply of only placeholder characters: %j",
    async (placeholder) => {
      const result = await turn(true, [text(placeholder), done]);
      expect(result.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ blocks: [], markUnread: false }),
      );
      expect(result.messages).toEqual([]);
      expect(result.savedEvents.filter((event) => event.type === "thread.progress")).toEqual([]);
    },
  );

  it.each(["—", "✓", "-", "?", "👍"])("keeps a reply of only %j", async (mark) => {
    const result = await turn(true, [text(mark), done]);
    expect(result.finalizeRun.mock.calls[0]![0].blocks).toEqual([{ kind: "text", text: mark }]);
    expect(result.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it("is not silent after an earlier message of its own run, such as an ask card", async () => {
    const result = await runTurn("", false, "", [], "request", {
      group: { optional: true },
      priorBotMessage: true,
      runtimeEvents: [text("NO_RESPONSE"), done],
    });
    expect(result.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it("keeps an emoji reply and a placeholder after tool work", async () => {
    const emoji = await turn(true, [text("👍"), done]);
    expect(emoji.finalizeRun.mock.calls[0]![0].blocks).toEqual([{ kind: "text", text: "👍" }]);
    const worked = await turn(true, [tool, text("."), done]);
    expect(worked.finalizeRun.mock.calls[0]![0].blocks.map((block) => block.kind)).toContain(
      "steps",
    );
    expect(worked.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });

  it("still posts a placeholder when the message named the member", async () => {
    const result = await turn(false, [text("."), done]);
    expect(result.finalizeRun.mock.calls[0]![0].blocks).toEqual([{ kind: "text", text: "." }]);
  });

  it("ends an empty finish silently instead of posting a fallback", async () => {
    const result = await turn(true, [done]);
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
  });

  it("keeps the fallback for an empty finish when the message named it", async () => {
    const result = await turn(false, [done]);
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: [{ kind: "text", text: "done." }], markUnread: true }),
    );
  });

  it("still posts and marks unread a real reply", async () => {
    const result = await turn(true, [text("Here is the plan."), done]);
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ kind: "text", text: "Here is the plan." }],
        markUnread: true,
      }),
    );
  });

  it("shows no live text while it could still turn out to be NO_RESPONSE", async () => {
    const result = await turn(true, [text("NO_RESPONSE"), done], true);
    const progress = result.savedEvents.filter((event) => event.type === "thread.progress");
    expect(JSON.stringify(progress)).not.toContain("NO_");
    expect(result.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ blocks: [] }));
  });

  it("holds the text back past an activity line too", async () => {
    const result = await turn(true, [
      text("NO_RESPONSE"),
      { type: "progress", text: "Reading the page", activity: true },
      done,
    ]);
    const progress = result.savedEvents.filter((event) => event.type === "thread.progress");
    expect(JSON.stringify(progress)).toContain("Reading the page");
    expect(JSON.stringify(progress)).not.toContain("NO_RESPONSE");
  });

  it("streams a real reply live", async () => {
    const result = await turn(true, [text("Here is the plan."), done], true);
    const progress = result.savedEvents.filter((event) => event.type === "thread.progress");
    expect(JSON.stringify(progress)).toContain("Here is the plan.");
  });

  it("no longer ends silently once a later message names it", async () => {
    const result = await runTurn("", false, "", [], "request", {
      group: { optional: true, namedWhileRunning: true },
      runtimeEvents: [text("NO_RESPONSE"), done],
    });
    expect(result.finalizeRun.mock.calls[0]![0].blocks).not.toEqual([]);
    expect(result.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: true }));
  });
});

describe("completion pushes", () => {
  const completionPushes = () =>
    vi.mocked(notifyRun).mock.calls.filter(([, , message]) => message.kind === "completion");

  it("sends none for an agent-to-agent turn that leaves the chat read", async () => {
    vi.mocked(notifyRun).mockClear();
    const { finalizeRun } = await runTurn("Pinned.", true, "I will pin it.", [], "request", {
      trigger: "bot_message",
    });
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ markUnread: false }));
    expect(completionPushes()).toEqual([]);
  });

  it("sends one for the answer to a request the bot made for the user", async () => {
    vi.mocked(notifyRun).mockClear();
    await runTurn("Both bots are pinned.", true, "I will check.", [], "fyi", {
      trigger: "bot_message",
      repliesToRequest: true,
    });
    expect(completionPushes()).toHaveLength(1);
  });

  it("sends one for a reply to the user", async () => {
    vi.mocked(notifyRun).mockClear();
    await runTurn("Done.", false, "I will check.", [], "fyi", { trigger: "user" });
    expect(completionPushes()).toHaveLength(1);
  });
});
