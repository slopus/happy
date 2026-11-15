import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { CONNECTION_LABEL_MAX_LENGTH } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  openEmailSignIn,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

function sidebarBotButton(page: Page, name: RegExp | string) {
  return page.locator("[data-sidebar-group] [data-roster-bot-id]").filter({
    has: page.locator("[data-roster-bot-name]").filter({ hasText: name }),
  });
}

test.describe.configure({ mode: "serial" });

test("takeover, routine, plugins, and export are reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@rakazo.test`, "password12", "Flow");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/handing you the computer|sign in to continue|protected input/i).first(),
  ).toBeVisible({ timeout: realSandboxTimeout(90_000, 30_000) });
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  // The chat card has its own Skip and I'm done; these steps answer from the computer.
  const chrome = page.getByTestId("computer-chrome");
  const computerCard = page.getByTestId("computer-card");
  await expect(computerCard).toBeVisible();
  await expect(computerCard.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(computerCard.getByTestId("computer-card-open")).toBeVisible();
  await captureScreenshot(page, testInfo, "08-protected-input-request");
  await computerCard.getByTestId("computer-card-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(chrome.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
  await expect(chrome.getByRole("button", { name: "I’m done", exact: true })).toBeVisible();
  if (process.env.SANDBOX_PROVIDER === "boat") await waitForBoatFramebuffer(page);
  await captureScreenshot(page, testInfo, "09-computer-takeover-outcomes");
  await chrome.getByRole("button", { name: "I’m done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Close computer" }).click();
  await expect(page.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });

  await composer.fill("sign in again so I can skip this time");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the second protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  // Reopen the computer tab so Open sees a refreshed computer status.
  const sidePanel = page.getByTestId("side-panel");
  const pill = page.getByTestId("bot-settings-trigger");
  if ((await pill.getAttribute("aria-expanded")) === "true") {
    await pill.click();
    await expect(sidePanel).toHaveAttribute("data-panel", "closed");
  }
  await openBotPanelTab(page, "Computer");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(sidePanel).toHaveCSS("width", "384px");
  const [mainBox, panelBox] = await Promise.all([
    page.locator("main").boundingBox(),
    sidePanel.boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect((mainBox?.x ?? 0) + (mainBox?.width ?? 0)).toBeLessThanOrEqual(panelBox?.x ?? 0);
  await sidePanel.getByTestId("computer-preview").hover();
  const openComputer = sidePanel.getByTestId("computer-preview-open");
  await expect(openComputer).toBeVisible({ timeout: 30_000 });
  await openComputer.click();
  await page
    .getByTestId("computer-chrome")
    .getByRole("button", { name: "Take control", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await chrome.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Close computer" }).click();
  await expect(page.getByText(/login was skipped/i).last()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await captureScreenshot(page, testInfo, "09a-computer-takeover-skipped");

  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Monday briefing");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every day", exact: true }).click();
  const savedRoutine = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await savedRoutine;
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();
  await captureScreenshot(page, testInfo, "10-routine-created");

  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/rpc/connections/catalog", async (route) => {
    await catalogGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  const catalogSpinner = page.getByRole("status", { name: "Loading integrations…" });
  const featured = page.getByTestId("featured-connectors");
  try {
    await expect(catalogSpinner).toBeVisible();
    await expect(featured).toBeHidden();
    await expect(page.getByPlaceholder("Search apps")).toBeDisabled();
    await expect(page.getByText("Not in the plugin catalog", { exact: true })).toBeHidden();
    await captureScreenshot(page, testInfo, "11-plugins-loading");
  } finally {
    releaseCatalog();
  }
  await expect(catalogSpinner).toBeHidden();
  await expect(page.getByPlaceholder("Search apps")).toBeEnabled();
  await expect(featured).toContainText(
    /Gmail[\s\S]*Google Calendar[\s\S]*Google Drive[\s\S]*Slack[\s\S]*Notion/,
  );
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add custom", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(page.getByText("Tool sources", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "11-plugins-catalog");

  // Nearest ancestor with an Add/Added control (featured tile or catalog row).
  const gmailRow = featured
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await gmailRow.getByRole("button", { name: "Add", exact: true }).click();
  await expect(gmailRow.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-tile-gmail")).toBeVisible();
  await captureScreenshot(page, testInfo, "11a-connected-plugins");

  await gmailRow.getByRole("button", { name: "Added", exact: true }).click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("connection-accounts")).toBeVisible();
  await expect(page.getByTestId("connection-tools")).toBeVisible();

  await detail.getByRole("button", { name: "Add another", exact: true }).click();
  await expect(detail.getByLabel("Account label")).toHaveCount(2);
  const accountName = "Work account ".padEnd(CONNECTION_LABEL_MAX_LENGTH, "x");
  const accountLabel = detail.getByLabel("Account label").nth(1);
  await accountLabel.clear();
  await accountLabel.pressSequentially(`${accountName}overflow`);
  await expect(accountLabel).toHaveValue(accountName);
  const windowKeys = await page.evaluateHandle(() => {
    const keys: string[] = [];
    window.addEventListener("keydown", (event) => keys.push(event.key));
    return keys;
  });
  // These synthetic keyboard events exercise the browser event flags; they do not start an OS IME.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await accountLabel.dispatchEvent("keydown", { key: "Enter", ...composition });
    await accountLabel.dispatchEvent("keydown", { key: "Escape", ...composition });
    expect(await windowKeys.evaluate((keys) => keys.includes("Escape"))).toBe(false);
    await expect(accountLabel).toBeFocused();
  }
  const renamed = page.waitForResponse(
    (response) => response.url().includes("connections/rename") && response.ok(),
  );
  await accountLabel.press("Enter");
  await renamed;
  await expect(detail.getByLabel("Account label").nth(1)).toHaveValue(accountName);
  await captureScreenshot(page, testInfo, "11a2-multi-account-plugins");

  await page
    .getByTestId("connection-tools")
    .getByText(/tools?$/)
    .click();
  await expect(detail.getByText("Send email", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "11a3-plugin-tools");

  await page.getByRole("button", { name: "Close integrations" }).click();
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  const gmailTileAgain = page.getByTestId("connection-tile-gmail");
  await expect(gmailTileAgain.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await gmailTileAgain.click();
  const detailAgain = page.getByTestId("connection-detail");
  await expect(detailAgain.getByLabel("Account label")).toHaveCount(2);
  await expect(detailAgain.getByLabel("Account label").nth(1)).toHaveValue(accountName);

  await detailAgain.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(detailAgain.getByLabel("Account label")).toHaveCount(1);
  await detailAgain.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  const gmailRowEmpty = page
    .getByTestId("featured-connectors")
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await expect(gmailRowEmpty.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "11b-connected-plugins-empty");

  const linearRow = page
    .getByText("Linear", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  const connectPopup = page.waitForEvent("popup");
  await linearRow.getByRole("button", { name: "Add", exact: true }).click();
  const popup = await connectPopup;
  await popup.close();
  await expect(linearRow.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await linearRow.getByRole("button", { name: "Added", exact: true }).click();
  const linearDetail = page.getByTestId("connection-detail");
  await expect(linearDetail).toBeVisible();
  await linearDetail.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  await expect(linearRow.getByRole("button", { name: "Add", exact: true })).toBeVisible();

  // Custom sources live behind one menu: GitHub, then MCP → OpenAPI → GraphQL → Executor.
  await page.getByRole("button", { name: "Add custom", exact: true }).click();
  const addItems = page.getByRole("menuitem");
  await expect(addItems).toHaveText([
    "From GitHub",
    "MCP server",
    "OpenAPI",
    "GraphQL",
    "Executor",
    "Browse MCP servers",
    "Search by domain",
    "Manage MCP servers",
  ]);
  await captureScreenshot(page, testInfo, "01-graphql-advanced-order");
  await page.getByRole("menuitem", { name: "Search by domain", exact: true }).click();

  const feed = page.getByTestId("integrations-catalog-feed");
  await feed.getByRole("textbox", { name: "Integration domain" }).fill("github.com");
  await feed.getByRole("button", { name: "Search", exact: true }).click();
  await expect(feed.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "MCP Add", exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "OPENAPI Add", exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "GRAPHQL Manual", exact: true })).toBeDisabled();
  await expect(feed.getByRole("button", { name: "CLI Manual", exact: true })).toBeDisabled();
  // Editing the query must drop prior results so a stale Add cannot run for the old domain.
  await feed.getByRole("textbox", { name: "Integration domain" }).fill("gitlab.com");
  await expect(feed.getByText("GitHub", { exact: true })).toBeHidden();
  await feed.getByRole("textbox", { name: "Integration domain" }).fill("github.com");
  await feed.getByRole("button", { name: "Search", exact: true }).click();
  await expect(feed.getByText("GitHub", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "11c-catalog-feed");

  await feed.getByRole("button", { name: "MCP Add", exact: true }).click();
  const form = page.getByTestId("integrations-source-form");
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("GitHub");
  await expect(form.getByLabel("URL", { exact: true })).toHaveValue("https://mcp.example.test/mcp");
  await expect(form.getByLabel("Authentication", { exact: true })).toHaveValue("bearer");
  await form.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("integrations-catalog-feed")).toBeVisible();
  await page
    .getByTestId("integrations-catalog-feed")
    .getByRole("button", { name: "Back", exact: true })
    .click();

  const addSource = async (item: string) => {
    await page.getByRole("button", { name: "Add custom", exact: true }).click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
  };
  const toolSources = page.getByTestId("tool-sources");

  await addSource("MCP server");
  await form.getByLabel("Name", { exact: true }).fill("Browser MCP");
  await form.getByLabel("URL", { exact: true }).fill("https://mcp.example.test/mcp");
  await form.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(toolSources.getByText(/MCP\s*https:\/\/mcp\.example\.test\/mcp/)).toBeVisible();

  await addSource("OpenAPI");
  await form.getByLabel("Name", { exact: true }).fill("Browser API");
  await form.getByLabel("URL", { exact: true }).fill("https://api.example.test/openapi.json");
  await form.getByLabel("Authentication", { exact: true }).selectOption("bearer");
  await form.getByLabel("Credential", { exact: true }).fill("fake-openapi-browser-credential");
  await form.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(toolSources.getByText(/OpenAPI\s*https:\/\/api\.example\.test\/v1/)).toBeVisible();

  await addSource("Executor");
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Executor");
  await form.getByLabel("URL", { exact: true }).fill("https://executor.example.test/mcp");
  await form.getByLabel("Bearer token", { exact: true }).fill("fake-executor-browser-credential");
  await form.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(toolSources.getByText(/MCP\s*https:\/\/executor\.example\.test\/mcp/)).toBeVisible();
  await captureScreenshot(page, testInfo, "11d-provider-emulators");

  await addSource("GraphQL");
  await form.getByLabel("Name", { exact: true }).fill("Browser GraphQL");
  await form.getByLabel("URL", { exact: true }).fill("https://graphql.example.test/graphql");
  await form.getByRole("button", { name: "Verify and add", exact: true }).click();
  await expect(
    toolSources.getByText(/GraphQL\s*https:\/\/graphql\.example\.test\/graphql/),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "02-graphql-installed");

  await page.getByRole("button", { name: "Close integrations" }).click();

  await page.getByText("Chief").first().click();
  await openBotPanelTab(page, "Advanced");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/chief-export\.json/i);
  await page.getByRole("button", { name: "Close panel" }).click();

  await page.locator("aside").first().getByRole("button", { name: /Chief/ }).first().click({
    button: "right",
  });
  const botMenu = page.getByRole("menu", { name: "Actions for Chief" });
  await expect(botMenu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
  await botMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("radio", { name: /Keep memories/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Delete memories too/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await captureScreenshot(page, testInfo, "12-bot-settings");
});

test("sign-in, spawn, and stop work in the shell", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
    );
  });
  const stamp = Date.now();
  const email = `shell-${stamp}@rakazo.test`;
  await signup(page, email, "password12", "Shell");
  await completeOnboarding(page);
  await page.evaluate(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");
  await expect(sidebarBotButton(page, /Scout/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("bot-mention").filter({ hasText: "Scout" })).toBeVisible({
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "13-spawned-bot");

  await page
    .locator("[data-sidebar-group]")
    .getByRole("button", { name: /^Chief/ })
    .click();
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  const holdToTalk = page
    .getByTestId("composer-bar")
    .getByRole("button", { name: "Hold to talk", exact: true });
  await expect(holdToTalk).toBeVisible();
  await composer.fill("Use the newer report and keep the answer short.");
  await expect(holdToTalk).toHaveCount(0);
  // Stop can arrive over the live stream before the first send returns; Send stays disabled
  // until then, and Tab would skip it.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Tab");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Use the newer report and keep the answer short."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "14-active-bot-work");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await captureScreenshot(page, testInfo, "14-active-bot-work-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  let releaseStopRequest: () => void = () => undefined;
  let markStopRequestStarted: () => void = () => undefined;
  const stopRequestStarted = new Promise<void>((resolve) => {
    markStopRequestStarted = resolve;
  });
  await page.route("**/rpc/threads/stop", async (route) => {
    markStopRequestStarted();
    await new Promise<void>((release) => {
      releaseStopRequest = release;
    });
    await route.continue();
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await stopRequestStarted;
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  releaseStopRequest();
  // Idle Send stays disabled with an empty draft; wait for Stop to leave instead.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await openEmailSignIn(page);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(sidebarBotButton(page, /^Chief/)).toBeVisible();
  await expect(sidebarBotButton(page, /Scout/)).toBeVisible();
  await captureScreenshot(page, testInfo, "15-restored-session");
});

async function threadRunStatus(page: Page) {
  const result = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
    botId: activeBotId(page),
  });
  return result.run?.status ?? "idle";
}

async function waitForBoatFramebuffer(page: Page) {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const canvas = frame.locator("canvas").first();
          if ((await canvas.count()) === 0) continue;
          const ready = await canvas
            .evaluate((element) => {
              const framebuffer = element as HTMLCanvasElement;
              return framebuffer.width > 0 && framebuffer.height > 0;
            })
            .catch(() => false);
          if (ready) return true;
        }
        return false;
      },
      { timeout: 60_000, message: "the Boat noVNC framebuffer must be ready" },
    )
    .toBe(true);
}
