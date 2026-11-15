import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { cloudAgentsEnabled, createCloudAgentConnection } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { T3CodeCloudAgentProvider } from "./t3code-cloud-agent.js";
import { link, SECRET_BODY, T3_TOKEN, T3McpEmulator } from "./t3code-mcp-emulator.test-support.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

function create(emulator = new T3McpEmulator(), fetch = emulator.fetch) {
  const provider = new T3CodeCloudAgentProvider({
    endpoint: "https://t3.example.test/mcp",
    token: T3_TOKEN,
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  return { emulator, provider };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).not.toContain(SECRET_BODY);
  expect(String((error as Error).message)).not.toContain(T3_TOKEN);
  return error as Error;
}

describe("T3 Code adapter over its MCP wire emulator (offline)", () => {
  it("launches the repository's project in a worktree and replays a lost response", async () => {
    const { emulator, provider } = create();
    const request = {
      idempotencyKey: "create-1",
      prompt: "Add a README\nwith install steps",
      repository: "https://github.com/Example/demo.git",
      openPr: true,
    };
    emulator.loseNextResponse = true;
    await rejection(provider.launch(request, ctx));
    const first = await provider.launch(request, ctx);
    expect(emulator.threads.size).toBe(1);
    // T3 Code reports a new run as preparing, then starting.
    expect(first).toMatchObject({
      status: "running",
      title: "Add a README",
      url: link(first.id),
      latestRunId: "run-1",
    });
    const launch = emulator.calls.findLast((call) => call.tool === "t3_thread_launch")!.args;
    expect(launch).toMatchObject({
      projectId: "project-demo",
      clientRequestId: "create-1",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
    });
    expect(String(launch.message)).toMatch(/^Add a README\nwith install steps\n\n.*pull request/i);
    emulator.complete(first.id);
    const followup = await provider.reply(first.id, { prompt: "Also add tests" }, ctx);
    expect(followup.status).toBe("running");
    expect(emulator.calls.findLast((call) => call.tool === "t3_thread_send")!.args).toMatchObject({
      message: "Also add tests",
      mode: "queue",
    });
  });

  it("launches without a repository in a scratch folder", async () => {
    const { emulator, provider } = create();
    await provider.launch({ idempotencyKey: "scratch", prompt: "Task" }, ctx);
    const launch = emulator.calls.find((call) => call.tool === "t3_thread_launch")!.args;
    expect(launch).toMatchObject({ scratch: true, message: "Task", title: "Task" });
    expect(launch).not.toHaveProperty("projectId");
    expect(launch).not.toHaveProperty("workspaceStrategy");
    expect(emulator.calls.some((call) => call.tool === "t3_project_list")).toBe(false);
  });

  it("finds a fork checkout's project on a later page", async () => {
    const emulator = new T3McpEmulator();
    for (let index = 0; index < 120; index += 1)
      emulator.projects.push({
        id: `project-${index}`,
        title: "x",
        workspaceRoot: `/srv/${index}`,
        repositoryIdentity: null,
      });
    // With an `upstream` remote, T3 Code keys the checkout by upstream and keeps the fork as origin.
    emulator.projects.push({
      id: "project-fork",
      title: "fork",
      workspaceRoot: "/srv/fork",
      repositoryIdentity: {
        canonicalKey: "github.com/upstream/demo",
        locator: { source: "git-remote", remoteName: "upstream", remoteUrl: "https://x" },
        origin: { canonicalKey: "github.com/fork/demo" },
      },
    });
    // An archived checkout of the same repository is passed over.
    emulator.projects.splice(1, 0, {
      ...emulator.projects.at(-1)!,
      id: "project-archived",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    const { provider } = create(emulator);
    await provider.launch(
      { idempotencyKey: "fork", prompt: "Task", repository: "https://github.com/fork/demo/" },
      ctx,
    );
    expect(emulator.calls.find((call) => call.tool === "t3_thread_launch")!.args.projectId).toBe(
      "project-fork",
    );
  });

  it("rejects what T3 Code cannot run before sending it", async () => {
    const { emulator, provider } = create();
    for (const request of [
      { idempotencyKey: "other", prompt: "Task", repository: "https://github.com/example/other" },
      { idempotencyKey: "image", prompt: "Task", images: [{ url: "https://example.test/a.png" }] },
    ]) {
      const error = await rejection(provider.launch(request, ctx));
      expect((error as CloudAgentRequestRejected).reason).toBe("invalid");
    }
    expect(emulator.calls.some((call) => call.tool === "t3_thread_launch")).toBe(false);
  });

  it("observes runs that were interrupted in T3 Code as cancelled", async () => {
    const { emulator, provider } = create();
    const first = await provider.launch({ idempotencyKey: "stopped", prompt: "Task" }, ctx);
    emulator.complete(first.id, "interrupted");
    expect((await provider.get(first.id, ctx)).status).toBe("cancelled");
  });

  it("cancels only the tracked run, leaving queued messages to run", async () => {
    const { emulator, provider } = create();
    const calls = (tool: string) =>
      emulator.calls.filter((call) => call.tool === tool).map((call) => call.args);
    const first = await provider.launch({ idempotencyKey: "queued", prompt: "Task" }, ctx);
    const followup = await provider.reply(first.id, { prompt: "Then this" }, ctx);
    // A queued run leaves the queue; the running one is untouched.
    expect((await provider.cancel(first.id, ctx, followup.latestRunId)).status).toBe("cancelled");
    expect(calls("t3_queue")).toEqual([
      { action: "cancel", threadId: first.id, queuedRunId: followup.latestRunId },
    ]);
    expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe("running");
    // A running run is interrupted by id, and the next queued message still starts.
    const next = await provider.reply(first.id, { prompt: "Next" }, ctx);
    // T3 Code ends the run once its agent stops, so the next poll sees it cancelled.
    expect((await provider.cancel(first.id, ctx, first.latestRunId)).status).toBe("running");
    expect((await provider.cancel(first.id, ctx, first.latestRunId)).status).toBe("cancelled");
    expect(calls("t3_thread_interrupt")).toEqual([
      { threadId: first.id, runId: first.latestRunId },
    ]);
    expect((await provider.get(first.id, ctx, next.latestRunId)).status).toBe("running");
    // A queued run that started meanwhile is refused by the queue, then read as running.
    const last = await provider.reply(first.id, { prompt: "Last" }, ctx);
    emulator.failNext = { failure: "orchestration_error", tool: "t3_queue" };
    expect((await provider.cancel(first.id, ctx, last.latestRunId)).status).toBe("running");
    // Without a run id the newest run is the target.
    expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
    expect(calls("t3_queue").at(-1)).toMatchObject({ queuedRunId: last.latestRunId });
    expect((await provider.get(first.id, ctx, next.latestRunId)).status).toBe("running");
  });

  it("ends a follow-up T3 Code holds, instead of polling it forever, and drops it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { emulator, provider } = create();
      const queues = () => emulator.calls.filter((call) => call.tool === "t3_queue");
      const first = await provider.launch(
        { idempotencyKey: "held", prompt: "Task", repository: "https://github.com/example/demo" },
        ctx,
      );
      // Stopped while its worktree was set up, T3 Code holds what is sent next until a person
      // releases it there.
      await provider.cancel(first.id, ctx, first.latestRunId);
      const held = await provider.reply(first.id, { prompt: "Retry" }, ctx);
      // Between two runs the next one also waits briefly, so a short wait is not a hold.
      expect((await provider.get(first.id, ctx, held.latestRunId)).status).toBe("running");
      vi.setSystemTime(Date.now() + 61_000);
      expect(await provider.get(first.id, ctx, held.latestRunId)).toMatchObject({
        status: "failed",
        latestRunId: held.latestRunId,
      });
      expect(queues().map((call) => call.args)).toEqual([
        { action: "cancel", threadId: first.id, queuedRunId: held.latestRunId },
      ]);
      expect(emulator.threads.get(first.id)!.runs.at(-1)!.status).toBe("cancelled");
      // A hold this connection may not drop, as on a thread above its access, still ends the agent.
      const other = await provider.launch(
        { idempotencyKey: "held-2", prompt: "Task", repository: "https://github.com/example/demo" },
        ctx,
      );
      await provider.cancel(other.id, ctx, other.latestRunId);
      const again = await provider.reply(other.id, { prompt: "Again" }, ctx);
      vi.setSystemTime(Date.now() + 61_000);
      emulator.failNext = { failure: "capability_denied", tool: "t3_queue" };
      expect((await provider.get(other.id, ctx, again.latestRunId)).status).toBe("failed");
      // A message queued behind a run T3 Code is still working on is not held.
      const busy = await provider.launch({ idempotencyKey: "busy", prompt: "Task" }, ctx);
      const queued = await provider.reply(busy.id, { prompt: "Next" }, ctx);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await provider.get(busy.id, ctx, queued.latestRunId)).status).toBe("running");
      expect(queues()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a held follow-up when T3 Code refuses a later status read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const emulator = new T3McpEmulator();
      let reads = 0;
      let refused = 0;
      const { provider } = create(emulator, async (input, init) => {
        if (String(init?.body ?? "").includes('"t3_thread_read"') && ++reads === refused)
          emulator.failNext = { invalidParams: true, tool: "t3_thread_read" };
        return emulator.fetch(input, init);
      });
      const first = await provider.launch(
        { idempotencyKey: "held", prompt: "Task", repository: "https://github.com/example/demo" },
        ctx,
      );
      await provider.cancel(first.id, ctx, first.latestRunId);
      const held = await provider.reply(first.id, { prompt: "Retry" }, ctx);
      vi.setSystemTime(Date.now() + 61_000);
      // The read that confirms the hold.
      refused = reads + 2;
      const confirming = await rejection(provider.get(first.id, ctx, held.latestRunId));
      expect((confirming as CloudAgentRequestRejected).reason).toBe("not_found");
      // The read after the run left the queue before it could be dropped.
      refused = reads + 3;
      emulator.failNext = { failure: "orchestration_error", tool: "t3_queue" };
      const after = await rejection(provider.get(first.id, ctx, held.latestRunId));
      expect((after as CloudAgentRequestRejected).reason).toBe("not_found");
      expect(reads).toBe(refused);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a run T3 Code starts itself once the tracked run finished", async () => {
    const { emulator, provider } = create();
    const first = await provider.launch({ idempotencyKey: "continued", prompt: "Task" }, ctx);
    emulator.complete(first.id);
    // A background task the agent left finishes, and T3 Code continues the thread on its own.
    emulator.continueRun(first.id);
    const continued = await provider.get(first.id, ctx, first.latestRunId);
    expect(continued).toMatchObject({ status: "running", latestRunId: "run-2" });
    expect((await provider.get(first.id, ctx, continued.latestRunId)).status).toBe("running");
    emulator.complete(first.id);
    expect(await provider.get(first.id, ctx, continued.latestRunId)).toMatchObject({
      status: "finished",
      latestRunId: "run-2",
    });
    // A tracked run that left the recent list is still the one followed, and has ended whatever
    // runs now, so cancelling its card stops nothing.
    for (let index = 0; index < 50; index += 1) {
      emulator.continueRun(first.id);
      emulator.complete(first.id);
    }
    emulator.continueRun(first.id);
    expect(await provider.get(first.id, ctx, continued.latestRunId)).toMatchObject({
      status: "finished",
      latestRunId: "run-2",
    });
    expect((await provider.cancel(first.id, ctx, continued.latestRunId)).status).toBe("finished");
    expect(emulator.threads.get(first.id)!.runs.at(-1)!.status).toBe("running");
  });

  it("cancels a run waiting for approval", async () => {
    const { emulator, provider } = create();
    const first = await provider.launch({ idempotencyKey: "approval", prompt: "Task" }, ctx);
    emulator.awaitApproval(first.id);
    expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe("running");
    await provider.cancel(first.id, ctx, first.latestRunId);
    expect((await provider.cancel(first.id, ctx, first.latestRunId)).status).toBe("cancelled");
    expect(emulator.threads.get(first.id)!.pendingRequestCount).toBe(0);
  });
});

describe("T3 Code failures", () => {
  it("ends a rejected token as expired and drops it for a reconnect", async () => {
    const emulator = new T3McpEmulator();
    let rejected = 0;
    const provider = new T3CodeCloudAgentProvider({
      endpoint: "https://t3.example.test/mcp",
      token: T3_TOKEN,
      fetch: emulator.fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      onTokenRejected: async () => {
        rejected++;
        throw new Error("no refresh token");
      },
    });
    const first = await provider.launch({ idempotencyKey: "cred", prompt: "Task" }, ctx);
    emulator.token = "rotated";
    const revoked = await rejection(provider.get(first.id, ctx));
    expect((revoked as CloudAgentRequestRejected).reason).toBe("expired");
    expect(rejected).toBe(1);
    emulator.token = T3_TOKEN;
    // Access the connection was not granted needs a reconnect, so polling cannot fix it.
    emulator.failNext = { failure: "capability_denied" };
    const denied = await rejection(provider.reply(first.id, { prompt: "More" }, ctx));
    expect((denied as CloudAgentRequestRejected).reason).toBe("invalid");
    emulator.failNext = { status: 403 };
    const forbidden = await rejection(provider.get(first.id, ctx));
    expect((forbidden as CloudAgentRetryLater).reason).toBe("credential");
    emulator.failNext = { status: 429 };
    const limited = await rejection(provider.get(first.id, ctx));
    expect((limited as CloudAgentRetryLater).reason).toBe("rate_limited");
    expect(rejected).toBe(1);
  });

  it("retries a rejected token later when a new one replaced it", async () => {
    const emulator = new T3McpEmulator();
    const provider = new T3CodeCloudAgentProvider({
      endpoint: "https://t3.example.test/mcp",
      token: T3_TOKEN,
      fetch: emulator.fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      onTokenRejected: async () => undefined,
    });
    const first = await provider.launch({ idempotencyKey: "swap", prompt: "Task" }, ctx);
    emulator.token = "rotated";
    const error = await rejection(provider.get(first.id, ctx));
    expect((error as CloudAgentRetryLater).reason).toBe("credential");
  });

  it("refuses every call without a token, without reaching T3 Code", async () => {
    const emulator = new T3McpEmulator();
    const provider = new T3CodeCloudAgentProvider({
      endpoint: "",
      token: undefined,
      fetch: emulator.fetch,
    });
    for (const call of [
      provider.launch({ idempotencyKey: "none", prompt: "Task" }, ctx),
      provider.get("thread-1", ctx),
      provider.reply("thread-1", { prompt: "More" }, ctx),
      provider.cancel("thread-1", ctx),
    ])
      expect(((await rejection(call)) as CloudAgentRequestRejected).reason).toBe("expired");
    expect(emulator.calls).toHaveLength(0);
  });

  it("launches on the first model of a provider that can run when T3 Code has no default, once", async () => {
    const { emulator, provider } = create();
    emulator.noDefaultModel = true;
    const first = await provider.launch({ idempotencyKey: "model", prompt: "Task" }, ctx);
    expect(first.status).toBe("running");
    const launches = emulator.calls.filter((call) => call.tool === "t3_thread_launch");
    expect(launches).toHaveLength(2);
    expect(launches[0]!.args).not.toHaveProperty("modelSelection");
    expect(launches[1]!.args.modelSelection).toEqual({ instanceId: "agent-b", model: "model-a" });
    expect(emulator.calls.filter((call) => call.tool === "orchestrator_capabilities")).toHaveLength(
      1,
    );
    // A launch still refused with a model fails the agent instead of retrying again.
    const before = emulator.calls.length;
    const fetch: typeof emulator.fetch = async (input, init) => {
      const body = String(init?.body ?? "");
      if (body.includes('"modelSelection"'))
        emulator.failNext = {
          failure: "invalid_request",
          tool: "t3_thread_launch",
        };
      return emulator.fetch(input, init);
    };
    const { provider: stubborn } = create(emulator, fetch);
    const refused = await rejection(
      stubborn.launch({ idempotencyKey: "model-2", prompt: "Task" }, ctx),
    );
    expect((refused as CloudAgentRequestRejected).reason).toBe("invalid");
    expect(
      emulator.calls.slice(before).filter((call) => call.tool === "t3_thread_launch").length,
    ).toBe(2);
  });

  it("fails the launch when T3 Code offers no model", async () => {
    const { emulator, provider } = create();
    emulator.noDefaultModel = true;
    emulator.providers = [{ providerInstanceId: "idle", models: [] }];
    const empty = provider;
    const refused = await rejection(
      empty.launch({ idempotencyKey: "nomodel", prompt: "Task" }, ctx),
    );
    expect((refused as CloudAgentRequestRejected).reason).toBe("invalid");
  });

  it("maps T3 Code failures to the contract", async () => {
    const { emulator, provider } = create();
    const missing = await rejection(provider.get("thread-missing", ctx));
    expect((missing as CloudAgentRequestRejected).reason).toBe("not_found");
    // A launch refused for T3 Code's settings, such as no default model, fails the agent.
    emulator.failNext = { failure: "invalid_request", tool: "t3_thread_launch" };
    const refused = await rejection(
      provider.launch({ idempotencyKey: "map", prompt: "Task" }, ctx),
    );
    expect((refused as CloudAgentRequestRejected).reason).toBe("invalid");
    const first = await provider.launch({ idempotencyKey: "map", prompt: "Task" }, ctx);
    for (const failure of ["thread_not_sendable", "runtime_mode_escalation_denied"]) {
      emulator.failNext = { failure, tool: "t3_thread_send" };
      const error = await rejection(provider.reply(first.id, { prompt: "More" }, ctx));
      expect((error as CloudAgentRequestRejected).reason).toBe("invalid");
    }
    // A failed read before the send means nothing was sent, so the message can be resent.
    const sends = () => emulator.calls.filter((call) => call.tool === "t3_thread_send").length;
    const sent = sends();
    emulator.failNext = { status: 500, tool: "t3_thread_read" };
    const unread = await rejection(provider.reply(first.id, { prompt: "More" }, ctx));
    expect((unread as CloudAgentRetryLater).reason).toBe("unavailable");
    expect(sends()).toBe(sent);
    // A failure after T3 Code may have accepted the message is ambiguous, never retryable.
    for (const failNext of [
      { internal: true as const },
      { status: 500 },
      { failure: "orchestration_error" },
    ]) {
      emulator.failNext = { ...failNext, tool: "t3_thread_send" };
      const error = await rejection(provider.reply(first.id, { prompt: "More" }, ctx));
      expect(error).not.toBeInstanceOf(CloudAgentRetryLater);
      expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
    }
  });

  it("fails a request this T3 Code does not take instead of retrying it forever", async () => {
    const emulator = new T3McpEmulator();
    const { provider } = create(emulator, async (input, init) =>
      emulator.fetch(input, {
        ...init,
        body: String(init?.body ?? "").replace('"t3_thread_launch"', '"t3_thread_launch_v0"'),
      }),
    );
    // An older T3 Code answers an unknown tool, or arguments it does not take, as invalid params.
    const error = await rejection(provider.launch({ idempotencyKey: "old", prompt: "Task" }, ctx));
    expect((error as CloudAgentRequestRejected).reason).toBe("invalid");
    const { provider: current } = create(emulator);
    const first = await current.launch({ idempotencyKey: "new", prompt: "Task" }, ctx);
    emulator.failNext = { invalidParams: true, tool: "t3_thread_send" };
    const refused = await rejection(current.reply(first.id, { prompt: "More" }, ctx));
    expect((refused as CloudAgentRequestRejected).reason).toBe("invalid");
    // A stop it refuses leaves the run going; a status read it refuses ends the card.
    emulator.failNext = { failure: "capability_denied", tool: "t3_thread_interrupt" };
    expect((await current.cancel(first.id, ctx, first.latestRunId)).status).toBe("running");
    emulator.failNext = { invalidParams: true, tool: "t3_thread_read" };
    const unread = await rejection(current.get(first.id, ctx, first.latestRunId));
    expect((unread as CloudAgentRequestRejected).reason).toBe("not_found");
    emulator.failNext = { invalidParams: true, tool: "t3_thread_read" };
    const unstopped = await rejection(current.cancel(first.id, ctx, first.latestRunId));
    expect((unstopped as CloudAgentRequestRejected).reason).toBe("not_found");
  });

  it("refuses redirects, plain http and malformed results", async () => {
    const redirect = new T3CodeCloudAgentProvider({
      endpoint: "https://t3.example.test/mcp",
      token: T3_TOKEN,
      fetch: async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example.test/mcp" },
        }),
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    await rejection(redirect.get("thread-1", ctx));
    const plain = new T3CodeCloudAgentProvider({
      endpoint: "http://t3.example.test/mcp",
      token: T3_TOKEN,
      fetch: new T3McpEmulator().fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    await rejection(plain.launch({ idempotencyKey: "plain", prompt: "Task" }, ctx));
    const { emulator, provider } = create();
    const first = await provider.launch({ idempotencyKey: "bad", prompt: "Task" }, ctx);
    emulator.threads.get(first.id)!.runs = [];
    expect((await provider.get(first.id, ctx)).status).toBe("finished");
    emulator.threads.get(first.id)!.threadId = "thread-other";
    await rejection(provider.get(first.id, ctx));
    // A project page whose cursor does not advance would be listed forever.
    const stuck = new T3McpEmulator();
    const { provider: paging } = create(stuck, async (input, init) => {
      const response = await stuck.fetch(input, init);
      const text = await response.text();
      return new Response(text.replaceAll('"nextCursor":null', '"nextCursor":0'), response);
    });
    const error = await rejection(
      paging.launch({ idempotencyKey: "stuck", prompt: "Task", repository: "github.com/x/y" }, ctx),
    );
    expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
  });
});

describe("T3 Code cloud agent composition", () => {
  it("is never configured from the environment", () => {
    const source = {
      CLOUD_AGENT_PROVIDER: "t3code",
      T3CODE_MCP_URL: "https://t3.example.test/mcp",
      T3CODE_MCP_TOKEN: T3_TOKEN,
      CLOUD_AGENT_SPACE_ID: "test-space",
    };
    expect(resolveCloudAgentProvider(source)).toBe("none");
    expect(createCloudAgentConnection(source)).toBeNull();
    expect(cloudAgentsEnabled(null, "test-space")).toBe(false);
  });
});
