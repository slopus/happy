import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("typing stop while the bot works stops it and says so", async ({ page }, testInfo) => {
  await signup(page, `stop-message-${Date.now()}@rakazo.test`, "password12", "Stopper");
  await completeOnboarding(page);

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible({ timeout: 30_000 });

  await composer.fill("Stop now");
  await page.keyboard.press("Enter");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Stop now", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Stopped. Anything already done stays done.", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(stopButton).toHaveCount(0, { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "86-stopped-by-message");
});
