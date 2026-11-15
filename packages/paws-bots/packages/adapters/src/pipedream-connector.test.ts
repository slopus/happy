import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPipedreamEnabled,
  MAX_PIPEDREAM_RESPONSE_BYTES,
  PipedreamConnector,
  pipedreamConfigFromEnv,
} from "./pipedream-connector.js";
import { ThirdPartyConnectorEmulator } from "./third-party-connector-emulator.js";

const context: AdapterContext = {
  operationId: "pipedream-test",
  traceId: "pipedream-test",
  spaceId: "workspace-example",
  userId: "user-example",
  signal: new AbortController().signal,
};

const FAKE_CONFIG = {
  clientId: "fake-client-id",
  clientSecret: "fake-client-secret",
  projectId: "fake-project-id",
  environment: "development" as const,
  identitySecret: "fake-identity-secret",
};

const TEST_NETWORK = { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] };

/** Serve the token endpoint plus one MCP server per app slug, keyed on `x-pd-app-slug`. */
function pipedreamMcpFetch(
  toolsByApp: Record<string, string[]>,
  calls: Array<{ app: string | null; name: string; args: unknown }> = [],
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/oauth/token") {
      return Response.json({ access_token: "fake-access-token", expires_in: 3_600 });
    }
    const app = request.headers.get("x-pd-app-slug");
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
    if (message.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "pipedream-test", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: (toolsByApp[app ?? ""] ?? []).map((name) => ({
            name,
            description: `Run ${name}`,
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: `schema-marker-${app}-${name}` } },
              required: ["text"],
            },
          })),
        },
      });
    }
    if (message.method === "tools/call") {
      calls.push({ app, name: message.params?.name ?? "", args: message.params?.arguments });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

function connectedContext(...apps: string[]): AdapterContext {
  return {
    ...context,
    connectedConnections: apps.map((app) => ({
      id: `connection-${app}`,
      connectorId: "pipedream",
      externalId: app,
      displayName: app,
      providerRef: `apn_${app}`,
    })),
  };
}

function appTools(app: string, count: number): Record<string, string[]> {
  return { [app]: Array.from({ length: count }, (_, index) => `${app}_tool_${index}`) };
}

describe("pipedreamConfigFromEnv", () => {
  it("maps shared environment values and normalizes unsupported environments", () => {
    expect(
      pipedreamConfigFromEnv({
        pipedreamClientId: "client-id",
        pipedreamClientSecret: "client-secret",
        pipedreamProjectId: "project-id",
        pipedreamEnvironment: "staging",
        encryptionKey: "identity-secret",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      projectId: "project-id",
      environment: "development",
      identitySecret: "identity-secret",
    });
  });

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(
      isPipedreamEnabled({
        clientId: "client-id",
        clientSecret: "client-secret",
        projectId: "project-id",
        environment: "production",
        identitySecret: "identity-secret",
      }),
    ).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("PipedreamConnector", () => {
  describe("needsReconnect", () => {
    const row = (providerRef?: string, externalId = "gmail") => ({
      id: "row",
      connectorId: "pipedream",
      externalId,
      displayName: "Gmail",
      providerRef,
    });
    it.each([
      ["a row names the account", [row("apn_1")], false],
      ["a row holds only the app slug", [row("gmail")], true],
      ["a row has no reference", [row()], true],
      ["no row at all", [], true],
      ["only another app has an account", [row("apn_2", "slack")], true],
    ])("%s", async (_name, connectedConnections, expected) => {
      const connector = new PipedreamConnector(FAKE_CONFIG);
      expect(await connector.needsReconnect({ ...context, connectedConnections }, "gmail")).toBe(
        expected,
      );
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "javascript:alert(document.domain)",
    "http://pipedream.example.test/connect",
    "https://user:password@pipedream.example.test/connect",
  ])("rejects an unsafe provider connect URL: %s", async (connectUrl) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-access-token", expires_in: 3_600 }),
      )
      .mockResolvedValueOnce(Response.json({ connect_link_url: connectUrl }));
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("secure HTTPS connect URL");
  });

  it("reports the status when a token response carries no JSON body", async () => {
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch: vi.fn().mockResolvedValue(new Response("", { status: 502 })) },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream authentication failed: 502");
  });

  it("rejects an oversized token response before buffering it", async () => {
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_PIPEDREAM_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch: vi.fn().mockResolvedValue(response) },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized Content-Length without waiting on a hanging body cancel", async () => {
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes
      },
      cancel() {
        cancelStarted = true;
        return new Promise(() => {
          // never settles
        });
      },
    });
    const abort = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-access-token", expires_in: 3_600 }),
      )
      .mockImplementationOnce(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_PIPEDREAM_RESPONSE_BYTES + 1) },
        });
      });
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    const started = Date.now();
    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        { ...context, signal: abort.signal },
      ),
    ).rejects.toThrow("Pipedream response is too large.");
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a chunked API response without a content length", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-access-token", expires_in: 3_600 }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_PIPEDREAM_RESPONSE_BYTES + 1)));
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream response is too large.");
  });

  it("clears a rejected token before reading an oversized 401 response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "rejected-token", expires_in: 3_600 }))
      .mockResolvedValueOnce(
        new Response("oversized", {
          status: 401,
          headers: { "content-length": String(MAX_PIPEDREAM_RESPONSE_BYTES + 1) },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "replacement-token", expires_in: 3_600 }),
      )
      .mockResolvedValueOnce(
        Response.json({ connect_link_url: "https://pipedream.example.test/connect" }),
      );
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream response is too large.");
    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).resolves.toEqual({
      authorizationUrl: "https://pipedream.example.test/connect?app=gmail",
      state: "gmail",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[1]?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer replacement-token" }),
    );
  });

  it("uses one opaque external identity across the app catalog and account flow", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/v1/oauth/token")) {
          return Response.json({ access_token: "fake-access-token", expires_in: 3_600 });
        }
        if (url.includes("/v1/connect/apps?")) {
          return Response.json({
            data: [{ id: "app-1", name_slug: "gmail", name: "Gmail" }],
            page_info: {},
          });
        }
        if (url.includes("/accounts?")) {
          return Response.json({
            data: [
              {
                id: "account-1",
                healthy: true,
                app: { id: "app-1", name_slug: "gmail", name: "Gmail" },
              },
            ],
            page_info: {},
          });
        }
        if (url.endsWith("/tokens")) {
          return Response.json({ connect_link_url: "https://pipedream.example.test/connect" });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const connector = new PipedreamConnector({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      projectId: "fake-project-id",
      environment: "development",
      identitySecret: "fake-identity-secret",
    });

    await expect(connector.catalog(context)).resolves.toEqual([
      expect.objectContaining({
        connectorId: "pipedream",
        slug: "gmail",
        connected: true,
      }),
    ]);
    const started = await connector.begin(
      { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
      context,
    );

    expect(started.authorizationUrl).toBe("https://pipedream.example.test/connect?app=gmail");
    expect(requests.filter((request) => request.url.endsWith("/v1/oauth/token"))).toHaveLength(1);
    expect(
      requests.find((request) => request.url.endsWith("/v1/oauth/token"))?.init?.body,
    ).toContain('"scope":"connect:*"');
    const accountUrl = requests.find((request) => request.url.includes("/accounts?"))?.url;
    const connectRequest = requests.find((request) => request.url.endsWith("/tokens"));
    const externalId = new URL(accountUrl!).searchParams.get("external_user_id");
    // Pipedream owns accounts by this ID and nothing stores it locally, so a
    // different derivation would orphan every existing connected account.
    expect(externalId).toBe("rkz_cf501546987d67cc9c570cd2cd628794ae730be9ab0bae106da4408a0401bf3f");
    expect(externalId).not.toContain(context.userId);
    expect(externalId).not.toContain(context.spaceId);
    expect(JSON.parse(String(connectRequest?.init?.body))).toEqual(
      expect.objectContaining({ external_user_id: externalId }),
    );
  });

  it("marks account-list failures as pre-delete so revoke can restore local retry state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/v1/oauth/token")) {
          return Response.json({ access_token: "fake-access-token", expires_in: 3_600 });
        }
        if (url.includes("/accounts?")) {
          const error = new Error("network timeout listing accounts");
          error.name = "TimeoutError";
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const connector = new PipedreamConnector({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      projectId: "fake-project-id",
      environment: "development",
      identitySecret: "fake-identity-secret",
    });

    await expect(connector.revoke("account-1", context)).rejects.toMatchObject({
      name: "TimeoutError",
      remoteRevokePreDelete: true,
    });
  });

  it("exposes 20 app tools directly and switches to the catalog at 21", async () => {
    for (const count of [20, 21]) {
      const connector = new PipedreamConnector(FAKE_CONFIG, {
        ...TEST_NETWORK,
        fetch: pipedreamMcpFetch(appTools("gmail", count)),
      });

      const tools = await connector.discoverTools(connectedContext("gmail"));

      if (count === 20) {
        expect(tools).toHaveLength(20);
        expect(tools[0]?.route).toEqual(
          expect.objectContaining({ connectorId: "pipedream", resourceId: "gmail" }),
        );
      } else {
        expect(tools.map((tool) => tool.name)).toEqual([
          "pipedream_search_tools",
          "pipedream_load_tool",
          "pipedream_execute_tool",
        ]);
        expect(JSON.stringify(tools)).not.toContain("schema-marker");
      }
    }
  });

  it("includes every connected app when more than 20 apps have one tool each", async () => {
    const apps = Array.from({ length: 21 }, (_, index) => `app_${index}`);
    const toolsByApp = Object.fromEntries(apps.map((app) => [app, [`${app}_tool`]]));
    const connector = new PipedreamConnector(FAKE_CONFIG, {
      ...TEST_NETWORK,
      fetch: pipedreamMcpFetch(toolsByApp),
    });
    const context = connectedContext(...apps);
    const [search] = await connector.discoverTools(context);

    expect(search?.name).toBe("pipedream_search_tools");

    const events = [];
    for await (const event of connector.execute(
      { tool: search!.name, args: {}, executionId: "search-many-apps", route: search!.route },
      context,
    )) {
      events.push(event);
    }

    const index = (events[0] as { data?: { index?: Array<{ group: string }> } })?.data?.index;
    expect(index?.map((entry) => entry.group).sort()).toEqual(
      apps.map((app) => `${app} (${app}; connection-${app})`).sort(),
    );
    expect(index).toHaveLength(21);
  });

  it("keeps other apps when one connected app fails discovery", async () => {
    const healthy = pipedreamMcpFetch(appTools("gmail", 21));
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/v1/oauth/token") {
        return Response.json({ access_token: "fake-access-token", expires_in: 3_600 });
      }
      if (request.headers.get("x-pd-app-slug") === "broken") {
        return new Response("upstream down", { status: 503 });
      }
      return healthy(input, init);
    });
    const connector = new PipedreamConnector(FAKE_CONFIG, { ...TEST_NETWORK, fetch });
    const tools = await connector.discoverTools(connectedContext("broken", "gmail"));
    expect(tools.map((tool) => tool.name)).toEqual([
      "pipedream_search_tools",
      "pipedream_load_tool",
      "pipedream_execute_tool",
    ]);
  });

  it("lists catalog names grouped by connected app", async () => {
    const connector = new PipedreamConnector(FAKE_CONFIG, {
      ...TEST_NETWORK,
      fetch: pipedreamMcpFetch({
        gmail: ["send_email", "list_threads"],
        ...appTools("slack", 20),
      }),
    });
    const context = connectedContext("gmail", "slack");
    const [search] = await connector.discoverTools(context);

    const events = [];
    for await (const event of connector.execute(
      { tool: search!.name, args: {}, executionId: "search", route: search!.route },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "result",
        data: {
          index: [
            { group: "gmail (gmail; connection-gmail)", names: ["list_threads", "send_email"] },
            {
              group: "slack (slack; connection-slack)",
              names: expect.arrayContaining(["slack_tool_0"]),
            },
          ],
        },
      },
    ]);
  });

  it("routes a catalog execute call to the app that owns the tool", async () => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const connector = new PipedreamConnector(FAKE_CONFIG, {
      ...TEST_NETWORK,
      fetch: pipedreamMcpFetch({ gmail: ["send_email"], ...appTools("slack", 20) }, calls),
    });
    const context = connectedContext("gmail", "slack");
    const execute = (await connector.discoverTools(context)).at(-1)!;
    const call = {
      tool: execute.name,
      args: { id: "gmail:connection-gmail:send_email", arguments: { text: "hello" } },
      executionId: "execute",
      route: execute.route,
    };

    await expect(connector.resolveCall(call, context)).resolves.toEqual(
      expect.objectContaining({
        call: expect.objectContaining({
          tool: expect.stringMatching(/^send_email__/),
          args: { text: "hello" },
          route: expect.objectContaining({ resourceId: "gmail", toolName: "send_email" }),
        }),
      }),
    );

    const events = [];
    for await (const event of connector.execute(call, context)) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ isError: false }),
      }),
    ]);
    expect(calls).toEqual([{ app: "gmail", name: "send_email", args: { text: "hello" } }]);
  });

  function gmailContext(...refs: string[]): AdapterContext {
    return {
      ...context,
      connectedConnections: refs.map((providerRef, index) => ({
        id: `connection-${index}`,
        connectorId: "pipedream",
        externalId: "gmail",
        displayName: `Gmail ${index}`,
        providerRef,
      })),
    };
  }

  it("resolves an old watch action only for a single connected account", async () => {
    const connector = new PipedreamConnector(FAKE_CONFIG, {
      ...TEST_NETWORK,
      fetch: pipedreamMcpFetch({ gmail: ["send_email"] }),
    });
    const call = { tool: "send_email", args: { text: "hello" }, executionId: "watch" };
    expect(
      (await connector.resolveCall(call, gmailContext("apn_work")))?.call.route?.connectionId,
    ).toBe("connection-0");
    expect(await connector.resolveCall(call, gmailContext("apn_work", "apn_home"))).toBeUndefined();
  });

  it("discovers each account's own tools and keeps a healthy sibling when one fails", async () => {
    const healthy = pipedreamMcpFetch({ gmail: ["send_email"] });
    let failWork = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const account = request.headers.get("x-pd-account-id");
      if (failWork && account === "apn_work") return new Response("unavailable", { status: 503 });
      const method = account
        ? (
            await request
              .clone()
              .json()
              .catch(() => ({}))
          ).method
        : undefined;
      const response = await healthy(request);
      if (account && method === "tools/list") {
        const body = await response.json();
        body.result.tools[0].inputSchema.properties.text.description = `schema-${account}`;
        return Response.json(body);
      }
      return response;
    });
    const connector = new PipedreamConnector(FAKE_CONFIG, { ...TEST_NETWORK, fetch });
    const ctx = gmailContext("apn_work", "apn_home");
    const tools = await connector.discoverTools(ctx);
    expect(tools).toHaveLength(2);
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain("schema-apn_work");
    expect(JSON.stringify(tools[1]?.inputSchema)).toContain("schema-apn_home");
    failWork = true;
    const remaining = await connector.discoverTools(ctx);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe(tools[1]?.name);
  });

  it.each(["gmail", "google_calendar"])(
    "keeps both %s accounts distinct through lazy execution",
    async (app) => {
      const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
      const fetch = pipedreamMcpFetch(appTools(app, 11), calls);
      const connector = new PipedreamConnector(FAKE_CONFIG, { ...TEST_NETWORK, fetch });
      const ctx = {
        ...context,
        connectedConnections: gmailContext("apn_work", "apn_home").connectedConnections!.map(
          (row) => ({ ...row, externalId: app }),
        ),
      };
      expect((await connector.discoverTools(ctx)).map(({ name }) => name)).toEqual([
        "pipedream_search_tools",
        "pipedream_load_tool",
        "pipedream_execute_tool",
      ]);
      for (const row of ctx.connectedConnections) {
        const call = {
          tool: "execute",
          executionId: "test",
          route: { connectorId: "pipedream", toolName: "__catalog_execute" },
          args: { id: `${app}:${row.id}:${app}_tool_0`, arguments: { text: "hello" } },
        };
        const resolved = await connector.resolveCall(call, ctx);
        expect(resolved?.call.route?.connectionId).toBe(row.id);
        const events = [];
        for await (const event of connector.execute(call, ctx)) events.push(event);
        expect(events).toEqual([expect.objectContaining({ type: "result" })]);
        const requests = fetch.mock.calls.map(([input, init]) => new Request(input, init));
        expect(
          requests
            .filter((req) => req.headers.has("x-pd-app-slug"))
            .at(-1)
            ?.headers.get("x-pd-account-id"),
        ).toBe(row.providerRef);
      }
      expect(calls).toHaveLength(2);
    },
  );

  async function runGmail(
    fetch: ReturnType<typeof pipedreamMcpFetch>,
    context: AdapterContext,
    args: Record<string, unknown>,
    connectionId?: string,
    resourceRevision?: string,
  ) {
    const connector = new PipedreamConnector(FAKE_CONFIG, { ...TEST_NETWORK, fetch });
    const tools = await connector.discoverTools(context);
    const events = [];
    for await (const event of connector.execute(
      {
        tool: "send_email",
        args,
        executionId: "pin",
        route: {
          connectorId: "pipedream",
          resourceId: "gmail",
          toolName: "send_email",
          connectionId,
          resourceRevision,
        },
      },
      context,
    )) {
      events.push(event);
    }
    const accounts = fetch.mock.calls
      .map(([input, init]) => new Request(input, init))
      .filter((request) => request.headers.has("x-pd-app-slug"))
      .map((request) => request.headers.get("x-pd-account-id"));
    return { tools, events, accounts };
  }

  it("pins a single approved account without asking the model to choose", async () => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const { tools, events, accounts } = await runGmail(
      pipedreamMcpFetch({ gmail: ["send_email"] }, calls),
      gmailContext("apn_work"),
      { text: "hello" },
    );

    expect(tools[0]?.inputSchema).toEqual(
      expect.objectContaining({ required: ["text"], properties: { text: expect.anything() } }),
    );
    expect(events).toEqual([expect.objectContaining({ type: "result" })]);
    expect(calls).toEqual([{ app: "gmail", name: "send_email", args: { text: "hello" } }]);
    expect(accounts.length).toBeGreaterThan(0);
    expect(new Set(accounts)).toEqual(new Set(["apn_work"]));
  });

  it.each(["apn_work", "apn_home"])("runs the selected account's tool on %s", async (chosen) => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const fetch = pipedreamMcpFetch({ gmail: ["send_email"] }, calls);
    const ctx = gmailContext("apn_work", "apn_home");
    const connectionId = ctx.connectedConnections!.find((row) => row.providerRef === chosen)!.id;
    const { tools, events } = await runGmail(fetch, ctx, { text: "hello" }, connectionId);
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(2);
    expect(tools.map((tool) => tool.route?.connectionId)).toEqual(["connection-0", "connection-1"]);
    expect(tools[0]?.inputSchema).toEqual(expect.objectContaining({ required: ["text"] }));
    expect(events).toEqual([expect.objectContaining({ type: "result" })]);
    expect(calls).toEqual([{ app: "gmail", name: "send_email", args: { text: "hello" } }]);
    const callAccounts = fetch.mock.calls
      .map(([input, init]) => new Request(input, init))
      .filter((request) => request.headers.has("x-pd-app-slug"))
      .map((request) => request.headers.get("x-pd-account-id"));
    expect(callAccounts.every(Boolean)).toBe(true);
    expect(callAccounts.at(-1)).toBe(chosen);
  });

  it.each([undefined, "unknown-connection"])(
    "refuses an ambiguous or unapproved route: %s",
    async (id) => {
      const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
      const { events } = await runGmail(
        pipedreamMcpFetch({ gmail: ["send_email"] }, calls),
        gmailContext("apn_work", "apn_home"),
        { text: "hello" },
        id,
      );
      expect(events).toEqual([expect.objectContaining({ type: "error" })]);
      expect(calls).toEqual([]);
    },
  );

  it("does not redirect a removed account's route to its remaining sibling", async () => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const { events } = await runGmail(
      pipedreamMcpFetch({ gmail: ["send_email"] }, calls),
      gmailContext("apn_home"),
      { text: "hello" },
      "removed-connection",
    );
    expect(events).toEqual([expect.objectContaining({ type: "error" })]);
    expect(calls).toEqual([]);
  });

  it("refuses a stale route after its connection is reauthorized as a different account", async () => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const { events } = await runGmail(
      pipedreamMcpFetch({ gmail: ["send_email"] }, calls),
      gmailContext("apn_new"),
      { text: "hello" },
      "connection-0",
      "apn_old",
    );
    expect(events).toEqual([expect.objectContaining({ type: "error" })]);
    expect(calls).toEqual([]);
  });

  it("offers only accounts a row names when another row stores just the app", async () => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const { tools, events, accounts } = await runGmail(
      pipedreamMcpFetch({ gmail: ["send_email"] }, calls),
      gmailContext("apn_work", "gmail"),
      { text: "hello" },
    );

    expect(tools[0]?.inputSchema).not.toHaveProperty("properties.connected_account");
    expect(events).toEqual([expect.objectContaining({ type: "result" })]);
    expect(calls).toHaveLength(1);
    expect(new Set(accounts)).toEqual(new Set(["apn_work"]));
  });

  it("refuses to run when no row names an account", async () => {
    const calls: Array<{ app: string | null; name: string; args: unknown }> = [];
    const { tools, events, accounts } = await runGmail(
      pipedreamMcpFetch({ gmail: ["send_email"] }, calls),
      gmailContext("gmail"),
      { text: "hello" },
    );

    expect(tools).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: "error" })]);
    expect(calls).toEqual([]);
    expect(accounts).toEqual([]);
  });

  it("leaves a direct app route to the normal execute path", async () => {
    const connector = new PipedreamConnector(FAKE_CONFIG, TEST_NETWORK);

    await expect(
      connector.resolveCall(
        {
          tool: "send_email",
          args: {},
          executionId: "direct",
          route: { connectorId: "pipedream", resourceId: "gmail", toolName: "send_email" },
        },
        connectedContext("gmail"),
      ),
    ).resolves.toBeUndefined();
  });

  it("runs catalog, connection, discovery, execution, and revoke against the protocol emulator", async () => {
    const emulator = new ThirdPartyConnectorEmulator();
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch: emulator.fetch, resolveHostname: emulator.resolveHostname },
    );

    await expect(connector.catalog(context)).resolves.toContainEqual(
      expect.objectContaining({ connectorId: "pipedream", slug: "linear", connected: false }),
    );
    await expect(
      connector.begin(
        { provider: "linear", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).resolves.toEqual({
      authorizationUrl: "https://pipedream.example.test/connect?app=linear",
      state: "linear",
    });
    await expect(connector.connectionReady(context, "linear")).resolves.toBe(true);

    const connectedContext = {
      ...context,
      connectedConnections: [
        {
          id: "connection-linear",
          connectorId: "pipedream",
          externalId: "linear",
          displayName: "Linear",
          providerRef: "account-linear",
        },
      ],
    };
    const tools = await connector.discoverTools(connectedContext);
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: expect.stringMatching(/^notes.write__/),
        route: expect.objectContaining({ connectorId: "pipedream", resourceId: "linear" }),
      }),
    );
    const events = [];
    for await (const event of connector.execute(
      {
        tool: "notes.write",
        args: { text: "emulated-pipedream-ok" },
        executionId: "pipedream-emulated-execution",
        route: tools[0]?.route,
      },
      connectedContext,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ isError: false }),
      }),
    );
    expect(emulator.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        args: { text: "emulated-pipedream-ok" },
      }),
    );

    await connector.revoke("linear", context);
    await expect(connector.connectionReady(context, "linear")).resolves.toBe(false);
  });
});
