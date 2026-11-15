import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("picks a tool for a rule and moves it from Always ask to Blocked", async ({
  page,
}, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@rakazo.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await settings.getByRole("button", { name: "Add rule", exact: true }).click();
  await page.getByRole("combobox", { name: "Search tools" }).fill("write");
  await page.getByRole("option", { name: "Write file", exact: true }).click();
  const asking = settings.getByTestId("approval-rules-require_approval");
  await expect(asking).toContainText("Write file");
  await settings
    .getByRole("group", { name: "Write file", exact: true })
    .getByRole("button", { name: "Block", exact: true })
    .click();
  await expect(settings.getByTestId("approval-rules-deny")).toContainText("Write file");
  await expect(asking).toHaveCount(0);
  await captureScreenshot(page, testInfo, "approval-rules-added");
});
