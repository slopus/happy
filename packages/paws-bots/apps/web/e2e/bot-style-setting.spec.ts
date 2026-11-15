import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("bot style stays available when bootstrap omits the saved preference", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.json.me.botAvatarSet;
    await route.fulfill({ response, json: body });
  });
  await signup(page, `bot-style-${Date.now()}@rakazo.test`, "password12", "Tester");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  const picker = settings.getByTestId("bot-style-select");
  const original = picker.getByRole("button", { name: "Original", exact: true });
  const rakazo = picker.getByRole("button", { name: "Rakazo", exact: true });
  await expect(original).toBeVisible();
  await expect(original).toHaveAttribute("aria-pressed", "false");
  await rakazo.click();
  await expect(rakazo).toHaveAttribute("aria-pressed", "true");
  await original.click();
  await expect(original).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "bot-style-original");
  await page.unroute("**/rpc/bootstrap");
  await page.reload();
  await openUserSettings(page);
  await expect(
    page.getByTestId("bot-style-select").getByRole("button", { name: "Original", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
