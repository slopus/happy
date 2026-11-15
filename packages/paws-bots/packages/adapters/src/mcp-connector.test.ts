import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  InvalidClientMetadataError,
  ServerError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "./connector-registry.js";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { DIRECT_TOOL_LIMIT } from "./lazy-tool-catalog.js";
import { MCP_CLOSE_TIMEOUT_MS } from "./mcp-close.js";
import { allowlistDrift, McpConnector } from "./mcp-connector.js";
import type { McpOAuthBroker, OAuthMaterial } from "./mcp-oauth.js";
import { StoredMcpOAuthProvider } from "./mcp-oauth.js";
import { MCP_TOOL_TIMEOUT_MS, McpSession } from "./mcp-transport.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { checkRoutineWatch, validateRoutineWatch } from "./routine-watch.js";
import { migrateSecrets } from "./secret-migration.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

// No server is shared with every agent, so only assignments reach a bot.
const NO_SHARED_SERVERS = { findMany: async () => [], findFirst: async () => null };

afterEach(() => vi.unstubAllGlobals());

/** Discovery of a failed server offers only its stand-in "unavailable" tool. */
const unavailableOnly = (slug = "demo") => [
  expect.objectContaining({
    name: `mcp__${slug}__unavailable`,
    route: expect.objectContaining({ toolName: "__rakazo_unavailable" }),
  }),
];

const SERVER = {
  id: "server-1",
  slug: "demo",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};

const ASSIGNMENT = {
  botId: "bot-1",
  serverId: "server-1",
  spaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};

const TEST_NETWORK = {
  // Read the global per call so a fetch stubbed after construction still wins.
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

function logicalHref(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
  if (host) url.host = host;
  return url.href;
}

function mcpFetch(
  state: {
    failNext: boolean;
    initializations: number;
    /** Tool requests to answer 404, as a server that expired the session. */
    sessionNotFound?: number;
    /** Overrides the 404 with another rejection, e.g. the SDK's 400 after a restart. */
    sessionNotFoundResponse?: { status: number; body: string };
    rejectedRequests?: string[];
    headers?: Record<string, string>[];
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean };
    }>;
    calls?: string[];
    /** Answer tool calls with a JSON-RPC error, as a server whose tool failed. */
    rpcError?: boolean;
    /** Hold tool calls until the request is aborted, as a slow tool. */
    holdCalls?: boolean;
  },
  expectedUrl = "https://mcp.example.test/mcp",
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    state.headers?.push(Object.fromEntries(request.headers.entries()));
    if (logicalHref(input, init) !== expectedUrl)
      throw new Error(`Unexpected request: ${logicalHref(input, init)}`);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (state.failNext) return new Response("boom", { status: 500 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    if (
      (message.method === "tools/call" || message.method === "tools/list") &&
      state.sessionNotFound
    ) {
      state.sessionNotFound -= 1;
      state.rejectedRequests?.push(message.method);
      const rejection = state.sessionNotFoundResponse ?? { status: 404, body: "Session not found" };
      return new Response(rejection.body, { status: rejection.status });
    }
    if (message.method === "initialize") {
      state.initializations += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: state.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
        },
      });
    }
    if (message.method === "tools/call") {
      if (message.params?.name) state.calls?.push(message.params.name);
      if (state.holdCalls)
        return new Promise<Response>((_, reject) => {
          const signal = request.signal;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      if (state.rpcError)
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "upstream failed" },
        });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

describe("MCP connector session cache", () => {
  it.each([
    "revision",
    "discovery failure",
    "call failure",
    "expired listing",
    "expired call",
  ] as const)("does not let a stuck close block %s or the next session", async (scenario) => {
    vi.useFakeTimers();
    const state = { failNext: false, initializations: 0, sessionNotFound: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const assignment = { ...ASSIGNMENT, server: { ...SERVER } };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
    };
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const connector = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
    const execute = async () => {
      const events: unknown[] = [];
      for await (const event of connector.execute(
        {
          tool: "mcp__demo__echo",
          args: {},
          route: { connectorId: "mcp", resourceId: SERVER.id, toolName: "echo" },
        } as never,
        context,
      ))
        events.push(event);
      return events;
    };
    let close: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expect(await connector.discoverTools(context)).toMatchObject([{ name: "mcp__demo__echo" }]);
      close = vi
        .spyOn(McpSession.prototype, "close")
        .mockImplementationOnce(() => new Promise(() => {}));
      if (scenario === "revision") assignment.server.revision += 1;
      else if (scenario.startsWith("expired")) state.sessionNotFound = 1;
      else state.failNext = true;
      const result = scenario.includes("call") ? execute() : connector.discoverTools(context);
      await vi.advanceTimersByTimeAsync(MCP_CLOSE_TIMEOUT_MS);
      if (scenario === "call failure") expect(await result).toMatchObject([{ type: "error" }]);
      else if (scenario === "discovery failure") expect(await result).toEqual(unavailableOnly());
      else if (scenario === "expired call")
        expect(await result).toMatchObject([{ type: "result" }]);
      else expect(await result).toMatchObject([{ name: "mcp__demo__echo" }]);
      expect(close).toHaveBeenCalled();
      state.failNext = false;
      expect(await execute()).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(2);
    } finally {
      close?.mockRestore();
      await connector.close();
      vi.useRealTimers();
    }
  });

  it.each([
    { repeated: false, rejectSetup: false, lostSessions: 0 },
    { repeated: true, rejectSetup: false, lostSessions: 0 },
    { repeated: false, rejectSetup: true, lostSessions: 0 },
    { repeated: true, rejectSetup: true, lostSessions: 0 },
    { repeated: false, rejectSetup: false, lostSessions: 1 },
    { repeated: false, rejectSetup: true, lostSessions: 1 },
    { repeated: false, rejectSetup: false, lostSessions: 2 },
  ])(
    "retries a credential change during connection (repeated: $repeated, rejected: $rejectSetup, lost sessions: $lostSessions)",
    async ({ repeated, rejectSetup, lostSessions }) => {
      const state = {
        failNext: false,
        initializations: 0,
        sessionNotFound: lostSessions,
        headers: [] as Record<string, string>[],
        calls: [] as string[],
      };
      let changed: (ref: string) => void = () => {};
      let token = "initial";
      const fetch = mcpFetch(state);
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetch(input, init);
        if (state.initializations === 1 || repeated) {
          token = "rotated";
          changed("secret-ref");
          if (rejectSetup) return new Response("Old credential rejected", { status: 401 });
        }
        return result;
      });
      const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: "secret-1" } };
      const connector = new McpConnector(
        {
          mcpServer: NO_SHARED_SERVERS,
          botMcpServer: { findMany: async () => [assignment], findFirst: async () => assignment },
          secret: { findFirst: async () => ({ id: "secret-1", ciphertext: "secret-ref" }) },
        } as never,
        {
          load: async () => JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
          onChange: (listener: typeof changed) => {
            changed = listener;
            return () => {};
          },
        } as never,
        { network: TEST_NETWORK },
      );
      const context = {
        operationId: "test",
        traceId: "test",
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      };
      const close = vi.spyOn(McpSession.prototype, "close");
      try {
        const tools = await connector.discoverTools(context);
        expect(state.initializations).toBe(lostSessions > 0 ? 3 : 2);
        expect(state.calls).toEqual([]);
        if (repeated || lostSessions > 1) {
          expect(tools).toEqual(unavailableOnly());
          expect(close).toHaveBeenCalledTimes(state.initializations);
        } else {
          expect(close).toHaveBeenCalledTimes(state.initializations - 1);
          expect(tools).toMatchObject([{ name: "mcp__demo__echo" }]);
          expect(state.headers.at(-1)?.authorization).toBe("Bearer rotated");
        }
      } finally {
        await connector.close();
        close.mockRestore();
      }
    },
  );

  it("keeps sessions across unchanged TTL reads and reconnects on observed rotation", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({ ...fake.options, cacheTtlMs: 100 });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    await store.start();
    const record = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: record.id, ciphertext: record.ref })) },
    };
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const reads = fake.fetcher.mock.calls.length;
      await connector.discoverTools(context);
      expect(fake.fetcher).toHaveBeenCalledTimes(reads);
      expect(state.initializations).toBe(1);
      const changed = vi.fn();
      store.onChange(changed);
      await vi.advanceTimersByTimeAsync(100);
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      expect(changed).not.toHaveBeenCalled();
      fake.values.set(
        record.ref.split(":").at(-1)!,
        JSON.stringify({ headers: { Authorization: "Bearer rotated" } }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await connector.discoverTools(context);
      expect(changed).toHaveBeenCalledExactlyOnceWith(record.ref);
      expect(state.initializations).toBe(2);
      expect(state.headers.some((headers) => headers.authorization === "Bearer rotated")).toBe(
        true,
      );
    } finally {
      await connector.close();
      await store.close();
      vi.useRealTimers();
    }
  });

  it("detects rotation after digest eviction and evicts deleted credentials", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({
      ...fake.options,
      cacheTtlMs: 100,
      cacheMaxEntries: 1,
    });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    await store.start();
    const record = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: record.id, ciphertext: record.ref })) },
    };
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const changed = vi.fn();
      store.onChange(changed);
      await store.put("unrelated", context);
      fake.values.set(
        record.ref.split(":").at(-1)!,
        JSON.stringify({ headers: { Authorization: "Bearer rotated" } }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await connector.discoverTools(context);
      expect(changed).not.toHaveBeenCalledWith(record.ref);
      expect(state.initializations).toBe(2);
      expect(state.headers.some((headers) => headers.authorization === "Bearer rotated")).toBe(
        true,
      );
      fake.values.delete(record.ref.split(":").at(-1)!);
      await vi.advanceTimersByTimeAsync(100);
      // Discovery suppresses per-server errors; no tools from the deleted credential survive.
      await expect(connector.discoverTools(context)).resolves.toEqual(unavailableOnly());
      expect((connector as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    } finally {
      await connector.close();
      await store.close();
      vi.useRealTimers();
    }
  });

  it("reconnects when another process stored a new credential record", async () => {
    const store = new EncryptedSecretStore("test-encryption-key-of-sufficient-length");
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const first = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    let current = { id: first.id, ciphertext: first.ciphertext };
    const assignment = () => ({ ...ASSIGNMENT, server: { ...SERVER, secretId: current.id } });
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment()]),
        findFirst: vi.fn(async () => assignment()),
      },
      secret: { findFirst: vi.fn(async () => current) },
    };
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);

      // A credential write from the worker leaves the old record readable here
      // and does not bump the server revision.
      const next = await store.put(
        JSON.stringify({ headers: { Authorization: "Bearer from-worker" } }),
        context,
      );
      current = { id: next.id, ciphertext: next.ciphertext };
      await connector.discoverTools(context);

      expect(state.initializations).toBe(2);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer from-worker");
    } finally {
      await connector.close();
    }
  });

  it("keeps a live session working during a secret-store outage after TTL", async () => {
    vi.useFakeTimers();
    const sink = createTestSink();
    const previousLogger = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({ ...fake.options, cacheTtlMs: 100 });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    await store.start();
    const record = await store.put(
      JSON.stringify({ headers: { Authorization: "Bearer initial" } }),
      context,
    );
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: record.id, ciphertext: record.ref })) },
    };
    // Health writes succeed, so the only log lines are the ones this test is about.
    Object.assign(prisma, {
      mcpServer: { ...NO_SHARED_SERVERS, updateMany: vi.fn(async () => ({ count: 1 })) },
    });
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, store, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const reads = fake.fetcher.mock.calls.length;
      fake.offline = true;
      await vi.advanceTimersByTimeAsync(100);
      const tools = await connector.discoverTools(context);
      expect(tools).toHaveLength(1);
      expect(fake.fetcher.mock.calls.length).toBeGreaterThan(reads);
      expect(state.initializations).toBe(1);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer initial");
      const events = [];
      for (const tool of tools) {
        const call = { tool: tool.name, args: {}, executionId: "test", route: tool.route };
        for await (const event of connector.execute(call, context)) events.push(event);
      }
      expect(events).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(1);
      expect(sink.events).toHaveLength(2);
      const log = JSON.stringify(sink.events);
      expect(log).toContain("MCP secret revalidation failed");
      expect(log).not.toContain("private response value");
      expect(log).not.toContain(record.ref);
      expect(log).not.toContain(record.id);
      expect(log).not.toContain("Bearer initial");
      // Recovery still revalidates and observes a rotation without a manual read.
      fake.offline = false;
      fake.values.set(
        record.ref.split(":").at(-1)!,
        JSON.stringify({ headers: { Authorization: "Bearer rotated" } }),
      );
      expect(await connector.discoverTools(context)).toHaveLength(1);
      expect(state.initializations).toBe(2);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer rotated");
    } finally {
      await connector.close();
      await store.close();
      installLogger(previousLogger);
      vi.useRealTimers();
    }
  });

  it("reconnects a legacy session when migration publishes the old ref through realtime", async () => {
    const fake = infisicalFake();
    const fanout = new InMemoryRealtimeFanout();
    const source = new ComposedSecretStore(new EncryptedSecretStore("fake-key"), undefined, fanout);
    const target = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
      fanout,
    );
    const worker = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
      fanout,
    );
    await source.start();
    await target.start();
    await worker.start();
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const record = await source.put(
      JSON.stringify({ headers: { Authorization: "Bearer fake" } }),
      context,
    );
    const row = { id: record.id, ciphertext: record.ref };
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: record.id } };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => row) },
    };
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = new McpConnector(prisma as never, worker, { network: TEST_NETWORK });
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      const result = await migrateSecrets(
        {
          async *rows() {
            yield { id: row.id, recordId: row.id, ref: row.ciphertext, label: "secret" };
          },
          async replace(original, ref) {
            if (original.ref !== row.ciphertext) return false;
            row.ciphertext = ref;
            return true;
          },
          async referenced(ref) {
            return row.ciphertext === ref;
          },
        },
        source,
        target,
        context,
        { direction: "forward" },
      );
      expect(result.migrated).toBe(1);
      await connector.discoverTools(context);
      expect(state.initializations).toBe(2);
    } finally {
      await connector.close();
      await source.close();
      await target.close();
      await worker.close();
      await fanout.close();
    }
  });

  it("keeps large MCP schemas out of the initial runtime tool catalog", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: `Tool ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: `schema-marker-${index}` } },
          required: ["value"],
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    const tools = await connector.discoverTools(context);

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "connectors_search_tools",
      "connectors_load_tool",
      "connectors_execute_tool",
    ]);
    // Anthropic rejects Claude Code OAuth requests carrying any `mcp_`-prefixed tool name.
    expect(tools.every((tool) => !tool.name.startsWith("mcp_"))).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("schema-marker");
    await connector.close();
  });

  it("exposes 20 MCP tools directly and switches at 21", async () => {
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    for (const count of [20, 21]) {
      const state = {
        failNext: false,
        initializations: 0,
        tools: Array.from({ length: count }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: "object" },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          mcpServer: NO_SHARED_SERVERS,
          botMcpServer: {
            findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
            findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
          },
        } as never,
        {} as never,
        { network: TEST_NETWORK },
      );
      const tools = await connector.discoverTools(context);
      if (count === 20) {
        expect(tools).toHaveLength(20);
        expect(tools[0]?.name).toMatch(/^mcp__demo__/);
      } else {
        expect(tools.map((tool) => tool.name)).toEqual([
          "connectors_search_tools",
          "connectors_load_tool",
          "connectors_execute_tool",
        ]);
      }
      await connector.close();
    }
  });

  it("records a discovery failure as a failed tool completion", async () => {
    vi.stubGlobal("fetch", mcpFetch({ failNext: true, initializations: 0 }));
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      events: { append },
    });

    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual(unavailableOnly());

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      spaceId: "w1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      type: "agent.tool.completed",
      payload: {
        name: "mcp__demo__discovery",
        executionId: "mcp-discovery-demo-run-1-0",
        outcome: "error",
      },
    });
    expect(append.mock.calls[0]?.[0].payload.error).toEqual(expect.any(String));
    await connector.close();
  });

  it("records a failed lookup of the bot's servers before the registry drops it", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockRejectedValue(new Error("lookup failed")) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      events: { append },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    } as never;

    await expect(connector.discoverTools(context)).rejects.toThrow("lookup failed");
    await expect(new ConnectorRegistry([connector]).discoverTools(context)).resolves.toEqual([]);

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
      type: "agent.tool.completed",
      payload: { name: "mcp__discovery", outcome: "error" },
    });
    await connector.close();
  });

  it("still offers the stand-in tool when closing the failed session throws", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
      mcpServer: { ...NO_SHARED_SERVERS, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      events: { append },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    } as never;
    await expect(connector.discoverTools(context)).resolves.not.toEqual([]);

    state.failNext = true;
    const close = vi.spyOn(McpSession.prototype, "close").mockRejectedValue(new Error("busy"));
    try {
      await expect(connector.discoverTools(context)).resolves.toEqual(unavailableOnly());
      expect(append.mock.calls.at(-1)?.[0].payload).toMatchObject({
        name: "mcp__demo__discovery",
        outcome: "error",
      });
    } finally {
      close.mockRestore();
    }
    await connector.close();
  });

  it("redacts credentials of a connect that failed before the session was cached", async () => {
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    // The connect itself fails, so the session never reaches the cache. The upstream
    // body quotes back the header it was sent, the way a strict server rejects one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected credential local-key", { status: 500 })),
    );
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi.fn().mockReturnValue(JSON.stringify({ headers: { "X-Api-Key": "local-key" } })),
      } as never,
      { network: TEST_NETWORK, events: { append }, allowPrivateEndpoint: true },
    );

    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual(unavailableOnly());

    expect(append).toHaveBeenCalledTimes(1);
    const reason = String(append.mock.calls[0]?.[0].payload.error);
    expect(reason).not.toContain("local-key");
    expect(reason).toContain("[redacted]");
    await connector.close();
  });

  it("redacts the same failed connect for every concurrent waiter", async () => {
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected credential local-key", { status: 500 })),
    );
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([localAssignment]),
        findFirst: vi.fn().mockResolvedValue(localAssignment),
      },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi.fn().mockReturnValue(JSON.stringify({ headers: { "X-Api-Key": "local-key" } })),
      } as never,
      { network: TEST_NETWORK, events: { append }, allowPrivateEndpoint: true },
    );
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    };

    // Both callers land on the same pending connect, so both receive the one
    // rejection it produces. Neither may see the credential it reflected.
    const [first, second] = await Promise.all([
      connector.discoverTools(context as never),
      connector.discoverTools(context as never),
    ]);

    expect(first).toEqual(unavailableOnly());
    expect(second).toEqual(unavailableOnly());
    // The reason the model reads is redacted the same way.
    expect(JSON.stringify([first, second])).not.toContain("local-key");
    expect(first[0]?.description).toContain("[redacted]");
    expect(append).toHaveBeenCalledTimes(2);
    for (const call of append.mock.calls) {
      const message = String(call[0].payload.error);
      expect(message).not.toContain("local-key");
      expect(message).toContain("[redacted]");
    }
    await connector.close();
  });

  it("gives every discovery failure of one run its own executionId", async () => {
    vi.stubGlobal("fetch", mcpFetch({ failNext: true, initializations: 0 }));
    const append = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      events: { append },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      runId: "run-1",
      signal: new AbortController().signal,
    };

    // Discovery is reached again on every lazy catalog access inside the same run; past
    // the failure backoff, the server is tried (and can fail) again.
    await connector.discoverTools(context as never);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    await connector.discoverTools(context as never);
    vi.mocked(Date.now).mockRestore();

    expect(append).toHaveBeenCalledTimes(2);
    const ids = append.mock.calls.map((call) => call[0].payload.executionId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^mcp-discovery-demo-run-1-\d+$/);
    await connector.close();
  });

  describe("a server the user has to fix", () => {
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const connectorWith = (server: typeof SERVER, network = TEST_NETWORK) =>
      new McpConnector(
        {
          botMcpServer: {
            findMany: vi.fn(async () => [{ ...ASSIGNMENT, server }]),
          },
          mcpServer: { ...NO_SHARED_SERVERS, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        } as never,
        {} as never,
        { network },
      );

    it("warns instead of reporting an error, and waits longer for a reconnect", async () => {
      const requests = vi.fn(async () => new Response("unauthorized", { status: 401 }));
      vi.stubGlobal("fetch", requests);
      const server = { ...SERVER };
      const connector = connectorWith(server);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          "mcp discovery failed for server demo",
          expect.objectContaining({ reason: expect.any(String) }),
        );
        const tried = requests.mock.calls.length;

        // Well past the usual backoff cap, nothing is sent yet.
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000);
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(requests).toHaveBeenCalledTimes(tried);

        // Reconnecting bumps the revision, which ends the wait.
        server.revision = 2;
        await connector.discoverTools(context);
        const retried = requests.mock.calls.length;
        expect(retried).toBeGreaterThan(tried);

        // A refresh that failed only briefly still gets another try after an hour.
        clock.mockReturnValue(now + 2 * 60 * 60_000);
        await connector.discoverTools(context);
        expect(requests.mock.calls.length).toBeGreaterThan(retried);
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it.each([
      [
        "a failure",
        "ok",
        (): Promise<Response> => Promise.resolve(new Response("unauthorized", { status: 401 })),
      ],
      ["a success", "error", null],
    ] as const)(
      "keeps %s from a discovery begun before sign-in off the new revision",
      async (_case, fresh, answer) => {
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const server = mcpFetch({ failNext: false, initializations: 0 }, SERVER.endpoint);
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            entered();
            await waiting;
            return answer ? answer() : server(input, init);
          }),
        );
        const row = { revision: 1, healthStatus: "unknown" };
        const writes = vi.fn(
          async ({
            where,
            data,
          }: {
            where: { revision?: number };
            data: { healthStatus: string };
          }) => {
            if (where.revision !== undefined && where.revision !== row.revision)
              return { count: 0 };
            row.healthStatus = data.healthStatus;
            return { count: 1 };
          },
        );
        const connector = new McpConnector(
          {
            botMcpServer: { findMany: vi.fn(async () => [ASSIGNMENT]) },
            mcpServer: { ...NO_SHARED_SERVERS, updateMany: writes },
          } as never,
          {} as never,
          { network: TEST_NETWORK },
        );
        try {
          const discovering = connector.discoverTools(context);
          await started;
          // Sign-in bumps the revision and the new revision's check records its own result.
          row.revision = 2;
          row.healthStatus = fresh;
          release();
          await discovering;
          await vi.waitFor(() => expect(writes).toHaveBeenCalled());
          expect(row.healthStatus).toBe(fresh);
        } finally {
          release();
          vi.restoreAllMocks();
          await connector.close();
        }
      },
    );

    it("writes an identical observation again once the revision changes", async () => {
      vi.stubGlobal("fetch", mcpFetch({ failNext: false, initializations: 0 }, SERVER.endpoint));
      const server = { ...SERVER };
      const writes = vi.fn().mockResolvedValue({ count: 1 });
      const connector = new McpConnector(
        {
          botMcpServer: { findMany: vi.fn(async () => [{ ...ASSIGNMENT, server }]) },
          mcpServer: { ...NO_SHARED_SERVERS, updateMany: writes },
        } as never,
        {} as never,
        { network: TEST_NETWORK },
      );
      const revisions = () => writes.mock.calls.map(([call]) => call.where.revision);
      try {
        await connector.discoverTools(context);
        await connector.discoverTools(context);
        // The same result for the same revision within a minute is not rewritten.
        await vi.waitFor(() => expect(revisions()).toEqual([1]));
        // Signing in bumps the revision; its first, identical result must still be recorded.
        server.revision = 2;
        await connector.discoverTools(context);
        await vi.waitFor(() => expect(revisions()).toEqual([1, 2]));
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("records a check only for the revision it probed", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("unauthorized", { status: 401 })),
      );
      const writes = vi.fn().mockResolvedValue({ count: 0 });
      const connector = new McpConnector(
        {
          botMcpServer: { findMany: vi.fn(async () => []) },
          mcpServer: { ...NO_SHARED_SERVERS, updateMany: writes },
        } as never,
        {} as never,
        { network: TEST_NETWORK },
      );
      try {
        // Signing in bumps the revision, so a check of revision 1 must not land on revision 2.
        await connector.probe({ ...SERVER, revision: 1 } as never, { spaceId: "w1", userId: "u1" });
        expect(writes).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: SERVER.id, revision: 1 } }),
        );
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("warns when the host no longer resolves, and waits for a new address", async () => {
      vi.stubGlobal("fetch", mcpFetch({ failNext: false, initializations: 0 }));
      const resolveHostname = vi.fn(async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND mcp.example.test"), {
          code: "ENOTFOUND",
        });
      });
      const server = { ...SERVER };
      const connector = connectorWith(server, { ...TEST_NETWORK, resolveHostname });
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.stringContaining("ENOTFOUND"),
        });
        const tried = resolveHostname.mock.calls.length;

        // A host name that is gone (an expired tunnel) will not come back on its own.
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000);
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(resolveHostname).toHaveBeenCalledTimes(tried);

        // Editing the address bumps the revision, which ends the wait.
        server.revision = 2;
        await connector.discoverTools(context);
        expect(resolveHostname.mock.calls.length).toBeGreaterThan(tried);
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("warns when the host times out, and retries it on the usual backoff", async () => {
      const requests = vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443"), {
            code: "ETIMEDOUT",
          }),
        });
      });
      vi.stubGlobal("fetch", requests);
      const connector = connectorWith(SERVER);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.stringContaining("ETIMEDOUT"),
        });
        const tried = requests.mock.calls.length;

        // A host that is only down is tried again once the short backoff passes.
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
        await connector.discoverTools(context);
        expect(requests.mock.calls.length).toBeGreaterThan(tried);
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("warns when the server's OAuth endpoint fails, and retries it on the usual backoff", async () => {
      const requests = vi.fn(async () => {
        throw new ServerError("");
      });
      vi.stubGlobal("fetch", requests);
      const connector = connectorWith(SERVER);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.any(String),
        });
        const tried = requests.mock.calls.length;

        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
        await connector.discoverTools(context);
        expect(requests.mock.calls.length).toBeGreaterThan(tried);
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it.each([
      ["refuses the client", () => new InvalidClientMetadataError("client not recognized"), false],
      [
        "cannot register a client",
        () => new Error("Incompatible auth server: does not support dynamic client registration"),
        false,
      ],
      ["rate limits the client", () => new TooManyRequestsError("slow down"), true],
    ])("warns when the server's OAuth endpoint %s", async (_, failure, retriesSoon) => {
      const requests = vi.fn(async () => {
        throw failure();
      });
      vi.stubGlobal("fetch", requests);
      const connector = connectorWith(SERVER);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.any(String),
        });
        const tried = requests.mock.calls.length;

        // A refusal waits for the user to reconnect; a rate limit is retried on the usual backoff.
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
        await connector.discoverTools(context);
        expect(requests.mock.calls.length > tried).toBe(retriesSoon);
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it.each([
      [
        "a web page",
        () =>
          new Response("<!doctype html><title>Home</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ],
      [
        "a non-MCP API",
        () => Response.json({ error: { code: "model_required" } }, { status: 400 }),
      ],
      ["a redirect", () => new Response(null, { status: 302, headers: { location: "/login" } })],
      [
        "a server error page",
        () =>
          new Response("<html><title>500 Internal Server Error</title></html>", {
            status: 500,
            headers: { "content-type": "text/html" },
          }),
      ],
    ])("warns when the endpoint answers with %s", async (_, answer) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer()),
      );
      const connector = connectorWith(SERVER);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.any(String),
        });
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it.each([
      [-32000, "warn"],
      [-32602, "error"],
    ])("logs a JSON-RPC error %i from the server at %s", async (code, level) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const { id } = (await request.json()) as { id?: number };
          return Response.json({
            jsonrpc: "2.0",
            id,
            error: { code, message: "Upstream MCP server error" },
          });
        }),
      );
      const connector = connectorWith(SERVER);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(level === "warn" ? error : warn).not.toHaveBeenCalled();
        expect(level === "warn" ? warn : error).toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("warns when the run was cancelled before it listed a live session's tools", async () => {
      vi.stubGlobal("fetch", mcpFetch({ failNext: false, initializations: 0 }));
      const connector = connectorWith(SERVER);
      const run = new AbortController();
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        await connector.discoverTools(context);
        run.abort();
        expect(
          await connector.discoverTools({ ...(context as object), signal: run.signal } as never),
        ).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.stringContaining("aborted"),
        });
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("warns when the server does not list its tools in time", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => undefined)),
      );
      const connector = new McpConnector(
        {
          botMcpServer: { findMany: vi.fn(async () => [ASSIGNMENT]) },
          mcpServer: { ...NO_SHARED_SERVERS, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        } as never,
        {} as never,
        { network: TEST_NETWORK, discoveryTimeoutMs: 50 },
      );
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server demo", {
          reason: expect.stringContaining("did not list its tools"),
        });
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });

    it("still reports an unexpected failure as an error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("boom");
        }),
      );
      const connector = connectorWith(SERVER);
      const error = vi.spyOn(getLogger(), "error");
      try {
        expect(await connector.discoverTools(context)).toEqual(unavailableOnly());
        expect(error).toHaveBeenCalledWith("mcp.discovery.failed", expect.any(Error), {
          "connector.id": SERVER.id,
        });
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    });
  });

  it("leaves no discovery event when the failure happens outside a run", async () => {
    vi.stubGlobal("fetch", mcpFetch({ failNext: true, initializations: 0 }));
    const append = vi.fn().mockResolvedValue(undefined);
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      } as never,
      {} as never,
      { network: TEST_NETWORK, events: { append } },
    );

    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual(unavailableOnly());

    expect(append).not.toHaveBeenCalled();
    await connector.close();
  });

  it("returns no tools when the MCP catalog is empty", async () => {
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
    );
    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);
    await connector.close();
  });

  it.each([DIRECT_TOOL_LIMIT, DIRECT_TOOL_LIMIT + 1])(
    "reads an MCP-only watch with production provider order and %i connected tools",
    async (count) => {
      const state = {
        failNext: false,
        initializations: 0,
        calls: [] as string[],
        tools: Array.from({ length: count }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          annotations: { readOnlyHint: true },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const prisma = {
        capabilityInstall: { findMany: vi.fn().mockResolvedValue([]) },
        integrationProviderConfig: { findUnique: vi.fn().mockResolvedValue(null) },
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: {
          findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
          findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
        },
        connection: { findMany: vi.fn().mockResolvedValue([]) },
        spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
        actionApprovalRule: { findMany: vi.fn().mockResolvedValue([]) },
        userActionApprovalRule: { findMany: vi.fn().mockResolvedValue([]) },
      };
      const mcp = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
      const secrets = new EncryptedSecretStore("test-encryption-key");
      const integrationSettings = new IntegrationProviderSettings(
        prisma as never,
        secrets,
        "test-identity",
      );
      const connector = new ConnectorRegistry([
        new InstalledConnectorProvider(prisma as never, secrets),
        ...integrationSettings.providers(),
        mcp,
      ]);
      const execute = vi.spyOn(mcp, "execute");
      const routine = {
        id: "routine-1",
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        watch: {
          kind: "tool" as const,
          tool: `mcp__demo__tool_${count - 1}`,
          args: { value: "ok" },
          everyMinutes: 5,
          loud: false,
        },
        watchState: null,
      };
      try {
        const deps = { prisma, connector } as never;
        const baseline = await checkRoutineWatch(deps, routine);
        expect(baseline).toMatchObject({ changed: false, state: { outcome: "baseline" } });
        await validateRoutineWatch(deps, routine.watch, routine);
        expect(state.calls).toEqual([`tool_${count - 1}`]);
        const unchanged = await checkRoutineWatch(deps, {
          ...routine,
          watchState: baseline.state,
        });
        expect(unchanged).toMatchObject({ changed: false, state: { outcome: "unchanged" } });
        expect(state.calls).toEqual([`tool_${count - 1}`, `tool_${count - 1}`]);
        expect(execute).toHaveBeenCalledWith(
          expect.objectContaining({
            args: { value: "ok" },
            route: expect.objectContaining({
              connectorId: "mcp",
              resourceId: "server-1",
              toolName: `tool_${count - 1}`,
            }),
          }),
          expect.objectContaining({ botId: "bot-1", spaceId: "w1", userId: "u1" }),
        );
      } finally {
        await mcp.close();
      }
    },
  );

  it("searches, loads, validates, authorizes, and executes one large-catalog tool", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: index === 29 ? "Find the final report" : `Utility ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const [search, load, execute] = await connector.discoverTools(context);
    const collect = async (call: Parameters<McpConnector["execute"]>[0]) => {
      const events: unknown[] = [];
      for await (const event of connector.execute(call as never, context)) events.push(event);
      return events;
    };

    const searched = await collect({
      tool: search!.name,
      args: { query: "final report", limit: 2 },
      executionId: "search",
      route: search!.route,
    });
    expect(searched).toEqual([
      {
        type: "result",
        data: {
          tools: [
            {
              id: "server-1:tool_29",
              name: "mcp__demo__tool_29",
              description: "Find the final report",
              readOnly: false,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain("inputSchema");

    const indexed = await collect({
      tool: search!.name,
      args: {},
      executionId: "index",
      route: search!.route,
    });
    expect(indexed).toEqual([
      {
        type: "result",
        data: {
          index: [
            {
              group: "demo",
              names: Array.from(
                { length: 30 },
                (_, index) => `tool_${String(index).padStart(2, "0")}`,
              ),
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(indexed)).not.toContain("inputSchema");
    expect(search!.description).toContain("demo:");
    expect(search!.description).toContain("tool_00");

    const expanded = await collect({
      tool: search!.name,
      args: { group: "demo" },
      executionId: "group",
      route: search!.route,
    });
    expect(expanded).toEqual([
      {
        type: "result",
        data: {
          group: "demo",
          names: Array.from({ length: 30 }, (_, index) => `tool_${String(index).padStart(2, "0")}`),
        },
      },
    ]);

    const loaded = await collect({
      tool: load!.name,
      args: { id: "server-1:tool_29" },
      executionId: "load",
      route: load!.route,
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          id: "server-1:tool_29",
          inputSchema: expect.objectContaining({ required: ["value"] }),
        }),
      }),
    ]);

    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "mcp__demo__missing", arguments: { value: "x" } },
          executionId: "unknown",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("unknown or not authorized");
    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "server-1:tool_29", arguments: {} },
          executionId: "invalid",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("arguments are invalid");

    await expect(
      connector.resolveCall(
        { tool: "mcp__demo__missing", args: { value: "ok" }, executionId: "watch-unknown" },
        context,
      ),
    ).rejects.toThrow("unknown or not authorized");
    await expect(
      connector.resolveCall(
        { tool: "mcp__demo__tool_29", args: {}, executionId: "watch-invalid" },
        context,
      ),
    ).rejects.toThrow("arguments are invalid");
    await expect(
      connector.resolveCall(
        { tool: "mcp__demo__tool_29", args: { value: "ok" }, executionId: "watch" },
        context,
      ),
    ).resolves.toMatchObject({
      tool: { name: "mcp__demo__tool_29", readOnly: undefined },
      call: {
        tool: "mcp__demo__tool_29",
        args: { value: "ok" },
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "tool_29" },
      },
    });

    const resolved = await connector.resolveCall(
      {
        tool: execute!.name,
        args: { id: "server-1:tool_29", arguments: { value: "ok" } },
        executionId: "execute",
        route: execute!.route,
      },
      context,
    );
    expect(resolved).toMatchObject({
      tool: { name: "mcp__demo__tool_29" },
      call: {
        tool: "mcp__demo__tool_29",
        args: { value: "ok" },
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "tool_29" },
      },
    });
    expect(await collect(resolved!.call)).toMatchObject([{ type: "result" }]);
    expect(state.calls).toEqual(["tool_29"]);
    prisma.botMcpServer.findMany.mockResolvedValue([
      { ...ASSIGNMENT, allowAllTools: false, allowedTools: [] },
    ]);
    await expect(
      connector.resolveCall(
        { tool: "mcp__demo__tool_29", args: { value: "ok" }, executionId: "watch-denied" },
        context,
      ),
    ).rejects.toThrow("unknown or not authorized");
    await connector.close();
  });

  it("executes authoritative MCP tools whose names match catalog controls", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: ["__catalog_search", "__catalog_load", "__catalog_execute"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    for (const tool of await connector.discoverTools(context)) {
      const call = { tool: tool.name, args: {}, executionId: tool.name, route: tool.route };
      await expect(connector.resolveCall(call, context)).resolves.toBeUndefined();
      const events = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
    }
    expect(state.calls).toEqual(["__catalog_search", "__catalog_load", "__catalog_execute"]);
    await connector.close();
  });

  it("gives a bot without an assignment every tool of a server shared with all agents", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: [{ name: "list_sites", inputSchema: { type: "object" } }],
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const shared = { ...SERVER, allBots: true };
    const prisma = {
      mcpServer: {
        findMany: vi.fn().mockResolvedValue([shared]),
        findFirst: vi.fn().mockResolvedValue(shared),
      },
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    const [tool] = await connector.discoverTools(context);
    expect(tool).toMatchObject({ name: "mcp__demo__list_sites" });
    expect(prisma.mcpServer.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        enabled: true,
        allBots: true,
        userId: "u1",
        assignments: { none: { botId: "bot-1" } },
      }),
    });
    const events = [];
    const call = { tool: tool!.name, args: {}, executionId: "call", route: tool!.route };
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "server-1", allBots: true, userId: "u1" }),
    });
    expect(state.calls).toEqual(["list_sites"]);
    await connector.close();
  });

  it.each([
    ["renews it and connects", { access_token: "fake-renewed", token_type: "bearer" }, true],
    ["asks for a reconnect when it cannot be renewed", undefined, false],
  ])(
    "when the server rejects an unexpired token with a JSON-RPC error, %s",
    async (_, renewed, connects) => {
      const state = { failNext: false, initializations: 0 };
      const healthy = mcpFetch(state);
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        {
          oauth: {
            tokens: {
              access_token: "fake-revoked",
              refresh_token: "fake-refresh",
              token_type: "bearer",
            },
          },
        },
        async () => undefined,
        { refresh: async () => ({ tokens: renewed, obtainedAt: Date.now() }) },
      );
      const connector = new McpConnector(
        {
          mcpServer: { ...NO_SHARED_SERVERS, updateMany: vi.fn(async () => ({ count: 1 })) },
          botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
        } as never,
        {} as never,
        {
          network: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
              const request = new Request(input, init);
              if (request.headers.get("authorization") !== "Bearer fake-revoked")
                return healthy(input, init);
              const { id } = (await request.json()) as { id?: number };
              return Response.json({
                jsonrpc: "2.0",
                id,
                error: { code: -32302, message: "Token is no longer active" },
              });
            }),
          },
        },
        { providerFor: vi.fn().mockResolvedValue(provider) } as unknown as McpOAuthBroker,
      );
      const error = vi.spyOn(getLogger(), "error");
      try {
        const tools = await connector.discoverTools({
          spaceId: "w1",
          userId: "u1",
          botId: "bot-1",
          signal: new AbortController().signal,
        } as never);
        expect(error).not.toHaveBeenCalled();
        if (connects) {
          expect(tools).not.toEqual(unavailableOnly());
          expect(state.initializations).toBe(1);
        } else {
          expect(tools).toEqual(unavailableOnly());
          expect(tools[0]?.description).toContain("Reconnect this server");
          expect(await provider.tokens()).toBeUndefined();
        }
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    },
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "blocks OAuth rediscovery to HTTP %s after invalid_client from a public server",
    async (host) => {
      const requests: Array<{ method: string; url: string }> = [];
      const metadataUrl = `http://${host}:8123/private-probe`;
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        {
          oauth: {
            redirectUri: "https://app.example.test/mcp/oauth/callback",
            tokens: {
              access_token: "fake-stale-access",
              refresh_token: "fake-refresh",
              token_type: "bearer",
            },
            clientInformation: { client_id: "fake-client" },
            discoveryState: {
              authorizationServerUrl: "https://auth.example.test",
              resourceMetadata: {
                resource: SERVER.endpoint,
                authorization_servers: ["https://auth.example.test"],
              },
              authorizationServerMetadata: {
                issuer: "https://auth.example.test",
                authorization_endpoint: "https://auth.example.test/authorize",
                token_endpoint: "https://auth.example.test/token",
                response_types_supported: ["code"],
              },
            },
          },
        },
        async () => undefined,
      );
      const invalidate = vi.spyOn(provider, "invalidateCredentials");
      const connector = new McpConnector(
        {
          mcpServer: NO_SHARED_SERVERS,
          botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
        } as never,
        {} as never,
        {
          network: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
              const request = new Request(input, init);
              const url = logicalHref(input, init);
              requests.push({ method: request.method, url });
              if (url === SERVER.endpoint) {
                return new Response(null, {
                  status: 401,
                  headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
                });
              }
              if (url === "https://auth.example.test/token") {
                return Response.json({ error: "invalid_client" }, { status: 400 });
              }
              return new Response(null, { status: 404 });
            }),
          },
        },
        { providerFor: vi.fn().mockResolvedValue(provider) } as unknown as McpOAuthBroker,
      );

      try {
        await expect(
          connector.discoverTools({
            spaceId: "w1",
            userId: "u1",
            botId: "bot-1",
            signal: new AbortController().signal,
          } as never),
        ).resolves.toEqual(unavailableOnly());

        expect(requests.slice(0, 2).map((request) => `${request.method} ${request.url}`)).toEqual([
          `POST ${SERVER.endpoint}`,
          "POST https://auth.example.test/token",
        ]);
        expect(invalidate).toHaveBeenCalledWith("all");
        expect(requests.some((request) => request.url === metadataUrl)).toBe(false);
        // The endpoint-origin compatibility retry remains allowed, through remote policy.
        expect(
          requests.some((request) => request.url === "https://mcp.example.test/private-probe"),
        ).toBe(true);
        expect(requests.every((request) => new URL(request.url).protocol === "https:")).toBe(true);
      } finally {
        await connector.close();
      }
    },
  );

  it("connects to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0 };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      allowPrivateEndpoint: true,
    });

    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("sends stored credentials to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ secret: "local-token", headers: { "X-Api-Key": "local-key" } }),
          ),
      } as never,
      { allowPrivateEndpoint: true },
    );

    await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(state.headers[0]?.authorization).toBe("Bearer local-token");
    expect(state.headers[0]?.["x-api-key"]).toBe("local-key");
    await connector.close();
  });

  it("evicts a session after a failed call so the next call reconnects instead of reusing a dead session", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;

    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.initializations).toBe(1);

    state.failNext = true;
    const failed: unknown[] = [];
    for await (const event of connector.execute(call, context)) failed.push(event);
    expect(failed).toMatchObject([{ type: "error" }]);

    state.failNext = false;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it.each(["the server's own error", "a cancelled run"] as const)(
    "keeps a healthy session after a call fails with %s",
    async (scenario) => {
      const state = {
        failNext: false,
        initializations: 0,
        rpcError: false,
        holdCalls: false,
        calls: [] as string[],
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const prisma = {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: {
          findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
          findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
        },
      };
      const connector = new McpConnector(prisma as never, {} as never, {
        network: TEST_NETWORK,
      });
      const contextWith = (signal: AbortSignal) =>
        ({ spaceId: "w1", userId: "u1", botId: "bot-1", signal }) as never;
      const call = {
        tool: "mcp__demo__echo",
        args: {},
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
      } as never;

      await connector.discoverTools(contextWith(new AbortController().signal));
      expect(state.initializations).toBe(1);

      const run = new AbortController();
      if (scenario === "a cancelled run") state.holdCalls = true;
      else state.rpcError = true;
      const failed: unknown[] = [];
      const failing = (async () => {
        for await (const event of connector.execute(call, contextWith(run.signal)))
          failed.push(event);
      })();
      if (scenario === "a cancelled run") {
        await vi.waitFor(() => expect(state.calls).toEqual(["echo"]));
        run.abort(new Error("Run cancelled"));
      }
      await failing;
      expect(failed).toMatchObject([{ type: "error" }]);

      state.holdCalls = false;
      state.rpcError = false;
      const events: unknown[] = [];
      for await (const event of connector.execute(call, contextWith(new AbortController().signal)))
        events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(1);

      await connector.close();
    },
  );

  it("restarts a server silent for the whole tool timeout, but not one a later call replaced", async () => {
    vi.useFakeTimers();
    const state = { failNext: false, initializations: 0, holdCalls: true, calls: [] as string[] };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const execute = async () => {
      const events: unknown[] = [];
      for await (const event of connector.execute(
        {
          tool: "mcp__demo__echo",
          args: {},
          route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
        } as never,
        context,
      ))
        events.push(event);
      return events;
    };
    try {
      await connector.discoverTools(context);
      expect(state.initializations).toBe(1);
      // Two calls hang on the first session; the second starts halfway through the first's wait.
      const first = execute();
      await vi.waitFor(() => expect(state.calls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(MCP_TOOL_TIMEOUT_MS / 2);
      const second = execute();
      await vi.waitFor(() => expect(state.calls).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(MCP_TOOL_TIMEOUT_MS / 2);
      expect(await first).toMatchObject([{ type: "error" }]);

      // The hung session was dropped, so the next call starts a fresh one.
      state.holdCalls = false;
      expect(await execute()).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(2);

      // The second call times out on the old session and leaves the fresh one alone.
      await vi.advanceTimersByTimeAsync(MCP_TOOL_TIMEOUT_MS);
      expect(await second).toMatchObject([{ type: "error" }]);
      expect(await execute()).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(2);
    } finally {
      await connector.close();
      vi.useRealTimers();
    }
  });

  it("retries a call once on a fresh session when the server expired the cached one", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      sessionNotFound: 0,
      rejectedRequests: [] as string[],
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;

    await connector.discoverTools(context);
    state.sessionNotFound = 1;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);
    expect(state.calls).toEqual(["echo"]);

    expect(state.rejectedRequests).toEqual(["tools/call"]);

    // A server that keeps forgetting the session gets one retry, not a loop.
    state.sessionNotFound = 2;
    const failed: unknown[] = [];
    for await (const event of connector.execute(call, context)) failed.push(event);
    expect(failed).toMatchObject([{ type: "error" }]);
    expect(state.initializations).toBe(3);
    expect(state.rejectedRequests).toEqual(["tools/call", "tools/call", "tools/call"]);
    expect(state.sessionNotFound).toBe(0);
    expect(state.calls).toEqual(["echo"]);

    await connector.close();
  });

  it("reconnects with the rotated secret when a session expires during refresh", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      sessionNotFound: 0,
      headers: [] as Record<string, string>[],
    };
    const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: "old" } };
    let current = "old";
    const materials = {
      old: { oauth: { tokens: { access_token: "old-token", token_type: "Bearer" } } },
      new: { oauth: { tokens: { access_token: "new-token", token_type: "Bearer" } } },
    };
    const fetch = mcpFetch(state);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (state.sessionNotFound && request.method === "POST") current = "new";
      return fetch(input, init);
    });
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([assignment]),
        findFirst: vi.fn().mockResolvedValue(assignment),
      },
      mcpServer: { ...NO_SHARED_SERVERS, findFirst: vi.fn(async () => ({ secretId: current })) },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === current ? { id: current, ciphertext: current } : null,
        ),
      },
    };
    const oauth = {
      providerFor: vi.fn(
        async (_server: unknown, _context: unknown, loaded: { material: OAuthMaterial }) =>
          loaded.material.oauth
            ? new StoredMcpOAuthProvider("server-1", loaded.material, async () => undefined)
            : undefined,
      ),
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi.fn(async (ref: keyof typeof materials) => JSON.stringify(materials[ref])),
      } as never,
      { network: TEST_NETWORK },
      oauth as unknown as McpOAuthBroker,
    );
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;
    try {
      await connector.discoverTools(context);
      state.sessionNotFound = 1;
      const events: unknown[] = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
      expect(state.initializations).toBe(2);
      expect(state.headers.at(-1)?.authorization).toBe("Bearer new-token");
    } finally {
      await connector.close();
    }
  });

  it.each(["changed configuration", "missing replacement secret"])(
    "does not connect with a stale server when the %s prevents loading credentials",
    async (scenario) => {
      const assignment = { ...ASSIGNMENT, server: { ...SERVER, secretId: "old" } };
      const network = { ...TEST_NETWORK, fetch: vi.fn() };
      const load = vi.fn();
      const prisma = {
        mcpServer: {
          findFirst: vi.fn(async ({ where }: { where: { revision: number } }) =>
            scenario === "changed configuration" && where.revision === 1
              ? null
              : { secretId: "new" },
          ),
        },
        secret: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      const connector = new McpConnector(prisma as never, { load } as never, { network });
      const context = {
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never;
      try {
        await expect(
          (
            connector as unknown as {
              connectSession: (
                server: unknown,
                context: unknown,
                onRef: () => void,
              ) => Promise<unknown>;
            }
          ).connectSession(assignment.server, context, () => undefined),
        ).rejects.toThrow("MCP server secret is unavailable");
        expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ revision: 1 }) }),
        );
        expect(load).not.toHaveBeenCalled();
        expect(network.fetch).not.toHaveBeenCalled();
      } finally {
        await connector.close();
      }
    },
  );

  it("retries concurrent calls on an expired session without closing in-flight requests", async () => {
    const state = { failNext: false, initializations: 0, calls: [] as string[] };
    const fetch = mcpFetch(state);
    let startBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      startBoth = resolve;
    });
    let reconnect!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      reconnect = resolve;
    });
    let expiredCalls = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        const message = JSON.parse(await request.clone().text());
        if (message.method === "initialize" && state.initializations === 1) reconnect();
        if (message.method === "tools/call" && expiredCalls < 2) {
          expiredCalls += 1;
          if (expiredCalls === 1) await bothStarted;
          else {
            startBoth();
            await reconnected;
          }
          return new Response("Session not found", { status: 404 });
        }
      }
      return fetch(input, init);
    });
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: {
          findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
          findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
        },
      } as never,
      {} as never,
      { network: TEST_NETWORK },
    );
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    try {
      await connector.discoverTools(context);
      const execute = async (toolName: string) => {
        const events = [];
        for await (const event of connector.execute(
          {
            tool: `mcp__demo__${toolName}`,
            args: {},
            executionId: toolName,
            route: { connectorId: "mcp", resourceId: "server-1", toolName },
          },
          context,
        ))
          events.push(event);
        return events;
      };
      const results = await Promise.all([execute("first"), execute("second")]);
      expect(results).toMatchObject([[{ type: "result" }], [{ type: "result" }]]);
      expect(expiredCalls).toBe(2);
      expect(state.initializations).toBe(2);
      expect(state.calls.sort()).toEqual(["first", "second"]);
    } finally {
      await connector.close();
    }
  });

  it("lets a running call finish when another run's discovery times out on its session", async () => {
    const state = { failNext: false, initializations: 0, calls: [] as string[] };
    const fetch = mcpFetch(state);
    let lists = 0;
    let callStarted!: () => void;
    const callArrived = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    let releaseCall!: () => void;
    const callReleased = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    let releaseList!: () => void;
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        const message = JSON.parse(await request.clone().text());
        if (message.method === "tools/call") {
          callStarted();
          await callReleased;
        }
        if (message.method === "tools/list" && ++lists === 2) {
          // The server stops answering tools/list.
          await listReleased;
          return new Response(null, { status: 202 });
        }
      }
      return fetch(input, init);
    });
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: {
          findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
          findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
        },
      } as never,
      {} as never,
      { network: TEST_NETWORK, discoveryTimeoutMs: 200 },
    );
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    try {
      await connector.discoverTools(context);
      const running = (async () => {
        const events = [];
        for await (const event of connector.execute(
          {
            tool: "mcp__demo__slow",
            args: {},
            executionId: "slow",
            route: { connectorId: "mcp", resourceId: "server-1", toolName: "slow" },
          },
          context,
        ))
          events.push(event);
        return events;
      })();
      await callArrived;

      expect(await connector.discoverTools(context)).toMatchObject([
        { name: "mcp__demo__unavailable" },
      ]);
      releaseCall();
      expect(await running).toMatchObject([{ type: "result" }]);
      expect(state.calls).toEqual(["slow"]);
      expect(state.initializations).toBe(1);
    } finally {
      releaseList();
      await connector.close();
    }
  });

  it("keeps a server's tools when discovery finds the cached session expired", async () => {
    const state = { failNext: false, initializations: 0, sessionNotFound: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    await connector.discoverTools(context);
    state.sessionNotFound = 1;
    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it.each([
    "Bad Request: Server not initialized",
    "Bad Request: No valid session ID",
    "Bad Request: No valid session ID provided",
    "Bad Request: No valid session ID or initialization request",
    "Bad Request: Mcp-Session-Id header is required",
    JSON.stringify({ error: { code: -32000, message: "Bad Request: Server not initialized" } }),
    "bad request: server not initialized",
  ])("retries a 400 that names the lost session, but not other bad requests (%s)", async (body) => {
    const state = {
      failNext: false,
      initializations: 0,
      sessionNotFound: 0,
      sessionNotFoundResponse: { status: 400, body },
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    await connector.discoverTools(context);
    state.sessionNotFound = 1;
    expect((await connector.discoverTools(context)).map((tool) => tool.name)).toEqual([
      "mcp__demo__echo",
    ]);
    expect(state.initializations).toBe(2);

    state.sessionNotFound = 1;
    state.sessionNotFoundResponse = { status: 400, body: "Bad Request: Invalid session parameter" };
    // Not retried: the server's tools are replaced by the stand-in that carries the reason.
    expect((await connector.discoverTools(context)).map((tool) => tool.name)).toEqual([
      "mcp__demo__unavailable",
    ]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it("does not reuse one session across workspaces", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
    });
    const contextFor = (spaceId: string, userId: string) =>
      ({ spaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w1", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w2", "u1"));
    expect(state.initializations).toBe(3);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(3);

    await connector.close();
  });
});

describe("MCP connector stdio OAuth", () => {
  const STDIO_SERVER = {
    id: "server-1",
    slug: "mail",
    transport: "stdio",
    command: "mail-mcp",
    endpoint: null,
    secretId: "secret-1",
    args: [],
    revision: 1,
  };
  const context = {
    spaceId: "w1",
    userId: "u1",
    botId: "bot-1",
    runId: undefined,
    signal: new AbortController().signal,
  } as never;

  /** Stored as one fixed value, as in the database: a changing value reads as a credential write. */
  function stored(overrides: Partial<OAuthMaterial> = {}, mutate?: (value: OAuthMaterial) => void) {
    const value = material(overrides);
    mutate?.(value);
    const json = JSON.stringify(value);
    return () => JSON.parse(json) as OAuthMaterial;
  }

  function material(
    overrides: Partial<OAuthMaterial> = {},
    obtainedAt = Date.now(),
  ): OAuthMaterial {
    return {
      env: {
        MAIL_TOKEN: "Bearer {{oauth.access_token}}",
        MAIL_CLIENT_ID: "{{oauth.client_id}}",
        MAIL_REGION: "eu",
      },
      oauthClient: {
        client_id: "client-1",
        client_secret: "client-secret",
        authorization_server: "https://auth.example.test/",
      },
      oauth: {
        tokens: {
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        },
        obtainedAt,
      },
      ...overrides,
    };
  }

  function stdioConnector(
    load: () => OAuthMaterial,
    oauth: Pick<McpOAuthBroker, "providerFor"> | undefined,
  ) {
    const assignment = { ...ASSIGNMENT, server: STDIO_SERVER };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })) },
    };
    const secrets = { load: vi.fn(async () => JSON.stringify(load())) };
    const connector = new McpConnector(
      prisma as never,
      secrets as never,
      { stdioEnabled: true, allowedCommands: ["mail-mcp"] },
      oauth as McpOAuthBroker | undefined,
    );
    return connector;
  }

  /** A broker whose provider holds whatever the stored material says. */
  function brokerFor() {
    return {
      providerFor: vi.fn<McpOAuthBroker["providerFor"]>(async (_server, _context, loaded) =>
        loaded?.material.oauth
          ? new StoredMcpOAuthProvider("server-1", loaded.material, async () => undefined)
          : undefined,
      ),
    };
  }

  function stubSession() {
    const launches: Array<Record<string, string> | undefined> = [];
    vi.spyOn(McpSession.prototype, "connectStdio").mockImplementation(async (options) => {
      launches.push(options.env);
    });
    vi.spyOn(McpSession.prototype, "listTools").mockResolvedValue({ tools: [] });
    vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
    return launches;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([false, true])(
    "refuses expired launch tokens (refresh token: %s)",
    async (refreshable) => {
      const launches = stubSession();
      const load = stored({}, (value) => {
        if (value.oauth) value.oauth.obtainedAt = Date.now() - 7200_000;
        if (!refreshable) delete value.oauth?.tokens?.refresh_token;
      });
      const connector = stdioConnector(load, brokerFor());
      await connector.discoverTools(context);
      expect(launches).toHaveLength(0);
      await connector.close();
    },
  );

  it("redacts a credential still held in a legacy row's launch arguments", async () => {
    const token = "FAKE-TOKEN-0000000000000000";
    vi.spyOn(McpSession.prototype, "connectStdio").mockRejectedValue(
      new Error(`invalid --api-key ${token}`),
    );
    vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
    const server = { ...STDIO_SERVER, secretId: null, args: ["--api-key", token] };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn(async () => [{ ...ASSIGNMENT, server }]) },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      stdioEnabled: true,
      allowedCommands: ["mail-mcp"],
    });

    const tools = await connector.discoverTools(context);

    expect(tools).toEqual(unavailableOnly("mail"));
    expect(tools[0]?.description).not.toContain(token);
    expect(tools[0]?.description).toContain("[redacted]");
    await connector.close();
  });

  it("waits for active calls before replacing an expiring process", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const connector = stdioConnector(stored(), brokerFor());
    await connector.discoverTools(context);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    vi.spyOn(McpSession.prototype, "listTools").mockImplementationOnce(async () => {
      enter();
      await held;
      return { tools: [] };
    });
    const active = connector.discoverTools(context);
    await entered;
    vi.setSystemTime(Date.now() + 3550_000);
    await connector.discoverTools(context);
    expect(launches).toHaveLength(1);
    release();
    await active;
    await connector.discoverTools(context);
    expect(launches).toHaveLength(2);
    await connector.close();
  });

  it("launches the process with the OAuth references resolved", async () => {
    const launches = stubSession();
    const load = stored();
    const connector = stdioConnector(load, brokerFor());

    await connector.discoverTools(context);

    expect(launches).toEqual([
      { MAIL_TOKEN: "Bearer access-1", MAIL_CLIENT_ID: "client-1", MAIL_REGION: "eu" },
    ]);
    await connector.close();
  });

  it("resolves the client secret and refresh token too", async () => {
    const launches = stubSession();
    const load = stored({
      env: { ID: "{{oauth.client_id}}:{{oauth.client_secret}}", RT: "{{oauth.refresh_token}}" },
    });
    const connector = stdioConnector(load, brokerFor());

    await connector.discoverTools(context);

    expect(launches).toEqual([{ ID: "client-1:client-secret", RT: "refresh-1" }]);
    await connector.close();
  });

  it("does not involve OAuth for an env without references", async () => {
    const launches = stubSession();
    const load = stored({ env: { MAIL_REGION: "eu" }, oauth: undefined });
    const oauth = brokerFor();
    const connector = stdioConnector(load, oauth);

    await connector.discoverTools(context);

    expect(launches).toEqual([{ MAIL_REGION: "eu" }]);
    expect(oauth.providerFor).not.toHaveBeenCalled();
    await connector.close();
  });

  it.each([
    ["has not connected", stored({ oauth: undefined })],
    ["has no tokens", stored({ oauth: {} })],
  ])("asks the user to connect when the server %s", async (_name, load) => {
    const launches = stubSession();
    const connector = stdioConnector(load, brokerFor());
    const call = {
      tool: "mcp__mail__send",
      args: {},
      executionId: "call-1",
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "send" },
    };

    const events = [];
    for await (const event of connector.execute(call, context)) events.push(event);

    expect(events).toMatchObject([
      { type: "error", message: expect.stringContaining("Reconnect") },
    ]);
    expect(launches).toEqual([]);
    await connector.close();
  });

  it("asks the user to connect when no OAuth broker is configured", async () => {
    const launches = stubSession();
    const connector = stdioConnector(stored(), undefined);
    const call = {
      tool: "mcp__mail__send",
      args: {},
      executionId: "call-1",
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "send" },
    };

    const events = [];
    for await (const event of connector.execute(call, context)) events.push(event);

    expect(events).toMatchObject([
      { type: "error", message: expect.stringContaining("Reconnect") },
    ]);
    expect(launches).toEqual([]);
    await connector.close();
  });

  it("keeps the credential values out of the error when a reference cannot be resolved", async () => {
    const launches = stubSession();
    const load = stored(
      { env: { RT: "{{oauth.refresh_token}}", TOKEN: "{{oauth.access_token}}" } },
      (value) => delete value.oauth?.tokens?.refresh_token,
    );
    const connector = stdioConnector(load, brokerFor());
    const call = {
      tool: "mcp__mail__send",
      args: {},
      executionId: "call-1",
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "send" },
    };

    const events = [];
    for await (const event of connector.execute(call, context)) events.push(event);

    expect(events).toMatchObject([{ type: "error" }]);
    expect(JSON.stringify(events)).not.toContain("access-1");
    expect(launches).toEqual([]);
    await connector.close();
  });

  it("restarts the process before its access token expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const oauth = brokerFor();
    const connector = stdioConnector(stored(), oauth);

    await connector.discoverTools(context);
    vi.setSystemTime(Date.now() + 3600_000 - 120_000);
    await connector.discoverTools(context);
    expect(launches).toHaveLength(1);

    // The provider renews the grant when asked for tokens inside the last minute.
    oauth.providerFor.mockImplementationOnce(async (_server, _context, loaded) => {
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        loaded?.material ?? {},
        async () => undefined,
      );
      vi.spyOn(provider, "tokens").mockImplementation(async () => {
        const renewed = {
          access_token: "access-2",
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        };
        if (loaded?.material.oauth) {
          loaded.material.oauth.tokens = renewed;
          loaded.material.oauth.obtainedAt = Date.now();
        }
        return renewed;
      });
      return provider;
    });
    vi.setSystemTime(Date.now() + 90_000);
    await connector.discoverTools(context);
    await connector.discoverTools(context);

    expect(launches).toHaveLength(2);
    expect(launches[1]?.MAIL_TOKEN).toBe("Bearer access-2");
    await connector.close();
  });

  it("keeps a process whose env does not use the access token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const connector = stdioConnector(
      stored({ env: { MAIL_CLIENT_ID: "{{oauth.client_id}}" } }),
      brokerFor(),
    );

    await connector.discoverTools(context);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await connector.discoverTools(context);

    expect(launches).toHaveLength(1);
    await connector.close();
  });

  it("keeps a process whose access token cannot be renewed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const load = stored({}, (value) => delete value.oauth?.tokens?.refresh_token);
    const connector = stdioConnector(load, brokerFor());

    await connector.discoverTools(context);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await connector.discoverTools(context);

    expect(launches).toHaveLength(1);
    await connector.close();
  });
});

describe("MCP connector stdio credential files", () => {
  const STDIO_SERVER = {
    id: "server-1",
    slug: "mail",
    transport: "stdio",
    command: "mail-mcp",
    endpoint: null,
    secretId: "secret-1",
    args: [],
    revision: 1,
  };
  const context = {
    spaceId: "w1",
    userId: "u1",
    botId: "bot-1",
    runId: undefined,
    signal: new AbortController().signal,
  } as never;
  const FILE_TEMPLATE =
    '{"token":"{{oauth.access_token}}","expiry":{{oauth.expires_at}},"scope":"{{oauth.scope}}","type":"{{oauth.token_type}}","id":"{{oauth.client_id}}"}';

  function material(
    overrides: Partial<OAuthMaterial> = {},
    obtainedAt = Date.now(),
  ): OAuthMaterial {
    return {
      env: { MAIL_REGION: "eu" },
      files: { MAIL_CREDENTIALS: FILE_TEMPLATE },
      oauthClient: {
        client_id: "client-1",
        client_secret: "client-secret",
        authorization_server: "https://auth.example.test/",
        scope: "mail.read",
      },
      oauth: {
        tokens: {
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        },
        obtainedAt,
      },
      ...overrides,
    };
  }

  /** Stored as one fixed value, as in the database. */
  function stored(overrides: Partial<OAuthMaterial> = {}, obtainedAt = Date.now()) {
    const json = JSON.stringify(material(overrides, obtainedAt));
    return () => JSON.parse(json) as OAuthMaterial;
  }

  function connectorFor(load: () => OAuthMaterial, withBroker = true, refresh = false) {
    const assignment = { ...ASSIGNMENT, server: STDIO_SERVER };
    const prisma = {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: {
        findMany: vi.fn(async () => [assignment]),
        findFirst: vi.fn(async () => assignment),
      },
      secret: { findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })) },
    };
    const secrets = { load: vi.fn(async () => JSON.stringify(load())) };
    const broker = {
      providerFor: vi.fn<McpOAuthBroker["providerFor"]>(async (_server, _context, loaded) =>
        loaded?.material.oauth
          ? new StoredMcpOAuthProvider("server-1", loaded.material, async () => undefined, {
              ...(refresh
                ? {
                    refresh: async () => ({
                      tokens: {
                        access_token: "renewed-access",
                        refresh_token: "renewed-refresh",
                        token_type: "Bearer",
                        expires_in: 3600,
                      },
                      obtainedAt: Date.now(),
                    }),
                  }
                : {}),
            })
          : undefined,
      ),
    };
    return new McpConnector(
      prisma as never,
      secrets as never,
      { stdioEnabled: true, allowedCommands: ["mail-mcp"], credentialTempRoot: credentialRoot },
      withBroker ? (broker as unknown as McpOAuthBroker) : undefined,
    );
  }

  const credentialRoot = mkdtempSync(join(tmpdir(), "mcp-credentials-test-"));
  afterAll(() => rmSync(credentialRoot, { recursive: true, force: true }));

  type Launch = {
    env: Record<string, string>;
    /** What the launched process could read at start-up, by env variable. */
    files: Record<string, { content: string; mode: number; dir: string; dirMode: number }>;
  };

  /** Records each launch and snapshots the credential files while they exist. */
  function stubSession(connect?: () => Promise<void>) {
    const launches: Launch[] = [];
    vi.spyOn(McpSession.prototype, "connectStdio").mockImplementation(async (options) => {
      const env = options.env ?? {};
      const files: Launch["files"] = {};
      for (const [key, value] of Object.entries(env)) {
        if (!value.startsWith(tmpdir()) || !existsSync(value)) continue;
        const dir = dirname(value);
        files[key] = {
          content: readFileSync(value, "utf8"),
          mode: statSync(value).mode & 0o777,
          dir,
          dirMode: statSync(dir).mode & 0o777,
        };
      }
      launches.push({ env, files });
      await connect?.();
    });
    vi.spyOn(McpSession.prototype, "listTools").mockResolvedValue({ tools: [] });
    vi.spyOn(McpSession.prototype, "close").mockImplementation(async (afterClose) => {
      await afterClose?.();
    });
    return launches;
  }

  const credentialDirs = () =>
    readdirSync(credentialRoot).filter((name) => name.startsWith("rakazo-mcp-"));

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("launches with the refreshed grant when the stored grant has expired", async () => {
    const launches = stubSession();
    const connector = connectorFor(stored({}, Date.now() - 7200_000), true, true);
    await connector.discoverTools(context);
    expect(launches).toHaveLength(1);
    const content = JSON.parse(launches[0]?.files.MAIL_CREDENTIALS?.content ?? "{}");
    expect(content.token).toBe("renewed-access");
    expect(content.expiry).toBeGreaterThan(Date.now());
    await connector.close();
  });

  it("preserves ordinary config values in tool results", async () => {
    stubSession();
    const connector = connectorFor(stored({ env: { DEBUG: "1", NODE_ENV: "production" } }));
    const text = "1 production authorized_user";
    vi.spyOn(McpSession.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text }],
    });
    const events = [];
    for await (const event of connector.execute(
      {
        tool: "mcp__mail__read",
        args: {},
        executionId: "test",
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "read" },
      },
      context,
    ))
      events.push(event);
    expect(JSON.stringify(events)).toContain(text);
    await connector.close();
  });

  it.each([false, true])(
    "keeps files until a delayed SDK shutdown settles (rejects: %s)",
    async (rejects) => {
      const launches = stubSession();
      vi.mocked(McpSession.prototype.close).mockRestore();
      const connector = connectorFor(stored());
      await connector.discoverTools(context);
      const session = vi.mocked(McpSession.prototype.connectStdio).mock.contexts[0] as McpSession;
      let finish!: () => void;
      vi.spyOn(session.client, "close").mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () => (rejects ? reject(new Error("shutdown failed")) : resolve());
          }),
      );
      const dir = launches[0]!.files.MAIL_CREDENTIALS!.dir;
      vi.useFakeTimers();
      try {
        const closing = connector.close();
        await vi.advanceTimersByTimeAsync(MCP_CLOSE_TIMEOUT_MS);
        await closing;
        expect(existsSync(dir)).toBe(true);
        finish();
        vi.useRealTimers();
        await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
      } finally {
        finish();
        vi.useRealTimers();
        await connector.close();
      }
    },
  );

  it("removes credentials when reconnect replaces a session", async () => {
    const launches = stubSession();
    const connector = connectorFor(stored());
    vi.spyOn(McpSession.prototype, "listTools")
      .mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found"))
      .mockResolvedValue({ tools: [] });
    await connector.discoverTools(context);
    expect(launches).toHaveLength(2);
    expect(existsSync(launches[0]?.files.MAIL_CREDENTIALS?.dir ?? "missing")).toBe(false);
    await connector.close();
  });

  it("redacts literal JSON secrets alongside OAuth substitutions on launch and discovery errors", async () => {
    const launches = stubSession();
    const load = stored({
      files: { CREDS: '{"client_secret":"literal-file-secret","token":"{{oauth.access_token}}"}' },
      env: { CUSTOM: "prefix-{{oauth.access_token}}" },
    });
    vi.spyOn(McpSession.prototype, "listTools").mockRejectedValue(
      new Error("literal-file-secret prefix-access-1 access-1"),
    );
    const connector = connectorFor(load);
    const log = vi.spyOn(getLogger(), "error");
    await connector.discoverTools(context);
    expect(JSON.stringify(log.mock.calls)).not.toContain("literal-file-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("prefix-access-1");
    await connector.close();
    expect(existsSync(launches[0]?.files.CREDS?.dir ?? "missing")).toBe(false);
  });

  it("removes credentials when the child closes without eviction", async () => {
    const launches = stubSession();
    const connector = connectorFor(stored());
    await connector.discoverTools(context);
    const session = vi.mocked(McpSession.prototype.connectStdio).mock.contexts[0] as McpSession;
    session?.client.onclose?.();
    await vi.waitFor(() =>
      expect(existsSync(launches[0]?.files.MAIL_CREDENTIALS?.dir ?? "missing")).toBe(false),
    );
    await connector.close();
  });

  it("redacts resolved file and environment values when connection fails", async () => {
    stubSession(async () => {
      throw new Error("literal-file-secret prefix-access-1 access-1");
    });
    const connector = connectorFor(
      stored({
        files: { CREDS: '{"secret":"literal-file-secret","token":"{{oauth.access_token}}"}' },
        env: { CUSTOM: "prefix-{{oauth.access_token}}" },
      }),
    );
    const log = vi.spyOn(getLogger(), "error");
    await connector.discoverTools(context);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /literal-file-secret|prefix-access-1|access-1/,
    );
    await connector.close();
  });

  it.each([false, true])("redacts resolved credentials from calls (throws: %s)", async (throws) => {
    stubSession();
    const connector = connectorFor(
      stored({
        files: { CREDS: '{"secret":"literal-file-secret","token":"{{oauth.access_token}}"}' },
        env: { CUSTOM: "prefix-{{oauth.access_token}}" },
      }),
    );
    const text = "literal-file-secret prefix-access-1 access-1";
    vi.spyOn(McpSession.prototype, "callTool").mockImplementation(async () => {
      if (throws) throw new Error(text);
      return { content: [{ type: "text", text }] };
    });
    const events = [];
    for await (const event of connector.execute(
      {
        tool: "mcp__mail__read",
        args: {},
        executionId: "test",
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "read" },
      },
      context,
    ))
      events.push(event);
    expect(events).toMatchObject([{ type: throws ? "error" : "result" }]);
    expect(JSON.stringify(events)).not.toMatch(/literal-file-secret|prefix-access-1|access-1/);
    expect(JSON.stringify(events)).toContain("[redacted]");
    await connector.close();
  });

  it("writes the resolved template to a private file and passes its path in the env", async () => {
    const launches = stubSession();
    const connector = connectorFor(stored());

    await connector.discoverTools(context);

    const [launch] = launches;
    const file = launch?.files.MAIL_CREDENTIALS;
    expect(launch?.env.MAIL_REGION).toBe("eu");
    expect(launch?.env.MAIL_CREDENTIALS).toMatch(/\/MAIL_CREDENTIALS$/);
    expect(file?.dir.startsWith(`${credentialRoot}/rakazo-mcp-`)).toBe(true);
    expect(file?.dirMode).toBe(0o700);
    expect(file?.mode).toBe(0o600);
    expect(JSON.parse(file?.content ?? "")).toEqual({
      token: "access-1",
      expiry: expect.any(Number),
      scope: "mail.read",
      type: "Bearer",
      id: "client-1",
    });
    await connector.close();
  });

  it("uses the granted scope over the configured one and the stored expiry", async () => {
    const launches = stubSession();
    const obtainedAt = Date.now();
    const load = stored(
      {
        oauth: {
          tokens: {
            access_token: "access-1",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "mail.read mail.send",
          },
          obtainedAt,
        },
      },
      obtainedAt,
    );
    const connector = connectorFor(load);

    await connector.discoverTools(context);

    const content = JSON.parse(launches[0]?.files.MAIL_CREDENTIALS?.content ?? "{}");
    expect(content.scope).toBe("mail.read mail.send");
    expect(content.expiry).toBe(obtainedAt + 3600_000);
    await connector.close();
  });

  it("writes a static file without involving OAuth", async () => {
    const launches = stubSession();
    const load = stored({ files: { MAIL_CREDENTIALS: '{"kind":"static"}' }, oauth: undefined });
    const connector = connectorFor(load, false);

    await connector.discoverTools(context);

    expect(launches[0]?.files.MAIL_CREDENTIALS?.content).toBe('{"kind":"static"}');
    await connector.close();
  });

  it("asks the user to connect, and leaves no directory, when a file needs a missing grant", async () => {
    const launches = stubSession();
    const before = credentialDirs();
    const connector = connectorFor(stored({ oauth: undefined }));
    const call = {
      tool: "mcp__mail__send",
      args: {},
      executionId: "call-1",
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "send" },
    };

    const events = [];
    for await (const event of connector.execute(call, context)) events.push(event);

    expect(events).toMatchObject([
      { type: "error", message: expect.stringContaining("Reconnect") },
    ]);
    expect(launches).toEqual([]);
    expect(credentialDirs()).toEqual(before);
    await connector.close();
  });

  it("removes the directory when the process fails to start", async () => {
    const launches = stubSession(async () => {
      throw new Error("spawn failed");
    });
    const connector = connectorFor(stored());

    await connector.discoverTools(context);

    const dir = launches[0]?.files.MAIL_CREDENTIALS?.dir ?? "";
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
    await connector.close();
  });

  it("removes the directory when the connector closes", async () => {
    const launches = stubSession();
    const connector = connectorFor(stored());
    await connector.discoverTools(context);
    const dir = launches[0]?.files.MAIL_CREDENTIALS?.dir ?? "";
    expect(existsSync(dir)).toBe(true);

    await connector.close();

    expect(existsSync(dir)).toBe(false);
  });

  it("replaces the directory when the process restarts before the token expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const connector = connectorFor(stored());

    await connector.discoverTools(context);
    const first = launches[0]?.files.MAIL_CREDENTIALS?.dir ?? "";
    vi.setSystemTime(Date.now() + 3600_000 - 30_000);
    await connector.discoverTools(context);

    const second = launches[1]?.files.MAIL_CREDENTIALS?.dir ?? "";
    expect(launches).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    await connector.close();
    expect(existsSync(second)).toBe(false);
  });

  it("keeps a process whose file does not use the access token or expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const connector = connectorFor(
      stored({ files: { MAIL_CREDENTIALS: '{"id":"{{oauth.client_id}}"}' } }),
    );

    await connector.discoverTools(context);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await connector.discoverTools(context);

    expect(launches).toHaveLength(1);
    await connector.close();
  });

  it("restarts for a file that only references expires_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launches = stubSession();
    const connector = connectorFor(
      stored({ files: { MAIL_CREDENTIALS: '{"expiry":{{oauth.expires_at}}}' } }),
    );

    await connector.discoverTools(context);
    vi.setSystemTime(Date.now() + 3600_000 - 30_000);
    await connector.discoverTools(context);

    expect(launches).toHaveLength(2);
    await connector.close();
  });

  it("lets the file path win over an env value with the same name", async () => {
    const launches = stubSession();
    const connector = connectorFor(stored({ env: { MAIL_CREDENTIALS: "plain" } }));

    await connector.discoverTools(context);

    const env = launches[0]?.env.MAIL_CREDENTIALS;
    expect(env).not.toBe("plain");
    expect(env).toBe(launches[0] && Object.keys(launches[0].files).length ? env : undefined);
    expect(launches[0]?.files.MAIL_CREDENTIALS).toBeDefined();
    await connector.close();
  });
});

describe("MCP connector private endpoints", () => {
  const privateAssignment = {
    ...ASSIGNMENT,
    server: { ...SERVER, endpoint: "http://10.0.0.8:3927/mcp" },
  };
  const lanDnsAssignment = {
    ...ASSIGNMENT,
    server: { ...SERVER, endpoint: "https://mcp.lan.test/mcp" },
  };

  it("does not connect a private IP for a non-owner when the instance escape is off", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: { findMany: vi.fn().mockResolvedValue([privateAssignment]) },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
      } as never,
      {} as never,
      { network: { fetch, resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }] } },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools).toEqual(unavailableOnly());
    expect(fetch).not.toHaveBeenCalled();
    await connector.close();
  });

  it.each(["http://localhost:3100/api/auth/get-session", "https://127.0.0.1:3100/mcp"])(
    "does not connect loopback %s for a non-owner",
    async (endpoint) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const connector = new McpConnector(
        {
          mcpServer: NO_SHARED_SERVERS,
          botMcpServer: {
            findMany: vi
              .fn()
              .mockResolvedValue([{ ...ASSIGNMENT, server: { ...SERVER, endpoint } }]),
          },
          deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
        } as never,
        {} as never,
        { network: { fetch, resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }] } },
      );
      const tools = await connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never);
      expect(tools).toEqual(unavailableOnly());
      expect(fetch).not.toHaveBeenCalled();
      await connector.close();
    },
  );

  it("connects a private IP under explicit operator configuration", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state, "http://10.0.0.8:3927/mcp"));
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: { findMany: vi.fn().mockResolvedValue([privateAssignment]) },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
      } as never,
      {} as never,
      {
        allowPrivateEndpoint: true,
        network: {
          fetch: (input, init) => globalThis.fetch(input, init),
          resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }],
        },
      },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("connects a private-resolving DNS name under explicit operator configuration", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state, "https://mcp.lan.test/mcp"));
    const connector = new McpConnector(
      {
        mcpServer: NO_SHARED_SERVERS,
        botMcpServer: { findMany: vi.fn().mockResolvedValue([lanDnsAssignment]) },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "u1" })) },
      } as never,
      {} as never,
      {
        allowPrivateEndpoint: true,
        network: {
          fetch: (input, init) => globalThis.fetch(input, init),
          resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }],
        },
      },
    );
    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });
});

describe("allowlistDrift", () => {
  it("names the allowed tools the server no longer offers", () => {
    const offered = [{ name: "echo" }, { name: "upper" }];
    expect(allowlistDrift(["echo", "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 2,
    });
    expect(allowlistDrift(["echo"], offered).missing).toEqual([]);
    // allowedTools is a Json column, so it can hold anything: it must not throw.
    expect(allowlistDrift(null, offered)).toEqual({
      missing: [],
      offered: 2,
      stringAllowedCount: 0,
    });
    // Non-string JSON values are ignored for both missing and the warning ratio.
    expect(allowlistDrift([42, "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 1,
    });
  });
});

it("preserves explicit MCP read-only annotations for unattended consumers", async () => {
  const state = {
    failNext: false,
    initializations: 0,
    tools: [
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      { name: "unknown", inputSchema: { type: "object" } },
    ],
  };
  vi.stubGlobal("fetch", mcpFetch(state));
  const connector = new McpConnector(
    {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn(async () => [ASSIGNMENT]) },
    } as never,
    new EncryptedSecretStore("fake-key"),
    { network: TEST_NETWORK },
  );
  try {
    const tools = await connector.discoverTools({
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    });
    expect(tools.map((tool) => tool.readOnly)).toEqual([true, false, undefined]);
  } finally {
    await connector.close();
  }
});

it("marks a Composio MCP server's multi-execute tool as a batch under its prefixed name", async () => {
  const state = {
    failNext: false,
    initializations: 0,
    tools: [
      { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } },
      { name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object" } },
    ],
  };
  vi.stubGlobal("fetch", mcpFetch(state));
  const connector = new McpConnector(
    {
      mcpServer: NO_SHARED_SERVERS,
      botMcpServer: { findMany: vi.fn(async () => [ASSIGNMENT]) },
    } as never,
    new EncryptedSecretStore("fake-key"),
    { network: TEST_NETWORK },
  );
  try {
    const tools = await connector.discoverTools({
      operationId: "test",
      traceId: "test",
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    });
    expect(
      tools.map((tool) => [
        tool.name.endsWith("__COMPOSIO_MULTI_EXECUTE_TOOL"),
        tool.batch?.action,
      ]),
    ).toEqual([
      [true, "tool_slug"],
      [false, undefined],
    ]);
  } finally {
    await connector.close();
  }
});
