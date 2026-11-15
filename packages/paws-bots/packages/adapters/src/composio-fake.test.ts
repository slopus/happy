import type { ConnectedAccountStatus } from "@composio/core";
import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import { ConnectorAuthUnavailableError } from "@rakazo/adapter-kit";
import { CONNECTOR_AUTH_UNAVAILABLE } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { ComposioConnector } from "./composio-connector.js";
import { FakeComposioClient } from "./composio-fake.js";
import { createConnectorStack } from "./connector-registry.js";

const USER = "user-1";

function context(
  connectedConnections?: AdapterContext["connectedConnections"],
  userId = USER,
): AdapterContext {
  return {
    operationId: "composio-fake",
    traceId: "composio-fake",
    spaceId: "workspace",
    userId,
    signal: new AbortController().signal,
    ...(connectedConnections ? { connectedConnections } : {}),
  };
}

function connection(provider: string, providerRef?: string) {
  return {
    id: `connection-${provider.toLowerCase()}-${providerRef ?? "legacy"}`,
    connectorId: "composio",
    externalId: provider,
    displayName: provider,
    ...(providerRef ? { providerRef } : {}),
  };
}

function setup() {
  const fake = new FakeComposioClient();
  return { fake, connector: new ComposioConnector({ client: fake }) };
}

async function run(
  connector: ComposioConnector,
  tool: string,
  args: Record<string, unknown>,
  ctx: AdapterContext,
) {
  const events: ConnectorEvent[] = [];
  for await (const event of connector.execute({ tool, args, executionId: `exec-${tool}` }, ctx)) {
    events.push(event);
  }
  return events;
}

async function connect(connector: ComposioConnector, provider: string, userId = USER) {
  const { state } = await connector.begin(
    { provider, redirectUrl: "http://example.test/callback" },
    context(undefined, userId),
  );
  return state;
}

describe("ComposioConnector over the fake Composio client", () => {
  it("stays registered when supplied without a live Composio key", () => {
    const { connector } = setup();
    expect(createConnectorStack(connector).connector.managed("composio")).toBe(connector);
  });

  it("serves and searches the toolkit catalog", async () => {
    const { connector } = setup();

    await expect(connector.catalog(context())).resolves.toHaveLength(6);
    await expect(connector.catalog(context(), "git")).resolves.toEqual([
      expect.objectContaining({ slug: "GITHUB", name: "GitHub", connected: false }),
    ]);
  });

  it("hides apps nobody can sign in to until the project sets up their auth", async () => {
    const fake = new FakeComposioClient([
      { slug: "GMAIL", name: "Gmail", logo: null, noAuth: false },
      { slug: "SHOPIFY", name: "Shopify", logo: null, noAuth: false, needsSignInSetup: true },
    ]);
    const hidden = new ComposioConnector({ client: fake });
    await expect(hidden.catalog(context())).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL" }),
    ]);
    await expect(connect(hidden, "SHOPIFY")).rejects.toBeInstanceOf(ConnectorAuthUnavailableError);

    fake.authConfigs.list = async () => ({
      items: [{ toolkit: { slug: "shopify" }, status: "ENABLED" }],
      nextCursor: null,
    });
    await expect(new ComposioConnector({ client: fake }).catalog(context())).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL" }),
      expect.objectContaining({ slug: "SHOPIFY" }),
    ]);
    await expect(connect(new ComposioConnector({ client: fake }), "SHOPIFY")).resolves.toMatch(
      /^ca_/,
    );
  });

  it("lists every app when the sign-in lookup fails", async () => {
    const fake = new FakeComposioClient([
      { slug: "SHOPIFY", name: "Shopify", logo: null, noAuth: false, needsSignInSetup: true },
    ]);
    fake.authConfigs.list = async () => {
      throw new Error("auth configs unavailable");
    };
    await expect(new ComposioConnector({ client: fake }).catalog(context())).resolves.toEqual([
      expect.objectContaining({ slug: "SHOPIFY" }),
    ]);
  });

  it("fails connect with a typed error when Composio has no managed auth for the toolkit", async () => {
    const { fake, connector } = setup();
    const create = fake.create.bind(fake);
    fake.create = async (userId, config) => ({
      ...(await create(userId, config)),
      authorize: async () => {
        throw new Error(
          '400 {"error":{"message":"Composio does not manage auth for toolkit twitter.","code":4308,"slug":"ToolRouterV2_NoManagedAuth","status":400}}',
        );
      },
    });

    const failure = await connector
      .begin({ provider: "TWITTER", redirectUrl: "http://example.test/callback" }, context())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectorAuthUnavailableError);
    expect(failure).toMatchObject({ code: CONNECTOR_AUTH_UNAVAILABLE });
    expect((failure as Error).message).not.toContain("ToolRouterV2_NoManagedAuth");
  });

  it("isolates connections by user and deletes the account on revoke", async () => {
    const { fake, connector } = setup();
    const ref = await connect(connector, "GMAIL");

    expect(ref).toMatch(/^ca_/);
    await expect(connector.connectionReady(context(), "GMAIL")).resolves.toBe(true);
    await expect(connector.listConnectedSlugs(USER)).resolves.toEqual(["GMAIL"]);
    await expect(connector.connectionReady(context(undefined, "user-2"), "GMAIL")).resolves.toBe(
      false,
    );
    await expect(connector.catalog(context(), "gmail")).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL", connected: true }),
    ]);
    expect(fake.mailboxFor(USER)?.messages.length).toBeGreaterThan(0);

    await connector.revoke(ref, context());
    await expect(connector.connectionReady(context(), "GMAIL")).resolves.toBe(false);
    expect(fake.accounts).toEqual([]);
    expect(fake.mailboxFor(USER)).toBeUndefined();
  });

  it("keeps the shared Gmail mailbox until the last account is revoked", async () => {
    const { fake, connector } = setup();
    const first = await connect(connector, "GMAIL");
    const second = await connect(connector, "GMAIL");
    expect(first).not.toEqual(second);

    await connector.revoke(first, context());
    await expect(connector.connectionReady(context(), "GMAIL")).resolves.toBe(true);
    expect(fake.mailboxFor(USER)).toBeDefined();

    await connector.revoke(second, context());
    await expect(connector.connectionReady(context(), "GMAIL")).resolves.toBe(false);
    expect(fake.mailboxFor(USER)).toBeUndefined();
  });

  it("discovers Gmail tools and thin actions for other apps", async () => {
    const { connector } = setup();
    const tools = await connector.discoverTools(
      context([connection("GMAIL"), connection("SLACK")]),
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_SEND_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_LIST_LABELS",
      "SLACK_EMULATED_ACTION",
    ]);
    expect(tools.find((tool) => tool.name === "GMAIL_SEND_EMAIL")?.inputSchema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        recipient_email: expect.any(Object),
        subject: expect.any(Object),
        body: expect.any(Object),
      }),
      required: ["subject"],
    });
  });

  it("round-trips Gmail fetch and send against the mailbox", async () => {
    const { fake, connector } = setup();
    const ctx = context([connection("GMAIL", await connect(connector, "GMAIL"))]);

    await expect(
      run(connector, "GMAIL_FETCH_EMAILS", { query: "from:teammate", max_results: 5 }, ctx),
    ).resolves.toEqual([
      {
        type: "result",
        data: {
          data: {
            messages: [
              expect.objectContaining({
                messageId: "18c5f5d1a2b3c4d6",
                subject: "Quarterly planning notes",
              }),
            ],
            resultSizeEstimate: 1,
          },
          logId: expect.any(String),
        },
      },
    ]);

    const send = await run(
      connector,
      "GMAIL_SEND_EMAIL",
      { bcc: ["hidden@example.test"], subject: "BCC only", body: "Sent with bcc only" },
      ctx,
    );
    expect(send).toEqual([
      {
        type: "result",
        data: expect.objectContaining({
          data: expect.objectContaining({ messageId: expect.any(String), labelIds: ["SENT"] }),
        }),
      },
    ]);
    expect(
      fake.mailboxFor(USER)?.messages.find((message) => message.subject === "BCC only"),
    ).toMatchObject({ to: "hidden@example.test", labelIds: ["SENT"] });

    await expect(
      run(connector, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: "missing" }, ctx),
    ).resolves.toEqual([{ type: "error", message: "Message not found: missing" }]);
    expect(fake.executions.map((entry) => entry.tool)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    ]);
  });

  it("serves seeded GitHub releases", async () => {
    const { fake, connector } = setup();
    const ctx = context([connection("GITHUB", await connect(connector, "GITHUB"))]);

    const tools = await connector.discoverTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual(["GITHUB_LIST_RELEASES", "GITHUB_GET_RELEASE"]);
    const events = await run(
      connector,
      "GITHUB_LIST_RELEASES",
      { owner: "elie222", repo: "rakazo" },
      ctx,
    );
    expect(events).toEqual([
      {
        type: "result",
        data: expect.objectContaining({
          data: expect.objectContaining({
            ok: true,
            releases: expect.arrayContaining([expect.objectContaining({ tag: "v0.4.2" })]),
          }),
        }),
      },
    ]);
    expect(fake.listGithubReleases()[0]?.tag).toBe("v0.4.2");
  });

  it("refuses tools from a toolkit the session does not include", async () => {
    const { fake, connector } = setup();
    const ctx = context([connection("GMAIL", await connect(connector, "GMAIL"))]);

    await expect(
      run(connector, "GITHUB_LIST_RELEASES", { owner: "elie222", repo: "rakazo" }, ctx),
    ).resolves.toEqual([
      {
        type: "error",
        message: "Toolkit for GITHUB_LIST_RELEASES is not enabled in this session",
      },
    ]);
    expect(fake.executions).toEqual([]);
  });

  it("requires an account in the session when several are pinned", async () => {
    const { fake, connector } = setup();
    const work = await connect(connector, "GMAIL");
    const personal = await connect(connector, "GMAIL");
    const ctx = context([connection("GMAIL", work), connection("GMAIL", personal)]);
    const listing = (account?: string) => ({
      tool_slug: "DROPBOX_LIST_FOLDERS",
      arguments: { path: "/" },
      ...(account ? { account } : {}),
    });

    await expect(run(connector, "GMAIL_LIST_LABELS", {}, ctx)).resolves.toEqual([
      { type: "error", message: "Select which GMAIL account to use" },
    ]);
    await expect(
      run(connector, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [listing("ca_other")] }, ctx),
    ).resolves.toEqual([
      {
        type: "error",
        message:
          "The account requested for DROPBOX_LIST_FOLDERS is not connected to this workspace.",
      },
    ]);
    expect(fake.executions).toEqual([]);
  });

  it("rejects an account the session did not pin", async () => {
    const { fake } = setup();
    const work = fake.connect(USER, "gmail");
    const session = await fake.create(USER, {
      toolkits: ["GMAIL"],
      connectedAccounts: { GMAIL: [work] },
    });

    await expect(
      session.execute("GMAIL_LIST_LABELS", {}, { account: "ca_other" }),
    ).resolves.toMatchObject({ error: "Account ca_other is not available in this session" });
    await expect(
      session.execute("GMAIL_LIST_LABELS", {}, { account: work }),
    ).resolves.toMatchObject({ error: null });
  });

  it("returns a tool error when a Dropbox listing has malformed arguments", async () => {
    const { fake, connector } = setup();
    const ctx = context([connection("GMAIL", await connect(connector, "GMAIL"))]);

    await expect(
      run(
        connector,
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        { tools: [{ tool_slug: "DROPBOX_LIST_FOLDERS", arguments: "{not-json" }] },
        ctx,
      ),
    ).resolves.toEqual([
      { type: "error", message: "Dropbox folder listing arguments must be a JSON object." },
    ]);
    expect(fake.executions).toEqual([]);
  });
});

describe("Composio connected-account lifecycle", () => {
  it.each([
    "INITIALIZING",
    "INITIATED",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
    "REVOKED",
  ] satisfies ConnectedAccountStatus[])(
    "never lets a %s pinned account fall back to another account",
    async (status) => {
      const { fake, connector } = setup();
      const work = fake.connect(USER, "gmail", status);
      fake.connect(USER, "gmail");
      const github = fake.connect(USER, "github");
      const ctx = context([connection("gmail", work), connection("github", github)]);

      await connector.discoverTools(ctx);
      expect(fake.created.at(-1)?.config).toEqual({
        manageConnections: false,
        sandbox: { enable: false },
        toolkits: ["GITHUB"],
        connectedAccounts: { GITHUB: [github] },
      });

      await expect(
        run(
          connector,
          "COMPOSIO_MULTI_EXECUTE_TOOL",
          { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] },
          ctx,
        ),
      ).resolves.toEqual([{ type: "error", message: expect.stringContaining("reconnect GMAIL") }]);
      expect(fake.executions).toEqual([]);
    },
  );

  it("pins an ACTIVE account found past the first page", async () => {
    const { fake, connector } = setup();
    fake.connect(USER, "gmail");
    const work = fake.connect(USER, "gmail");

    await connector.discoverTools(context([connection("gmail", work)]));

    expect(fake.created.at(-1)?.config).toMatchObject({
      toolkits: ["GMAIL"],
      connectedAccounts: { GMAIL: [work] },
    });
    expect(fake.accountListCalls.map((call) => call.cursor ?? null)).toEqual([null, "1"]);
  });

  it("creates no session when every pinned toolkit needs reconnect", async () => {
    const { fake, connector } = setup();
    const work = fake.connect(USER, "gmail", "EXPIRED");

    await expect(connector.discoverTools(context([connection("gmail", work)]))).resolves.toEqual(
      [],
    );
    expect(fake.created.filter((entry) => entry.userId === USER)).toEqual([]);
  });

  it("treats an account Composio already deleted as revoked", async () => {
    const { connector } = setup();
    await expect(connector.revoke("ca_gone", context())).resolves.toBeUndefined();
  });

  it("lists only toolkits whose connected account is active", async () => {
    const fake = new FakeComposioClient([
      { slug: "GMAIL", name: "Gmail", logo: null, noAuth: false },
      { slug: "GITHUB", name: "GitHub", logo: null, noAuth: false },
      { slug: "HACKERNEWS", name: "Hacker News", logo: null, noAuth: true },
    ]);
    const connector = new ComposioConnector({ client: fake });
    fake.connect(USER, "gmail", "EXPIRED");
    fake.connect(USER, "github");

    await expect(connector.listConnectedSlugs(USER)).resolves.toEqual(["GITHUB", "HACKERNEWS"]);
  });

  it("falls back to the toolkit connection when account listing is down", async () => {
    const { fake, connector } = setup();
    const work = fake.connect(USER, "gmail");
    fake.failAccountList = true;

    await expect(connector.connectedAccountId(USER, "gmail")).resolves.toBe(work);
    fake.setStatus(work, "EXPIRED");
    await expect(connector.connectedAccountId(USER, "gmail")).resolves.toBeUndefined();
  });

  it("reports every account the user has to reconnect, across pages", async () => {
    const { fake, connector } = setup();
    const statuses: ConnectedAccountStatus[] = [
      "ACTIVE",
      "INITIATED",
      "EXPIRED",
      "INACTIVE",
      "FAILED",
      "REVOKED",
    ];
    const ids = statuses.map((status) => fake.connect(USER, "gmail", status));
    fake.connect("user-2", "gmail", "EXPIRED");

    await expect(connector.listReconnectRefs(context())).resolves.toEqual(ids.slice(2));
  });
});
