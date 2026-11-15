import { describe, expect, it, vi } from "vitest";
import { callRemoteMcpTool, RemoteMcpSessionCache } from "./remote-mcp.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];
const ENDPOINT = "https://mcp.example.test/mcp";

type JsonRpc = {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

/** Streamable HTTP server over an injected fetch, answering JSON per POST. */
function mcpServer(
  handler: (options: {
    message: JsonRpc;
    session: string | null;
    respond: (body: Record<string, unknown>, init?: ResponseInit) => Response;
  }) => Response | undefined,
) {
  const toolCalls: Array<{ session: string | null; tool: string }> = [];
  const deletes: Array<string | null> = [];
  let initializations = 0;
  const sessions = new Set<string>();
  const nextSession = () => {
    initializations += 1;
    const id = `session-${initializations}`;
    sessions.add(id);
    return id;
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const session = request.headers.get("mcp-session-id");
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") {
      deletes.push(session);
      return new Response(null, { status: 202 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(await request.text()) as JsonRpc;
    const respond = (body: Record<string, unknown>, responseInit?: ResponseInit) =>
      Response.json({ jsonrpc: "2.0", id: message.id, ...body }, responseInit);
    if (message.method === "initialize") {
      const id = nextSession();
      return respond(
        {
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          },
        },
        { headers: { "mcp-session-id": id } },
      );
    }
    if (message.method === "tools/call")
      toolCalls.push({ session, tool: message.params?.name ?? "" });
    // Like a stateful server: a session it no longer knows is a 404.
    if (!session || !sessions.has(session)) return new Response(null, { status: 404 });
    return handler({ message, session, respond }) ?? new Response(null, { status: 202 });
  });
  return {
    fetch,
    sessions,
    toolCalls,
    deletes,
    initializations: () => initializations,
  };
}

/** A server whose answers only depend on the calling session being known. */
function statefulServer() {
  return mcpServer(({ message, session, respond }) => {
    if (message.method === "tools/call") {
      if (!session) throw new Error("tools/call without a session header");
      return respond({ result: { content: [{ type: "text", text: `ok:${session}` }] } });
    }
    return undefined;
  });
}

function scopedCall(
  pool: RemoteMcpSessionCache,
  scope: string,
  server: ReturnType<typeof mcpServer>,
  signal?: AbortSignal,
  runId?: string,
  tool = "do_work",
) {
  return callRemoteMcpTool(
    {
      endpoint: ENDPOINT,
      fetch: server.fetch as unknown as typeof globalThis.fetch,
      resolveHostname: publicResolver,
      sessionScope: scope,
      sessionPool: pool,
      signal,
      sessionRunId: runId,
    },
    tool,
    {},
  );
}

describe("run-scoped remote MCP sessions", () => {
  it("bounds each operation with a fresh timeout and closes the session it timed out on", async () => {
    let hangNext = true;
    const server = mcpServer(({ message, respond }) => {
      if (message.method !== "tools/call") return undefined;
      if (!hangNext) return respond({ result: { content: [{ type: "text", text: "done" }] } });
      hangNext = false;
      return new Promise<Response>(() => undefined) as unknown as Response;
    });
    const pool = new RemoteMcpSessionCache();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hanging = scopedCall(pool, "run-1 srv", server);
      await vi.waitFor(() => expect(server.toolCalls).toHaveLength(1));
      const call = server.fetch.mock.calls.find(
        ([, init]) => typeof init?.body === "string" && init.body.includes('"tools/call"'),
      );
      vi.advanceTimersByTime(30_000);
      await expect(hanging).rejects.toThrow();
      // The timed-out HTTP request is aborted and the server told to drop the session.
      await vi.waitFor(() => expect(call?.[1]?.signal?.aborted).toBe(true));
      await vi.waitFor(() => expect(server.deletes).toEqual(["session-1"]));

      await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
        content: [{ text: "done" }],
      });
      expect(server.initializations()).toBe(2);
    } finally {
      vi.useRealTimers();
      await pool.close();
    }
  });

  it.each([
    ["the deadline fires first", true],
    ["the caller cancels first", false],
  ])(
    "closes the session only when the deadline ends the call: %s",
    async (_case, deadlineFirst) => {
      let hangNext = true;
      const server = mcpServer(({ message, respond }) => {
        if (message.method !== "tools/call") return undefined;
        if (!hangNext) return respond({ result: { content: [{ type: "text", text: "done" }] } });
        hangNext = false;
        return new Promise<Response>(() => undefined) as unknown as Response;
      });
      const pool = new RemoteMcpSessionCache();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const caller = new AbortController();
        const hanging = scopedCall(pool, "run-1 srv", server, caller.signal);
        await vi.waitFor(() => expect(server.toolCalls).toHaveLength(1));
        // Both fire before the call's rejection is handled; the first one decides.
        const expire = () => vi.advanceTimersByTime(30_000);
        if (deadlineFirst) {
          expire();
          caller.abort();
        } else {
          caller.abort();
          expire();
        }
        await expect(hanging).rejects.toThrow();

        await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
          content: [{ text: "done" }],
        });
        expect(server.initializations()).toBe(deadlineFirst ? 2 : 1);
      } finally {
        vi.useRealTimers();
        await pool.close();
      }
    },
  );

  it("does not cancel a settled request when its deadline passes or its caller aborts", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache();
    const caller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await scopedCall(pool, "run-1 srv", server);
      await scopedCall(pool, "run-1 srv", server, caller.signal);
      const requests = server.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      caller.abort();
      // Flush any cancellation POST through the injected fetch.
      await vi.advanceTimersByTimeAsync(0);
      expect(server.fetch).toHaveBeenCalledTimes(requests);
      expect(server.deletes).toEqual([]);
    } finally {
      vi.useRealTimers();
      await pool.close();
    }
  });

  it("closes an idle session, so the next call opens a fresh one", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache(40);
    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-1" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(pool.reapIdle()).resolves.toBe(1);

    expect(server.deletes).toEqual(["session-1"]);
    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("closes one run's sessions on endRun and leaves other runs open", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache();
    await scopedCall(pool, "run-1 srv", server, undefined, "run-1");
    await scopedCall(pool, "run-2 srv", server, undefined, "run-2");

    pool.endRun("run-1");

    await vi.waitFor(() => expect(server.deletes).toEqual(["session-1"]));
    await expect(scopedCall(pool, "run-2 srv", server, undefined, "run-2")).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("bounds a run that ended elsewhere by the idle reap, without leftover run state", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache(40);
    await scopedCall(pool, "run-1 srv", server, undefined, "run-1");

    // The run finished on another worker: no endRun arrives here, so the idle
    // bound is what closes this process's session for it.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(pool.reapIdle()).resolves.toBe(1);
    expect(server.deletes).toEqual(["session-1"]);

    // No per-run bookkeeping outlives the session: ending the run now is a no-op.
    pool.endRun("run-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.deletes).toEqual(["session-1"]);
    await pool.close();
  });

  it("replays a call exactly once after the server forgot the session", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache();
    await scopedCall(pool, "run-1 srv", server);

    // The server expired the session between two calls of the run.
    server.sessions.clear();
    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    // One POST for the first call, then the expired attempt and its single replay.
    expect(server.toolCalls).toHaveLength(3);
    expect(server.toolCalls.map((call) => call.session)).toEqual([
      "session-1",
      "session-1",
      "session-2",
    ]);
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("stops after one replay when the fresh session is unknown too", async () => {
    const server = mcpServer(({ message, respond }) => {
      if (message.method === "tools/call") {
        // The server answers 404: it never knew this session.
        return new Response(null, { status: 404 });
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
      return respond({ result: {} });
    });
    const pool = new RemoteMcpSessionCache();

    await expect(scopedCall(pool, "run-1 srv", server)).rejects.toThrow(/404|Error POSTing/);

    expect(server.toolCalls).toHaveLength(2);
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("keeps a session whose server answered a -32000 JSON-RPC error", async () => {
    const server = mcpServer(({ message, session, respond }) => {
      if (message.method === "tools/call") {
        if (!session) throw new Error("tools/call without a session header");
        if (message.params?.name === "fail_once") {
          // A recoverable application error in a JSON-RPC error response: the
          // connection is healthy, so the session and its server state stay.
          return respond({ error: { code: -32000, message: "app failed, retry later" } });
        }
        return respond({ result: { content: [{ type: "text", text: `ok:${session}` }] } });
      }
      return undefined;
    });
    const pool = new RemoteMcpSessionCache();
    await expect(
      scopedCall(pool, "run-1 srv", server, undefined, undefined, "fail_once"),
    ).rejects.toThrow(/app failed/);
    expect(server.deletes).toEqual([]);

    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-1" }],
    });
    expect(server.initializations()).toBe(1);
    await pool.close();
  });

  it("does not replay a call that failed ambiguously", async () => {
    let failCalls = true;
    const server = mcpServer(({ message, session, respond }) => {
      if (message.method === "tools/call") {
        // A server error says nothing about the session, which stays usable.
        if (failCalls) return new Response(null, { status: 500 });
        return respond({
          result: { content: [{ type: "text", text: `ok:${session}` }] },
        });
      }
      return undefined;
    });
    const pool = new RemoteMcpSessionCache();

    await expect(scopedCall(pool, "run-1 srv", server)).rejects.toThrow(/500|Error POSTing/);
    // The request may have run, so it is never replayed within one call.
    expect(server.toolCalls).toHaveLength(1);

    failCalls = false;
    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-1" }],
    });
    expect(server.initializations()).toBe(1);
    await pool.close();
  });

  it("drops a session whose transport failed, so the next call reconnects", async () => {
    let failFetch = false;
    const base = statefulServer();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (failFetch) throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
      return base.fetch(input, init);
    });
    const server = { ...base, fetch, toolCalls: base.toolCalls };
    const pool = new RemoteMcpSessionCache();
    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-1" }],
    });

    failFetch = true;
    await expect(scopedCall(pool, "run-1 srv", server)).rejects.toThrow(/Could not reach/);
    expect(server.toolCalls).toHaveLength(1);

    failFetch = false;
    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("keeps the session working after one call is aborted", async () => {
    let release: (() => void) | undefined;
    let hangNext = true;
    const server = mcpServer(({ message, respond }) => {
      if (message.method === "tools/call") {
        if (!hangNext) {
          return respond({ result: { content: [{ type: "text", text: "done" }] } });
        }
        hangNext = false;
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(respond({ result: { content: [{ type: "text", text: "late" }] } }));
        }) as unknown as Response;
      }
      return undefined;
    });
    const pool = new RemoteMcpSessionCache();
    const controller = new AbortController();
    const hanging = scopedCall(pool, "run-1 srv", server, controller.signal);
    await vi.waitFor(() => expect(server.toolCalls).toHaveLength(1));
    controller.abort();
    await expect(hanging).rejects.toThrow();
    // Let the late response for the cancelled request arrive before continuing.
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "done" }],
    });
    expect(server.initializations()).toBe(1);
    await pool.close();
  });

  it("runs parallel calls of one run on a single session", async () => {
    const server = mcpServer(({ message, session, respond }) => {
      if (message.method === "tools/call") {
        if (!session) throw new Error("tools/call without a session header");
        return new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(respond({ result: { content: [{ type: "text", text: "ok" }] } })),
            25,
          );
        }) as unknown as Response;
      }
      return undefined;
    });
    const pool = new RemoteMcpSessionCache();

    const calls = await Promise.all([
      scopedCall(pool, "run-1 srv", server),
      scopedCall(pool, "run-1 srv", server),
    ]);

    expect(calls).toHaveLength(2);
    expect(server.initializations()).toBe(1);
    expect(new Set(server.toolCalls.map((call) => call.session))).toEqual(new Set(["session-1"]));
    await pool.close();
  });

  it("keeps a concurrent call's response when another call's transport fails", async () => {
    const base = statefulServer();
    let failNextPost = false;
    let writeArrived = false;
    let finishWrite: (() => void) | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "POST") return base.fetch(input, init);
      if (failNextPost) {
        failNextPost = false;
        throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
      }
      const message = JSON.parse(await request.text()) as JsonRpc;
      if (message.method === "tools/call" && message.params?.name === "write") {
        // A write whose committed response is still on the wire.
        writeArrived = true;
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      }
      return base.fetch(input, init);
    });
    const server = { ...base, fetch, toolCalls: base.toolCalls };
    const pool = new RemoteMcpSessionCache();

    const write = scopedCall(pool, "run-1 srv", server, undefined, undefined, "write");
    await vi.waitFor(() => expect(writeArrived).toBe(true));

    // The read loses its transport while the write still runs on the session.
    failNextPost = true;
    await expect(scopedCall(pool, "run-1 srv", server)).rejects.toThrow(/Could not reach/);

    finishWrite?.();
    await expect(write).resolves.toMatchObject({ content: [{ text: "ok:session-1" }] });
    // Retired only after its last call landed, so the server saw the write once.
    await vi.waitFor(() => expect(server.deletes).toEqual(["session-1"]));

    await expect(scopedCall(pool, "run-1 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("does not close a session that was used again while the reaper ran", async () => {
    const base = statefulServer();
    let holdDeleteArrived = false;
    let releaseDelete: (() => void) | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        request.method === "DELETE" &&
        request.headers.get("mcp-session-id") === "session-1" &&
        !holdDeleteArrived
      ) {
        // The first candidate's cleanup waits; the reaper awaits it.
        holdDeleteArrived = true;
        await new Promise<void>((resolve) => {
          releaseDelete = resolve;
        });
      }
      return base.fetch(input, init);
    });
    const server = { ...base, fetch, toolCalls: base.toolCalls };
    const pool = new RemoteMcpSessionCache(40);

    await scopedCall(pool, "run-1 srv", server);
    await scopedCall(pool, "run-2 srv", server);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const reaping = pool.reapIdle();
    await vi.waitFor(() => expect(holdDeleteArrived).toBe(true));
    // Session-2 answers a new call while the reaper is still on session-1.
    await scopedCall(pool, "run-2 srv", server);
    releaseDelete?.();

    await expect(reaping).resolves.toBe(1);
    expect(server.deletes).toEqual(["session-1"]);
    await expect(scopedCall(pool, "run-2 srv", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    expect(server.initializations()).toBe(2);
    await pool.close();
  });

  it("still refuses private endpoints with a session scope", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache();
    await expect(
      callRemoteMcpTool(
        {
          endpoint: "https://10.0.0.8/mcp",
          fetch: server.fetch as unknown as typeof globalThis.fetch,
          resolveHostname: publicResolver,
          sessionScope: "run-1 srv",
          sessionPool: pool,
        },
        "do_work",
        {},
      ),
    ).rejects.toThrow(/private host/i);
    expect(server.initializations()).toBe(0);
    await pool.close();
  });

  it("keeps scopes apart inside one cache", async () => {
    const server = statefulServer();
    const pool = new RemoteMcpSessionCache();
    await expect(scopedCall(pool, "run-1 srv-a", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-1" }],
    });
    await expect(scopedCall(pool, "run-2 srv-a", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-2" }],
    });
    await expect(scopedCall(pool, "run-1 srv-b", server)).resolves.toMatchObject({
      content: [{ text: "ok:session-3" }],
    });
    expect(server.initializations()).toBe(3);
    await pool.close();
  });
});
