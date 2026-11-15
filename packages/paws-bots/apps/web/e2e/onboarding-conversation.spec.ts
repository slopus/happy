import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

function slackCard(page: Page) {
  return page.getByRole("group", { name: "Slack connection" });
}

test("focus choice suggests apps and preserves a completed connection", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `onboarding-${stamp}@rakazo.test`, "password12", "Robin");
  await completeOnboarding(page);

  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Day-to-day work/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Research & writing/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /A bit of everything/ })).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "01-focus-choice");
  await captureScreenshot(page, testInfo, "choice-card-onboarding");

  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  // The focus step suggests apps but must not rename the bot: the name the
  // user chose during creation ("Chief") is preserved.
  await expect(page.locator("main").getByText("Chief", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(page.getByText("Slack", { exact: true })).toBeVisible();
  await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
  const connectionCards = page.getByRole("group", { name: / connection$/ });
  await expect(connectionCards).toHaveCount(3);
  const cardBoxes = await connectionCards.evaluateAll((cards) =>
    cards.map((card) => {
      const { bottom, top } = card.getBoundingClientRect();
      return { bottom, top };
    }),
  );
  expect(cardBoxes[1]!.top - cardBoxes[0]!.bottom).toBeGreaterThanOrEqual(8);
  expect(cardBoxes[2]!.top - cardBoxes[1]!.bottom).toBeGreaterThanOrEqual(8);
  await page
    .getByTestId("transcript")
    .getByText("Hit those three and I’ll start pulling the picture.")
    .scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "02-app-suggestions");
  const authorizeButton = slackCard(page).getByRole("button", { name: "Connect", exact: true });
  const restingBackground = await authorizeButton.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  await authorizeButton.hover();
  await expect
    .poll(() => authorizeButton.evaluate((button) => getComputedStyle(button).backgroundColor))
    .not.toBe(restingBackground);
  await captureScreenshot(page, testInfo, "02-app-suggestions-authorize-hover");

  await authorizeButton.click();
  await expect(slackCard(page).getByText("Connected", { exact: true })).toBeVisible();
  await expect(slackCard(page).getByText("Connected", { exact: true })).toHaveCSS("opacity", "1");
  await expect
    .poll(async () => {
      const connections = await rpc<Array<{ provider: string; status: string }>>(
        page,
        "connections/list",
        {},
      );
      return connections.some(
        (connection) => connection.provider === "SLACK" && connection.status === "connected",
      );
    })
    .toBe(true);
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "03-slack-connected");

  await page.reload();
  await expect(slackCard(page).getByText("Connected", { exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "04-connected-after-reload");
});

test("choice refresh failures leave options available for retry", { tag: "@nightly" }, async ({
  page,
}) => {
  await signup(page, `choice-refresh-${Date.now()}@rakazo.test`, "password12", "Choice Retry");
  await completeOnboarding(page);
  const choice = page.getByRole("button", { name: /Day-to-day work/ });
  await expect(choice).toBeEnabled();
  // Keep the existing choice rendered while its save succeeds and navigation refresh fails.
  await page.route("**/rpc/onboarding/choose", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    }),
  );
  await page.route("**/rpc/spaces/list", (route) => route.abort());
  await Promise.all([page.waitForRequest("**/rpc/spaces/list"), choice.click()]);
  await expect(choice).toBeEnabled();
});
