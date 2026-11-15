import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

function rosterRow(page: Page, name: RegExp) {
  return page.locator("[data-sidebar-group] [data-roster-bot-id]").filter({
    has: page.locator("[data-roster-bot-name]").filter({ hasText: name }),
  });
}

test("created bots appear as regular bots and reorder across their creator", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `created-bots-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");

  const scout = rosterRow(page, /Scout/);
  const chief = rosterRow(page, /^Chief/);
  await expect(scout).toBeVisible({ timeout: 30_000 });
  await expect(chief).toBeVisible();
  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByRole("button", { name: /^(Collapse|Expand) Chief$/ })).toHaveCount(0);
  // Both rows use the same inset; creation provenance must not indent a bot.
  const inset = (row: ReturnType<typeof rosterRow>) =>
    row.evaluate((element) => getComputedStyle(element).paddingInlineStart);
  expect(await inset(scout)).toEqual(await inset(chief));
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "sidebar-created-bots");

  await page.reload();
  await expect(scout).toBeVisible();
  await expect(chief).toBeVisible();

  const rosterOrder = () => sidebar.locator("[data-roster-bot-name]").allTextContents();
  const before = await rosterOrder();
  expect(before).toHaveLength(2);
  const last = before[1] === "Scout" ? scout : chief;
  await last.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(rosterOrder).toEqual([before[1], before[0]]);

  await scout.click();
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
});
