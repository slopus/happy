import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  openBotPanelTab,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

test("bot creation, editing, and deletion persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  // Installed before the shell starts its roster poll, so the focus check below can hold it.
  await page.clock.install();
  await signup(page, `bot-crud-${stamp}@rakazo.test`, "password12", "Bot CRUD");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botList = page.locator("aside").first();
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();

  let createFailed = false;
  let resolveCreateAborted!: () => void;
  const createAborted = new Promise<void>((resolve) => {
    resolveCreateAborted = resolve;
  });
  await page.route("**/rpc/bots/create", async (route) => {
    createFailed = true;
    await route.abort("failed");
    resolveCreateAborted();
  });
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByPlaceholder("Name your Bot").fill("New Bot");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await createAborted;
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("create-bot-error")).toBeVisible();
  expect(createFailed).toBe(true);
  await page.unroute("**/rpc/bots/create");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  let failedPostCreateRefresh = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (failedPostCreateRefresh) {
      await route.fallback();
      return;
    }
    failedPostCreateRefresh = true;
    await route.abort("failed");
  });
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect.poll(() => failedPostCreateRefresh).toBe(true);
  await page.unroute("**/rpc/spaces/list");
  await expect(botList.getByRole("button", { name: /^New Bot/ })).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  const deletedBotPath = new URL(page.url()).pathname;
  // A focus refresh that no longer knows the current bot redirects away from it; wait for
  // that refresh's roster response, not a fixed delay an overloaded runner can beat. The
  // request wait is armed before the event, so an in-flight overlapping poll cannot match
  // it, and only the response of the matched request releases the wait. That response can
  // arrive before `runFor` returns, so it is read from the request, which also returns one
  // already received. The paused clock fires every pending timer now, so the 3 s poll is not
  // due while the 50 ms focus debounce runs. The poll it fires schedules that same debounce,
  // so its read is run and settled first; the page counts roster reads itself, so a read
  // started inside `runFor` is counted when it returns. A fixed date makes the pause target
  // the clock's current time, so a stalled runner cannot overshoot it.
  await page.evaluate(() => {
    const counted = window as typeof window & { rosterReads?: number };
    counted.rosterReads = 0;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/rpc/spaces/list")) return original(input, init);
      counted.rosterReads = (counted.rosterReads ?? 0) + 1;
      try {
        const response = await original(input, init);
        await response
          .clone()
          .arrayBuffer()
          .catch(() => undefined);
        return response;
      } finally {
        counted.rosterReads = (counted.rosterReads ?? 1) - 1;
      }
    };
  });
  const pausedAt = Date.now();
  await page.clock.setFixedTime(pausedAt);
  await page.clock.pauseAt(pausedAt);
  await page.clock.setSystemTime(pausedAt);
  await page.clock.fastForward(3_000);
  await page.clock.runFor(50);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { rosterReads?: number }).rosterReads),
    )
    .toBe(0);
  const nextListRequest = page.waitForRequest((request) =>
    request.url().includes("/rpc/spaces/list"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.runFor(50);
  const focusResponse = await (await nextListRequest).response();
  expect(focusResponse).not.toBeNull();
  expect(focusResponse?.ok()).toBe(true);
  // The response resolves on headers; the roster applies only once the body has arrived.
  expect(await focusResponse?.finished()).toBeNull();
  await page.clock.resume();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(new URL(page.url()).pathname).toBe(deletedBotPath);
  await captureScreenshot(page, testInfo, "27-created-bot");

  await openBotPanelTab(page, "Advanced");
  await expect(page.getByRole("button", { name: "Edit name", exact: true })).toBeVisible();
  async function editName(value: string) {
    await page.getByRole("button", { name: "Edit name", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Name", exact: true });
    await input.fill(value);
    await input.press("Enter");
  }
  const descriptionInput = page.getByRole("textbox", {
    name: "How other bots see it",
    exact: true,
  });
  await editName("Researcher");
  await descriptionInput.fill("Finds reliable sources and turns them into concise briefs.");
  await page.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();
  await studio.getByRole("button", { name: "Color #FFAF38" }).click();
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await expect(studio).toBeHidden();
  await expect(botList.getByRole("button", { name: /^Researcher/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Researcher")).toBeVisible();

  await page.getByRole("button", { name: "Close panel" }).click();
  await openBotPanelTab(page, "Advanced");
  await expect(page.getByRole("button", { name: "Edit name", exact: true })).toHaveText(
    "Researcher",
  );
  await expect(descriptionInput).toHaveValue(
    "Finds reliable sources and turns them into concise briefs.",
  );
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("avatar-studio-trigger").click();
  await expect(studio).toBeVisible();
  await expect(studio.getByRole("button", { name: "Color #FFAF38" })).toHaveClass(/ring-2/);
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  const modelSelect = settings.getByRole("combobox", { name: "Model", exact: true });
  const teamComputer = settings.getByRole("button", { name: "Team" });
  const openWork = settings.getByTestId("bot-scratchpad");
  const notificationsHeading = settings.getByRole("heading", {
    name: "Notifications",
    exact: true,
  });
  await openBotPanelTab(page, "Computer");
  await expect(notificationsHeading).toHaveCount(0);
  await expect(modelSelect).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
  await openBotPanelTab(page, "Advanced");
  await expect(notificationsHeading).toBeVisible();
  await expect(
    settings.getByRole("switch", { name: "When it finishes or needs input", exact: true }),
  ).toBeVisible();
  await expect(openWork).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  await expect(settings.locator('label[for$="-model"]')).toHaveClass("sr-only");
  await expect(modelSelect).toBeVisible();
  const dailyCheckIns = settings.getByRole("switch", {
    name: "Daily check-ins on unfinished work",
    exact: true,
  });
  await dailyCheckIns.scrollIntoViewIfNeeded();
  await expect(dailyCheckIns).toBeChecked();
  await captureScreenshot(page, testInfo, "bot-settings-daily-check-ins");
  await captureScreenshot(page, testInfo, "bot-settings-sections-advanced");
  await rpc(page, "scratchpad/create", {
    botId: deletedBotPath.split("/").at(-1),
    title: "First fixture task",
  });
  await page.getByRole("button", { name: "Close panel" }).click();
  await openBotPanelTab(page, "Advanced");
  await expect(openWork.getByText("First fixture task", { exact: true })).toBeVisible();
  await openWork.getByRole("button", { name: "Add open work" }).click();
  await openWork.getByRole("textbox", { name: "New open-work item" }).fill("Second fixture task");
  await openWork.getByRole("button", { name: "Add", exact: true }).click();
  const workRows = openWork.locator(".group");
  await expect(workRows).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await workRows.first().hover();
    await workRows.first().getByRole("button", { name: "Remove" }).click();
  }
  await expect(openWork).toHaveCount(0);
  const disabledTools = settings.getByLabel("Disable a tool");
  await expect(disabledTools).toBeVisible();
  await disabledTools.selectOption("web_search");
  await expect(settings.getByRole("button", { name: "Enable Web search" })).toBeVisible();
  await captureScreenshot(page, testInfo, "27c-disabled-builtin-tools");
  await expect(teamComputer).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Read replies aloud" })).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Manage other bots" })).toBeVisible();
  const replyMode = settings.getByRole("combobox", { name: "Replies", exact: true });
  await replyMode.scrollIntoViewIfNeeded();
  await expect(replyMode).toHaveValue("chat");
  await replyMode.selectOption("messages");
  await expect(replyMode).toHaveValue("messages");
  await captureScreenshot(page, testInfo, "27d-bot-settings-reply-mode");
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toContainText("Space default");
  await captureScreenshot(page, testInfo, "27a-bot-settings-model");
  await openBotPanelTab(page, "Computer");
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  // Overlay may flash during boot or never appear (already ready/asleep/stopped). Assert panel
  // chrome, then wait until any overlay has cleared — avoid Locator.or() strict-mode multi-hits.
  const bootOverlay = page.getByText(/Booting up .* computer/);
  await expect(sidePanel.getByTestId("computer-preview")).toBeVisible();
  await expect(bootOverlay).toBeHidden();
  await expect(sidePanel.getByText("Teach a task")).toHaveCount(0);
  await expect(sidePanel.getByTestId("teach-start-button")).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "27b-computer-panel");

  await editName("Atlas");
  await openBotPanelTab(page, "Advanced");
  await descriptionInput.fill("Builds durable, source-backed research briefs.");
  await descriptionInput.blur();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await captureScreenshot(page, testInfo, "28-edited-bot-profile");

  await page.reload();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await openBotPanelTab(page, "Advanced");
  await expect(page.getByRole("button", { name: "Edit name", exact: true })).toHaveText("Atlas");
  await expect(descriptionInput).toHaveValue("Builds durable, source-backed research briefs.");
  await captureScreenshot(page, testInfo, "29-reloaded-bot-profile");

  // Long instructions scroll inside their box instead of stretching the narrow panel.
  const instructionsInput = settings.getByRole("textbox", { name: "Instructions", exact: true });
  await instructionsInput.fill(
    Array.from(
      { length: 80 },
      (_, index) => `${index + 1}. Cite a primary source for every claim.`,
    ).join("\n"),
  );
  const instructionsSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await instructionsInput.blur();
  await instructionsSaved;
  await expect(instructionsInput).toBeEnabled();
  const scrollsInside = await instructionsInput.evaluate(
    (field) => field.scrollHeight > field.clientHeight,
  );
  expect(scrollsInside).toBe(true);
  await instructionsInput.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "29a-long-bot-instructions");

  // Wrap in the narrow dialog without pushing Delete below the Playwright viewport.
  const longUnbrokenName = "A".repeat(48);
  expect(longUnbrokenName.length).toBe(48);
  await editName(longUnbrokenName);
  const longNameBot = botList.getByRole("button", {
    name: new RegExp(`^${longUnbrokenName}`),
  });
  await expect(longNameBot).toBeVisible();
  await expect(page.getByPlaceholder(`Message ${longUnbrokenName}`)).toBeVisible();

  await longNameBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: `Delete ${longUnbrokenName}?`,
  });
  await expect(deleteDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "30-delete-bot-confirmation");
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await page.waitForURL((url) => url.pathname !== deletedBotPath);

  await page.goto(deletedBotPath);
  await page.waitForURL((url) => url.pathname !== deletedBotPath);
  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "31-deleted-bot-fallback");
});
