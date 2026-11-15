import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, expectCardWidth, signup } from "./helpers";

test("a completed subagent card folds, opens from its header, and fills its width", async ({
  page,
}, testInfo) => {
  await signup(page, `subagent-card-${Date.now()}@rakazo.test`, "password12", "Subagent Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("delegate to a helper: list three venue ideas");
  await page.keyboard.press("Enter");

  const card = page.getByTestId("subagent-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Completed", { timeout: 30_000 });
  const header = card.getByRole("button");
  const body = card.getByTestId("subagent-body");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-card");
  await expectCardWidth(card, 420);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(body).toContainText("done. i handled");
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-card-open");
  await header.click();
  await expect(body).toBeHidden();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card).toBeVisible();
  await expectCardWidth(card, 420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("a background helper's card can be stopped while the chat stays free", async ({
  page,
}, testInfo) => {
  await signup(page, `background-card-${Date.now()}@rakazo.test`, "password12", "Background Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("keep working on the venue list in the background");
  await page.keyboard.press("Enter");

  // The bot answers and its turn ends while the helper keeps working.
  // The sidebar previews the same reply, so read it from the chat.
  await expect(
    page.getByTestId("message-bot-bubble").getByText("a background helper is on it"),
  ).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId("subagent-card");
  await expect(card).toContainText("Running", { timeout: 30_000 });
  const stop = card.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "background-helper-running");

  await stop.click();
  await expect(card).toContainText("Stopped", { timeout: 15_000 });
  await expect(stop).toBeHidden();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "background-helper-stopped");
});
