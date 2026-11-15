import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, signup } from "./helpers";

const credentialsTemplate = `{
  "installed": {
    "client_id": "{{oauth.client_id}}",
    "client_secret": "{{oauth.client_secret}}"
  }
}`;

// Only admins add stdio servers; the create below is stubbed, so the account only needs to read as one.
async function asAdmin(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) Object.assign(me, { isAdmin: true, mcpStdioEnabled: true });
  await route.fulfill({ response, json: body });
}

test("adds a stdio MCP server with encrypted environment variables", async ({ page }, testInfo) => {
  await page.context().route("**/rpc/me", (route) => asAdmin(route, "me"));
  await page.context().route("**/rpc/bootstrap", (route) => asAdmin(route, "bootstrap"));
  const stamp = Date.now();
  await signup(page, `mcp-stdio-${stamp}@rakazo.test`, "password12", "MCP stdio");
  await completeOnboarding(page);

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
      transport: "stdio",
      command: "npx",
      args: ["-y", "invoices-mcp@1.0.0"],
      env: {
        INVOICES_API_ID: "id-value",
        INVOICES_API_SECRET: "secret-value",
        GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}",
      },
      files: { GOOGLE_OAUTH_CREDENTIALS: credentialsTemplate },
      oauthClient: {
        clientId: "google-client",
        clientSecret: "google-secret",
        authorizationServer: "https://accounts.google.com",
        scope: "openid email",
        authorizationParams: "access_type=offline&prompt=consent",
      },
    });
    expect(json.env).not.toHaveProperty("GOOGLE_OAUTH_CREDENTIALS");
    const created: McpServer = {
      id: "mcp-stdio-server",
      spaceId: "mcp-stdio-workspace",
      slug: "invoices",
      name: "Invoices",
      description: "",
      transport: "stdio",
      endpoint: null,
      command: "npx",
      hasArgs: true,
      envKeys: ["INVOICES_API_ID", "INVOICES_API_SECRET", "GOOGLE_ACCESS_TOKEN"],
      fileKeys: ["GOOGLE_OAUTH_CREDENTIALS"],
      headerKeys: [],
      hasSecret: true,
      oauthStatus: "none",
      oauthClientId: "google-client",
      health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
      enabled: true,
      verbatimResults: false,
      revision: 1,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    servers.push(created);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: created }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");

  await page.getByLabel("Server name").fill("Invoices");
  await page.getByRole("tab", { name: "STDIO", exact: true }).click();
  await page.getByLabel("Command").fill("npx");
  await page.getByLabel("Arguments").fill("-y invoices-mcp@1.0.0");
  await page.getByText("Advanced", { exact: true }).click();

  const names = page.getByRole("textbox", { name: "Name", exact: true });
  const values = page.getByLabel("Value", { exact: true });
  await names.nth(0).fill("123-key");
  await expect(names.nth(0)).toHaveValue("_123_KEY");
  await names.nth(0).fill("invoices-api-id");
  await expect(names.nth(0)).toHaveValue("INVOICES_API_ID");
  await values.nth(0).fill("id-value");
  await expect(values.nth(0)).toHaveAttribute("type", "password");
  await expect(values.nth(0)).toHaveAttribute("autocomplete", "new-password");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(1).fill("invoices-api-id");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeDisabled();
  await names.nth(1).fill("1password-token");
  await expect(names.nth(1)).toHaveValue("_1PASSWORD_TOKEN");
  await names.nth(1).fill("INVOICES_API_SECRET");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(0);
  await values.nth(1).fill("secret-value");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(2).fill("invoices-api-id");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeDisabled();
  expect(servers).toHaveLength(0);
  await page.getByRole("button", { name: "Remove", exact: true }).nth(2).click();
  await expect(names).toHaveCount(2);
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(0);

  // The OAuth client is host-managed: the grant reaches the process through a visible reference.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(2).fill("GOOGLE_ACCESS_TOKEN");
  await values.nth(2).fill("{{oauth.access_token}}");
  await expect(values.nth(2)).toHaveAttribute("type", "text");
  await expect(values.nth(0)).toHaveAttribute("type", "password");
  // A file row hands the process a path to a file holding the template (visible, multi-line).
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(3).fill("GOOGLE_ACCESS_TOKEN");
  await page.getByRole("button", { name: "File", exact: true }).nth(3).click();
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "mcp-stdio-duplicate-names");
  await names.nth(3).fill("GOOGLE_OAUTH_CREDENTIALS");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(0);
  await expect(values.nth(3)).toHaveJSProperty("tagName", "TEXTAREA");
  await values.nth(3).fill(credentialsTemplate);
  await expect(values.nth(3)).toHaveAttribute("autocomplete", "off");
  await expect(values.nth(3)).toHaveAttribute("spellcheck", "false");
  await expect(page.getByRole("button", { name: "File", exact: true }).nth(3)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "File", exact: true }).nth(0)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByLabel("Redirect URI")).toHaveCount(0);
  await page.getByLabel("OAuth client ID (optional)").fill("google-client");
  await page.getByLabel("OAuth client secret (optional)").fill("google-secret");
  await page.getByLabel("Authorization server").fill("https://accounts.google.com");
  await page.getByLabel("Scopes (optional)").fill("openid email");
  await page
    .getByLabel("Authorization parameters (optional)")
    .fill("access_type=offline&prompt=consent");
  await expect(page.getByLabel("Redirect URI")).toHaveValue(/\/mcp\/oauth\/callback$/);
  await expect(page.getByText("Use {{oauth.access_token}} for the access token.")).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-stdio-env-form");

  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(page.getByText("Invoices", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect OAuth", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const advanced = page.getByRole("button", { name: "Advanced", exact: true });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(names).toHaveCount(1);
  await expect(names.nth(0)).toHaveValue("");
  await expect(values.nth(0)).toHaveValue("");
  await expect(values.nth(0)).toHaveJSProperty("tagName", "INPUT");
  await expect(page.getByLabel("OAuth client ID (optional)")).toHaveValue("");
  await expect(page.getByLabel("Authorization server")).toHaveCount(0);
});
