import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("asks before using an app on the user's computer", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `user-screen-${stamp}@rakazo.test`, "password12", "User Screen");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("look at TextEdit on my computer");
  await page.keyboard.press("Enter");

  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Use TextEdit on your computer?", { exact: true })).toBeVisible(
    { timeout: 60_000 },
  );
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "user-computer-screen-approval-card");

  await page.getByRole("button", { name: "Allow in this space", exact: true }).click();
  await expect(transcript.getByText("Allowed in this space", { exact: true })).toBeVisible();

  // The emulated desktop (see UserDeviceEmulator) records requests; the window it returns is
  // only for the bot, so check that the approved look reached it.
  const api = process.env.API_URL ?? "http://127.0.0.1:3110";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${api}/__e2e/user-device-requests`);
      const requests = (await response.json()) as Array<{
        request: { method: string; app?: string };
      }>;
      return requests.some(
        ({ request }) => request.method === "screenObserve" && request.app === "TextEdit",
      );
    })
    .toBe(true);
});
