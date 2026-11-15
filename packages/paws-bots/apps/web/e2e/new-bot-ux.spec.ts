import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createBotFromPicker, rpc, signup } from "./helpers";

test("a stale roster refresh started before creation keeps the new bot selected", async ({
  page,
}, testInfo) => {
  await signup(page, `stale-create-${Date.now()}@rakazo.test`, "password12", "Stale Create");
  await completeOnboarding(page);
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();

  let markReady!: () => void;
  let releaseList!: () => void;
  let releaseStart!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  await page.route(
    "**/rpc/spaces/list",
    async (route) => {
      const response = await route.fetch();
      markReady();
      await listGate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  // Keep the post-create refresh from masking the stale response.
  await page.route("**/rpc/onboarding/start", async (route) => {
    await startGate;
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await ready;
  try {
    await createBotFromPicker(page, { name: "Later Bot" });
    const composer = page.getByRole("combobox", { name: "Message Later Bot", exact: true });
    await expect(composer).toBeEditable();
    const createdPath = new URL(page.url()).pathname;
    const delivered = page.waitForResponse("**/rpc/spaces/list");
    releaseList();
    await (await delivered).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(composer).toBeEditable();
    expect(new URL(page.url()).pathname).toBe(createdPath);
    await captureScreenshot(page, testInfo, "new-bot-stale-refresh");
    // The create flow's final refresh follows the stale response, without masking a redirect.
    const freshRoster = page.waitForResponse("**/rpc/spaces/list");
    releaseStart();
    await freshRoster;
    await expect(page).toHaveURL((url) => url.pathname === createdPath);
    await expect(composer).toBeEditable();
  } finally {
    releaseList();
    releaseStart();
  }
});

test("creation actions stay visible above a long bot list", async ({ page }, testInfo) => {
  await signup(page, `create-menu-${Date.now()}@rakazo.test`, "password12", "Create menu");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  for (let index = 0; index < 12; index++) {
    await rpc(page, "bots/create", {
      name: `Helper ${index + 1}`,
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("bot-create-picker");
  const group = picker.getByTestId("create-new-group");
  const space = picker.getByTestId("create-new-space");
  const firstBot = picker.locator('[data-testid^="picker-bot-"]').first();
  await expect(picker.locator('[data-testid^="picker-bot-"]')).toHaveCount(13);
  const groupBox = await group.boundingBox();
  const botBox = await firstBot.boundingBox();
  expect(groupBox!.y).toBeLessThan(botBox!.y);
  await picker.locator('[data-testid^="picker-bot-"]').last().scrollIntoViewIfNeeded();
  await expect(group).toBeInViewport();
  await expect(space).toBeInViewport();
  await captureScreenshot(page, testInfo, "create-menu-long-roster");
  await page.setViewportSize({ width: 900, height: 360 });
  const lastBot = picker.locator('[data-testid^="picker-bot-"]').last();
  await lastBot.scrollIntoViewIfNeeded();
  await expect(lastBot).toBeInViewport({ ratio: 1 });
  await expect(group).toBeInViewport({ ratio: 1 });
  await expect(space).toBeInViewport({ ratio: 1 });
  await captureScreenshot(page, testInfo, "create-menu-short-window");
  await group.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create-group");
});
