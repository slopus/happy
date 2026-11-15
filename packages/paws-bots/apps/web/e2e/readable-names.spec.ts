import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";
import { expectReadableNames } from "./visible-name-guard";

test("legacy opaque names never appear in navigation, account, chats or Activity", async ({
  page,
}, testInfo) => {
  const email = `names-${Date.now()}@example.test`;
  await signup(page, email, "password12", "Demo");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Helper",
    description: "",
    computerMode: "team",
  });
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Team",
    botIds: bots.map((item) => item.id),
  });
  const me = await rpc<{ spaceId: string }>(page, "me", {});
  // Reproduce old stored data directly. New writes normalize these values.
  const { prisma: db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    await db.user.update({ where: { email }, data: { name: "__TestTok1__" } });
    await db.bot.update({
      where: { id: bot.id },
      data: { name: "550e8400-e29b-41d4-a716-446655440000" },
    });
    await db.chatGroup.update({
      where: { id: group.id },
      data: { name: "c123456789012345678901234" },
    });
    await db.space.update({ where: { id: me.spaceId }, data: { name: "__SpaceTok1__" } });
    await page.goto(`/app/${bot.id}`);
    await expect(page.getByPlaceholder("Message Bot")).toBeVisible();
    const accountTrigger = page.getByTestId("user-menu-trigger");
    await expect(accountTrigger).toHaveAccessibleName(`Account menu for ${email}`);
    await accountTrigger.click();
    await expect(page.getByTestId("account-menu-header")).toContainText(email);
    await expectReadableNames(page.locator("body"));
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("account-menu-header")).toBeHidden();
    await expectReadableNames(page.locator("body"));
    await captureScreenshot(page, testInfo, "readable-names-sidebar-chat");
    await openUserSettings(page);
    await expect(page.getByTestId("user-settings")).toContainText(email);
    await expectReadableNames(page.locator("body"));
    await captureScreenshot(page, testInfo, "readable-names-account");
    const accountCard = page.getByTestId("account-card");
    await accountCard.getByRole("button", { name: "Edit", exact: true }).click();
    const nameInput = accountCard.getByRole("textbox", { name: "Name", exact: true });
    await expect(nameInput).toHaveValue("");
    await expect(accountCard.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await nameInput.fill("Discard me");
    await nameInput.press("Escape");
    await expect(page.getByTestId("user-settings")).toBeVisible();
    await expect(nameInput).toBeHidden();
    await accountCard.getByRole("button", { name: "Edit", exact: true }).click();
    await nameInput.fill("💬");
    await nameInput.press("Enter");
    await expect(accountCard.getByRole("alert")).toHaveText("Could not update name");
    await expect(nameInput).toHaveValue("💬");
    await expect(page.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      `Account menu for ${email}`,
    );
    await nameInput.fill("  Alex Rivera  ");
    await nameInput.press("Enter");
    await expect(nameInput).toBeHidden();
    await expect(accountCard).toContainText("Alex Rivera");
    await expect(page.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "Account menu for Alex Rivera",
    );
    await captureScreenshot(page, testInfo, "readable-names-account-saved");
    await page.reload();
    await expect(page.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "Account menu for Alex Rivera",
    );
    await page.keyboard.press("Escape");
    await page.goto(`/app/g/${group.id}`);
    await expect(page.getByPlaceholder("Message Group")).toBeVisible();
    await expectReadableNames(page.locator("body"));
    await captureScreenshot(page, testInfo, "readable-names-group-members");
    await page.evaluate(() => localStorage.setItem("rakazo.uiLocale", "ru"));
    await page.reload();
    await expect(page.getByTestId("bots-sidebar")).toContainText("Группа");
    await expect(page.getByTestId("bots-sidebar")).toContainText("Бот");
    await expectReadableNames(page.locator("body"));
    await captureScreenshot(page, testInfo, "readable-names-localized");
    await page.evaluate(() => localStorage.setItem("rakazo.uiLocale", "en"));
    await page.goto(`/app/${bot.id}`);
    await rpc(page, "threads/send", { botId: bot.id, text: "keep working until I stop you" });
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("status", { name: "Loading activity…" })).toBeHidden();
    // Activity folds its Working section by default; open it so the run row is visible.
    await page
      .locator("aside")
      .getByRole("button", { name: /^Working/ })
      .click();
    await expect(page.locator("aside").getByRole("button", { name: /^Bot, / })).toBeVisible();
    await expectReadableNames(page.locator("body"));
    await captureScreenshot(page, testInfo, "readable-names-activity");
  } finally {
    await rpc(page, "threads/stop", { botId: bot.id }).catch(() => undefined);
    try {
      await db.$disconnect();
    } finally {
      await pool.end();
    }
  }
});
