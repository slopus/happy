import { expect, test } from "@playwright/test";
import { captureScreenshot, expectCardWidth } from "./helpers";

const fixture = "/e2e/fixtures/chart-links.html";

// The full matrix of unsafe and supported schemes lives in plot-tool.test.ts;
// this checks one obfuscated href stays inert in a real browser.
const href = ' \u0000\u001fJaVa\tScRi\nPt:void(document.body.dataset.plotExecuted="yes")';

test("chart links cannot execute script when clicked or expanded", async ({ page }, testInfo) => {
  for (const inspect of ["0", "1"]) {
    await page.goto(`${fixture}?${new URLSearchParams({ href, inspect })}`);
    const circle = page.locator("svg circle").first();
    await expect(circle).toBeVisible();
    const assertInert = async () => {
      const links = page.locator("svg a");
      expect(await links.count()).toBeGreaterThan(0);
      expect(
        await links.evaluateAll((anchors) =>
          anchors.every(
            (anchor) =>
              !anchor.hasAttribute("href") &&
              !anchor.hasAttributeNS("http://www.w3.org/1999/xlink", "href"),
          ),
        ),
      ).toBe(true);
      await expect(page.locator("body")).not.toHaveAttribute("data-plot-executed");
    };
    await assertInert();
    await circle.click();
    // Hover inspection still works, without reintroducing unsafe links.
    if (inspect === "1") await expect(page.locator('[aria-label="tip"]')).toBeVisible();
    await assertInert();
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("svg circle")).toBeVisible();
    await dialog.locator("svg circle").click();
    await assertInert();
    await expect(page).toHaveURL(`${fixture}?${new URLSearchParams({ href, inspect })}`);
    await page.getByRole("button", { name: "Close chart" }).click();
  }
  await captureScreenshot(page, testInfo, "chart-with-inert-link");
});

for (const width of [1280, 375]) {
  test.describe(`${width}px chart layout`, () => {
    test.use({
      viewport: { width, height: 812 },
      hasTouch: width === 375,
      isMobile: width === 375,
    });

    test(`chart fills its transcript bubble at ${width}px without horizontal overflow`, async ({
      page,
    }, testInfo) => {
      await page.goto(fixture);
      const card = page.getByRole("button", { name: "Expand", exact: true }).locator("..");
      const plot = card.locator("svg").first();
      await expect(plot).toBeVisible();
      await expectCardWidth(card, 552);

      // The 520px plot sits inside the card's two 16px padding edges.
      const measured = await card.evaluate((element) => ({
        card: element.getBoundingClientRect().width,
        plot: element.querySelector("svg")!.getBoundingClientRect().width,
        overflow: element.scrollWidth - element.clientWidth,
      }));
      expect(Math.abs(measured.plot - (measured.card - 32))).toBeLessThan(1);
      if (width === 1280) expect(Math.abs(measured.plot - 520)).toBeLessThan(1);
      expect(measured.overflow).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await captureScreenshot(page, testInfo, `chart-card-${width}px`);
    });
  });
}
