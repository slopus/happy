import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { MCP_OAUTH_CHANNEL } from "../src/lib/mcp-oauth-channel";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, signup } from "./helpers";

test("connects an MCP server through the OAuth popup callback", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-oauth-${stamp}@rakazo.test`, "password12", "MCP OAuth");
  await completeOnboarding(page);

  let oauthStatus: McpServer["oauthStatus"] = "none";
  let hasSecret = false;
  const server: McpServer = {
    id: "mcp-oauth-server",
    spaceId: "mcp-oauth-workspace",
    slug: "linear",
    name: "Linear MCP",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.linear.test/mcp",
    command: null,
    hasArgs: false,
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    hasSecret,
    oauthStatus,
    oauthClientId: null,
    enabled: true,
    verbatimResults: false,
    revision: 1,
    health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const browserOrigin = new URL(page.url()).origin;
  let releaseCompletion = () => {};
  let markCompletionStarted = () => {};
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const completionStarted = new Promise<void>((resolve) => {
    markCompletionStarted = resolve;
  });

  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [{ ...server, hasSecret, oauthStatus }] }),
    });
  });
  await page.context().route("**/rpc/mcp/assignments/all", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [] }) });
  });
  await page.context().route("**/rpc/mcp/oauth/begin", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: {
        serverId: server.id,
        redirectUri: `${browserOrigin}/mcp/oauth/callback`,
      },
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          status: "authorization_required",
          sessionId: "mcp-oauth-session",
          authorizationUrl: `${browserOrigin}/mcp/oauth/callback?code=fake-code&state=mcp-oauth-session`,
        },
      }),
    });
  });
  await page.context().route("**/rpc/mcp/oauth/complete", async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: {
        sessionId: "mcp-oauth-session",
        code: "fake-code",
        state: "mcp-oauth-session",
      },
    });
    markCompletionStarted();
    await completionGate;
    oauthStatus = "connected";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await expect(page.getByText("Linear MCP", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-oauth-ready");

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect OAuth", exact: true }).click();
  const popup = await popupPromise;
  await completionStarted;
  await expect(popup.getByText("Finishing MCP connection…", { exact: true })).toBeVisible();
  await captureScreenshot(popup, testInfo, "mcp-oauth-callback");

  releaseCompletion();
  await expect(page.getByRole("button", { name: "Connect OAuth", exact: true })).toBeHidden();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await captureScreenshot(page, testInfo, "mcp-oauth-connected");
  await page.getByRole("button", { name: "Actions for Linear MCP", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Reconnect OAuth", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Disconnect", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  oauthStatus = "reconnect";
  hasSecret = true;
  await page.evaluate((channelName) => {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type: "mcp-oauth-complete" });
    channel.close();
  }, MCP_OAUTH_CHANNEL);
  await expect(page.getByRole("button", { name: "Reconnect OAuth", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-oauth-expired");
});

test("adds an MCP server with a pre-registered OAuth client", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-oauth-client-${stamp}@rakazo.test`, "password12", "MCP OAuth");
  await completeOnboarding(page);

  const browserOrigin = new URL(page.url()).origin;
  const servers: McpServer[] = [];
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: servers }),
    });
  });
  await page.context().route("**/rpc/mcp/servers/create", async (route) => {
    const { json } = route.request().postDataJSON() as { json: Record<string, unknown> };
    expect(json).toMatchObject({
      transport: "streamable_http",
      endpoint: "https://gmailmcp.example.test/mcp/v1",
      oauthClient: { clientId: "client-1.apps.example.test", clientSecret: "client-secret" },
    });
    const created: McpServer = {
      id: "mcp-oauth-client-server",
      spaceId: "mcp-oauth-workspace",
      slug: "gmail",
      name: "Gmail",
      description: "",
      transport: "streamable_http",
      endpoint: "https://gmailmcp.example.test/mcp/v1",
      command: null,
      hasArgs: false,
      envKeys: [],
      fileKeys: [],
      headerKeys: [],
      hasSecret: true,
      oauthStatus: "none",
      oauthClientId: "client-1.apps.example.test",
      enabled: true,
      verbatimResults: false,
      revision: 1,
      health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    servers.push(created);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: created }),
    });
  });
  await page.context().route("**/rpc/mcp/servers/test", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: servers[0] }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");

  await page.getByLabel("Server name").fill("Gmail");
  await page.getByLabel("Server URL").fill("https://gmailmcp.example.test/mcp/v1");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Redirect URI")).toBeHidden();
  await page.getByLabel("OAuth client ID (optional)").fill("client-1.apps.example.test");
  await page.getByLabel("OAuth client secret (optional)").fill("client-secret");
  await expect(page.getByLabel("Redirect URI")).toHaveValue(`${browserOrigin}/mcp/oauth/callback`);
  await captureScreenshot(page, testInfo, "mcp-oauth-client-form");

  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect OAuth", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("OAuth client ID (optional)")).toHaveValue("");
  await expect(page.getByLabel("OAuth client secret (optional)")).toHaveValue("");
});

test("asks for a client ID when the MCP server cannot register one", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-oauth-dcr-${stamp}@rakazo.test`, "password12", "MCP OAuth");
  await completeOnboarding(page);

  const message = "Incompatible auth server: does not support dynamic client registration";
  let health: McpServer["health"] = {
    status: "unknown",
    message: null,
    toolCount: null,
    checkedAt: null,
  };
  const server: Omit<McpServer, "health"> = {
    id: "mcp-oauth-dcr-server",
    spaceId: "mcp-oauth-workspace",
    slug: "notes",
    name: "Notes MCP",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.notes.test/mcp",
    command: null,
    hasArgs: false,
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    hasSecret: false,
    oauthStatus: "none",
    oauthClientId: null,
    enabled: true,
    verbatimResults: false,
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [{ ...server, health }] }),
    });
  });
  await page.context().route("**/rpc/mcp/assignments/all", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [] }) });
  });
  await page.context().route("**/rpc/mcp/oauth/begin", async (route) => {
    health = {
      status: "error",
      message,
      code: MCP_OAUTH_CLIENT_REQUIRED,
      toolCount: null,
      checkedAt: new Date().toISOString(),
    };
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        json: { defined: false, code: MCP_OAUTH_CLIENT_REQUIRED, status: 400, message },
      }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await page.getByRole("button", { name: "Connect OAuth", exact: true }).click();

  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Needs an OAuth client ID");
  await expect(page.getByLabel("OAuth client ID (optional)")).toBeFocused();
  await captureScreenshot(page, testInfo, "mcp-oauth-client-required");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("mcp-health")).toContainText("Needs an OAuth client ID");
  await expect(page.getByRole("button", { name: "Connect OAuth", exact: true })).toBeHidden();
});
