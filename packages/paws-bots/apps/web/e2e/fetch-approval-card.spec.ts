import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("asks before fetching a site the message did not name", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `fetch-approval-${stamp}@rakazo.test`, "password12", "Fetch Approval");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a fetch approval card");
  await page.keyboard.press("Enter");

  const always = page.getByRole("button", { name: "Always allow example.test", exact: true });
  await expect(always).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("url: https://docs.example.test/page?q=fixture")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  const row = page.locator("[data-message-id]").filter({ has: always });
  const card = always.locator("xpath=../..");
  const rail = row.getByTestId("message-hover-rail");
  await row.hover();
  await rail.getByRole("button", { name: "React", exact: true }).focus();
  await expect(rail).toHaveCSS("opacity", "1");
  await expect
    .poll(async () => {
      const cardBox = await card.boundingBox();
      const railBox = await rail.boundingBox();
      if (!cardBox || !railBox) return null;
      return {
        gap: Math.round(railBox.x - cardBox.x - cardBox.width),
        centered: Math.abs(railBox.y + railBox.height / 2 - cardBox.y - cardBox.height / 2) < 2,
      };
    })
    .toEqual({ gap: 4, centered: true });
  await captureScreenshot(page, testInfo, "fetch-approval-card");
  await rail.getByRole("button", { name: "React", exact: true }).click();
  await expect(page.getByRole("button", { name: "👍", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "fetch-approval-reaction-picker");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByTestId("transcript").getByText("Denied", { exact: true })).toBeVisible();
});
