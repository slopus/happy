import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];
const states = [
  { name: "active", live: true, reply: "Still finding a free slot…" },
  { name: "complete", live: false, reply: "Tuesday afternoon is free." },
];

test("chat shows mid-turn progress without Working…", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const state of states) {
      await page.goto(`/e2e/fixtures/chat-progress-messages.html?live=${state.live ? 1 : 0}`);
      const bubbles = page.getByTestId("message-bot-bubble");
      await expect(bubbles).toHaveCount(2);
      await expect(bubbles.nth(0)).toHaveText("Checking your calendars…");
      await expect(bubbles.nth(1)).toHaveText(state.reply);
      await expect(
        page.locator('[data-message-id="bot-progress"]').getByTestId("message-hover-actions"),
      ).toHaveCount(1);
      await expect(page.locator(".rk-chat-markdown-streaming")).toHaveCount(state.live ? 1 : 0);
      await expect(page.getByTestId("tool-activity")).toHaveCount(0);
      await expect(page.getByRole("status")).toHaveCount(0);
      await expect(page.getByText("Working…")).toHaveCount(0);
      await expect(page.getByText("Done")).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `${state.name}-${viewport.name}`);
    }
  }
});
