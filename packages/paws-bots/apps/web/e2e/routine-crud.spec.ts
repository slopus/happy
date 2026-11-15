import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, Routine } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

async function addScheduleTrigger(page: Page, freq: string) {
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: freq, exact: true }).click();
}

test("a delayed schedule is visible only while the routine is active", async ({
  page,
}, testInfo) => {
  await signup(page, `routine-delay-${Date.now()}@rakazo.test`, "password12", "Routine delay");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Morning report",
    prompt: "Prepare the report.",
    crons: ["0 8 * * *"],
    timezone: "UTC",
    active: false,
  });
  let scheduleDelayed = true;
  await page.route("**/rpc/routines/list", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.json = body.json.map((item: Routine) =>
      item.id === routine.id ? { ...item, active: true, scheduleDelayed } : item,
    );
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: /Morning report/ }).click();
  const delay = page.getByRole("status").filter({ hasText: "Schedule delayed" });
  await expect(delay).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-schedule-delayed");
  const name = page.locator("label:has-text('Name') input");
  await name.fill("Unsaved report name");
  scheduleDelayed = false;
  await expect(delay).toHaveCount(0, { timeout: 35_000 });
  await expect(name).toHaveValue("Unsaved report name");
  scheduleDelayed = true;
  await expect(delay).toBeVisible({ timeout: 35_000 });
  await expect(name).toHaveValue("Unsaved report name");
  await page.getByRole("switch", { name: "Active", exact: true }).click();
  await expect(delay).toHaveCount(0);
});

async function saveAndReturn(page: Page, procedure: "routines/create" | "routines/update") {
  const saved = page.waitForResponse(
    (response) => response.url().includes(`/rpc/${procedure}`) && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const response = await saved;
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  return response.request().postDataJSON().json;
}

test("routine editing updates in place, preserves timezone, deletion persists, and model choice saves", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-crud-${stamp}@rakazo.test`, "password12", "Routine CRUD");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const created = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Tokyo check-in",
    prompt: "Send the original update",
    crons: ["0 9 * * *"],
    timezone: "Asia/Tokyo",
    active: true,
    notify: true,
  });
  expect(created.nextRunAt).not.toBeNull();
  expect(localSchedule(created.nextRunAt!, created.timezone)).toMatchObject({ hour: 9, minute: 0 });
  await page.reload();
  await openBotPanelTab(page, "Routines");

  await page.getByRole("button", { name: /Tokyo check-in/ }).click();
  await page.locator("label:has-text('Name') input").fill("Weekday check-in");
  await page.locator("label:has-text('Instruction') textarea").fill("Send the revised update");
  await page.getByLabel("How often").selectOption("Weekdays");
  const patch = await saveAndReturn(page, "routines/update");
  for (const column of ["modelProvider", "modelId", "thinkingLevel"])
    expect(patch).not.toHaveProperty(column);

  const updatedButton = page.getByRole("button", { name: /Weekday check-in/ });
  await expect(updatedButton).toHaveCount(1);
  await expect(updatedButton).toContainText("Weekdays at 9:00 AM");
  await expect(page.getByRole("button", { name: /Tokyo check-in/ })).toHaveCount(0);

  const [updated] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(updated).toMatchObject({
    name: "Weekday check-in",
    prompt: "Send the revised update",
    crons: ["0 9 * * 1-5"],
    timezone: "Asia/Tokyo",
  });
  expect(updated?.nextRunAt).not.toBeNull();
  expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(
    localSchedule(updated!.nextRunAt!, updated!.timezone).weekday,
  );
  await captureScreenshot(page, testInfo, "routine-weekday-schedule");

  await updatedButton.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Weekday check-in?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Weekday check-in");

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const removeResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/remove") && response.ok(),
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await removeResponse;
  await expect(updatedButton).toHaveCount(0);
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);

  // A routine runs on the bot's model until another is picked.
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Model check");
  await page.locator("label:has-text('Instruction') textarea").fill("Check the inbox");
  await addScheduleTrigger(page, "Every day");

  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const modelSelect = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(modelSelect).toHaveValue("");
  await expect(modelSelect).toContainText("Bot's model");
  await captureScreenshot(page, testInfo, "routine-model-picker");

  await page.keyboard.press("Escape");
  expect(await saveAndReturn(page, "routines/create")).toMatchObject({
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
  });
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines.find((routine) => routine.name === "Model check")).toMatchObject({
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
  });
  await rpc(page, "models/connect", {
    provider: "openai-compatible",
    apiKey: "fake-routine-model-key",
    modelId: "llama-3.3-70b",
    baseUrl: "http://127.0.0.1:8090/v1",
    thinkingLevel: "low",
    reasoning: true,
  });
  await page.getByRole("button", { name: /Model check/ }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await modelSelect.selectOption("openai-compatible::llama-3.3-70b");
  await page.keyboard.press("Escape");
  expect(await saveAndReturn(page, "routines/update")).toMatchObject({
    modelProvider: "openai-compatible",
    modelId: "llama-3.3-70b",
    thinkingLevel: null,
  });
  await expect(page.getByRole("button", { name: /Model check/ })).toContainText("llama-3.3-70b");

  await page.getByRole("button", { name: /Model check/ }).click();
  await page.locator("label:has-text('Name') input").fill("Renamed model check");
  const renamePatch = await saveAndReturn(page, "routines/update");
  for (const column of ["modelProvider", "modelId", "thinkingLevel"])
    expect(renamePatch).not.toHaveProperty(column);

  await page.reload();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  expect((await rpc<Routine[]>(page, "routines/list", { botId })).map((r) => r.name)).toEqual([
    "Renamed model check",
  ]);
  await expect(updatedButton).toHaveCount(0);
});

test("an email trigger claims the bot's address and saves who can start it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-email-${stamp}@rakazo.test`, "password12", "Routine Email");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openBotPanelTab(page, "Routines");

  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Inbox triage");
  await page.locator("label:has-text('Instruction') textarea").fill("Summarize what I forward.");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Email" }).click();

  const name = page.getByRole("textbox", { name: "Email address" });
  await expect(name).not.toHaveValue("");
  await name.fill("postmaster");
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByRole("alert")).toHaveText("That address isn't available");
  await name.fill(`triage-${stamp}`);
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByText(`triage-${stamp}@bots.rakazo.test`)).toBeVisible();
  await page.getByRole("combobox", { name: "Who can start it" }).selectOption("domain");
  await captureScreenshot(page, testInfo, "routine-email-trigger");

  expect(await saveAndReturn(page, "routines/create")).toMatchObject({ emailSenders: "domain" });
  await expect(page.getByRole("button", { name: /Inbox triage/ })).toContainText("Email");
  const [saved] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(saved).toMatchObject({ name: "Inbox triage", crons: [], emailSenders: "domain" });
  expect(await rpc(page, "bots/emailAddress", { botId })).toEqual({
    domain: "bots.rakazo.test",
    address: `triage-${stamp}@bots.rakazo.test`,
  });
});

test("a successful routine create is not reported as failed when refresh fails", {
  tag: "@nightly",
}, async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `routine-refresh-${stamp}@rakazo.test`, "password12", "Routine Refresh");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Persisted routine");
  await page.locator("label:has-text('Instruction') textarea").fill("Run once each morning");
  await addScheduleTrigger(page, "Every day");

  await page.route(
    "**/rpc/routines/list",
    (route) => route.fulfill({ status: 500, body: "refresh failed" }),
    { times: 1 },
  );
  const createResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  const failedRefresh = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/list") && response.status() === 500,
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await createResponse;
  await failedRefresh;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.unroute("**/rpc/routines/list");
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines).toHaveLength(1);
  expect(routines[0]?.name).toBe("Persisted routine");
});

test("switching bots while a routine save is pending does not reopen stale state", {
  tag: "@nightly",
}, async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `routine-switch-${stamp}@rakazo.test`, "password12", "Routine Switch");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const secondBot = await rpc<Bot>(page, "bots/create", {
    name: "Second",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await Promise.all([
    rpc<Routine>(page, "routines/create", {
      botId: firstBotId,
      name: "First routine",
      prompt: "First prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
    rpc<Routine>(page, "routines/create", {
      botId: secondBot.id,
      name: "Second routine",
      prompt: "Second prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
  ]);
  await page.reload();

  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: /First routine/ }).click();
  await page.locator("label:has-text('Name') input").fill("First routine updated");

  let releaseUpdate!: () => void;
  let sawUpdate!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const updateIntercepted = new Promise<void>((resolve) => {
    sawUpdate = resolve;
  });
  await page.route(
    "**/rpc/routines/update",
    async (route) => {
      sawUpdate();
      await updateReleased;
      await route.fulfill({ status: 500, body: "save failed" });
    },
    { times: 1 },
  );
  const updateResponse = page.waitForResponse((response) =>
    response.url().includes("/rpc/routines/update"),
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await updateIntercepted;
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Second/ })
    .click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  releaseUpdate();
  await updateResponse;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await openBotPanelTab(page, "Routines");
  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);

  let releaseStaleList!: () => void;
  let sawStaleList!: () => void;
  const staleListReleased = new Promise<void>((resolve) => {
    releaseStaleList = resolve;
  });
  const staleListIntercepted = new Promise<void>((resolve) => {
    sawStaleList = resolve;
  });
  await page.route("**/rpc/routines/list", async (route) => {
    if (route.request().postData()?.includes(firstBotId) !== true) {
      await route.continue();
      return;
    }
    sawStaleList();
    await staleListReleased;
    await route.continue();
  });
  const staleListResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/routines/list") &&
      response.request().postData()?.includes(firstBotId) === true,
  );

  const botList = page.locator("aside").first();
  await botList.getByRole("button", { name: /^Chief/ }).click();
  await staleListIntercepted;
  await botList.getByRole("button", { name: /^Second/ }).click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  releaseStaleList();
  await staleListResponse;
  await page.unroute("**/rpc/routines/list");

  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);
});

function localSchedule(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: value("weekday"),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
  };
}

test("change-trigger screenshot walkthrough", { tag: "@nightly" }, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "light" });
  const stamp = Date.now();
  await signup(page, `routine-walkthrough-${stamp}@rakazo.test`, "password12", "Routine Watch");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openBotPanelTab(page, "Routines");
  await expect(page.getByRole("button", { name: "Create Routine" })).toBeVisible();
  await expect(page.getByText(/Booting up .* computer/)).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "routine-watch-01-routines-list");
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Inbox watch");
  await page.locator("label:has-text('Instruction') textarea").fill("Summarize what arrived");
  await addScheduleTrigger(page, "Every day");
  await expect(page.getByLabel("How often")).toHaveValue("Every day");
  await captureScreenshot(page, testInfo, "routine-watch-02-editor-scheduled");

  await page.getByRole("button", { name: "Add trigger" }).click();
  const watchOption = page.getByRole("menuitem", { name: "When something changes" });
  await expect(watchOption).toBeDisabled();
  await captureScreenshot(page, testInfo, "routine-watch-03-add-trigger-menu");
  await page.keyboard.press("Escape");
  await expect(watchOption).toBeHidden();
  await page.getByRole("button", { name: "Remove schedule", exact: true }).click();
  await page.getByRole("button", { name: "Add trigger" }).click();
  await expect(watchOption).toBeVisible();
  await expect(watchOption).toBeEnabled();
  await captureScreenshot(page, testInfo, "routine-watch-03-add-trigger-menu-enabled");
  await watchOption.click();

  const card = page.getByTestId("routine-watch-card");
  const kind = card.getByRole("combobox", { name: "What to watch" });
  await expect(kind).toHaveValue("files");
  await expect(card.getByRole("spinbutton", { name: "Check every" })).toHaveValue("15");
  await expect(card.getByRole("textbox", { name: "Files or folders, one per line" })).toBeEmpty();
  await captureScreenshot(page, testInfo, "routine-watch-04-empty-card");
  // Native select popups are not captured by page screenshots; show each selected kind below.
  await expect(kind).toHaveJSProperty("tagName", "SELECT");
  await card
    .getByRole("textbox", { name: "Files or folders, one per line" })
    .fill("inbox/\nreports/latest.csv");
  await captureScreenshot(page, testInfo, "routine-watch-06-files");

  await kind.selectOption("command");
  await card
    .getByRole("textbox", { name: "Command", exact: true })
    .fill("curl -s https://example.com/status.json");
  await card
    .getByRole("textbox", { name: "Fields to compare (optional)" })
    .fill("status, updatedAt");
  await captureScreenshot(page, testInfo, "routine-watch-07-command");

  await kind.selectOption("tool");
  await card.getByRole("textbox", { name: "Tool name", exact: true }).fill("brain_changed");
  await card.getByRole("textbox", { name: "Tool arguments (JSON)" }).fill('{"path":"reports/"}');
  await card
    .getByRole("textbox", { name: "Fields to compare (optional)" })
    .fill("id, modifiedTime");
  await captureScreenshot(page, testInfo, "routine-watch-08-tool");

  await card.getByRole("textbox", { name: "Tool name", exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Pick a tool to check");
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);
  await page.getByRole("alert").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "routine-watch-09-validation");

  await kind.selectOption("files");
  const interval = card.getByRole("spinbutton", { name: "Check every" });
  await expect(interval).toHaveAttribute("min", "5");
  await interval.fill("");
  await interval.pressSequentially("10");
  await expect(interval).toHaveValue("10");
  // A watch replaces schedules, so the schedule menu is unavailable while one exists.
  await page.getByRole("button", { name: "Add trigger" }).click();
  await expect(page.getByRole("menuitem", { name: "On a schedule" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "routine-watch-trigger");

  expect(await saveAndReturn(page, "routines/create")).toMatchObject({
    crons: [],
    watch: {
      kind: "files",
      paths: ["inbox/", "reports/latest.csv"],
      everyMinutes: 10,
      loud: false,
    },
  });
  await expect(page.getByRole("button", { name: /Inbox watch/ })).toContainText(
    "When something changes",
  );
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines.find((routine) => routine.name === "Inbox watch")?.watch).toMatchObject({
    kind: "files",
    paths: ["inbox/", "reports/latest.csv"],
  });
  await captureScreenshot(page, testInfo, "routine-watch-10-saved-list");
});

test("an HTTPS change trigger saves and reopens", async ({ page }, testInfo) => {
  await signup(page, `http-watch-${Date.now()}@rakazo.test`, "password12", "Routine Watch");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openBotPanelTab(page, "Routines");
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Status watch");
  await page.locator("label:has-text('Instruction') textarea").fill("Report what changed.");
  // Keep this saved watch inactive: no real endpoint is contacted by the offline UI test.
  await page.getByRole("switch", { name: "Active", exact: true }).click();
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "When something changes" }).click();
  const card = page.getByTestId("routine-watch-card");
  await card.getByRole("combobox", { name: "What to watch" }).selectOption("http");
  await card.getByRole("textbox", { name: "HTTPS URL" }).fill("https://example.com/status");
  await card.getByRole("spinbutton", { name: "Check every" }).fill("5");
  const fields = card.getByRole("textbox", { name: "Fields to compare (optional)" });
  await expect(fields).toBeVisible();
  const selectorBox = await card.getByRole("combobox", { name: "What to watch" }).boundingBox();
  const urlBox = await card.getByRole("textbox", { name: "HTTPS URL" }).boundingBox();
  expect(selectorBox?.width).toBe(urlBox?.width);
  expect(selectorBox?.height).toBe(urlBox?.height);
  await captureScreenshot(page, testInfo, "routine-http-watch");
  await fields.fill("id, modifiedTime");
  await card.getByRole("switch", { name: "Report unchanged checks" }).click();
  const help = card.getByRole("button", { name: "About Report unchanged checks" });
  await help.hover();
  const explanation = page
    .getByText("Post a chat message when a check finds no changes. The routine won't run.", {
      exact: true,
    })
    .last();
  await expect(explanation).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-http-watch-help");
  await page.keyboard.press("Escape");
  expect(await saveAndReturn(page, "routines/create")).toMatchObject({
    active: false,
    crons: [],
    watch: {
      kind: "http",
      url: "https://example.com/status",
      everyMinutes: 5,
      track: ["id", "modifiedTime"],
      loud: true,
    },
  });
  const [saved] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(saved?.watch).toMatchObject({ kind: "http", url: "https://example.com/status" });
  await page.getByRole("button", { name: /Status watch/ }).click();
  await expect(card.getByRole("combobox", { name: "What to watch" })).toHaveValue("http");
  await expect(card.getByRole("textbox", { name: "HTTPS URL" })).toHaveValue(
    "https://example.com/status",
  );
  await expect(fields).toBeVisible();
  await expect(fields).toHaveValue("id, modifiedTime");
  await expect(card.getByRole("switch", { name: "Report unchanged checks" })).toBeChecked();
});
