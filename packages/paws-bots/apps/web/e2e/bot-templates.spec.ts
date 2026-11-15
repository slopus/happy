import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a bot template previews what it adds, then creates a bot with a paused routine", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, `templates-${Date.now()}@rakazo.test`, "password12", "Template Test");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Integrations", exact: true })
    .getByTestId("open-bot-templates")
    .click();
  const dialog = page.getByRole("dialog", { name: "Bot templates", exact: true });
  const cards = dialog.getByTestId("bot-template-card");
  await expect(cards).toHaveCount(4);
  const briefing = cards.filter({ hasText: "Morning briefing" });
  await expect(briefing.getByText("Needs you", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-templates");

  await briefing.click();
  const detail = dialog.getByTestId("bot-template-detail");
  await expect(detail.getByRole("heading", { name: "Morning briefing" })).toBeVisible();
  await expect(detail.getByText("Skill", { exact: true })).toBeVisible();
  await expect(detail.getByText(/paused until you turn it on$/)).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-template-detail");

  await detail.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/[^/?]+/);
  const botId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByTestId("import-setup-card")).toBeVisible();
  await expect(page.getByTestId("import-setup-card")).toContainText("Morning briefing");
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines.map((routine) => [routine.name, routine.active])).toEqual([
    ["Morning briefing", false],
  ]);
  await captureScreenshot(page, testInfo, "bot-template-created");

  // Opening the template again offers the bot it made instead of a second one.
  await page.goto(`/app/${botId}?templates`);
  await dialog.getByTestId("bot-template-card").filter({ hasText: "Morning briefing" }).click();
  await expect(detail.getByRole("button", { name: "Open", exact: true })).toBeVisible();
});
