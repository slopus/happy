import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("command palette switches bots and runs actions", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cmdk-bots-${stamp}@rakazo.test`, "password12", "CmdK Bots");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    description: "Finds sources and writes briefs.",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(
    page
      .locator("aside")
      .first()
      .getByRole("button", { name: /^Researcher/ }),
  ).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("command-palette");
  const dialog = page.getByRole("dialog", { name: "Command menu" });
  await expect(dialog).toBeVisible();
  await expect(palette).toBeVisible();
  await expect(page.getByRole("option", { name: /Chief/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Researcher/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "command-palette-bots");

  const search = page.getByTestId("command-palette-search");
  await search.fill("Research");
  await expect(page.getByRole("option", { name: /Researcher/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Chief/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "command-palette-filtered");

  await page.getByRole("option", { name: /Researcher/ }).click();
  await expect(dialog).toBeHidden();
  await page.waitForURL(new RegExp(`/app/${researcher.id}$`));
  expect(activeBotId(page)).toBe(researcher.id);
  await expect(page.getByRole("combobox", { name: "Message Researcher" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog).toBeVisible();
  await page.getByTestId(`command-palette-bot-${chiefId}`).click();
  await page.waitForURL(new RegExp(`/app/${chiefId}$`));
  expect(activeBotId(page)).toBe(chiefId);

  await page.keyboard.press("ControlOrMeta+K");
  const lightTheme = page.getByTestId("command-palette-action-appearance-light");
  await lightTheme.scrollIntoViewIfNeeded();
  await expect(lightTheme).toBeVisible();
  await captureScreenshot(page, testInfo, "command-palette-actions");
  await lightTheme.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.keyboard.press("ControlOrMeta+K");
  await search.fill("models");
  await expect(page.getByRole("option", { name: "Settings: Models" })).toBeVisible();
  await expect(page.getByRole("option", { name: /Chief/ })).toHaveCount(0);
  await page.getByRole("option", { name: "Settings: Models" }).click();
  await page.waitForURL(/[?&]settings=models/);
});
