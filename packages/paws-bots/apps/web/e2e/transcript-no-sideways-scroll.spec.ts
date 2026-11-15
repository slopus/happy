import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("the chat never scrolls sideways, even with card actions showing in a narrow window", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=secrets");
  const transcript = page.getByTestId("transcript");
  const row = page
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("secret-ask-card") });
  await row.first().hover();
  await expect(row.first().getByTestId("message-hover-rail")).toHaveCSS("opacity", "1");
  await page.mouse.wheel(400, 0);
  await expect.poll(() => transcript.evaluate((node) => node.scrollLeft)).toBe(0);
  await captureScreenshot(page, testInfo, "transcript-no-sideways-scroll");
});
