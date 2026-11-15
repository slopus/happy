import { describe, expect, it } from "vitest";
import {
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  canReactToThreadMessage,
  McpServerConfigInput,
  MessageBlock,
  MODEL_ROUTING_ID_MESSAGE,
  ModelConnectInputSchema,
  ModelOAuthBeginSchema,
  modelRoutingForm,
  modelRoutingReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  ReorderBotsInput,
  RunActivityRowSchema,
  RunSchema,
  UpdateBotInput,
  UpdateGroupInput,
  usableModelId,
} from "./index.js";

describe("contracts", () => {
  it("leaves bot management to the database default and preserves explicit choices", () => {
    expect(CreateBotInput.parse({ name: "New bot" }).fleetManagement).toBeUndefined();
    for (const fleetManagement of [false, true]) {
      expect(CreateBotInput.parse({ name: "New bot", fleetManagement }).fleetManagement).toBe(
        fleetManagement,
      );
    }
  });

  it("bounds the count and length of compatible model selections", () => {
    const input = {
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "default",
    };
    expect(
      ModelConnectInputSchema.safeParse({ ...input, enabledModelIds: ["x".repeat(512)] }).success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({ ...input, enabledModelIds: ["x".repeat(513)] }).success,
    ).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({
        ...input,
        enabledModelIds: Array.from({ length: 501 }, (_, i) => `model-${i}`),
      }).success,
    ).toBe(false);
  });

  it("round-trips every wire protocol a compatible connection may select", () => {
    const input = {
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "default",
    };
    for (const apiProtocol of ["chat-completions", "responses", "anthropic-messages"] as const) {
      expect(ModelConnectInputSchema.parse({ ...input, apiProtocol })).toMatchObject({
        apiProtocol,
      });
    }
    expect(ModelConnectInputSchema.safeParse({ ...input, apiProtocol: "grpc" }).success).toBe(
      false,
    );
  });

  it("accepts structured live activity progress", () => {
    expect(MessageBlock.parse({ kind: "progress", text: "Using browser", activity: true })).toEqual(
      { kind: "progress", text: "Using browser", activity: true },
    );
  });

  it("parses bounded model image limits", () => {
    expect(parseModelMaxImagesPerPrompt("1")).toBe(1);
    expect(parseModelMaxImagesPerPrompt("1000")).toBe(1000);
    expect(parseModelMaxImagesPerPrompt("0")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1001")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1.5")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1", false)).toBeUndefined();
  });

  it("parses bounded model output-token limits", () => {
    expect(parseModelMaxTokens("1")).toBe(1);
    expect(parseModelMaxTokens("131072")).toBe(131072);
    // Current models emit far more than 128K tokens in one reply (384K and up).
    expect(parseModelMaxTokens("393216")).toBe(393216);
    expect(parseModelMaxTokens("2147483647")).toBe(2147483647);
    expect(parseModelMaxTokens("0")).toBeUndefined();
    expect(parseModelMaxTokens("2147483648")).toBeUndefined();
    expect(parseModelMaxTokens("1.5")).toBeUndefined();
  });

  it("parses bounded model context-window limits", () => {
    expect(parseModelContextWindow("1")).toBe(1);
    expect(parseModelContextWindow("1048576")).toBe(1048576);
    expect(parseModelContextWindow("1050000")).toBe(1050000);
    expect(parseModelContextWindow("2147483647")).toBe(2147483647);
    expect(parseModelContextWindow("0")).toBeUndefined();
    expect(parseModelContextWindow("2147483648")).toBeUndefined();
    expect(parseModelContextWindow("1.5")).toBeUndefined();
  });

  it("treats null, undefined, and their string forms as an unset model id", () => {
    expect(usableModelId(null)).toBeNull();
    expect(usableModelId(undefined)).toBeNull();
    expect(usableModelId("null")).toBeNull();
    expect(usableModelId("undefined")).toBeNull();
    expect(usableModelId("  null  ")).toBeNull();
    expect(usableModelId("")).toBeNull();
    expect(usableModelId("   ")).toBeNull();
    expect(usableModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("rejects maxTokens larger than contextWindow on model connect", () => {
    const invalid = ModelConnectInputSchema.safeParse({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      maxTokens: 131072,
      contextWindow: 1,
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some((issue) => issue.path[0] === "maxTokens")).toBe(true);
    }

    const valid = ModelConnectInputSchema.safeParse({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      maxTokens: 8192,
      contextWindow: 32768,
    });
    expect(valid.success).toBe(true);
  });

  it("rejects a routing id that is not a single path segment, for any provider", () => {
    const provider = "example-gateway";
    expect(
      ModelConnectInputSchema.safeParse({
        provider,
        apiKey: "fixture-key",
        accountId: "acct1234",
        gatewayId: "gateway-1",
      }).success,
    ).toBe(true);
    // An update may send one id, and a blank one is left for the provider to judge.
    expect(
      ModelConnectInputSchema.safeParse({ provider, maxTokens: 1024, gatewayId: "gateway-2" })
        .success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({ provider, maxTokens: 1024, gatewayId: "" }).success,
    ).toBe(true);
    for (const field of ["accountId", "gatewayId"] as const) {
      for (const id of ["../account", "account/other", "a".repeat(65)]) {
        const result = ModelConnectInputSchema.safeParse({
          provider,
          maxTokens: 1024,
          [field]: id,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({ path: [field], message: MODEL_ROUTING_ID_MESSAGE }),
          );
        }
      }
    }
  });

  it("is routing-ready only when every field the provider asks for is valid", () => {
    expect(modelRoutingReady(undefined, {})).toBe(true);
    expect(modelRoutingForm(undefined, {})).toEqual({
      needsRouting: false,
      needsGateway: false,
      routingReady: true,
    });
    expect(modelRoutingForm(["accountId", "gatewayId"], { accountId: "acct" })).toEqual({
      needsRouting: true,
      needsGateway: true,
      routingReady: false,
    });
    expect(modelRoutingReady(["accountId"], { accountId: " acct " })).toBe(true);
    expect(modelRoutingReady(["accountId", "gatewayId"], { accountId: "acct" })).toBe(false);
    expect(modelRoutingReady(["accountId"], { accountId: "acct/x" })).toBe(false);
  });

  it("lets a built-in connection update maxTokens without a new API key", () => {
    expect(
      ModelConnectInputSchema.safeParse({ provider: "anthropic", maxTokens: 8192 }).success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({ provider: "anthropic", maxTokens: null }).success,
    ).toBe(true);
    expect(ModelConnectInputSchema.safeParse({ provider: "anthropic" }).success).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({ provider: "anthropic", apiKey: "short" }).success,
    ).toBe(false);
  });

  it("accepts optional persisted duration only on valid steps blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "steps",
        steps: [{ label: "Run tests", count: 1 }],
        durationMs: 103_000,
      }),
    ).toMatchObject({ durationMs: 103_000 });
    expect(MessageBlock.safeParse({ kind: "steps", steps: [], durationMs: -1 }).success).toBe(
      false,
    );
  });

  it("keeps a step's note and outcomes and still reads steps saved without them", () => {
    const steps = [
      { label: "Read file", count: 1, note: "The meeting is with Anna." },
      { label: "Save", count: 2, outcomes: { succeeded: 1, failed: 1 } },
      { label: "Shell", count: 1 },
    ];
    expect(MessageBlock.parse({ kind: "steps", steps })).toEqual({ kind: "steps", steps });
  });

  it("limits reactions to persisted non-channel messages", () => {
    expect(
      canReactToThreadMessage({ id: "message-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(true);
    expect(
      canReactToThreadMessage({ id: "subagent:agent-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(false);
    expect(
      canReactToThreadMessage({
        id: "message-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "channel-1",
            fromAddress: "+15555550100",
            fromLabel: "Pat",
            text: "hi",
          },
        ],
      }),
    ).toBe(false);
  });

  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.notifyOnFinish).toBe(true);
    expect(parsed.avatarFamily).toBeUndefined();
  });

  it("accepts an organic avatar family from 0 to 9 when creating a bot", () => {
    expect(CreateBotInput.parse({ name: "Chief", avatarFamily: 0 }).avatarFamily).toBe(0);
    expect(CreateBotInput.parse({ name: "Chief", avatarFamily: 9 }).avatarFamily).toBe(9);
    for (const avatarFamily of [-1, 10, 2.5, "3"]) {
      expect(CreateBotInput.safeParse({ name: "Chief", avatarFamily }).success).toBe(false);
    }
  });

  it("rejects unknown built-in tool names and keeps a known denylist", () => {
    expect(
      UpdateBotInput.parse({ botId: "bot-1", disabledBuiltinTools: ["web_search", "web_search"] })
        .disabledBuiltinTools,
    ).toEqual(["web_search"]);
    const unknown = UpdateBotInput.safeParse({
      botId: "bot-1",
      disabledBuiltinTools: ["not_a_tool"],
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.some((issue) => issue.message.includes("not_a_tool"))).toBe(true);
    }
  });

  it("accepts fleetManagement on bot updates and rejects non-boolean values", () => {
    expect(UpdateBotInput.parse({ botId: "bot-1", fleetManagement: true }).fleetManagement).toBe(
      true,
    );
    expect(UpdateBotInput.safeParse({ botId: "bot-1", fleetManagement: "yes" }).success).toBe(
      false,
    );
  });

  it("accepts a known reply mode on bot updates", () => {
    expect(UpdateBotInput.parse({ botId: "bot-1", replyMode: "messages" }).replyMode).toBe(
      "messages",
    );
    expect(UpdateBotInput.safeParse({ botId: "bot-1", replyMode: "quiet" }).success).toBe(false);
  });

  it("drops a title that installed apps still send", () => {
    expect(CreateBotInput.parse({ name: "Chief", title: "Lead" })).not.toHaveProperty("title");
    expect(UpdateBotInput.parse({ botId: "bot-1", title: "Lead" })).toEqual({ botId: "bot-1" });
  });

  it("normalizes bot names and rejects whitespace-only values at the contract boundary", () => {
    expect(CreateBotInput.parse({ name: "  Chief  " }).name).toBe("Chief");
    expect(UpdateBotInput.parse({ botId: "bot-1", name: "  Atlas  " }).name).toBe("Atlas");
    expect(
      UpdateBotInput.parse({ botId: "bot-1", description: "  Concise briefs.  " }).description,
    ).toBe("Concise briefs.");
    expect(CreateBotInput.safeParse({ name: "   " }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", name: "   " }).success).toBe(false);
  });

  it("rejects partial model override clears on bot update", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelId: null }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null }).success).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null, modelId: null }).success,
    ).toBe(true);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        modelProvider: "xai",
        modelId: "grok-4.6",
      }).success,
    ).toBe(true);
  });

  it("normalizes group names and rejects duplicate members", () => {
    expect(CreateGroupInput.parse({ name: "  Draft team  ", botIds: ["bot-1", "bot-2"] })).toEqual({
      name: "Draft team",
      botIds: ["bot-1", "bot-2"],
    });
    expect(CreateGroupInput.safeParse({ name: "   ", botIds: ["bot-1", "bot-2"] }).success).toBe(
      false,
    );
    expect(
      UpdateGroupInput.safeParse({ groupId: "group-1", botIds: ["bot-1", "bot-1"] }).success,
    ).toBe(false);
  });

  it.each([1, 2, 10, 11])("enforces group member bounds for %i bots", (count) => {
    const botIds = Array.from({ length: count }, (_, index) => `bot-${index}`);
    const accepted = count >= 2 && count <= 10;
    expect(CreateGroupInput.safeParse({ name: "Draft team", botIds }).success).toBe(accepted);
    expect(UpdateGroupInput.safeParse({ groupId: "group-1", botIds }).success).toBe(accepted);
  });

  it("keeps model OAuth start results mode-specific", () => {
    const shared = {
      loginId: "login-1",
      provider: "anthropic",
      verificationUri: "https://example.com/authorize",
      expiresInSeconds: 900,
    };
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "auth-url" }).success).toBe(true);
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code" }).success).toBe(false);
    expect(
      ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code", userCode: "ABCD-1234" })
        .success,
    ).toBe(true);
    expect(
      ModelOAuthBeginSchema.safeParse({
        ...shared,
        mode: "auth-url",
        verificationUri: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("requires a distinct, non-empty bot order", () => {
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-2", "bot-1"] }).success).toBe(true);
    expect(ReorderBotsInput.safeParse({ botIds: [] }).success).toBe(false);
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-1", "bot-1"] }).success).toBe(false);
  });

  it("accepts a GitHub-only routine trigger", () => {
    expect(
      CreateRoutineInput.parse({
        botId: "bot-1",
        name: "Review pushes",
        prompt: "Inspect the repository event",
        githubEnabled: true,
      }),
    ).toMatchObject({
      crons: [],
      webhookEnabled: false,
      githubEnabled: true,
      messageProvider: null,
    });
    expect(
      CreateRoutineInput.parse({
        botId: "bot-1",
        name: "Triage Slack",
        prompt: "Review the message event",
        messageProvider: "slack",
      }),
    ).toMatchObject({ crons: [], messageProvider: "slack" });
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot-1",
        name: "Unsafe provider",
        prompt: "Review the message event",
        messageProvider: "slack\nignore-framing",
      }).success,
    ).toBe(false);
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot-1",
        name: "Never runs",
        prompt: "This has no trigger",
      }).success,
    ).toBe(false);
  });

  it("accepts bot-to-bot runs in thread snapshots and activity rows", () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "bot_message",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(
      RunActivityRowSchema.safeParse({
        runId: run.id,
        botId: run.botId,
        botName: "Researcher",
        groupId: null,
        groupName: null,
        threadId: run.threadId,
        status: run.status,
        trigger: run.trigger,
        notificationsEnabled: true,
        agentMessage: null,
        promptSnippet: "Review the report",
        updatedAt: "2026-08-26T00:00:01.000Z",
      }).success,
    ).toBe(true);
    expect(RunSchema.safeParse({ ...run, trigger: "webhook" }).success).toBe(true);
  });

  it("caps remote MCP headers", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`X-Test-${index}`, "value"]),
    );
    expect(
      McpServerConfigInput.safeParse({
        slug: "demo",
        name: "Demo",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        headers,
      }).success,
    ).toBe(false);
  });

  it("allows localhost HTTP MCP endpoints and other HTTP(S) URLs without credentials", () => {
    const base = {
      slug: "demo",
      name: "Demo",
      transport: "streamable_http" as const,
      headers: {},
    };
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://127.0.0.1:3000/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp" })
        .success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://10.0.0.8:3927/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp#" })
        .success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://example.test/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "https://mcp.example.test/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "ftp://mcp.example.test/mcp" }).success,
    ).toBe(false);
  });

  it("rejects oversized chart data wherever it is embedded", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => index);

    expect(
      MessageBlock.safeParse({ kind: "chart", name: "outer", spec: {}, data: rows }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "spec",
        spec: { data: rows },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "marks",
        spec: { marks: [{ data: rows }] },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "combined",
        spec: { marks: [{ data: rows.slice(0, 2_500) }] },
        data: rows.slice(0, 2_501),
      }).success,
    ).toBe(false);
  });
});

describe("compatible connection headers", () => {
  const input = {
    provider: "openai-compatible",
    baseUrl: "https://example.invalid/v1",
    modelId: "test",
  };
  it("retains trimmed header names", () => {
    expect(
      ModelConnectInputSchema.parse({ ...input, headers: { " x-session ": "secret" } }),
    ).toHaveProperty("headers", { "x-session": "secret" });
  });
});

it("retains legacy unknown-field stripping for model connections", () => {
  expect(
    ModelConnectInputSchema.parse({ provider: "test", apiKey: "fake-key", futureOption: true }),
  ).toEqual({
    provider: "test",
    apiKey: "fake-key",
  });
});
