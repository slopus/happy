import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

async function expectRailBesideCard(row: Locator, cardId: string) {
  const card = row.getByTestId(cardId);
  const rail = row.getByTestId("message-hover-rail");
  // The transcript can still be scrolling as cards above render, moving another row under the pointer.
  await expect(async () => {
    await row.hover();
    await expect(rail).toHaveCSS("opacity", "1", { timeout: 1_000 });
  }).toPass();
  await expect
    .poll(async () => {
      const cardBox = await card.boundingBox();
      const railBox = await rail.boundingBox();
      if (!cardBox || !railBox) return null;
      return Math.round(railBox.x - cardBox.x - cardBox.width);
    })
    .toBe(4);
}

// 720px leaves 36px of slack beyond the narrowest column (684px) where a card and its actions fit.
test("card actions sit beside the card without scrolling the chat sideways", async ({
  page,
}, testInfo) => {
  for (const width of [1440, 1024, 720]) {
    await page.setViewportSize({ width, height: 900 });
    for (const { scenario, cardId, count } of [
      { scenario: "secrets", cardId: "secret-ask-card", count: 4 },
      { scenario: "rich", cardId: "mcp-approval-card", count: 1 },
    ]) {
      await page.goto(`/e2e/fixtures/gallery.html?embed&scenario=${scenario}`);
      const transcript = page.getByTestId("transcript");
      const rows = page.locator("[data-message-id]").filter({ has: page.getByTestId(cardId) });
      await expect(rows).toHaveCount(count);
      expect(await transcript.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
      for (const row of await rows.all()) await expectRailBesideCard(row, cardId);
      expect(await transcript.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
      if (width === 1024 && scenario === "secrets") {
        await expectRailBesideCard(rows.first(), cardId);
        await captureScreenshot(page, testInfo, "secret-card-actions-beside-card");
      }
    }
  }
});
