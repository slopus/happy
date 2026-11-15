import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

const fake = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  type Tool = {
    name: string;
    execute(id: string, args: Record<string, unknown>): Promise<unknown>;
  };
  class Agent {
    state = { messages: [], errorMessage: undefined };
    aborted = deferred();
    release = deferred();
    idle = deferred();
    settled = false;
    listener?: (event: unknown) => void;
    tools: Tool[];
    abort = vi.fn(() => this.aborted.resolve());

    constructor(options: { initialState: { tools: Tool[] } }) {
      this.tools = options.initialState.tools;
      state.agents.push(this);
    }
    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
    }
    async prompt() {
      try {
        this.listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "started" },
        });
        if (state.delegate && state.agents[0] === this) {
          await this.tools
            .find((tool) => tool.name === "run_subagent")!
            .execute("child", {
              task: "fake task",
            });
        }
        await this.release.promise;
      } finally {
        this.settled = true;
        this.idle.resolve();
      }
    }
    async waitForIdle() {
      await this.idle.promise;
    }
  }
  const state = { agents: [] as Agent[], delegate: false };
  return { Agent, state, deferred };
});

vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: fake.Agent }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: () => ({ provider: "test", id: "fake-model" }),
    streamSimple: () => {
      throw new Error("No model requests are allowed");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const request: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "fake task",
  instructions: "test",
  history: [],
  tools: builtinAgentTools,
  model: { provider: "test", id: "fake-model" },
};

async function microtasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("Pi runtime cancellation", () => {
  beforeEach(() => {
    fake.state.agents = [];
    fake.state.delegate = false;
  });
  afterEach(async () => {
    for (const agent of fake.state.agents) agent.release.resolve();
    await microtasks();
  });

  it.each([false, true])(
    "aborts and settles stream closure with external signal=%s",
    async (external) => {
      const runtime = new PiAgentRuntime();
      const controller = new AbortController();
      const stream = runtime
        .run(request, external ? { signal: controller.signal } : undefined)
        [Symbol.asyncIterator]();
      await stream.next();
      const agent = fake.state.agents[0]!;
      let closed = false;
      const closing = stream.return!().then(() => {
        closed = true;
      });
      await microtasks();
      expect(agent.abort).toHaveBeenCalled();
      expect(closed).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      agent.release.resolve();
      await closing;
      expect(agent.settled).toBe(true);
    },
  );

  it("closes a quiet stream even when next is already pending", async () => {
    const runtime = new PiAgentRuntime();
    const stream = runtime.run(request)[Symbol.asyncIterator]();
    await stream.next();
    const next = stream.next();
    const closing = stream.return!();
    await microtasks();
    const agent = fake.state.agents[0]!;
    expect(agent.abort).toHaveBeenCalled();
    agent.release.resolve();
    await Promise.all([next, closing]);
    expect(agent.settled).toBe(true);
  });

  it("runtime.abort still cancels with a supplied context and awaits work", async () => {
    const runtime = new PiAgentRuntime();
    const stream = runtime
      .run(request, { signal: new AbortController().signal })
      [Symbol.asyncIterator]();
    await stream.next();
    let stopped = false;
    const stopping = runtime.abort(request.runId).then(() => {
      stopped = true;
    });
    await microtasks();
    const agent = fake.state.agents[0]!;
    expect(agent.abort).toHaveBeenCalled();
    expect(stopped).toBe(false);
    agent.release.resolve();
    await stopping;
    expect(agent.settled).toBe(true);
    await stream.return!();
  });

  it("propagates external abort and does not finish before the agent settles", async () => {
    const controller = new AbortController();
    const runtime = new PiAgentRuntime();
    const stream = runtime.run(request, { signal: controller.signal })[Symbol.asyncIterator]();
    await stream.next();
    controller.abort();
    const agent = fake.state.agents[0]!;
    expect(agent.abort).toHaveBeenCalled();
    let closed = false;
    const closing = stream.return!().then(() => {
      closed = true;
    });
    await microtasks();
    expect(closed).toBe(false);
    agent.release.resolve();
    await closing;
    expect(agent.settled).toBe(true);
  });

  it("does not start a prompt after cancellation during asynchronous setup", async () => {
    const setup = fake.deferred();
    const runtime = new PiAgentRuntime();
    const stream = runtime
      .run({
        ...request,
        claimSteering: async () => {
          await setup.promise;
          return [];
        },
      })
      [Symbol.asyncIterator]();
    const first = stream.next();
    const closing = stream.return!();
    setup.resolve();
    await Promise.all([first, closing]);
    expect(fake.state.agents.every((agent) => !agent.listener)).toBe(true);
  });

  it("does not dispatch another tool after cancellation", async () => {
    const executeTool = vi.fn();
    const runtime = new PiAgentRuntime();
    const stream = runtime.run({ ...request, executeTool })[Symbol.asyncIterator]();
    await stream.next();
    const stopping = runtime.abort(request.runId);
    const agent = fake.state.agents[0]!;
    await expect(
      agent.tools.find((tool) => tool.name === "shell")!.execute("late", { command: "true" }),
    ).rejects.toThrow();
    expect(executeTool).not.toHaveBeenCalled();
    agent.release.resolve();
    await stopping;
    await stream.return!();
  });

  it("settles work before propagating a consumer's injected error", async () => {
    const runtime = new PiAgentRuntime();
    const stream = runtime.run(request)[Symbol.asyncIterator]();
    await stream.next();
    const failure = new Error("consumer failed");
    let finished = false;
    const closing = stream.throw!(failure).catch((error) => {
      finished = true;
      return error;
    });
    await microtasks();
    const agent = fake.state.agents[0]!;
    expect(agent.abort).toHaveBeenCalled();
    expect(finished).toBe(false);
    agent.release.resolve();
    expect(await closing).toBe(failure);
    expect(agent.settled).toBe(true);
  });

  it("aborts and settles nested agent work before returning", async () => {
    fake.state.delegate = true;
    const runtime = new PiAgentRuntime();
    const stream = runtime.run(request)[Symbol.asyncIterator]();
    await stream.next();
    await microtasks();
    expect(fake.state.agents).toHaveLength(2);
    let closed = false;
    const closing = stream.return!().then(() => {
      closed = true;
    });
    await microtasks();
    for (const agent of fake.state.agents) expect(agent.abort).toHaveBeenCalled();
    expect(closed).toBe(false);
    for (const agent of fake.state.agents) agent.release.resolve();
    await closing;
    expect(fake.state.agents.every((agent) => agent.settled)).toBe(true);
  });

  it("does not erase a replacement attempt when the previous stream closes", async () => {
    const runtime = new PiAgentRuntime();
    const first = runtime.run(request)[Symbol.asyncIterator]();
    await first.next();
    const second = runtime.run(request)[Symbol.asyncIterator]();
    await second.next();
    fake.state.agents[0]!.release.resolve();
    await first.return!();
    const stopping = runtime.abort(request.runId);
    await microtasks();
    expect(fake.state.agents[1]!.abort).toHaveBeenCalled();
    fake.state.agents[1]!.release.resolve();
    await stopping;
    await second.return!();
  });
});
