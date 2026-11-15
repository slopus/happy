import type { AgentRunRequest, MemoryReadRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const OWNER_MEMORY = "Owner's door code is 4821";
const OWNER_NOTE = "Plan the owner's surprise party";
/** What an owner-only tool returned to an earlier reply, kept for the bot's own later turns. */
const OWNER_TOOL_RESULT = "Inbox: offer letter from the owner's new employer";

type Sender = { senderId: string; senderIsBot?: boolean };

/** One team-chat run through the executor, returning what the model was given. */
async function teamChatRun(input: {
  senders: Sender[];
  ownerAddress?: string | null;
  linkedAddresses?: string[];
  sharedChannel?: boolean;
}) {
  const [waking, ...batched] = input.senders.map((sender, index) => ({
    id: `external-${index}`,
    externalConversationId: "conversation-1",
    providerEventId: `event-${index}`,
    senderId: sender.senderId,
    senderIsBot: sender.senderIsBot ?? false,
    batchContext: null as string | null,
  }));
  if (!waking) throw new Error("a run needs a waking message");
  if (batched.length) {
    waking.batchContext = JSON.stringify({
      prompt: "Channel update",
      messageIds: [waking, ...batched].map((message) => message.id),
    });
  }
  const externalMessages = [waking, ...batched];
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "messaging",
    sourceMessageId: "source-1",
    leaseFence: 0,
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    space: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      // The earlier reply's run: started under the conversation's (owner's) user, as all are.
      findMany: vi.fn(async () => [{ id: "run-0", userId: run.userId }]),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: { findMany: vi.fn(async () => []) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        userId: run.userId,
        name: "Assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => []),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        externalConversationId: "conversation-1",
      })),
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })),
    },
    message: {
      // The history loader asks for tool history; an earlier reply read the owner's inbox.
      findMany: vi.fn(async (args: { select?: { toolHistory?: boolean } }) =>
        args.select?.toolHistory
          ? [
              {
                id: "reply-0",
                threadId: "thread-1",
                seq: 0,
                role: "bot",
                botId: "bot-1",
                runId: "run-0",
                blocks: [
                  { kind: "steps", steps: [{ label: "Read email", count: 1 }] },
                  { kind: "text", text: "You have one new email." },
                ],
                toolHistory: JSON.stringify({
                  steps: [
                    {
                      tool: "read_email",
                      calls: [{ arguments: "{}", result: OWNER_TOOL_RESULT }],
                    },
                  ],
                }),
                authorUserId: null,
                createdAt: new Date("2026-11-01T00:00:00Z"),
                replyToMessageId: null,
                replyQuote: null,
                replyTo: null,
                clientNonce: null,
                steeringMessages: [],
              },
            ]
          : [],
      ),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({
        blocks: input.sharedChannel
          ? [{ kind: "channel_message", channelId: "channel-1" }]
          : [{ kind: "text", text: "Slack message from Pat:\n\nWhat do you remember?" }],
        clientNonce: `teamchat:slack:${waking.providerEventId}`,
      })),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "message-1", ...data })),
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Use @Private recipe and @Rakazo and @Interrogate",
      })),
    },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: {
      findMany: vi.fn(async () => [
        {
          id: "taught-1",
          name: "Private recipe",
          goal: "PRIVATE_TAUGHT_GOAL",
          playbook: { whenToUse: "PRIVATE_TAUGHT_HINT", steps: [] },
        },
      ]),
    },
    secret: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: {
      findMany: vi.fn(async () => [
        {
          id: "skill-1",
          name: "Private recipe",
          description: "PRIVATE_SKILL_DESCRIPTION",
          content: "PRIVATE_SKILL_BODY",
          source: "user",
        },
        {
          id: "shadow-1",
          name: "Interrogate",
          description: "PRIVATE_SKILL_SHADOW",
          content: "PRIVATE_SKILL_OVERRIDE",
          source: "user",
        },
      ]),
    },
    scratchpadItem: {
      findMany: vi.fn(async () => [
        {
          id: "scratch-1",
          spaceId: run.spaceId,
          botId: run.botId,
          userId: run.userId,
          title: OWNER_NOTE,
          status: "open",
          notes: "",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
          updatedAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ]),
    },
    spaceSettingOverride: { findUnique: async () => null },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    steeringMessage: { findFirst: vi.fn(async () => null) },
    externalConversation: {
      findUnique: vi.fn(async () => ({
        provider: "slack",
        workspaceId: "T1",
        userId: run.userId,
        botId: run.botId,
      })),
    },
    externalMessage: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            externalConversationId_providerEventId: { providerEventId: string };
          };
        }) =>
          externalMessages.find(
            (message) =>
              message.providerEventId ===
              where.externalConversationId_providerEventId.providerEventId,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        externalMessages.filter((message) => where.id.in.includes(message.id)),
      ),
    },
    messagingInstallation: {
      findUnique: vi.fn(async () =>
        input.ownerAddress === undefined
          ? null
          : { ownerAddress: input.ownerAddress, userId: run.userId, botId: run.botId },
      ),
    },
    messagingIdentity: {
      findMany: vi.fn(async ({ where }: { where: { address: { in: string[] } } }) =>
        (input.linkedAddresses ?? [])
          .filter((address) => where.address.in.includes(address))
          .map((address) => ({ address })),
      ),
    },
  };
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma: {
      ...prisma,
      $transaction: async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async (_request: MemoryReadRequest) => ({
        documents: [{ path: "MEMORY.md", content: OWNER_MEMORY, revision: "rev-1" }],
      }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-2" })),
      remove: vi.fn(async () => ({ removed: false })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      pauseRunForInput: vi.fn(async () => true),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  if (!request) throw new Error("the run never reached the model");
  const tools = request.tools.map((tool) => tool.name);
  const context = [request.instructions, request.prompt].join("\n");
  return {
    tools,
    context,
    sawOwnerState: context.includes(OWNER_MEMORY) || context.includes(OWNER_NOTE),
    sawOwnerToolResult: JSON.stringify(request.history).includes(OWNER_TOOL_RESULT),
    toldNonOwner: context.includes("someone other than your owner"),
  };
}

const ownerOnlyTools = ["remember", "scratchpad_add"];

describe("team chat runs from people other than the owner", () => {
  it.each([
    ["a coworker", [{ senderId: "T1:U-COWORKER" }]],
    ["a guest from another organization", [{ senderId: "T-OTHER:U-GUEST" }]],
    ["another app", [{ senderId: "T1:U-OWNER", senderIsBot: true }]],
    ["a batch that mixes in a coworker", [{ senderId: "T1:U-OWNER" }, { senderId: "T1:U-PAT" }]],
  ])("keep the owner's memory and notes from %s", async (_who, senders) => {
    const result = await teamChatRun({ senders, ownerAddress: "T1:U-OWNER" });
    expect(result.sawOwnerState).toBe(false);
    expect(result.sawOwnerToolResult).toBe(false);
    expect(result.toldNonOwner).toBe(true);
    for (const tool of ownerOnlyTools) expect(result.tools).not.toContain(tool);
    expect(result.tools).toContain("web_fetch");
  });

  it("restricts a workspace connected before its installer was recorded", async () => {
    const result = await teamChatRun({
      senders: [{ senderId: "T1:U-OWNER" }],
      ownerAddress: null,
    });
    expect(result.sawOwnerState).toBe(false);
    expect(result.tools).not.toContain("remember");
  });
});

describe("team chat runs from the owner", () => {
  it.each([
    ["the person who installed the workspace", { ownerAddress: "T1:U-OWNER" }],
    ["a sender the owner linked", { ownerAddress: null, linkedAddresses: ["T1:U-OWNER"] }],
  ])("keep full owner context for %s", async (_who, owner) => {
    const result = await teamChatRun({
      senders: [{ senderId: "T1:U-OWNER" }, { senderId: "T1:U-OWNER" }],
      ...owner,
    });
    expect(result.sawOwnerState).toBe(true);
    expect(result.sawOwnerToolResult).toBe(true);
    expect(result.toldNonOwner).toBe(false);
    for (const tool of ownerOnlyTools) expect(result.tools).toContain(tool);
  });
});

describe("private skills in shared-channel prompts", () => {
  it("keeps private catalogs and expanded bodies out while retaining built-in skills", async () => {
    const result = await teamChatRun({ senders: [{ senderId: "member" }], sharedChannel: true });
    expect(result.context).not.toContain("PRIVATE_SKILL");
    expect(result.context).not.toContain("PRIVATE_TAUGHT");
    expect(result.context).toContain("Use skill: Rakazo");
    expect(result.context).toContain("Use skill: Interrogate");
  });

  it("keeps private skills available to the owner", async () => {
    const result = await teamChatRun({
      senders: [{ senderId: "T1:U-OWNER" }],
      ownerAddress: "T1:U-OWNER",
    });
    expect(result.context).toContain("PRIVATE_SKILL_BODY");
    expect(result.context).toContain("PRIVATE_TAUGHT_HINT");
  });
});
