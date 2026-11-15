import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a short reply thread shows one time separator and navigates to its parent", async ({
  page,
}, testInfo) => {
  await signup(page, `time-replies-${Date.now()}@rakazo.test`, "password12", "Reply Tester");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/clear", { botId });
  await page.reload({ waitUntil: "domcontentloaded" });
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("Let's review the release notes.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  const parent = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: "Let's review the release notes." })
    .first();
  await expect(parent).toBeVisible();
  await parent.hover();
  await parent.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(page.getByTestId("reply-chip")).toContainText("Let's review the release notes.");
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("reply-chip")).toHaveCount(0);
  await parent.hover();
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  await captureScreenshot(page, testInfo, "time-separator-reply-composer");
  await composer.fill("OK");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("reply-chip")).toHaveCount(0);
  const reply = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: "OK" })
    .first();
  const quote = reply.getByTestId("reply-parent-preview");
  await expect(quote).toHaveText("↩ You: Let's review the release notes.");
  // A quote wider than its bubble must not pull the user bubble off the right edge.
  const quoteBox = (await quote.boundingBox())!;
  const bubbleBox = (await reply.getByTestId("message-user-bubble").boundingBox())!;
  expect(quoteBox.width).toBeGreaterThan(bubbleBox.width);
  expect(bubbleBox.x + bubbleBox.width).toBeCloseTo(quoteBox.x + quoteBox.width, 0);
  await expect(transcript.getByTestId("time-separator")).toHaveCount(1);
  await expect(transcript.getByTestId("time-separator")).toContainText("Today");
  await quote.click();
  await expect(parent).toBeInViewport();
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "time-separator-sent-reply");
});
