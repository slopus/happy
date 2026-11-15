import { expect, test } from "@playwright/test";
import type {
  AgentSkillCatalogEntry,
  BotMcpServer,
  CapabilityInstall,
  McpServer,
} from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openIntegrationsAdd,
  rpc,
  signup,
} from "./helpers";

test("Integrations installs a plugin, completes real broker OAuth against a fake provider, and removes its children", async ({
  page,
}, testInfo) => {
  await signup(page, `marketplace-${Date.now()}@rakazo.test`, "password12", "Marketplace Test");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let cancel = true;
  await page.context().route("https://marketplace-auth.example.test/authorize**", async (route) => {
    const authorize = new URL(route.request().url());
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    if (cancel)
      return route.fulfill({ contentType: "text/html", body: "<h1>Fixture provider sign-in</h1>" });
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", authorize.searchParams.get("state")!);
    redirect.searchParams.set("code", "fake-marketplace-code");
    return route.fulfill({ status: 302, headers: { location: redirect.toString() } });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
  const section = dialog.getByTestId("plugin-section").filter({ hasText: "Productivity" });
  await expect(section.getByText("Planning Notes", { exact: true })).toBeVisible();
  // A skill pack has nothing to connect, so it is offered under Skills instead.
  await expect(dialog.getByText("Review Kit", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-plugins");
  await dialog.getByRole("textbox", { name: "Search apps", exact: true }).fill("planning");
  const row = dialog.getByTestId("plugin-results").getByTestId("plugin-row");
  await expect(row).toHaveCount(1);
  await captureScreenshot(page, testInfo, "integrations-plugin-search");
  await row.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Planning Notes", exact: true })).toBeVisible();
  await expect(
    dialog.getByText("https://marketplace-tools.example.test/mcp", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/^Not added/)).toHaveCount(0);
  expect(await rpc(page, "capabilities/list", undefined)).toEqual([]);
  await captureScreenshot(page, testInfo, "integrations-plugin-detail");

  // Connecting adds only the connector; the skills are a separate choice.
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const installs = await rpc<CapabilityInstall[]>(page, "capabilities/list", undefined);
  const install = installs.find((row) => row.kind === "plugin")!;
  expect(install.version).toBe("f".repeat(40));
  expect(install.config).toMatchObject({ parts: ["connector"] });
  const skillNames = async () =>
    (await rpc<AgentSkillCatalogEntry[]>(page, "agentSkills/list", undefined)).map(
      (skill) => skill.name,
    );
  expect(await skillNames()).not.toContain("planning-notes");
  await dialog.getByRole("button", { name: "Add skills", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove skills", exact: true })).toBeVisible();
  expect(await rpc<AgentSkillCatalogEntry[]>(page, "agentSkills/list", undefined)).toContainEqual(
    expect.objectContaining({ name: "planning-notes", source: "plugin", readOnly: true }),
  );
  const servers = await rpc<McpServer[]>(page, "mcp/servers/list", undefined);
  const server = servers.find((row) => row.installId === install.id)!;
  expect(server.oauthStatus).toBe("none");
  expect(await rpc(page, "mcp/assignments/list", { botId })).toEqual([]);

  // Closing the provider must not claim Connected or lose the install.
  const cancelledPopup = page.waitForEvent("popup", { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  const first = await cancelledPopup;
  await expect(first.getByRole("heading", { name: "Fixture provider sign-in" })).toBeVisible();
  await first.close();
  await expect(dialog.getByRole("alert")).toContainText("Sign-in cancelled");
  await expect(dialog.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();

  cancel = false;
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  const popup = await popupPromise;
  await expect(dialog.getByRole("img", { name: "Connected", exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const connected = (await rpc<McpServer[]>(page, "mcp/servers/list", undefined)).find(
    (row) => row.id === server.id,
  )!;
  expect(connected).toMatchObject({ oauthStatus: "connected", hasSecret: true });
  expect(JSON.stringify(connected)).not.toContain("fake-marketplace-access");
  await dialog.getByRole("button", { name: "Use in this bot", exact: true }).click();
  await expect(dialog.getByText("In this bot", { exact: true })).toBeVisible();
  expect(await rpc<BotMcpServer[]>(page, "mcp/assignments/list", { botId })).toContainEqual(
    expect.objectContaining({ serverId: server.id }),
  );
  await captureScreenshot(page, testInfo, "integrations-plugin-connected");

  await dialog.getByRole("button", { name: "Close integrations", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await dialog.getByRole("button", { name: /^\d+ connected$/ }).click();
  const apps = dialog.getByTestId("connected-apps").getByTestId("installed-plugin");
  await expect(apps).toContainText("Planning Notes");
  await expect(apps).toContainText("1 connector");
  await expect(apps.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  // Skills are managed in the Skills dialog; the Connected view lists apps only.
  await expect(dialog.getByTestId("connected-skills")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-manage");

  // Removing the connector keeps the skills; removing the last part removes the plugin.
  await apps.getByRole("button", { name: /Planning Notes/ }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  expect(await rpc(page, "mcp/servers/list", undefined)).toEqual([]);
  expect(await rpc(page, "mcp/assignments/list", { botId })).toEqual([]);
  expect(await skillNames()).toContain("planning-notes");
  await dialog.getByRole("button", { name: "Remove skills", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Add skills", exact: true })).toBeVisible();
  expect(await rpc(page, "capabilities/list", undefined)).toEqual([]);
  expect(await skillNames()).not.toContain("planning-notes");
});

test("shows directly registered MCP servers in Integrations without catalog connections", async ({
  page,
}, testInfo) => {
  await signup(page, `direct-mcp-list-${Date.now()}@rakazo.test`, "password12", "Direct MCP List");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await expect(page.getByRole("textbox", { name: "Server name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close MCP servers", exact: true }).click();
  for (const name of ["Dropbox", "GitHub"])
    await rpc(page, "mcp/servers/create", {
      slug: name.toLowerCase(),
      name,
      transport: "streamable_http",
      endpoint: `https://${name.toLowerCase()}.example.test/mcp`,
      secret: "fake-mcp-credential",
    });
  expect(await rpc(page, "connections/list", undefined)).toEqual([]);
  // Every connection state, on the two real servers plus copies of one.
  // "partial": Docs has one connected and one failing server; "all": both connected;
  // "down": nothing is connected.
  let phase: "partial" | "all" | "down" = "partial";
  const states: Record<string, [string, (server: McpServer) => McpServer]> = {
    Dropbox: [
      "Connected",
      (s) => ({ ...s, health: { ...s.health, status: phase === "down" ? "error" : "ok" } }),
    ],
    GitHub: ["Needs sign-in", (s) => ({ ...s, oauthStatus: "reconnect" })],
    Linear: ["Not connected", (s) => ({ ...s, health: { ...s.health, status: "unknown" } })],
    Notion: ["Not working", (s) => ({ ...s, health: { ...s.health, status: "error" } })],
    Figma: [
      "Needs an OAuth client ID",
      (s) => ({ ...s, health: { ...s.health, status: "error", code: MCP_OAUTH_CLIENT_REQUIRED } }),
    ],
    Slack: ["Disabled", (s) => ({ ...s, enabled: false })],
  };
  await page.route("**/rpc/mcp/servers/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: McpServer[] };
    const [first] = body.json;
    const copies = Object.keys(states)
      .filter((name) => !body.json.some((server) => server.name === name))
      .map((name) => ({ ...first!, id: `copy-${name}`, slug: name.toLowerCase(), name }));
    const json = [...body.json, ...copies].map((server) => states[server.name]![1](server));
    // Plugin servers: Notes is signed in but failing, Docs has two, and Empty has none.
    const pluginServer = (install: string, slug: string, working: boolean) => ({
      ...first!,
      id: `copy-${slug}`,
      slug,
      name: `${install}: ${slug}`,
      installId: `install-${install}`,
      oauthStatus: "connected" as const,
      health: { ...first!.health, status: working ? ("ok" as const) : ("error" as const) },
    });
    const plugins = [
      pluginServer("notes", "notes-mcp", false),
      pluginServer("docs", "docs-read", phase !== "down"),
      pluginServer("docs", "docs-write", phase === "all"),
    ];
    await route.fulfill({ response, json: { ...body, json: [...json, ...plugins] } });
  });
  await page.route("**/rpc/capabilities/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: CapabilityInstall[] };
    const plugins = ["notes", "docs", "empty"].map(
      (name): CapabilityInstall => ({
        id: `install-${name}`,
        kind: "plugin",
        name: name.charAt(0).toUpperCase() + name.slice(1),
        source: `https://plugins.example.test/${name}`,
        version: null,
        digest: null,
        secretConfigured: false,
        config: { parts: ["connector"] },
        createdAt: new Date().toISOString(),
      }),
    );
    await route.fulfill({ response, json: { ...body, json: [...body.json, ...plugins] } });
  });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  // Of six saved servers and three plugins, only Dropbox is connected: Docs has a failing
  // server. The plugin rows show once installs have loaded, so the count is read after that.
  await page.getByRole("button", { name: /^\d+ connected$/ }).click();
  await expect(page.getByTestId("installed-plugin")).toHaveCount(3);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  // The count's logos are decorative (aria-hidden); a plugin shows one only once it counts.
  const marks = (count: string) =>
    page.getByRole("button", { name: count, exact: true }).locator("span[aria-hidden]").first();
  await expect(marks("1 connected")).toHaveText("");
  await page.getByRole("button", { name: "1 connected", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
  const servers = page.getByTestId("registered-mcp-servers");
  await expect(servers.getByText("Dropbox", { exact: true })).toBeVisible();
  await expect(servers.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(servers.getByTestId("registered-mcp-server")).toHaveCount(6);
  for (const [name, [label]] of Object.entries(states)) {
    const server = servers.getByTestId("registered-mcp-server").filter({
      has: page.getByText(name, { exact: true }),
    });
    await expect(server.getByText(label, { exact: true })).toBeVisible();
    await expect(server.getByText(name.charAt(0), { exact: true })).toBeVisible();
    await expect(server.getByRole("button")).toHaveCount(0);
    const tone =
      label === "Connected"
        ? "text-success"
        : label === "Not working"
          ? "text-destructive"
          : label === "Needs sign-in" || label === "Needs an OAuth client ID"
            ? "text-warning"
            : "text-muted-foreground";
    await expect(server.getByText(label, { exact: true }).locator("..")).toHaveClass(
      new RegExp(tone),
    );
    await expect(server.locator("svg[aria-hidden='true']")).toHaveCount(
      label === "Not connected" || label === "Disabled" ? 0 : 1,
    );
  }
  await expect(servers).not.toContainText("fake-mcp-credential");
  await captureScreenshot(page, testInfo, "integrations-direct-mcp-servers");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "integrations-direct-mcp-mobile");
  await page
    .getByTestId("connected-apps")
    .getByRole("button", { name: "Manage MCP servers", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("GitHub", { exact: true })).toBeVisible();

  // Once both of its servers are connected, Docs counts once.
  phase = "all";
  await page.getByRole("button", { name: "Close MCP servers", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByRole("button", { name: "2 connected", exact: true })).toBeVisible();
  await expect(marks("2 connected")).toHaveText("D");
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();

  // With nothing connected, the count still opens the saved apps.
  phase = "down";
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(marks("0 connected")).toHaveText("");
  await page.getByRole("button", { name: "0 connected", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
  await expect(servers.getByTestId("registered-mcp-server")).toHaveCount(6);
  await expect(
    servers.getByTestId("registered-mcp-server").filter({ hasText: "Dropbox" }),
  ).toContainText("Not working");
  await page.unrouteAll({ behavior: "wait" });
});
