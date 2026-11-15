import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { beforeEach, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { builtinAgentTools } from "./builtin-tools.js";

const fake = vi.hoisted(() => ({ models: new Map<string, unknown>(), stream: vi.fn() }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => fake.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => fake.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

function response(
  target: Model<"openai-completions">,
  name?: string,
  args = {},
  id = name,
  thinking?: string,
) {
  const message: AssistantMessage = {
    role: "assistant",
    api: target.api,
    provider: target.provider,
    model: target.id,
    content: name
      ? [{ type: "toolCall", id: id!, name, arguments: args }]
      : [{ type: "text", text: "Done." }],
    stopReason: name ? "toolUse" : "stop",
    timestamp: 1,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  if (thinking) message.content.unshift({ type: "thinking", thinking, thinkingSignature: "sig" });
  if (name === "!error") {
    message.content = [];
    message.stopReason = "error";
    message.errorMessage = "403 Quota exceeded for this account.";
  }
  const stream = new AssistantMessageEventStream();
  if (message.stopReason === "error")
    stream.push({ type: "error", reason: "error", error: message });
  else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
  stream.end(message);
  return stream;
}
function crossProviderRequest(reverse = false): AgentRunRequest {
  const input = request();
  const claude = {
    ...input.model,
    provider: "anthropic",
    id: "claude",
    connectionId: "claude-account",
    apiKey: "claude-key",
    thinkingLevel: "high" as const,
  };
  const codex = {
    provider: "openai-codex",
    id: "gpt",
    connectionId: "codex-account",
    thinkingLevel: "medium" as const,
    oauth: {
      credential: {
        type: "oauth" as const,
        access: "codex-token",
        refresh: "fake-refresh",
        expires: 9999999999999,
      },
    },
  };
  for (const config of [claude, codex])
    fake.models.set(`${config.provider}/${config.id}`, {
      ...(fake.models.get("test/main") as object),
      provider: config.provider,
      id: config.id,
      api: config.provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
      baseUrl: config.provider === "anthropic" ? "https://claude.invalid" : "https://codex.invalid",
    });
  input.model = reverse ? codex : claude;
  input.computerModel = reverse ? claude : codex;
  input.onModelChange = vi.fn(async () => {});
  input.resolveFallbackModel = vi.fn(async (provider, id, connectionId) => {
    const match = [claude, codex].find(
      (c) => c.provider === provider && c.id === id && c.connectionId === connectionId,
    );
    if (!match) throw new Error("Missing pinned connection");
    return match;
  });
  return input;
}
function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "mode-run",
    prompt: "Click the button",
    instructions: "",
    history: [],
    tools: builtinAgentTools.filter((t) =>
      ["browser_act", "computer_observe", "request_takeover", "run_subagent"].includes(t.name),
    ),
    model: { provider: "test", id: "main", apiKey: "fake-key", thinkingLevel: "high" },
    computerModel: { provider: "test", id: "computer", apiKey: "fake-key" },
    executeTool: vi.fn(async () => ({ ok: true })),
  };
}
async function run(input: AgentRunRequest, signal?: AbortSignal) {
  const events = [];
  for await (const event of new PiAgentRuntime().run(input, { signal })) events.push(event);
  return events;
}
beforeEach(() => {
  fake.stream.mockReset();
  fake.models.clear();
  for (const id of ["main", "computer", "backup", "text-only"])
    fake.models.set(`test/${id}`, {
      provider: "test",
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://models.invalid/v1",
      reasoning: true,
      input: id === "text-only" ? ["text"] : ["text", "image"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
});
function script(steps: Array<[string | undefined, Record<string, unknown>?]>) {
  fake.stream.mockImplementation((target: Model<"openai-completions">) => {
    const step = steps.shift();
    if (!step) throw new Error("Unexpected model call");
    return response(target, step[0], step[1]);
  });
}
it.each(["missing", "text-only", "wrong-provider", "implicit-key"])(
  "rejects invalid computer config: %s without model calls",
  async (variant) => {
    const input = request();
    if (variant === "wrong-provider") input.computerModel!.provider = "other";
    else if (variant === "implicit-key") input.computerModel!.apiKey = undefined;
    else input.computerModel!.id = variant;
    await expect(run(input)).rejects.toThrow(/Computer model/);
    expect(fake.stream).not.toHaveBeenCalled();
    expect(input.executeTool).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "switches Claude/Codex roles with isolated auth, endpoints, effort and billing (reverse=%s)",
  async (reverse) => {
    const input = crossProviderRequest(reverse);
    const mainObserver = { beforeCall: vi.fn(async () => "main-reservation"), afterCall: vi.fn() };
    const computerObserver = {
      beforeCall: vi.fn(async () => "computer-reservation"),
      afterCall: vi.fn(),
    };
    input.model = { ...input.model, contextWindow: 64000, callObserver: mainObserver };
    input.computerModel = {
      ...input.computerModel!,
      contextWindow: 32000,
      callObserver: computerObserver,
    };
    script([
      ["enter_computer_mode", { goal: "Click" }],
      ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
      ["leave_computer_mode", { summary: "Clicked" }],
      [undefined],
    ]);
    await run(input);
    expect(fake.stream.mock.calls.map((c) => c[0].contextWindow)).toEqual([
      64000, 32000, 32000, 64000,
    ]);
    for (const [observer, config, reservation] of [
      [mainObserver, input.model, "main-reservation"],
      [computerObserver, input.computerModel, "computer-reservation"],
    ] as const) {
      expect(observer.beforeCall).toHaveBeenCalledTimes(2);
      expect(observer.beforeCall).toHaveBeenCalledWith(
        expect.objectContaining({ provider: config.provider, modelId: config.id }),
      );
      expect(observer.afterCall).toHaveBeenCalledTimes(2);
      expect(observer.afterCall).toHaveBeenCalledWith(
        reservation,
        expect.objectContaining({ inputTokens: 4, outputTokens: 2 }),
      );
    }
    const configs = [input.model, input.computerModel!, input.computerModel!, input.model];
    expect(
      fake.stream.mock.calls.map((c) => [c[0].provider, c[0].id, c[2].apiKey, c[2].reasoning]),
    ).toEqual(
      configs.map((c) => [
        c.provider,
        c.id,
        c.oauth?.credential.access ?? c.apiKey,
        c.thinkingLevel,
      ]),
    );
    expect(fake.stream.mock.calls.map((c) => c[0].baseUrl)).toEqual(
      configs.map((c) =>
        c.provider === "anthropic" ? "https://claude.invalid" : "https://codex.invalid",
      ),
    );
    expect(input.onModelChange).toHaveBeenNthCalledWith(
      1,
      input.computerModel!.provider,
      input.computerModel!.id,
      true,
    );
    expect(input.onModelChange).toHaveBeenNthCalledWith(
      2,
      input.model.provider,
      input.model.id,
      false,
    );
    expect(input.executeTool).toHaveBeenCalledTimes(1);
  },
);
it("enters the configured computer target after a different-provider main fallback", async () => {
  const input = crossProviderRequest();
  input.fallbackModels = [{ provider: "test", id: "backup", connectionId: "backup-account" }];
  input.resolveFallbackModel = vi.fn(async (provider, id, connectionId) => ({
    provider,
    id,
    connectionId,
    apiKey: "backup-key",
  }));
  script([
    ["!error"],
    ["enter_computer_mode", { goal: "Click" }],
    ["leave_computer_mode", { summary: "Done" }],
    [undefined],
  ]);
  await run(input);
  expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual(["claude", "backup", "gpt", "backup"]);
});
it("never uses main fallbacks when the computer target fails", async () => {
  const input = request();
  input.fallbackModels = [{ provider: "test", id: "backup" }];
  input.resolveFallbackModel = vi.fn(async (provider, id) => ({
    provider,
    id,
    apiKey: "fake-key",
  }));
  script([["enter_computer_mode", { goal: "Click" }], ["!error"]]);
  await expect(run(input)).rejects.toThrow();
  expect(input.resolveFallbackModel).not.toHaveBeenCalled();
  expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual(["main", "computer"]);
});
it("returns to the selected main fallback rather than retrying the failed primary", async () => {
  const input = request();
  input.fallbackModels = [{ provider: "test", id: "backup" }];
  input.resolveFallbackModel = async (provider, id) => ({
    provider,
    id,
    apiKey: "fake-key",
    thinkingLevel: "high",
  });
  script([
    ["!error"],
    ["enter_computer_mode", { goal: "Click" }],
    ["leave_computer_mode", { summary: "Done" }],
    [undefined],
  ]);
  await run(input);
  expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual([
    "main",
    "backup",
    "computer",
    "backup",
  ]);
});
it("keeps the default unset tool surface and prompt unchanged", async () => {
  const input = request();
  input.computerModel = undefined;
  script([["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }], [undefined]]);
  await run(input);
  expect(input.executeTool).toHaveBeenCalledTimes(1);
  expect(getCurrentTools(fake.stream.mock.calls[0]![1].messages).map((t) => t.name)).not.toContain(
    "enter_computer_mode",
  );
});
it("requires entry even when main and computer are the same model", async () => {
  const input = request();
  input.computerModel!.id = "main";
  script([
    ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
    ["enter_computer_mode", { goal: "Click" }],
    ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
    ["leave_computer_mode", { summary: "Done" }],
    [undefined],
  ]);
  await run(input);
  expect(input.executeTool).toHaveBeenCalledTimes(1);
  expect(fake.stream.mock.calls.map((c) => c[2].reasoning)).toEqual([
    "high",
    "high",
    "medium",
    "medium",
    "high",
  ]);
});
it.each([false, true])(
  "resumes cross-provider takeover without repeating it (reverse=%s)",
  async (reverse) => {
    const input = crossProviderRequest(reverse);
    let checkpoint = "";
    input.onCheckpoint = async (capture) => {
      checkpoint = capture();
    };
    script([
      ["enter_computer_mode", { goal: "Sign in" }],
      ["request_takeover", { reason: "Sign in" }],
    ]);
    expect(await run(input)).toContainEqual(expect.objectContaining({ type: "takeover" }));
    const resumed = {
      ...input,
      turnCheckpoint: checkpoint,
      resumeToolResult: { content: [{ type: "text" as const, text: "Signed in" }] },
      resolveModel: async (provider: string, id: string) => ({ provider, id, apiKey: "fresh-key" }),
    };
    fake.stream.mockReset();
    script([["leave_computer_mode", { summary: "Signed in" }], [undefined]]);
    const events = await run(resumed);
    expect(events.some((e) => e.type === "takeover")).toBe(false);
    expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual([
      input.computerModel!.id,
      input.model.id,
    ]);
    expect(input.executeTool).not.toHaveBeenCalled();
  },
);
it.each(["missing", "wrong-account", "changed-auth"])(
  "fails closed on cross-provider resume when the target is %s",
  async (variant) => {
    const input = crossProviderRequest();
    let checkpoint = "";
    input.onCheckpoint = async (capture) => {
      checkpoint = capture();
    };
    script([
      ["enter_computer_mode", { goal: "Sign in" }],
      ["request_takeover", { reason: "Sign in" }],
    ]);
    await run(input);
    const resolve = input.resolveFallbackModel!;
    input.resolveFallbackModel = async (provider, id, connectionId) => {
      const target = await resolve(provider, id, connectionId);
      if (connectionId !== input.computerModel!.connectionId) return target;
      if (variant === "missing") throw new Error("Pinned connection unavailable");
      if (variant === "wrong-account") return { ...target, connectionId: "another-account" };
      return { ...target, oauth: undefined, apiKey: "unselected-key" };
    };
    fake.stream.mockReset();
    await expect(
      run({
        ...input,
        computerModel: undefined,
        turnCheckpoint: checkpoint,
        resumeToolResult: { content: [{ type: "text", text: "Signed in" }] },
      }),
    ).rejects.toThrow(/Pinned .*unavailable/);
    expect(fake.stream).not.toHaveBeenCalled();
    expect(input.executeTool).not.toHaveBeenCalled();
  },
);
it("rejects an unauthenticated cross-provider target without borrowing main tokens or backups", async () => {
  const input = crossProviderRequest();
  input.computerModel = { ...input.computerModel!, oauth: undefined };
  input.fallbackModels = [{ provider: "test", id: "backup" }];
  await expect(run(input)).rejects.toThrow(/authenticated configuration/);
  expect(fake.stream).not.toHaveBeenCalled();
  expect(input.resolveFallbackModel).not.toHaveBeenCalled();
});
it("cancellation in computer mode prevents further effects and model calls", async () => {
  const input = request();
  const controller = new AbortController();
  input.executeTool = vi.fn(async () => {
    controller.abort();
    return { ok: true };
  });
  script([
    ["enter_computer_mode", { goal: "Click" }],
    ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
  ]);
  await run(input, controller.signal).catch(() => undefined);
  expect(fake.stream).toHaveBeenCalledTimes(2);
  expect(input.executeTool).toHaveBeenCalledTimes(1);
});

it("runs the user's own screen tools only in computer mode", async () => {
  const input = request();
  input.tools = builtinAgentTools.filter((t) => t.name === "user_computer_observe");
  script([
    ["use_tool", { name: "user_computer_observe", arguments: { app: "Notes" } }],
    ["enter_computer_mode", { goal: "Look at Notes" }],
    ["use_tool", { name: "user_computer_observe", arguments: { app: "Notes" } }],
    ["leave_computer_mode", { summary: "Done" }],
    [undefined],
  ]);
  await run(input);
  expect(input.executeTool).toHaveBeenCalledTimes(1);
  expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual([
    "main",
    "main",
    "computer",
    "computer",
    "main",
  ]);
});
it("keeps the main model's own reasoning after computer work", async () => {
  const input = request();
  const steps: Array<[string | undefined, Record<string, unknown>?, string?]> = [
    ["enter_computer_mode", { goal: "Click" }, "main plan"],
    ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }, "computer plan"],
    ["leave_computer_mode", { summary: "Clicked" }],
    [undefined],
  ];
  const sent: string[][] = [];
  fake.stream.mockImplementation(
    (target: Model<"openai-completions">, context: { messages: AssistantMessage[] }) => {
      sent.push(
        context.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : []))
            : [],
        ),
      );
      const [name, args, thinking] = steps.shift()!;
      return response(target, name, args, name, thinking);
    },
  );
  await run(input);
  expect(sent.at(-1)).toContain("main plan");
  expect(sent.at(-1)).not.toContain("computer plan");
});
it("finds screen tools only in computer mode", async () => {
  const input = request();
  input.tools = builtinAgentTools.filter((t) => ["open_path", "launch_app"].includes(t.name));
  script([
    ["find_tool", { query: "open a file" }],
    ["enter_computer_mode", { goal: "Open it" }],
    ["find_tool", { query: "open a file" }],
    ["leave_computer_mode", { summary: "Done" }],
    [undefined],
  ]);
  await run(input);
  const findResults = fake.stream.mock.calls
    .map(
      (c) =>
        (
          c[1] as {
            messages: Array<{ role: string; toolName?: string; content: Array<{ text?: string }> }>;
          }
        ).messages,
    )
    .at(-1)!
    .filter((message) => message.role === "toolResult" && message.toolName === "find_tool")
    .map((message) => message.content.map((part) => part.text ?? "").join(""));
  expect(findResults).toHaveLength(2);
  expect(findResults[0]).not.toContain("open_path");
  expect(findResults[1]).toContain("open_path");
});
it("switches main -> computer -> main before any GUI effect, preserving namespace and effort", async () => {
  const input = request();
  script([
    ["enter_computer_mode", { goal: "Click button" }],
    ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
    ["leave_computer_mode", { summary: "Clicked" }],
    [undefined],
  ]);
  await run(input);
  expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual([
    "main",
    "computer",
    "computer",
    "main",
  ]);
  expect(fake.stream.mock.calls.map((c) => c[2].reasoning)).toEqual([
    "high",
    "medium",
    "medium",
    "high",
  ]);
  const names = (ctx: TranscriptContext) => getCurrentTools(ctx.messages).map((t) => t.name);
  expect(names(fake.stream.mock.calls[0]![1])).not.toContain("browser_act");
  expect(names(fake.stream.mock.calls[1]![1])).toContain("browser_act");
  expect(names(fake.stream.mock.calls[3]![1])).not.toContain("browser_act");
  expect(input.executeTool).toHaveBeenCalledTimes(1);
  expect(vi.mocked(input.executeTool!).mock.calls[0]![2]).toBe('["pi-tool","main","browser_act"]');
});
it.each([false, true])(
  "restores cross-provider approved action once before inference (reverse=%s)",
  async (reverse) => {
    const input = crossProviderRequest(reverse);
    let checkpoint = "";
    let capture: (() => string) | undefined;
    let effects = 0;
    input.onCheckpoint = async (fn) => {
      capture = fn;
    };
    input.executeTool = vi.fn(async () => {
      checkpoint = capture!();
      return approvalPausedToolResult();
    });
    script([
      ["enter_computer_mode", { goal: "Click" }],
      ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
    ]);
    await run(input);
    expect(checkpoint).not.toContain("fake-key");
    expect(JSON.parse(checkpoint).computerMode.mode).toBe("computer");
    const resumed = {
      ...input,
      computerModel: undefined,
      turnCheckpoint: checkpoint,
      resolveModel: vi.fn(async (provider: string, id: string) => ({
        provider,
        id,
        apiKey: "fresh-key",
      })),
      executeTool: vi.fn(async () => {
        effects++;
        return { ok: true };
      }),
    };
    fake.stream.mockReset();
    script([["leave_computer_mode", { summary: "Clicked" }], [undefined]]);
    const implementation = fake.stream.getMockImplementation()!;
    fake.stream.mockImplementation((...args) => {
      expect(effects).toBe(1);
      return implementation(...args);
    });
    await run(resumed);
    expect(effects).toBe(1);
    expect(fake.stream.mock.calls.map((c) => c[0].id)).toEqual([
      input.computerModel!.id,
      input.model.id,
    ]);
    expect(vi.mocked(resumed.executeTool).mock.calls[0]?.slice(0, 4)).toEqual(
      vi.mocked(input.executeTool).mock.calls[0]?.slice(0, 4),
    );
  },
);
it("keeps the computer model's thinking when resuming an approval in computer mode", async () => {
  const input = request();
  let checkpoint = "";
  let capture: (() => string) | undefined;
  input.onCheckpoint = async (fn) => {
    capture = fn;
  };
  input.executeTool = vi.fn(async () => {
    checkpoint = capture!();
    return approvalPausedToolResult();
  });
  const steps: Array<[string, Record<string, unknown>]> = [
    ["enter_computer_mode", { goal: "Click" }],
    ["browser_act", { actions: [{ kind: "click", ref: "button-1" }] }],
  ];
  fake.stream.mockImplementation((target: Model<"openai-completions">) => {
    const [name, args] = steps.shift()!;
    const stream = response(target, name, args);
    if (name !== "browser_act") return stream;
    const reasoned = new AssistantMessageEventStream();
    void stream.result().then((message) => {
      message.content.unshift({
        type: "thinking",
        thinking: "Plan the click",
        thinkingSignature: "sig",
      });
      reasoned.push({ type: "done", reason: "toolUse", message });
      reasoned.end(message);
    });
    return reasoned;
  });
  await run(input);
  expect(JSON.parse(checkpoint).model).toBe("computer");
  fake.stream.mockReset();
  script([["leave_computer_mode", { summary: "Clicked" }], [undefined]]);
  await run({
    ...input,
    computerModel: undefined,
    turnCheckpoint: checkpoint,
    resolveModel: async (provider: string, id: string) => ({ provider, id, apiKey: "fresh-key" }),
    executeTool: vi.fn(async () => ({ ok: true })),
  });
  const [target, context] = fake.stream.mock.calls[0] as [
    Model<"openai-completions">,
    TranscriptContext,
  ];
  expect(target.id).toBe("computer");
  expect(
    context.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) => part.type === "thinking" && part.thinking === "Plan the click",
        ),
    ),
  ).toBe(true);
});
