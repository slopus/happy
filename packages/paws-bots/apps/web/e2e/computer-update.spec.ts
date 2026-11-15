import { expect, test } from "@playwright/test";
import type { ComputerUpdate } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  signup,
} from "./helpers";

test("computer maintenance shows durable background progress and failure recovery", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await signup(page, `computer-update-${Date.now()}@rakazo.test`, "password12", "Computer Update");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let updates: ComputerUpdate[] = [];
  const updating: ComputerUpdate = {
    id: "update-example",
    botId,
    name: "Chief",
    mode: "team",
    action: "update",
    status: "running",
    stage: "restoring",
  };
  await page.route("**/rpc/computer/updates", (route) =>
    route.fulfill({ json: { json: updates } }),
  );
  await page.route("**/rpc/computer/update", (route) => {
    updates = [updating];
    return route.fulfill({ json: { json: updating } });
  });
  await page.route("**/rpc/computer/recover", (route) => {
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  await openBotPanelTab(page, "Computer");
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await openBotPanelTab(page, "Advanced");
  const settings = page.getByTestId("bot-settings");
  const reset = settings.getByRole("button", { name: "Reset computer", exact: true });
  await expect(reset).toBeVisible();
  await expect(settings.getByRole("button", { name: "Stop computer" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await reset.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "computer-maintenance-settings");
  await reset.click();
  const resetConfirmation = page.getByRole("alertdialog");
  await expect(resetConfirmation.getByRole("heading")).toHaveText("Reset computer?");
  await captureScreenshot(page, testInfo, "computer-maintenance-reset-confirmation");
  await resetConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings.getByRole("button", { name: "Update computer", exact: true }).click();
  const dialog = page.getByTestId("computer-update-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Updating Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await captureScreenshot(page, testInfo, "computer-update-background");
  await page.reload();
  await page.getByRole("button", { name: /Updating Team Computer/ }).click();
  await expect(dialog).toBeVisible();
  updates = [{ ...updating, status: "interrupted" }];
  await expect(
    dialog.getByText("Recovery is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  // Older wire flags cannot expose a server lock-release control in the app.
  updates = [{ ...updating, status: "interrupted", canReleaseReservation: true }];
  await expect(dialog.getByRole("button", { name: "Release computer", exact: true })).toBeHidden();
  updates = [{ ...updating, status: "failed" }];
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = [];
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});
