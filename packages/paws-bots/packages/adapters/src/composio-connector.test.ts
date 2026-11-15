import type { ToolkitConnectionState } from "@composio/core";
import type { AdapterContext, ConnectorEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { composioToolkitDirectory } from "./composio-catalog-cache.js";
import {
  asConnectorTools,
  ComposioConnector,
  collectLogIds,
  composioResultError,
  executeSessionKey,
  expandComposioMultiExecute,
  isComposioEnabled,
  isNoAuthToolkitError,
  isNoManagedAuthError,
  mergeConnectedPlugins,
  needsLivePluginSync,
  pickReusableConnection,
  planLiveConnectionSync,
  sanitizeIntegrationError,
} from "./composio-connector.js";
import { collectPages, filterCatalog } from "./connector-catalog.js";
import { ConnectorRegistry } from "./connector-registry.js";
import { DestinationEmulator } from "./destination-emulator.js";

const composioSdkState = vi.hoisted(() => ({
  created: [] as Array<{ userId: string; config: Record<string, unknown> }>,
  directoryFails: false,
  executions: [] as Array<{
    tool: string;
    args: Record<string, unknown>;
    options?: { account?: string };
  }>,
  executeResult: null as null | {
    data: Record<string, unknown>;
    error: string | null;
    resultType?: "completed" | "failed" | "blocked";
  },
  failTools: null as null | string[],
  repeatToolCursor: false,
  rawToolQueries: [] as Array<{ toolkit_slug: string; limit: number; cursor?: string }>,
  logIds: null as null | string[],
  connectedAccounts: {
    list: async (_query?: Record<string, unknown>) => ({ items: [] as Array<{ id: string }> }),
    waitForConnection: async (id: string, _timeout?: number) => ({ id: `resolved-${id}` }),
    get: async (id: string) => ({ id, userId: "user-1" }),
    delete: async (_id: string) => undefined,
  },
  sessions: new Map<
    string,
    {
      sessionId: string;
      toolkits?: (options?: {
        isConnected?: boolean;
        cursor?: string;
      }) => Promise<{ items: ToolkitConnectionState[]; cursor?: string }>;
      tools?: () => Promise<unknown[]>;
      execute?: (
        tool: string,
        args: Record<string, unknown>,
        options?: { account?: string },
      ) => Promise<{
        data: Record<string, unknown>;
        error: string | null;
        logId: string;
      }>;
    }
  >(),
}));

vi.mock("@composio/core", () => ({
  Composio: class {
    readonly sessions = {
      use: async (sessionId: string) => {
        const session = composioSdkState.sessions.get(sessionId);
        if (!session) throw new Error(`unknown session ${sessionId}`);
        return session;
      },
    };

    getClient() {
      return {
        tools: {
          list: async (query: { toolkit_slug: string; limit: number; cursor?: string }) => {
            composioSdkState.rawToolQueries.push(query);
            const offset = Number(query.cursor ?? 0);
            const end = Math.min(offset + query.limit, 250);
            return {
              items: Array.from({ length: end - offset }, (_, index) => ({
                slug: `GMAIL_ACTION_${offset + index}`,
                description: "An action",
              })),
              next_cursor: composioSdkState.repeatToolCursor ? "0" : end < 250 ? String(end) : null,
            };
          },
        },
      };
    }

    readonly connectedAccounts = {
      list: (query?: Record<string, unknown>) => composioSdkState.connectedAccounts.list(query),
      waitForConnection: (id: string, timeout?: number) =>
        composioSdkState.connectedAccounts.waitForConnection(id, timeout),
      get: (id: string) => composioSdkState.connectedAccounts.get(id),
      delete: (id: string) => composioSdkState.connectedAccounts.delete(id),
    };

    async create(userId: string, config: Record<string, unknown>) {
      composioSdkState.created.push({ userId, config });
      const toolkits = Array.isArray(config.toolkits) ? config.toolkits : [];
      if (toolkits.length === 0) {
        const session = {
          sessionId: "catalog-session",
          toolkits: async () => {
            if (composioSdkState.directoryFails) throw new Error("directory unavailable");
            return {
              items: [
                {
                  slug: "GITHUB",
                  name: "GitHub",
                  isNoAuth: false,
                  connection: {
                    isActive: true,
                    connectedAccount: { id: "ca-github", status: "ACTIVE" },
                  },
                },
              ],
            };
          },
        };
        composioSdkState.sessions.set(session.sessionId, session);
        return session;
      }

      const scopedToCanonicalGithub = toolkits.includes("GITHUB");
      const session = {
        sessionId: scopedToCanonicalGithub ? "github-session" : "unscoped-session",
        tools: async () =>
          scopedToCanonicalGithub
            ? [
                {
                  type: "function",
                  function: {
                    name: "GITHUB_GET_REPOS",
                    description: "List GitHub repositories",
                    parameters: { type: "object", properties: {} },
                  },
                },
              ]
            : [],
        execute: async (
          tool: string,
          args: Record<string, unknown>,
          options?: { account?: string },
        ) => {
          composioSdkState.executions.push(options ? { tool, args, options } : { tool, args });
          const failed = composioSdkState.failTools?.includes(tool) ?? false;
          const result = failed
            ? { data: { ok: false }, error: "listing failed" }
            : (composioSdkState.executeResult ?? { data: { ok: true }, error: null });
          return {
            resultType: result.error ? "failed" : "completed",
            ...result,
            logId: composioSdkState.logIds?.shift() ?? "log-github",
          };
        },
      };
      composioSdkState.sessions.set(session.sessionId, session);
      return session;
    }
  },
}));

describe("composio app tools", () => {
  it("rejects a repeated catalog cursor", async () => {
    composioSdkState.repeatToolCursor = true;
    try {
      await expect(
        new ComposioConnector().listAppTools(
          {
            operationId: "app-tools",
            traceId: "app-tools",
            spaceId: "workspace",
            userId: "user-1",
            signal: new AbortController().signal,
          },
          "gmail",
        ),
      ).rejects.toThrow("pagination did not terminate");
    } finally {
      composioSdkState.repeatToolCursor = false;
    }
  });

  it("does not fetch tools for an aborted request", async () => {
    const signal = AbortSignal.abort(new Error("Cancelled"));
    const before = composioSdkState.rawToolQueries.length;
    await expect(
      new ComposioConnector().listAppTools(
        {
          operationId: "app-tools",
          traceId: "app-tools",
          spaceId: "workspace",
          userId: "user-1",
          signal,
        },
        "gmail",
      ),
    ).rejects.toThrow("Cancelled");
    expect(composioSdkState.rawToolQueries).toHaveLength(before);
  });
  it("lists the app's own actions rather than the session's search tools", async () => {
    composioToolkitDirectory.invalidate();
    const tools = await new ComposioConnector().listAppTools(
      {
        operationId: "composio-app-tools",
        traceId: "composio-app-tools",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
      },
      "gmail",
    );
    expect(tools).toHaveLength(250);
    expect(tools.at(-1)?.name).toBe("GMAIL_ACTION_249");
    expect(composioSdkState.rawToolQueries.at(-1)?.toolkit_slug.toLowerCase()).toBe("gmail");
  });
});

describe("composio tool mapping", () => {
  it("maps OpenAI-style session tools and raw slugs", () => {
    const tools = asConnectorTools([
      {
        type: "function",
        function: {
          name: "COMPOSIO_SEARCH_TOOLS",
          description: "Search tools",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
      {
        slug: "HACKERNEWS_GET_USER",
        description: "Look up a public HN profile",
        inputParameters: { type: "object", properties: { username: { type: "string" } } },
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "HACKERNEWS_GET_USER",
    ]);
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { username: { type: "string" } } });
  });

  it("labels session tools without the vendor name", () => {
    const tools = asConnectorTools([
      { slug: "COMPOSIO_SEARCH_TOOLS" },
      { slug: "COMPOSIO_WAIT_FOR_CONNECTIONS" },
      { slug: "HACKERNEWS_GET_USER" },
    ]);
    expect(tools.map((tool) => tool.label)).toEqual([
      "Searching your apps",
      "Wait for connections",
      undefined,
    ]);
  });

  it("marks the multi-execute tool as a batch of the actions it names", () => {
    const tools = asConnectorTools([
      { slug: "COMPOSIO_MULTI_EXECUTE_TOOL" },
      { type: "function", function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL" } },
      { slug: "COMPOSIO_SEARCH_TOOLS" },
    ]);
    expect(tools.map((tool) => tool.batch)).toEqual([
      { items: "tools", action: "tool_slug", arguments: "arguments" },
      { items: "tools", action: "tool_slug", arguments: "arguments" },
      undefined,
    ]);
  });

  it("retains provider route metadata independently of the tool name", async () => {
    const destination = new DestinationEmulator();
    const events: ConnectorEvent[] = [];
    const composio = {
      describe: () => ({ ...destination.describe(), id: "composio" }),
      discoverTools: async () => [
        {
          name: "destination.write",
          description: "shadow",
          inputSchema: {},
          route: { connectorId: "composio", toolName: "destination.write" },
        } satisfies ConnectorTool,
      ],
      execute: async function* () {
        yield { type: "result", data: { provider: "composio" } } as ConnectorEvent;
      },
    } as never;
    const connector = new ConnectorRegistry([destination, composio]);
    const context = { userId: "u" } as AdapterContext;
    for await (const event of connector.execute(
      {
        tool: "destination.write",
        args: {},
        executionId: "x",
        route: { connectorId: "composio", toolName: "destination.write" },
      },
      context,
    ))
      events.push(event);
    expect(events).toEqual([{ type: "result", data: { provider: "composio" } }]);
  });

  it("logs sanitized connector discovery failures", async () => {
    const destination = new DestinationEmulator();
    const failing = {
      describe: () => ({ ...destination.describe(), id: "failing" }),
      discoverTools: async () => {
        throw new Error("denied ak_secretvaluehere");
      },
      execute: async function* () {},
    } as never;
    const connector = new ConnectorRegistry([destination, failing]);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    try {
      await expect(connector.discoverTools({ userId: "u" } as AdapterContext)).resolves.toEqual([
        expect.objectContaining({ name: "destination.write" }),
      ]);
      expect(sink.events[0]).toMatchObject({
        message: "connector discovery failed",
        "connector.id": "failing",
      });
      const logged = JSON.stringify(sink.events);
      expect(logged).toContain("[redacted]");
      expect(logged).not.toContain("ak_secretvaluehere");
    } finally {
      installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
    }
  });

  it("redacts project keys from errors", () => {
    expect(sanitizeIntegrationError("denied ak_secretvaluehere")).toContain("[redacted]");
    expect(sanitizeIntegrationError("denied ak_secretvaluehere")).not.toContain("ak_secret");
    expect(sanitizeIntegrationError("COMPOSIO_API_KEY=ak_shouldnotleak")).not.toContain(
      "ak_shouldnotleak",
    );
    expect(sanitizeIntegrationError('COMPOSIO_API_KEY="alpha beta"')).toBe(
      'COMPOSIO_API_KEY="[redacted]"',
    );
    expect(sanitizeIntegrationError("COMPOSIO_API_KEY plain-secret-value")).toBe(
      "COMPOSIO_API_KEY=[redacted]",
    );
    expect(sanitizeIntegrationError('COMPOSIO_API_KEY "alpha beta"')).toBe(
      "COMPOSIO_API_KEY=[redacted]",
    );
    expect(sanitizeIntegrationError("denied password=p@ss;word")).toBe(
      'denied password="[redacted]"',
    );
    expect(sanitizeIntegrationError("denied password=bad;status=failed")).toBe(
      'denied password="[redacted]";status=failed',
    );
    expect(sanitizeIntegrationError('denied password="p\\"secret"')).toBe(
      'denied password="[redacted]"',
    );
  });

  it("keeps each tool's error when a multi-execute batch fails", () => {
    const data = {
      results: [
        { tool_slug: "TOOL_OK", response: { successful: true, data: {} } },
        {
          tool_slug: "TOOL_MISSING",
          error: "The requested message was not found.",
          response: { successful: false, data: { status_code: 404 } },
        },
        {
          tool_slug: "TOOL_NESTED",
          error: "",
          response: { successful: false, error: "Query failed." },
        },
        null,
        "not-an-object",
      ],
    };
    expect(composioResultError("2 out of 3 tools failed", data)).toBe(
      "2 out of 3 tools failed: TOOL_MISSING: The requested message was not found.; TOOL_NESTED: Query failed.",
    );
    const longSecret = `${"p".repeat(470)} password="alpha beta-secret-tail" done ${"q".repeat(80)}`;
    const longMessage = composioResultError("1 out of 1 tools failed", {
      results: [{ tool_slug: "TOOL", error: longSecret }],
    });
    expect(longMessage).toContain("[redacted]");
    expect(longMessage).not.toContain("beta-secret");
    expect(composioResultError("1 out of 1 tools failed", { results: [] })).toBe(
      "1 out of 1 tools failed",
    );
    expect(composioResultError("Session expired", null)).toBe("Session expired");
    const long = composioResultError("2 out of 2 tools failed", {
      results: [
        { tool_slug: "TOOL_LONG", error: "x".repeat(800) },
        { tool_slug: "TOOL_LATER", error: "Still reported." },
      ],
    });
    expect(long).toContain(`TOOL_LONG: ${"x".repeat(500)}…`);
    expect(long).toContain("TOOL_LATER: Still reported.");
    const many = composioResultError("7 out of 7 tools failed", {
      results: Array.from({ length: 7 }, (_, index) => ({
        tool_slug: `TOOL_${index}`,
        error: "Failed.",
      })),
    });
    expect(many).toContain("TOOL_4: Failed.; +2 more");
    expect(many).not.toContain("TOOL_5");
  });

  it("paginates until the cursor ends", async () => {
    const pages = [
      { items: ["gmail", "github"], cursor: "page-2" },
      { items: ["slack"], cursor: undefined },
    ];
    const items = await collectPages(async (cursor) => {
      if (!cursor) return pages[0]!;
      return pages[1]!;
    });
    expect(items).toEqual(["gmail", "github", "slack"]);
  });

  it("treats Composio no-auth toolkit errors as in-app connect", () => {
    expect(
      isNoAuthToolkitError(
        new Error(
          '400 {"error":{"message":"Toolkit hackernews does not require authentication.","slug":"ToolRouterV2_ToolkitsIsNoAuth"}}',
        ),
      ),
    ).toBe(true);
    expect(isNoAuthToolkitError(new Error("redirect required"))).toBe(false);
  });

  it("recognizes toolkits Composio has no managed auth for", () => {
    const noManagedAuth = new Error(
      '400 {"error":{"message":"Composio does not manage auth for toolkit twitter and no auth config without required fields is available.","code":4308,"slug":"ToolRouterV2_NoManagedAuth","status":400}}',
    );
    expect(isNoManagedAuthError(noManagedAuth)).toBe(true);
    expect(isNoAuthToolkitError(noManagedAuth)).toBe(false);
    expect(isNoManagedAuthError(new Error("redirect required"))).toBe(false);
  });

  it("collects nested Composio log ids", () => {
    expect(
      collectLogIds({
        logId: "",
        data: { results: [{ log_id: "log_abc123", slug: "HACKERNEWS_GET_USER" }] },
      }),
    ).toEqual(["log_abc123"]);
  });

  it("keys execute sessions by sorted unique toolkits", () => {
    expect(executeSessionKey(["hackernews", "gmail", "hackernews"])).toBe("gmail,hackernews");
    expect(executeSessionKey(["github", "GITHUB"])).toBe("github");
    expect(executeSessionKey([])).toBe("");
    expect(executeSessionKey(["GMAIL"], { GMAIL: ["ca-work", "ca-personal", "ca-work"] })).toBe(
      "GMAIL|GMAIL:ca-personal,ca-work",
    );
  });

  function stubActiveAccounts(ids: string[]) {
    const previous = composioSdkState.connectedAccounts.list;
    composioSdkState.connectedAccounts.list = async () => ({
      items: ids.map((id) => ({ id })),
    });
    return () => {
      composioSdkState.connectedAccounts.list = previous;
    };
  }

  it("pins every connected account into multi-account execute sessions", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    const restore = stubActiveAccounts(["ca-personal", "ca-work"]);

    try {
      const connector = new ComposioConnector();
      await connector.discoverTools({
        operationId: "composio-multi-account",
        traceId: "composio-multi-account",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "connection-personal",
            connectorId: "composio",
            externalId: "github",
            displayName: "Personal",
            providerRef: "ca-personal",
          },
          {
            id: "connection-work",
            connectorId: "composio",
            externalId: "GITHUB",
            displayName: "Work",
            providerRef: "ca-work",
          },
          {
            id: "connection-personal-dup",
            connectorId: "composio",
            externalId: "GitHub",
            displayName: "Personal again",
            providerRef: "ca-personal",
          },
          {
            id: "connection-noauth",
            connectorId: "composio",
            externalId: "GITHUB",
            displayName: "Legacy",
            providerRef: "github",
          },
        ],
      });

      expect(composioSdkState.created.at(-1)).toEqual({
        userId: "user-1",
        config: {
          manageConnections: false,
          sandbox: { enable: false },
          toolkits: ["GITHUB"],
          connectedAccounts: { GITHUB: ["ca-personal", "ca-work"] },
          multiAccount: {
            enable: true,
            maxAccountsPerToolkit: 10,
            requireExplicitSelection: true,
          },
        },
      });
    } finally {
      restore();
    }
  });

  it("drops a dead sibling account id so it cannot poison discovery", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    const restore = stubActiveAccounts(["ca_current"]);

    try {
      const connector = new ComposioConnector();
      await expect(
        connector.discoverTools({
          operationId: "composio-dead-sibling",
          traceId: "composio-dead-sibling",
          spaceId: "workspace",
          userId: "user-1",
          signal: new AbortController().signal,
          connectedConnections: [
            {
              id: "connection-revoked",
              connectorId: "composio",
              externalId: "github",
              displayName: "GitHub",
              providerRef: "ca_old",
            },
            {
              id: "connection-live",
              connectorId: "composio",
              externalId: "github",
              displayName: "GitHub",
              providerRef: "ca_current",
            },
          ],
        }),
      ).resolves.toContainEqual(expect.objectContaining({ name: "GITHUB_GET_REPOS" }));

      expect(composioSdkState.created.at(-1)).toEqual({
        userId: "user-1",
        config: {
          manageConnections: false,
          sandbox: { enable: false },
          toolkits: ["GITHUB"],
          connectedAccounts: { GITHUB: ["ca_current"] },
        },
      });
    } finally {
      restore();
    }
  });

  it.each([
    { tool: "GITHUB_MCP_LIST_REPOS", batch: false, stale: "github", blocked: false },
    { tool: "github_mcp_list_repos", batch: true, stale: "github", blocked: false },
    { tool: "GITHUB_GET_REPOS", batch: false, stale: "github", blocked: true },
    { tool: "GITHUB_GET_REPOS", batch: true, stale: "github", blocked: true },
    { tool: "GITHUB_MCP_LIST_REPOS", batch: false, stale: "github_mcp", blocked: true },
    { tool: "GITHUB_MCP_LIST_REPOS", batch: true, stale: "github_mcp", blocked: true },
  ])("routes overlapping toolkit names: %o", async ({ tool, batch, stale, blocked }) => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    const restore = stubActiveAccounts([stale === "github" ? "ca-mcp" : "ca-github"]);
    try {
      const connector = new ComposioConnector();
      const args = batch ? { tools: [{ tool_slug: tool, arguments: {} }] } : {};
      const call = {
        tool: batch ? "COMPOSIO_MULTI_EXECUTE_TOOL" : tool,
        args,
        executionId: "overlapping-toolkits",
      };
      const events: ConnectorEvent[] = [];
      for await (const event of connector.execute(call, {
        operationId: "test",
        traceId: "test",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "github",
            connectorId: "composio",
            externalId: "github",
            displayName: "GitHub",
            providerRef: "ca-github",
          },
          {
            id: "mcp",
            connectorId: "composio",
            externalId: "GitHub_MCP",
            displayName: "GitHub MCP",
            providerRef: "ca-mcp",
          },
        ],
      }))
        events.push(event);
      expect(events.map((event) => event.type)).toEqual([blocked ? "error" : "result"]);
      expect(composioSdkState.executions).toEqual(blocked ? [] : [{ tool: call.tool, args }]);
      expect(composioSdkState.created.at(-1)?.config).toMatchObject({
        toolkits: [stale === "github" ? "GITHUB_MCP" : "GITHUB"],
        connectedAccounts:
          stale === "github" ? { GITHUB_MCP: ["ca-mcp"] } : { GITHUB: ["ca-github"] },
      });
    } finally {
      restore();
    }
  });

  it("pins a single concrete account without enabling multi-account mode", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    const restore = stubActiveAccounts(["ca-work"]);

    try {
      const connector = new ComposioConnector();
      await connector.discoverTools({
        operationId: "composio-single-account",
        traceId: "composio-single-account",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "connection-work",
            connectorId: "composio",
            externalId: "gmail",
            displayName: "Work",
            providerRef: "ca-work",
          },
        ],
      });

      expect(composioSdkState.created.at(-1)).toEqual({
        userId: "user-1",
        config: {
          manageConnections: false,
          sandbox: { enable: false },
          toolkits: ["GMAIL"],
          connectedAccounts: { GMAIL: ["ca-work"] },
        },
      });
    } finally {
      restore();
    }
  });

  it("omits connectedAccounts and multiAccount for legacy slug-only refs", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();

    const connector = new ComposioConnector();
    await connector.discoverTools({
      operationId: "composio-legacy-only",
      traceId: "composio-legacy-only",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-legacy",
          connectorId: "composio",
          externalId: "GITHUB",
          displayName: "Legacy",
          providerRef: "github",
        },
        {
          id: "connection-hackernews",
          connectorId: "composio",
          externalId: "hackernews",
          displayName: "Hacker News",
          providerRef: "HACKERNEWS",
        },
      ],
    });

    expect(composioSdkState.created.at(-1)).toEqual({
      userId: "user-1",
      config: {
        manageConnections: false,
        sandbox: { enable: false },
        toolkits: ["GITHUB", "HACKERNEWS"],
      },
    });
  });

  it("uses catalog-canonical toolkit slugs without preloading every tool", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-canonical-slug",
      traceId: "composio-canonical-slug",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "github",
          displayName: "GitHub",
        },
      ],
    };

    await expect(connector.discoverTools(context)).resolves.toContainEqual(
      expect.objectContaining({ name: "GITHUB_GET_REPOS" }),
    );
    expect(
      composioSdkState.created.map(({ userId, config }) => ({
        userId,
        toolkits: config.toolkits,
        sessionPreset: config.sessionPreset,
      })),
    ).toEqual([
      { userId: "__rakazo_catalog__", toolkits: undefined, sessionPreset: undefined },
      { userId: "user-1", toolkits: ["GITHUB"], sessionPreset: undefined },
    ]);

    const events: ConnectorEvent[] = [];
    for await (const event of connector.execute(
      {
        tool: "GITHUB_GET_REPOS",
        args: { owner: "composio" },
        executionId: "composio-canonical-execution",
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
    expect(composioSdkState.executions).toEqual([
      { tool: "GITHUB_GET_REPOS", args: { owner: "composio" } },
    ]);
    await expect(connector.connectionReady(context, "github")).resolves.toBe(true);
    await expect(connector.connectedAccountId("user-1", "github")).resolves.toBe("ca-github");
  });

  it.each([
    {
      label: "nested arguments",
      item: {
        tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER",
        arguments: { path: "/Invoices", recursive: false },
      },
      expected: { path: "/Invoices", recursive: false },
    },
    {
      label: "path beside an empty arguments object",
      item: {
        tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER",
        path: "/Invoices",
        arguments: {},
      },
      expected: { path: "/Invoices" },
    },
    {
      label: "arguments encoded as a JSON string",
      item: {
        tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER",
        arguments: JSON.stringify({ path: "/Invoices" }),
      },
      expected: { path: "/Invoices" },
    },
  ])(
    "forwards a non-root Dropbox folder path through multi-execute ($label)",
    async ({ item, expected }) => {
      composioSdkState.created.length = 0;
      composioSdkState.executions.length = 0;
      composioSdkState.sessions.clear();
      composioToolkitDirectory.invalidate();

      const connector = new ComposioConnector();
      const context: AdapterContext = {
        operationId: "composio-dropbox-list",
        traceId: "composio-dropbox-list",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "connection-dropbox",
            connectorId: "composio",
            externalId: "dropbox",
            displayName: "Dropbox",
          },
        ],
      };
      const events: ConnectorEvent[] = [];
      for await (const event of connector.execute(
        {
          tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
          args: {
            tools: [item],
          },
          executionId: "composio-dropbox-list",
        },
        context,
      )) {
        events.push(event);
      }

      expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
      expect(composioSdkState.executions).toEqual([
        { tool: "DROPBOX_LIST_FILES_IN_FOLDER", args: expected },
      ]);
    },
  );

  it.each([
    { label: "an unpinned account", account: "ca-other", executed: [] },
    {
      label: "a pinned account",
      account: "ca-work",
      executed: [
        {
          tool: "DROPBOX_LIST_FILES_IN_FOLDER",
          args: { path: "/Invoices" },
          options: { account: "ca-work" },
        },
      ],
    },
  ])("runs a nested Dropbox listing only on $label", async ({ account, executed }) => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    const restore = stubActiveAccounts(["ca-work"]);

    const events: ConnectorEvent[] = [];
    try {
      const connector = new ComposioConnector();
      for await (const event of connector.execute(
        {
          tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
          args: {
            tools: [
              {
                tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER",
                arguments: { path: "/Invoices" },
                account,
              },
            ],
          },
          executionId: "composio-dropbox-account",
        },
        {
          operationId: "composio-dropbox-account",
          traceId: "composio-dropbox-account",
          spaceId: "workspace",
          userId: "user-1",
          signal: new AbortController().signal,
          connectedConnections: [
            {
              id: "connection-dropbox",
              connectorId: "composio",
              externalId: "dropbox",
              displayName: "Dropbox",
              providerRef: "ca-work",
            },
          ],
        },
      )) {
        events.push(event);
      }
    } finally {
      restore();
    }

    expect(composioSdkState.executions).toEqual(executed);
    expect(events.at(-1)?.type).toBe(executed.length > 0 ? "result" : "error");
  });

  it("keeps mixed multi-execute calls in their original order", () => {
    const createFolder = { tool_slug: "DROPBOX_CREATE_FOLDER", arguments: { path: "/Invoices" } };
    const listFolder = {
      tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER",
      arguments: { path: "/Invoices" },
    };
    const listRepos = { tool_slug: "GITHUB_GET_REPOS", arguments: { owner: "composio" } };

    expect(
      expandComposioMultiExecute("COMPOSIO_MULTI_EXECUTE_TOOL", {
        thought: "check the new folder",
        tools: [createFolder, listFolder, listRepos],
      }),
    ).toEqual([
      {
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        args: { thought: "check the new folder", tools: [createFolder] },
      },
      { tool: "DROPBOX_LIST_FILES_IN_FOLDER", args: { path: "/Invoices" } },
      {
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        args: { thought: "check the new folder", tools: [listRepos] },
      },
    ]);
  });

  it("rejects malformed Dropbox listing arguments instead of listing the root", () => {
    expect(() =>
      expandComposioMultiExecute("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER", arguments: "{not-json" }],
      }),
    ).toThrow("Dropbox folder listing arguments must be a JSON object.");
    expect(
      expandComposioMultiExecute("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "DROPBOX_LIST_FOLDERS", arguments: "" }],
      }),
    ).toEqual([{ tool: "DROPBOX_LIST_FOLDERS", args: {} }]);
  });

  it("keeps every execution log id when a batch is split", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioSdkState.logIds = ["log-create", "log-list"];
    composioToolkitDirectory.invalidate();
    composioSdkState.executeResult = { data: { ok: true }, error: null };

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-dropbox-logs",
      traceId: "composio-dropbox-logs",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-dropbox",
          connectorId: "composio",
          externalId: "dropbox",
          displayName: "Dropbox",
        },
      ],
    };
    const events: ConnectorEvent[] = [];
    try {
      for await (const event of connector.execute(
        {
          tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
          args: {
            tools: [
              { tool_slug: "DROPBOX_CREATE_FOLDER", arguments: { path: "/Invoices" } },
              { tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER", arguments: { path: "/Invoices" } },
            ],
          },
          executionId: "composio-dropbox-logs",
        },
        context,
      )) {
        events.push(event);
      }
    } finally {
      composioSdkState.executeResult = null;
      composioSdkState.logIds = null;
    }

    const result = events.find((event) => event.type === "result");
    expect(result && result.type === "result" ? collectLogIds(result.data) : []).toEqual([
      "log-create",
      "log-list",
    ]);
    expect(composioSdkState.executions.map((execution) => execution.tool)).toEqual([
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "DROPBOX_LIST_FILES_IN_FOLDER",
    ]);
  });

  it("keeps earlier log ids when a later split call fails", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioSdkState.logIds = ["log-create", "log-list"];
    composioSdkState.failTools = ["DROPBOX_LIST_FILES_IN_FOLDER"];
    composioToolkitDirectory.invalidate();
    composioSdkState.executeResult = { data: { ok: true }, error: null };

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-dropbox-partial",
      traceId: "composio-dropbox-partial",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-dropbox",
          connectorId: "composio",
          externalId: "dropbox",
          displayName: "Dropbox",
        },
      ],
    };
    const events: ConnectorEvent[] = [];
    try {
      for await (const event of connector.execute(
        {
          tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
          args: {
            tools: [
              { tool_slug: "DROPBOX_CREATE_FOLDER", arguments: { path: "/Invoices" } },
              { tool_slug: "DROPBOX_LIST_FILES_IN_FOLDER", arguments: { path: "/Invoices" } },
            ],
          },
          executionId: "composio-dropbox-partial",
        },
        context,
      )) {
        events.push(event);
      }
    } finally {
      composioSdkState.executeResult = null;
      composioSdkState.logIds = null;
      composioSdkState.failTools = null;
    }

    expect(events).toEqual([{ type: "error", message: "listing failed", logIds: ["log-create"] }]);
  });

  it("emits each failed tool's error from a failed batch", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    composioSdkState.executeResult = {
      data: {
        results: [
          {
            tool_slug: "GITHUB_GET_REPOS",
            error:
              'Repository not found. access_token="opaque-access-value" client_secret: "opaque-client-secret" api_key=opaque-api-key password=opaque-password',
            response: { successful: false },
          },
        ],
      },
      error: "1 out of 1 tools failed",
    };

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-batch-failure",
      traceId: "composio-batch-failure",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "github",
          displayName: "GitHub",
        },
      ],
    };

    const events: ConnectorEvent[] = [];
    try {
      for await (const event of connector.execute(
        { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", args: {}, executionId: "composio-batch-failure" },
        context,
      )) {
        events.push(event);
      }
    } finally {
      composioSdkState.executeResult = null;
    }
    expect(events).toEqual([
      {
        type: "error",
        message:
          '1 out of 1 tools failed: GITHUB_GET_REPOS: Repository not found. access_token="[redacted]" client_secret: "[redacted]" api_key="[redacted]" password="[redacted]"',
      },
    ]);
  });

  it("reports a call the provider marked failed even when its error text is empty", async () => {
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    composioSdkState.executeResult = { data: {}, error: null, resultType: "failed" };

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-failed-without-error",
      traceId: "composio-failed-without-error",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "github",
          displayName: "GitHub",
        },
      ],
    };

    const events: ConnectorEvent[] = [];
    try {
      for await (const event of connector.execute(
        { tool: "GITHUB_GET_REPOS", args: {}, executionId: "composio-failed-without-error" },
        context,
      )) {
        events.push(event);
      }
    } finally {
      composioSdkState.executeResult = null;
    }
    expect(events).toEqual([{ type: "error", message: "GITHUB_GET_REPOS failed" }]);
  });

  it("redacts credential values in successful tool results without dropping the payload", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    composioSdkState.executeResult = {
      data: {
        body: "Reset your password: hunter2 today",
        quoted: 'cfg password="x"',
        secret: { a: 1 },
        has_password: true,
        flag: "has_password: true",
        joined: "password=p@ss;word",
        escaped: 'note password="p\\"secret" tail',
        meta: { name: "ada", api_key: "live-key-value" },
        lookup_ak_ABC123: "first",
        lookup_ak_DEF456: "second",
        COMPOSIO_API_KEY: "plain-secret-value",
        id: 1,
      },
      error: null,
    };

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-payload-redaction",
      traceId: "composio-payload-redaction",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "github",
          displayName: "GitHub",
        },
      ],
    };

    const events: ConnectorEvent[] = [];
    try {
      for await (const event of connector.execute(
        { tool: "GITHUB_GET_REPOS", args: {}, executionId: "composio-payload-redaction" },
        context,
      )) {
        events.push(event);
      }
    } finally {
      composioSdkState.executeResult = null;
    }

    expect(events).toEqual([
      {
        type: "result",
        data: {
          data: {
            body: 'Reset your password: "[redacted]" today',
            quoted: 'cfg password="[redacted]"',
            secret: "[redacted]",
            has_password: true,
            flag: "has_password: true",
            joined: 'password="[redacted]"',
            escaped: 'note password="[redacted]" tail',
            meta: { name: "ada", api_key: "[redacted]" },
            "lookup_[redacted]": "first",
            "lookup_[redacted]~2": "second",
            COMPOSIO_API_KEY: "[redacted]",
            id: 1,
          },
          logId: "log-github",
        },
      },
    ]);
  });

  it("resolves connection-request ids to connected-account ids and skips sibling refs", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();
    composioSdkState.connectedAccounts.list = async () => ({
      items: [{ id: "ca-personal" }, { id: "ca-work" }],
    });
    composioSdkState.connectedAccounts.waitForConnection = async (id: string) => {
      if (id === "req-work") return { id: "ca-work" };
      if (id === "req-missing") throw new Error("timeout");
      return { id: `resolved-${id}` };
    };

    const connector = new ComposioConnector();
    await expect(
      connector.resolveConnectedAccountId("user-1", "gmail", "req-work", ["ca-personal"]),
    ).resolves.toBe("ca-work");
    await expect(
      connector.resolveConnectedAccountId("user-1", "gmail", "gmail", ["ca-personal"]),
    ).resolves.toBe("ca-work");
    await expect(
      connector.resolveConnectedAccountId("user-1", "gmail", "req-missing", [
        "ca-personal",
        "ca-work",
      ]),
    ).resolves.toBeUndefined();
  });

  it("cancels pending authorization requests by request id without waiting", async () => {
    const deleted: string[] = [];
    const waited: string[] = [];
    composioSdkState.connectedAccounts.waitForConnection = async (id: string) => {
      waited.push(id);
      throw new Error(`should not wait for ${id}`);
    };
    composioSdkState.connectedAccounts.delete = async (id: string) => {
      deleted.push(id);
    };
    const connector = new ComposioConnector();
    await connector.cancelAuthorizationRequest("req-pending-1", {
      operationId: "test",
      traceId: "test",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
    });
    expect(waited).toEqual([]);
    expect(deleted).toEqual(["req-pending-1"]);
  });

  it.each([{ status: 404 }, { statusCode: 404 }])(
    "ignores missing authorization requests during cancellation (%o)",
    async (notFound) => {
      composioSdkState.connectedAccounts.delete = async () => {
        throw Object.assign(new Error("not found"), notFound);
      };
      const connector = new ComposioConnector();

      await expect(
        connector.cancelAuthorizationRequest("req-missing", {
          operationId: "test",
          traceId: "test",
          spaceId: "workspace",
          userId: "user-1",
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("surfaces authorization cancellation failures for router fallback", async () => {
    composioSdkState.connectedAccounts.delete = async () => {
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    };
    const connector = new ComposioConnector();

    await expect(
      connector.cancelAuthorizationRequest("req-pending-1", {
        operationId: "test",
        traceId: "test",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("service unavailable");
  });

  it("resolves authorization-request ids before deleting on revoke", async () => {
    const deleted: string[] = [];
    const waited: string[] = [];
    composioSdkState.connectedAccounts.list = async () => ({ items: [] });
    composioSdkState.connectedAccounts.waitForConnection = async (id: string) => {
      waited.push(id);
      return { id: `ca-from-${id}` };
    };
    composioSdkState.connectedAccounts.delete = async (id: string) => {
      deleted.push(id);
    };
    const connector = new ComposioConnector();
    await connector.revoke("req-oauth-1", {
      operationId: "test",
      traceId: "test",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
    });
    expect(waited).toEqual(["req-oauth-1"]);
    expect(deleted).toEqual(["ca-from-req-oauth-1"]);
  });

  it("uses Composio slug casing when the toolkit directory is unavailable", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioSdkState.directoryFails = true;
    composioToolkitDirectory.invalidate();

    try {
      const connector = new ComposioConnector();
      const context = {
        operationId: "composio-directory-fallback",
        traceId: "composio-directory-fallback",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "connection-github",
            connectorId: "composio",
            externalId: "github",
            displayName: "GitHub",
          },
        ],
      } satisfies AdapterContext;

      await expect(connector.discoverTools(context)).resolves.toContainEqual(
        expect.objectContaining({ name: "GITHUB_GET_REPOS" }),
      );
      expect(composioSdkState.created.at(-1)?.config.toolkits).toEqual(["GITHUB"]);
    } finally {
      composioSdkState.directoryFails = false;
      composioToolkitDirectory.invalidate();
    }
  });

  it("merges live Composio slugs onto pending DB plugin rows", () => {
    const merged = mergeConnectedPlugins(
      [
        { provider: "github", displayName: "GitHub", status: "connected" },
        { provider: "gmail", displayName: "Gmail", status: "pending" },
        { provider: "linear", displayName: "Linear", status: "revoked" },
      ],
      ["gmail", "github", "notion"],
    );
    expect(merged).toEqual([
      { provider: "github", displayName: "GitHub" },
      { provider: "gmail", displayName: "Gmail" },
    ]);
  });

  it("reconciles Composio slugs without case sensitivity", () => {
    expect(
      mergeConnectedPlugins(
        [{ provider: "github", displayName: "GitHub", status: "pending" }],
        ["GITHUB"],
      ),
    ).toEqual([{ provider: "github", displayName: "GitHub" }]);
    expect(
      planLiveConnectionSync(
        [{ id: "row-gh", provider: "github", status: "pending", displayName: "GitHub" }],
        ["GITHUB"],
      ),
    ).toEqual({ connectIds: ["row-gh"], revokeIds: [] });
  });

  it("only fetches live Composio slugs when a Rakazo row is still pending or errored", () => {
    expect(needsLivePluginSync([{ status: "connected" }, { status: "revoked" }])).toBe(false);
    expect(needsLivePluginSync([{ status: "pending" }])).toBe(true);
    expect(needsLivePluginSync([{ status: "error" }])).toBe(true);
  });

  it("keeps DB-connected plugins when live Composio listing is empty", () => {
    expect(
      mergeConnectedPlugins(
        [{ provider: "github", displayName: "GitHub", status: "connected" }],
        [],
      ),
    ).toEqual([{ provider: "github", displayName: "GitHub" }]);
  });

  it("plans DB sync when Composio is connected but Rakazo is still pending", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail", "slack"],
      ),
    ).toEqual({
      connectIds: ["row-gmail"],
      revokeIds: [],
    });
  });

  it("does not create connection rows for live slugs that have no workspace row", () => {
    expect(
      planLiveConnectionSync(
        [{ id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" }],
        ["github", "slack"],
      ),
    ).toEqual({ connectIds: [], revokeIds: [] });
  });

  it("reconnects existing error rows instead of inserting duplicates", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-err", provider: "gmail", status: "error", displayName: "Gmail" },
          { id: "row-old", provider: "slack", status: "revoked", displayName: "Slack" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail", "slack", "github", "slack"],
      ),
    ).toEqual({
      connectIds: ["row-err"],
      revokeIds: [],
    });
  });

  it("does not revive a revoked sibling when a live row shares the provider slug", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-old", provider: "gmail", status: "revoked", displayName: "Gmail" },
          { id: "row-live", provider: "gmail", status: "connected", displayName: "Gmail" },
        ],
        ["gmail"],
      ),
    ).toEqual({ connectIds: [], revokeIds: [] });
    expect(
      pickReusableConnection([
        { id: "row-old", status: "revoked" },
        { id: "row-live", status: "connected" },
      ]),
    ).toBeUndefined();
    expect(pickReusableConnection([{ id: "row-old", status: "revoked" }])).toEqual({
      id: "row-old",
      status: "revoked",
    });
  });

  it("revokes abandoned pending or error rows after a successful live listing", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-dup", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: ["row-gmail"],
      revokeIds: ["row-dup", "row-err"],
    });
  });

  it("clears failed additional-account error rows while keeping in-flight pendings", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "connected", displayName: "Personal" },
          { id: "row-work", provider: "gmail", status: "pending", displayName: "Work" },
          { id: "row-fail", provider: "gmail", status: "error", displayName: "Gmail" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: [],
      revokeIds: ["row-fail", "row-err"],
    });
  });

  it("keeps an in-flight additional account when the provider is already connected", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "connected", displayName: "Personal" },
          { id: "row-work", provider: "gmail", status: "pending", displayName: "Work" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: [],
      revokeIds: ["row-err"],
    });
  });

  it("filters the catalog by name or slug", () => {
    const items = [
      { slug: "github", name: "GitHub", logo: null, connected: false, noAuth: false },
      { slug: "hackernews", name: "Hacker News", logo: null, connected: false, noAuth: true },
    ];
    expect(filterCatalog(items, "hacker").map((item) => item.slug)).toEqual(["hackernews"]);
  });
});

describe("Composio during pnpm test", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(isComposioEnabled("ck_configured")).toBe(true);
    vi.unstubAllEnvs();
  });
});
