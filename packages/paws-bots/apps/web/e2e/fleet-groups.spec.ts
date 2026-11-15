import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a group a bot creates after approval appears in the sidebar without a reload", async ({
  page,
}, testInfo) => {
  await signup(page, `bot-management-groups-${Date.now()}@rakazo.test`, "password12", "Bot Groups");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);
  await rpc(page, "bots/update", { botId: chiefId, fleetManagement: true });
  for (const name of ["Alpha", "Beta"]) {
    await rpc(page, "bots/create", { name, description: "", notifyOnFinish: true });
  }

  const sidebar = page.locator("aside").first();
  const composer = page.getByPlaceholder("Message Chief");
  await expect(composer).toBeEnabled();
  await composer.fill("create a group named Crew with Alpha, Beta");
  await page.keyboard.press("Enter");

  await expect(
    page.getByTestId("transcript").getByText("Create group “Crew”?", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Members: Alpha, Beta", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Crew/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "fleet-create-group-approval");

  // A new question can run beside the approval, and both cards stay answerable.
  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Which city should I use?", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
  await expect(composer).toBeEnabled();
  await captureScreenshot(page, testInfo, "pending-cards-never-block-chat");
  await page.reload();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
  await expect(composer).toBeEnabled();

  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: /^Crew/ })).toBeVisible({ timeout: 30_000 });
});

test(
  "model approvals use catalog labels and fit wide and narrow chats",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    await signup(
      page,
      `bot-management-model-${Date.now()}@rakazo.test`,
      "password12",
      "Bot Models",
    );
    await completeOnboarding(page);
    await page.waitForURL(/\/app\/[^/]+$/);
    const chiefId = activeBotId(page);
    await rpc(page, "bots/update", { botId: chiefId, fleetManagement: true });
    const composer = page.getByPlaceholder("Message Chief");
    await composer.fill("spawn a bot named Scout to research venues");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-roster-bot-name]").filter({ hasText: /^Scout$/ })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    const bots = await rpc<Array<{ id: string; name: string }>>(page, "bots/list", {});
    const scout = bots.find((bot) => bot.name === "Scout");
    if (!scout) throw new Error("Missing child bot");
    await rpc(page, "models/connect", {
      provider: "openai",
      apiKey: "test-key-not-a-real-secret",
      label: "Test",
      modelId: "gpt-6-sol",
    });
    await rpc(page, "bots/update", {
      botId: scout.id,
      modelProvider: "openai",
      modelId: "gpt-6-sol",
    });
    await expect(composer).toBeEnabled();
    await composer.fill(`set the model of bot ${scout.id} to openai/gpt-6-luna`);
    await page.keyboard.press("Enter");
    const card = page
      .locator("[data-message-id]")
      .filter({ has: page.getByText("Change the model of Scout?", { exact: true }) })
      .last();
    await expect(card.getByText("From: OpenAI: GPT-6 Sol", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.getByText("To: OpenAI: GPT-6 Luna", { exact: false })).toBeVisible();
    const allow = card.getByRole("button", { name: "Allow once", exact: true });
    const deny = card.getByRole("button", { name: "Deny", exact: true });
    const a = await allow.boundingBox();
    const d = await deny.boundingBox();
    expect(a?.y).toBe(d?.y);
    expect(
      (await card.locator("[data-testid=message-bubble-frame]").boundingBox())?.width,
    ).toBeGreaterThan(450);
    await captureScreenshot(page, testInfo, "fleet-model-change-approval");
    await page.setViewportSize({ width: 400, height: 900 });
    await expect(allow).toBeVisible();
    expect(
      (await card.locator("[data-testid=message-bubble-frame]").boundingBox())?.width,
    ).toBeGreaterThan(350);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      400,
    );
    await deny.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "fleet-model-change-approval-narrow");
    await deny.click();
    await expect(card.getByText("Denied", { exact: true })).toHaveClass(/text-muted-foreground/);
  },
);
