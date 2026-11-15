import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("asks before running a command on the user's computer", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `user-computer-${stamp}@rakazo.test`, "password12", "User Computer");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("run hostname on my computer");
  await page.keyboard.press("Enter");

  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Run on your computer?", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const allow = page.getByRole("button", { name: "Allow in this space", exact: true });
  await expect(allow).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "user-computer-approval-card");

  await allow.click();
  await expect(transcript.getByText("Allowed in this space", { exact: true })).toBeVisible();

  // The emulated desktop (see UserDeviceEmulator) records what it ran; tool output is not
  // shown in the transcript, so check that the approved command reached it.
  const api = process.env.API_URL ?? "http://127.0.0.1:3110";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${api}/__e2e/user-device-requests`);
      const requests = (await response.json()) as Array<{
        request: { method: string; command?: { argv: string[] } };
      }>;
      return requests.some(
        ({ request }) =>
          request.method === "execute" && request.command?.argv.at(-1) === "hostname",
      );
    })
    .toBe(true);
});
