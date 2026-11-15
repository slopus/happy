import type { Locator, Page, Route, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signupRequiresEmailVerification } from "@rakazo/core";

export function isRealSandboxProvider(provider = process.env.SANDBOX_PROVIDER) {
  return (
    provider === "e2b" ||
    provider === "novita" ||
    provider === "daytona" ||
    provider === "boat" ||
    provider === "boxd" ||
    provider === "instabox"
  );
}

export function realSandboxTimeout(real: number, emulated: number) {
  if (process.env.SANDBOX_PROVIDER === "boat") return Math.max(real, 300_000);
  return isRealSandboxProvider() ? real : emulated;
}

export function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

export async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

export async function completeOnboarding(page: Page, testInfo?: TestInfo) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  // Optional Server integrations step (needsSetup). Skip when shown, then the
  // first bot is created automatically — land in Chief's chat with no form.
  const integrations = page.getByRole("heading", { name: "Server integrations", exact: true });
  const chief = page.getByText("Chief").first();
  await integrations.or(chief).waitFor({ timeout: 20_000 });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) {
    if (testInfo) {
      await captureScreenshot(page, testInfo, "03-create-first-bot");
      await captureScreenshot(page, testInfo, "06-onboarding-complete");
    }
    return;
  }
  if (await integrations.isVisible().catch(() => false)) {
    if (testInfo) await captureScreenshot(page, testInfo, "02-connect-apps");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByText("Chief").first()).toBeVisible();
  if (testInfo) {
    await captureScreenshot(page, testInfo, "03-create-first-bot");
    await captureScreenshot(page, testInfo, "06-onboarding-complete");
  }
}

/**
 * Creates the account through the auth API, as the sign-up form does, and opens
 * the page the form would land on. Passing testInfo goes through the form to
 * capture it; tests of the form itself use signupThroughForm.
 */
export async function signup(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  if (testInfo) return signupThroughForm(page, email, password, name, testInfo);
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("signup needs a baseURL");
  const response = await page.request.post("/api/auth/sign-up/email", {
    data: { email, password, name },
    // Better Auth checks the origin of credential requests that carry cookies.
    headers: { origin: new URL(baseURL).origin },
  });
  if (!response.ok()) throw new Error(`sign-up ${response.status()}: ${await response.text()}`);
  const verify = signupRequiresEmailVerification(await response.json());
  await page.goto(verify ? "/sign-up?verify=email" : "/onboarding");
}

/** Opens the email form when the server offers a provider chooser first. */
export async function openEmailSignIn(page: Page) {
  const email = page.getByLabel("Email", { exact: true });
  const choice = page.getByRole("button", { name: "Continue with email" });
  await expect(email.or(choice)).toBeVisible();
  if (await choice.isVisible()) await choice.click();
  await expect(email).toBeVisible();
}

export async function signupThroughForm(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await openEmailSignIn(page);
  if (testInfo) await captureScreenshot(page, testInfo, "01-sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Opens Integrations' add menu and picks one of its custom sources. */
export async function openIntegrationsAdd(page: Page, item: string) {
  const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
  await dialog.getByRole("button", { name: "Add custom", exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/**
 * Opens the bot panel from the header pill and shows one tab, leaving an open routine editor.
 * `name` is the tab's label in the UI language ("Routines", or "자동 실행" in Korean).
 */
export async function openBotPanelTab(page: Page, name: string) {
  const pill = page.getByTestId("bot-settings-trigger");
  const tab = page.getByTestId("bot-settings").getByRole("tab", { name, exact: true });
  // A reloaded page restores its saved panel a moment after it draws, so a single pass can
  // race that restore; the sequence is retried until the tab is selected.
  await expect(async () => {
    if (!(await tab.isVisible())) {
      // The pill closes whatever else the sidebar shows, such as a restored routine editor.
      if ((await pill.getAttribute("aria-expanded")) === "true") {
        await pill.click();
        await expect(pill).toHaveAttribute("aria-expanded", "false", { timeout: 2_000 });
      }
      await pill.click();
    }
    await tab.click({ timeout: 2_000 });
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Waits for fold-outs to settle before clicking or dragging their contents. */
async function waitForTransitions(element: Locator) {
  // Base UI starts a fold a frame after the toggle.
  await element.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  await expect
    .poll(() =>
      element.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation instanceof CSSTransition).length,
      ),
    )
    .toBe(0);
}

export async function waitForSidebarTransitions(page: Page) {
  await waitForTransitions(page.locator("aside").first());
}

/**
 * A card inside the fit-content bubble frame fills its fixed width and shrinks only to the
 * frame's cap. A percentage width would resolve against the card's own content instead.
 */
export async function expectCardWidth(card: Locator, width: number) {
  const measured = await card.evaluate((element) => ({
    card: element.getBoundingClientRect().width,
    frame:
      element.closest('[data-testid="message-bubble-frame"]')?.getBoundingClientRect().width ??
      Number.NaN,
  }));
  expect(Math.abs(measured.card - Math.min(width, measured.frame))).toBeLessThan(1);
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

export async function openNewBot(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-bot").click();
  await expect(page.getByTestId("create-bot-dialog")).toBeVisible();
}

export async function openNewGroup(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-group").click();
}

export async function openNewSpace(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-space").click();
}

export async function createBotFromPicker(
  page: Page,
  { name = "New Bot" }: { name?: string } = {},
) {
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByPlaceholder("Name your Bot").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
}

export async function openUserSettings(
  page: Page,
  section?:
    | "general"
    | "models"
    | "memory"
    | "voice"
    | "vault"
    | "wallet"
    | "usage"
    | "computer"
    | "billing"
    | "organization"
    | "updates",
) {
  // A reload keeps settings open because the URL holds them; closing clears the URL at once.
  if (!new URL(page.url()).searchParams.has("settings")) {
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  if (section && section !== "general") {
    await settings.getByTestId(`settings-nav-${section}`).click();
  }
  return settings;
}

/** The connection page for a provider, titled "Connect X" until it is connected and "X" after. */
export function modelConnectionDialog(page: Page, provider: string) {
  const name = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .getByTestId("model-connection")
    .filter({ has: page.getByRole("heading", { name: new RegExp(`^(Connect )?${name}$`) }) });
}

/** A picker option that connects a provider, listed after the connected models with a "Connect" shortcut. */
export function modelConnectOption(page: Page, provider: string) {
  return page
    .locator('[role="option"][data-value^="connect:"]')
    .filter({ has: page.getByText(provider, { exact: true }) });
}

/**
 * Opens a model list's picker on the Models settings page and chooses a provider that still
 * needs connecting. The "main" slot is the list's first row, so connecting there sets the
 * role's primary model; "fallback" appends through "Add fallback".
 */
export async function openModelConnection(
  page: Page,
  provider: string,
  {
    slot = "main",
    role = "main",
    search = provider,
  }: { slot?: "main" | "fallback"; role?: "main" | "approval"; search?: string } = {},
) {
  const section = page.getByTestId(`model-role-${role}`);
  await (slot === "main"
    ? section.getByRole("button", { name: /^Change / }).first()
    : section.getByRole("button", { name: "Add fallback", exact: true })
  ).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(search);
  await modelConnectOption(page, provider).click();
  const dialog = modelConnectionDialog(page, provider);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * After a connection the slot's picker reopens on that provider's models. Picks `model`
 * there, or closes the picker when the test keeps whatever the connection placed.
 */
export async function pickReopenedModel(page: Page, model?: string) {
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeVisible();
  if (model === undefined) await search.press("Escape");
  else
    await page
      .getByRole("listbox", { name: "Model options" })
      .getByRole("option", { name: model, exact: true })
      .first()
      .click();
  await expect(search).toBeHidden();
}

export async function manageModelConnection(
  page: Page,
  provider: string,
  { role = "main", row = 1 }: { role?: "main" | "approval"; row?: number } = {},
) {
  await page
    .getByTestId(`model-role-${role}`)
    .getByTestId(`model-role-row-${row}`)
    .getByRole("button", { name: / options$/ })
    .click();
  await page.getByRole("menuitem", { name: `Manage ${provider}`, exact: true }).click();
  const dialog = modelConnectionDialog(page, provider);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function createNamedBot(
  page: Page,
  name: string,
  options: { computerMode?: "team" | "dedicated" } = {},
) {
  const bot = await rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: options.computerMode ?? "team",
  });
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return bot.id;
}

/**
 * Picks an option from one of the kit's dropdowns. They open a menu of options rather than a
 * native select, so selectOption() does not apply; options are matched by their visible name.
 */
export async function chooseOption(trigger: Locator, option: string | { index: number }) {
  await trigger.click();
  const options = trigger.page().getByRole("option");
  await (typeof option === "string"
    ? trigger.page().getByRole("option", { name: option, exact: true })
    : options.nth(option.index)
  ).click();
}

/**
 * Clicks a button and waits for the RPC it sends to succeed, so what the test reads next
 * reflects it. The wait starts before the click, so a fast reply is never missed.
 */
export async function clickAndWaitForRpc(page: Page, button: Locator, path: string) {
  const [reply] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/rpc/${path}` &&
        response.request().method() === "POST",
    ),
    button.click(),
  ]);
  expect(reply.status()).toBe(200);
  // The whole reply has arrived, not just its headers.
  const failure = await reply.finished();
  if (failure) throw new Error(`/rpc/${path} reply did not finish: ${failure.message}`);
}

/** Presents a deployment default the offline E2E server cannot run, as host credentials would. */
export async function presentMainDeploymentDefault(page: Page, provider: string, modelId: string) {
  await page.route("**/rpc/models/role", async (route) => {
    const { json } = route.request().postDataJSON() as { json: { role: string } };
    if (json.role !== "main") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    body.json.deploymentPrimary = { provider, modelId };
    await route.fulfill({ response, json: body });
  });
}

export async function makeAdmin(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) me.isAdmin = true;
  await route.fulfill({ response, json: body });
}
