import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioConnector,
  EncryptedSecretStore,
  FakeComposioClient,
  InstalledConnectorProvider,
  PipedreamConnector,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { appliedModelRole, runAsSystem, runAsTenant, updateModelRole } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Actor = { spaceId: string; userId: string };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
const TEST_ENCRYPTION_KEY = "offline-connector-test-encryption-key";

describeWithDatabase("Composio catalog reconciliation", () => {
  let handles: AppHandles;
  let app: App;
  let fake: FakeComposioClient;
  let composio: ComposioConnector;
  let thirdParties: ThirdPartyConnectorEmulator;
  let connectionOrdinal = 0;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-connections-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    fake = new FakeComposioClient();
    composio = new ComposioConnector({ client: fake });
    thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: TEST_ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio,
      pipedream,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      encryptionKey: TEST_ENCRYPTION_KEY,
      signupsEnabled: "true",
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes overlapping backup replacements without mixing users or orders", async () => {
    const ownerCookie = await signup(app, `backup-owner-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `backup-other-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<Actor>(app, ownerCookie, "me");
    const other = await rpc<Actor>(app, otherCookie, "me");
    const first = [{ provider: "provider-a", modelId: "first" }];
    const second = [
      { provider: "provider-b", modelId: "second" },
      { provider: "provider-c", modelId: "third" },
    ];
    const replace = (actor: Actor, backups: typeof first) =>
      runAsTenant(actor, () => updateModelRole(handles.prisma, actor, "main", { backups }));
    const backups = async (actor: Actor) =>
      (await runAsTenant(actor, () => appliedModelRole(handles.prisma, actor, "main"))).backups;
    await replace(other, first);
    await Promise.all([replace(owner, first), replace(owner, second)]);
    expect([first, second]).toContainEqual(await backups(owner));
    expect(await backups(other)).toEqual(first);
  });

  it("reconciles one scoped row per provider under concurrent catalog fetches", async () => {
    const ownerCookie = await signup(app, `owner-connections-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `other-connections-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<Actor>(app, ownerCookie, "me");
    const other = await rpc<Actor>(app, otherCookie, "me");
    await connectRemote(composio, owner, "GMAIL");

    const first = await createConnection(owner, "GMAIL");
    const duplicate = await createConnection(owner, "GMAIL");
    const otherProvider = await createConnection(owner, "SLACK");
    const otherUser = await createConnection(
      { spaceId: owner.spaceId, userId: other.userId },
      "GMAIL",
    );
    const otherWorkspace = await createConnection(
      { spaceId: other.spaceId, userId: owner.userId },
      "GMAIL",
    );

    const catalogs = await Promise.all(
      Array.from({ length: 4 }, () =>
        rpc<Array<{ slug: string; connected: boolean }>>(app, ownerCookie, "connections/catalog"),
      ),
    );
    for (const catalog of catalogs) {
      expect(catalog).toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: true }));
    }

    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
    await expect(statuses([otherProvider.id, otherUser.id, otherWorkspace.id])).resolves.toEqual([
      { id: otherProvider.id, status: "pending" },
      { id: otherUser.id, status: "pending" },
      { id: otherWorkspace.id, status: "pending" },
    ]);

    await rpc(app, ownerCookie, "connections/catalog");
    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
  });

  it("keeps a second connected account for the same provider and renames it", async () => {
    const cookie = await signup(app, `multi-account-${stamp}@rakazo.test`, "Multi Account");
    const first = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Personal",
    });
    const second = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Work",
    });
    await expect(
      rpc<Array<{ id: string; displayName: string; status: string }>>(
        app,
        cookie,
        "connections/list",
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.connectionId,
          displayName: "Personal",
          status: "connected",
        }),
        expect.objectContaining({
          id: second.connectionId,
          displayName: "Work",
          status: "connected",
        }),
      ]),
    );

    await expect(
      rpc<{ displayName: string }>(app, cookie, "connections/rename", {
        connectionId: second.connectionId,
        displayName: "Work inbox",
      }),
    ).resolves.toMatchObject({ displayName: "Work inbox" });

    await rpc(app, cookie, "connections/catalog");
    await expect(statuses([first.connectionId, second.connectionId])).resolves.toEqual([
      { id: first.connectionId, status: "connected" },
      { id: second.connectionId, status: "connected" },
    ]);

    await rpc(app, cookie, "connections/revoke", { connectionId: first.connectionId });
    await expect(
      rpc<Array<{ id: string; status: string }>>(app, cookie, "connections/list"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.connectionId, status: "revoked" }),
        expect.objectContaining({ id: second.connectionId, status: "connected" }),
      ]),
    );

    // Uninstall the remaining account: catalog must flip off Added.
    await rpc(app, cookie, "connections/revoke", { connectionId: second.connectionId });
    await expect(
      rpc<Array<{ slug: string; connected: boolean }>>(app, cookie, "connections/catalog", {
        connectorId: "composio",
      }),
    ).resolves.toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: false }));
  });

  it("marks a connected account Composio reports dead as needing reconnect", async () => {
    const cookie = await signup(app, `reconnect-${stamp}@rakazo.test`, "Reconnect");
    const work = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Work",
    });
    const personal = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Personal",
    });
    const row = await asSystem(handles.prisma).connection.findUniqueOrThrow({
      where: { id: work.connectionId },
    });
    fake.setStatus(row.providerRef!, "EXPIRED");

    await rpc(app, cookie, "connections/catalog", { connectorId: "composio" });

    await expect(statuses([work.connectionId, personal.connectionId])).resolves.toEqual([
      { id: work.connectionId, status: "error" },
      { id: personal.connectionId, status: "connected" },
    ]);
  });

  it("returns the remote catalog when local reconciliation fails", async () => {
    const cookie = await signup(app, `db-failure-connections-${stamp}@rakazo.test`, "DB Failure");
    const actor = await rpc<Actor>(app, cookie, "me");
    await connectRemote(composio, actor, "SLACK");
    const pending = await createConnection(actor, "SLACK");
    // Keep the rejection sticky: catalog reconciliation may call findMany more
    // than once, and a one-shot mock lets a later call mark the row connected.
    const failure = vi
      .spyOn(asSystem(handles.prisma).connection, "findMany")
      .mockRejectedValue(new Error("simulated reconciliation failure"));

    // Scope to composio so a parallel managed provider cannot consume the one-shot findMany reject.
    const catalog = await rpc<Array<{ slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      { connectorId: "composio" },
    );

    expect(catalog).toContainEqual(expect.objectContaining({ slug: "SLACK", connected: true }));
    failure.mockRestore();
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
  });

  it("does not mutate local state when the provider catalog fails", async () => {
    const cookie = await signup(
      app,
      `provider-failure-connections-${stamp}@rakazo.test`,
      "Provider Failure",
    );
    const actor = await rpc<Actor>(app, cookie, "me");
    const pending = await createConnection(actor, "GITHUB");
    const failure = vi
      .spyOn(composio, "catalog")
      .mockRejectedValueOnce(new Error("simulated provider failure"));

    await expect(
      rpc(app, cookie, "connections/catalog", { connectorId: "composio" }),
    ).resolves.toEqual([]);
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
    failure.mockRestore();
  });

  it("routes an emulated Composio app tool with user-scoped connection context", async () => {
    const cookie = await signup(app, `composio-tool-${stamp}@rakazo.test`, "Composio Tool");
    const actor = await rpc<Actor>(app, cookie, "me");
    const started = await rpc<{ connectionId: string; authorizationUrl: null }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "composio", provider: "GMAIL", displayName: "Gmail" },
    );
    expect(started.authorizationUrl).toBeNull();
    const context = {
      operationId: "composio-product-test",
      traceId: "composio-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Gmail",
        },
      ],
    };
    const tools = (await handles.connectors.discoverTools(context)).filter(
      (candidate) => candidate.route?.connectorId === "composio",
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_SEND_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_LIST_LABELS",
    ]);
    const fetchTool = tools.find((tool) => tool.name === "GMAIL_FETCH_EMAILS");
    expect(fetchTool).toBeDefined();
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: fetchTool!.name,
        args: { query: "from:teammate", max_results: 5 },
        executionId: "composio-product-execution",
        route: fetchTool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          data: {
            messages: [
              expect.objectContaining({
                messageId: "18c5f5d1a2b3c4d6",
                subject: "Quarterly planning notes",
              }),
            ],
            resultSizeEstimate: 1,
          },
        }),
      }),
    );
    expect(fake.executions).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        tool: "GMAIL_FETCH_EMAILS",
        args: { query: "from:teammate", max_results: 5 },
      }),
    );
  });

  it("runs Pipedream connection and MCP tool execution through the product registry", async () => {
    const cookie = await signup(app, `pipedream-${stamp}@rakazo.test`, "Pipedream Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const catalog = await rpc<Array<{ connectorId: string; slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      { connectorId: "pipedream" },
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ connectorId: "pipedream", slug: "linear", connected: false }),
    );

    const started = await rpc<{ connectionId: string; authorizationUrl: string }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "pipedream", provider: "linear", displayName: "Linear" },
    );
    expect(started.authorizationUrl).toBe("https://pipedream.example.test/connect?app=linear");
    await expect(
      rpc<{ status: string }>(app, cookie, "connections/complete", {
        connectionId: started.connectionId,
      }),
    ).resolves.toMatchObject({ status: "connected" });
    const stored = await asSystem(handles.prisma).connection.findUniqueOrThrow({
      where: { id: started.connectionId },
    });
    expect(stored.providerRef).toBe("account-linear");

    const context = {
      operationId: "pipedream-product-test",
      traceId: "pipedream-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "pipedream",
          externalId: "linear",
          displayName: "Linear",
          providerRef: stored.providerRef ?? undefined,
        },
      ],
    };
    const tool = (await handles.connectors.discoverTools(context)).find(
      (candidate) => candidate.route?.connectorId === "pipedream",
    );
    expect(tool).toMatchObject({
      name: expect.stringMatching(/^notes.write__/),
      route: {
        connectionId: started.connectionId,
        resourceRevision: stored.providerRef,
        toolName: "notes.write",
      },
    });
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: tool!.name,
        args: { text: "product-pipedream-ok" },
        executionId: "pipedream-product-execution",
        route: tool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "result" }));

    await rpc(app, cookie, "connections/revoke", { connectionId: started.connectionId });
    await expect(
      rpc<Array<{ id: string; status: string }>>(app, cookie, "connections/list"),
    ).resolves.toContainEqual(
      expect.objectContaining({ id: started.connectionId, status: "revoked" }),
    );
  });

  it("installs Treg, Executor, and custom MCP sources and routes their calls", async () => {
    const cookie = await signup(app, `mcp-connectors-${stamp}@rakazo.test`, "MCP Connectors");
    const actor = await rpc<Actor>(app, cookie, "me");
    const tregCredential = "fake-treg-credential-value";
    const treg = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Treg",
        source: "https://treg.to/mcp/",
        credential: tregCredential,
        config: { preset: "treg", auth: { type: "bearer" } },
      },
    );
    const custom = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Custom MCP",
        source: "https://mcp.example.test/mcp",
        config: { preset: "custom", auth: { type: "none" } },
      },
    );
    const executorCredential = "fake-executor-credential-value";
    const executor = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Executor",
        source: "https://executor.example.test/mcp",
        credential: executorCredential,
        config: { preset: "custom", auth: { type: "bearer" } },
      },
    );
    expect(treg.secretConfigured).toBe(true);
    expect(custom.secretConfigured).toBe(false);
    expect(executor.secretConfigured).toBe(true);
    expect(JSON.stringify(treg)).not.toContain(tregCredential);
    expect(JSON.stringify(executor)).not.toContain(executorCredential);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const context = {
      operationId: "mcp-product-test",
      traceId: "mcp-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    // The executor calls installed connectors from the run.continue job.
    await runAsSystem("background job run.continue", async () => {
      const tools = await provider.discoverTools(context);
      // All three installs expose the same MCP tool name, so approval kinds are disambiguated.
      expect(tools.filter((tool) => tool.route?.toolName === "notes.write")).toHaveLength(3);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      for (const install of [treg, executor, custom]) {
        const tool = tools.find((candidate) => candidate.route?.resourceId === install.id);
        expect(tool?.name).toBe(`installed__${install.id}__notes.write`);
        const events = [];
        for await (const event of provider.execute(
          {
            tool: tool!.name,
            args: { text: `mcp-${install.id}` },
            executionId: `mcp-${install.id}`,
            route: tool!.route,
          },
          context,
        )) {
          events.push(event);
        }
        expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
      }
    });
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({ provider: "mcp", operation: "notes.write", host: "treg.to" }),
    );
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        host: "executor.example.test",
        authenticated: true,
      }),
    );
    expect(JSON.stringify(thirdParties.records)).not.toContain(executorCredential);
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        host: "mcp.example.test",
      }),
    );
  });

  it("imports an OpenAPI connector, keeps its credential encrypted, and routes calls", async () => {
    const cookie = await signup(app, `api-connector-${stamp}@rakazo.test`, "API Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const credential = "test-connector-secret-value";
    const install = await rpc<{
      id: string;
      config: Record<string, unknown>;
      secretConfigured: boolean;
    }>(app, cookie, "capabilities/install", {
      kind: "api",
      name: "CRM API",
      source: "https://api.example.test/openapi.json",
      credential,
      config: { openApi: true, auth: { type: "bearer" } },
    });
    expect(install.secretConfigured).toBe(true);
    expect(JSON.stringify(install)).not.toContain(credential);

    const storedInstall = await asSystem(handles.prisma).capabilityInstall.findUniqueOrThrow({
      where: { id: install.id },
    });
    const storedSecret = await asSystem(handles.prisma).secret.findUniqueOrThrow({
      where: { id: storedInstall.secretId! },
    });
    expect(storedSecret.ciphertext).not.toContain(credential);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const adapterContext = {
      operationId: "api-connector-test",
      traceId: "api-connector-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const events: unknown[] = [];
    // The executor calls installed connectors from the run.continue job.
    await runAsSystem("background job run.continue", async () => {
      const tools = await provider.discoverTools(adapterContext);
      const tool = tools.find((candidate) => candidate.route?.toolName === "getContact");
      expect(tool).toMatchObject({
        name: "getContact",
        readOnly: true,
      });
      for await (const event of provider.execute(
        {
          tool: tool!.name,
          args: { contactId: "contact-1" },
          executionId: "api-call-1",
          route: tool!.route,
        },
        adapterContext,
      )) {
        events.push(event);
      }
    });
    expect(JSON.stringify(events)).toContain("contact-1");
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "openapi",
        path: "/v1/contacts/contact-1",
        authenticated: true,
      }),
    );

    await rpc(app, cookie, "capabilities/remove", { id: install.id });
    await expect(
      asSystem(handles.prisma).secret.findUnique({ where: { id: storedSecret.id } }),
    ).resolves.toBeNull();
  });

  it("imports a GraphQL connector, introspects operations, and routes calls", async () => {
    const cookie = await signup(app, `graphql-connector-${stamp}@rakazo.test`, "GraphQL Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const install = await rpc<{
      id: string;
      config: Record<string, unknown>;
      secretConfigured: boolean;
    }>(app, cookie, "capabilities/install", {
      kind: "graphql",
      name: "Star Wars API",
      source: "https://graphql.example.test/graphql",
      config: { auth: { type: "none" } },
    });
    expect(install.secretConfigured).toBe(false);
    expect(Array.isArray((install.config as { operations?: unknown[] }).operations)).toBe(true);
    expect((install.config as { operations: unknown[] }).operations.length).toBeGreaterThan(0);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const adapterContext = {
      operationId: "graphql-connector-test",
      traceId: "graphql-connector-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const tools = await provider.discoverTools(adapterContext);
    const tool = tools.find((candidate) => candidate.route?.toolName === "query_hero");
    expect(tool).toMatchObject({
      name: "hero",
      readOnly: true,
    });

    const events = [];
    for await (const event of provider.execute(
      {
        tool: tool!.name,
        args: { episode: "EMPIRE" },
        executionId: "graphql-call-1",
        route: tool!.route,
      },
      adapterContext,
    )) {
      events.push(event);
    }
    expect(JSON.stringify(events)).toContain("ok");
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "graphql",
        authenticated: false,
      }),
    );

    await rpc(app, cookie, "capabilities/remove", { id: install.id });
  });

  async function createConnection(owner: Actor, provider: string) {
    return asSystem(handles.prisma).connection.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        provider,
        displayName: provider,
        status: "pending",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, connectionOrdinal++)),
      },
    });
  }

  async function statuses(ids: string[]) {
    return asSystem(handles.prisma).connection.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
  }
});

async function connectRemote(composio: ComposioConnector, actor: Actor, provider: string) {
  await composio.begin(
    { provider, redirectUrl: "http://127.0.0.1.invalid/callback" },
    {
      operationId: "connections-test",
      traceId: "connections-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
  );
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (!response.ok) throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
