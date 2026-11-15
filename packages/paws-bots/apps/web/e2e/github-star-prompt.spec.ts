import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("asks for a GitHub star after a few messages", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `star-prompt-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });
  await page.evaluate(() => localStorage.setItem("rakazo.githubStarPrompt.sent", "5"));

  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill("What should I work on today?");
  await composer.press("Enter");

  const prompt = page.getByRole("complementary", { name: "Star on GitHub" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("link", { name: "Star on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/elie222/rakazo",
  );
  await captureScreenshot(page, testInfo, "github-star-prompt");

  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
  await page.reload();
  await composer.fill("And tomorrow?");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("And tomorrow?", { exact: true }),
  ).toBeVisible();
  await expect(prompt).toBeHidden();
});
