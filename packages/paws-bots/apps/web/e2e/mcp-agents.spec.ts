import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, rpc, signup } from "./helpers";

const server: McpServer = {
  id: "mcp-agents-server",
  spaceId: "mcp-agents-workspace",
  slug: "search-console",
  name: "Search Console",
  description: "",
  transport: "streamable_http",
  endpoint: "https://mcp.search-console.test/mcp",
  command: null,
  hasArgs: false,
  envKeys: [],
  fileKeys: [],
  headerKeys: [],
  hasSecret: false,
  oauthStatus: "none",
  oauthClientId: null,
  health: { status: "ok", message: null, toolCount: 7, checkedAt: "2026-10-30T00:00:00.000Z" },
  enabled: true,
  verbatimResults: false,
  allBots: true,
  revision: 1,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};

test("a server the user adds reaches every bot until they pick some", async ({
  page,
}, testInfo) => {
  await signup(page, `mcp-agents-${Date.now()}@rakazo.test`, "password12", "MCP agents");
  await completeOnboarding(page);
  const writer = await rpc<{ id: string }>(page, "bots/create", {
    name: "Writer",
    computerMode: "team",
  });
  const servers: McpServer[] = [];
  await page
    .context()
    .route("**/rpc/mcp/servers/list", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: servers }) }),
    );
  await page.context().route("**/rpc/mcp/servers/create", async (route) => {
    servers.push(server);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: server }),
    });
  });
  const requests: unknown[] = [];
  await page.context().route("**/rpc/mcp/servers/agents", async (route) => {
    const { json } = route.request().postDataJSON() as {
      json: { allBots: boolean; botIds: string[] };
    };
    requests.push(json);
    servers[0] = { ...server, allBots: json.allBots };
    const assignments = json.botIds.map((botId) => ({
      id: `assignment-${botId}`,
      botId,
      serverId: server.id,
      allowAllTools: true,
      allowedTools: [],
      createdAt: server.createdAt,
      updatedAt: server.createdAt,
    }));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { server: servers[0], assignments } }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await page.getByLabel("Server name").fill("Search Console");
  await page.getByLabel("Server URL").fill(server.endpoint!);
  await captureScreenshot(page, testInfo, "mcp-agents-add");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const access = page.getByTestId("mcp-server").getByTestId("agent-access");
  await expect(access).toContainText("All bots");
  await captureScreenshot(page, testInfo, "mcp-agents");

  await access.getByRole("button").click();
  const chief = page.getByRole("menuitemcheckbox", { name: "Chief", exact: true });
  await expect(chief).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-agents-menu");
  await chief.click();
  await page.keyboard.press("Escape");
  await expect(access).toContainText("Writer");
  expect(requests).toEqual([{ id: server.id, allBots: false, botIds: [writer.id] }]);
});

test("shows each server's bots and state with several bots", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signup(page, `mcp-states-${Date.now()}@rakazo.test`, "password12", "MCP states");
  await completeOnboarding(page);
  const bots: Record<string, string> = {};
  for (const name of ["Writer", "Researcher", "Support", "Ops", "Designer", "Sales"]) {
    bots[name] = (
      await rpc<{ id: string }>(page, "bots/create", { name, computerMode: "team" })
    ).id;
  }
  const at = server.createdAt;
  const servers: McpServer[] = [
    server,
    {
      ...server,
      id: "mcp-states-linear",
      slug: "linear",
      name: "Linear",
      endpoint: "https://mcp.linear.test/mcp",
      oauthStatus: "connected",
      health: { status: "ok", message: null, toolCount: 23, checkedAt: at },
      allBots: false,
    },
    {
      ...server,
      id: "mcp-states-github",
      slug: "github",
      name: "GitHub",
      endpoint: "https://mcp.github.test/mcp",
      hasSecret: true,
      health: { status: "error", message: "401 Unauthorized", toolCount: null, checkedAt: at },
      allBots: false,
    },
    {
      ...server,
      id: "mcp-states-notion",
      slug: "notion",
      name: "Notion",
      endpoint: "https://mcp.notion.test/mcp",
      oauthStatus: "reconnect",
      health: { status: "ok", message: null, toolCount: 12, checkedAt: at },
      allBots: false,
    },
    {
      ...server,
      id: "mcp-states-files",
      slug: "files",
      name: "Files",
      transport: "stdio",
      endpoint: null,
      command: "npx -y @modelcontextprotocol/server-filesystem",
      health: { status: "installing", message: null, toolCount: null, checkedAt: null },
      allBots: false,
    },
  ];
  const assignment = (serverId: string, botId: string) => ({
    id: `assignment-${serverId}-${botId}`,
    botId,
    serverId,
    allowAllTools: true,
    allowedTools: [],
    createdAt: at,
    updatedAt: at,
  });
  const assignments = [
    assignment("mcp-states-linear", bots.Writer!),
    assignment("mcp-states-linear", bots.Researcher!),
    assignment("mcp-states-linear", bots.Ops!),
    assignment("mcp-states-github", bots.Support!),
    ...["Writer", "Researcher", "Support", "Ops", "Designer"].map((name) =>
      assignment("mcp-states-files", bots[name]!),
    ),
  ];
  await page
    .context()
    .route("**/rpc/mcp/servers/list", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: servers }) }),
    );
  await page.context().route("**/rpc/mcp/assignments/all", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: assignments }),
    }),
  );

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  const rows = page.getByTestId("mcp-server");
  await expect(rows).toHaveCount(servers.length);
  await expect(rows.nth(1).getByTestId("agent-access")).toContainText("Researcher");
  await expect(rows.nth(3).getByTestId("agent-access")).toContainText("No bots");
  await expect(rows.nth(4).getByTestId("agent-access")).toContainText("+1");
  await captureScreenshot(page, testInfo, "mcp-states");

  await rows.nth(1).getByTestId("agent-access").getByRole("button").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Support", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-states-menu");
  await page.keyboard.press("Escape");

  await rows.nth(1).getByRole("button", { name: "Actions for Linear" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-states-actions");
});
