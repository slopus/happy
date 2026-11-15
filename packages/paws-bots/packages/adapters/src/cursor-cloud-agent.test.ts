import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CursorCloudAgentEmulator } from "./cloud-agent-emulator.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

describe("Cursor HTTP boundary", () => {
  it("keeps a duplicate create recoverable when the accepted agent is not yet readable", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (_url, init) =>
        new Response(null, { status: init?.method === "POST" ? 409 : 404 }),
    });
    const error = await provider
      .launch({ idempotencyKey: "operation", prompt: "Task" }, context)
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
  });
  it("sends the documented create shape with a stable client agent ID", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const result = await provider.launch(
      {
        idempotencyKey: "operation",
        prompt: "Task",
        repository: "https://github.com/example/demo",
        openPr: false,
        images: [{ data: "ZmFrZQ==", mimeType: "image/png" }],
      },
      context,
    );
    expect(wire.requests[0]).toEqual({
      method: "POST",
      path: "/v1/agents",
      body: {
        agentId: result.id,
        prompt: { text: "Task", images: [{ data: "ZmFrZQ==", mimeType: "image/png" }] },
        repos: [{ url: "https://github.com/example/demo" }],
        autoCreatePR: false,
      },
    });
    expect(result.id).toMatch(
      /^bc-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });
  it.each([400, 401, 403, 404, 422, 429, 500, 503])(
    "never exposes a %s response body",
    async (status) => {
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async () => new Response("fake-key and fake-secret", { status }),
      });
      const error = await provider.get("test-agent", context).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/fake-key|fake-secret/);
    },
  );
  it("rejects malformed and oversized response bodies", async () => {
    for (const body of ['{"bad":true}', "invalid fake-secret", " ".repeat(1_000_001)]) {
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async () => new Response(body),
      });
      await expect(provider.get("test-agent", context)).rejects.toThrow();
    }
  });
  it("bounds hanging body reads even if stream cancellation never settles", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      timeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
        ),
    });
    await expect(provider.get("test-agent", context)).rejects.toThrow();
  });
  it("uses a fixed credential origin and rejects redirects", async () => {
    let redirect: RequestRedirect | undefined;
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (url, init) => {
        expect(String(url).startsWith("https://api.cursor.com/v1/agents/")).toBe(true);
        redirect = init?.redirect;
        return new Response(null, { status: 302 });
      },
    });
    await expect(provider.get("test-agent", context)).rejects.toThrow();
    expect(redirect).toBe("error");
  });
  it("does not turn a successful follow-up into failure by fetching metadata afterward", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "follow-up", prompt: "Task" }, context);
    wire.complete(agent.id);
    wire.requests.length = 0;
    await provider.reply(agent.id, { prompt: "Tests" }, context);
    expect(wire.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  });
  it("reads the newest run from the run list, not stale agent metadata", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "list", prompt: "Task" }, context);
    wire.complete(agent.id);
    const followup = await provider.reply(agent.id, { prompt: "Tests" }, context);
    wire.staleLatestRunId = agent.latestRunId;
    expect((await provider.get(agent.id, context)).latestRunId).toBe(followup.latestRunId);
  });
  it("reports a follow-up whose pre-send read failed as never sent", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "unsent", prompt: "Task" }, context);
    wire.complete(agent.id);
    wire.failNextRequest = 503;
    const error = await provider.reply(agent.id, { prompt: "Tests" }, context).catch((e) => e);
    expect(error).toMatchObject({ name: "CloudAgentRetryLater", reason: "unavailable" });
    expect(wire.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
  it("keeps a follow-up to a busy agent ambiguous instead of rejecting it", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "busy", prompt: "Task" }, context);
    const error = await provider.reply(agent.id, { prompt: "Tests" }, context).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
  });
  it.each([
    ["CREATING", "running"],
    ["RUNNING", "running"],
    ["FINISHED", "finished"],
    ["ERROR", "failed"],
    ["CANCELLED", "cancelled"],
    ["EXPIRED", "expired"],
    ["SOME_FUTURE_STATUS", "running"],
  ])("maps run status %s to %s", async (wireStatus, status) => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: wireStatus, prompt: "Task" }, context);
    wire.setRunStatus(agent.id, wireStatus);
    expect((await provider.get(agent.id, context)).status).toBe(status);
  });
  it("reports an archived agent as expired and refuses follow-ups as expired", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "archived", prompt: "Task" }, context);
    wire.archive(agent.id);
    expect((await provider.get(agent.id, context)).status).toBe("expired");
    wire.setRunStatus(agent.id, "FINISHED");
    expect((await provider.get(agent.id, context)).status).toBe("finished");
    const error = await provider.reply(agent.id, { prompt: "More" }, context).catch((e) => e);
    expect(error).toMatchObject({ name: "CloudAgentRequestRejected", reason: "expired" });
    expect(wire.requests.at(-1)?.method).toBe("GET");
  });
  it.each([
    [400, CloudAgentRequestRejected, { reason: "invalid" }],
    [409, CloudAgentRequestRejected, { reason: "invalid" }],
    [422, CloudAgentRequestRejected, { reason: "invalid" }],
    [404, CloudAgentRequestRejected, { reason: "not_found" }],
    [401, CloudAgentRetryLater, { reason: "credential" }],
    [403, CloudAgentRetryLater, { reason: "credential" }],
    [429, CloudAgentRetryLater, { reason: "rate_limited", retryAfterMs: 30_000 }],
  ])("classifies a %s response", async (status, type, fields) => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "classify", prompt: "Task" }, context);
    wire.failNextRequest = status;
    const error = await provider.get(agent.id, context).catch((e) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject(fields);
  });
  it("classifies a removed agent, a removed run, and a revoked key from the wire", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "gone", prompt: "Task" }, context);
    await expect(provider.get(agent.id, context, "missing-run")).rejects.toMatchObject({
      reason: "not_found",
    });
    wire.apiKey = "rotated-key";
    await expect(provider.get(agent.id, context)).rejects.toBeInstanceOf(CloudAgentRetryLater);
    wire.apiKey = "fake-key";
    wire.agents.delete(agent.id);
    await expect(provider.cancel(agent.id, context)).rejects.toMatchObject({
      reason: "not_found",
    });
  });
  it("observes a run that ended before its cancel request arrived", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (String(input).endsWith("/cancel"))
          wire.complete(wire.requests[0]!.body!.agentId as string);
        return wire.fetch(input, init);
      },
    });
    const agent = await provider.launch({ idempotencyKey: "race", prompt: "Task" }, context);
    expect((await provider.cancel(agent.id, context)).status).toBe("finished");
  });
});
