import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

async function prepareOnboarding(page: Page) {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: false } } });
  });
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          providers: [],
          webUrl: "https://example.test/integrations/setup",
        },
      },
    }),
  );
}

async function swipe(page: Page, start: [number, number], end: [number, number]) {
  await page.getByTestId("shell-root").evaluate(
    (shell, { start, end }) => {
      function touch([clientX, clientY]: [number, number]) {
        return new Touch({ clientX, clientY, identifier: 1, target: shell });
      }
      const first = touch(start);
      shell.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          changedTouches: [first],
          touches: [first],
        }),
      );
      const last = touch(end);
      shell.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          changedTouches: [last],
          touches: [],
        }),
      );
    },
    { start, end },
  );
}

test("swiping inward from the mobile edge opens the bots sidebar", async ({ page }, testInfo) => {
  await prepareOnboarding(page);
  const stamp = Date.now();
  await signup(page, `mobile-sidebar-swipe-${stamp}@rakazo.test`, "password12", "Swipe Test");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const closeNavigation = page.getByRole("button", { name: "Close navigation" });
  const edge = page.getByTestId("mobile-sidebar-swipe-edge");
  await expect(closeNavigation).toHaveCount(0);
  await expect(edge).toHaveCSS("touch-action", "none");

  await swipe(page, [16, 420], [35, 510]);
  await expect(closeNavigation).toHaveCount(0);
  await swipe(page, [120, 420], [205, 424]);
  await expect(closeNavigation).toHaveCount(0);

  await swipe(page, [16, 420], [92, 426]);
  await expect(closeNavigation).toBeVisible();
  await expect(edge).toHaveCount(0);
  await expect(page.getByTestId("bots-sidebar")).toContainText("Chief");
  await captureScreenshot(page, testInfo, "mobile-sidebar-edge-swipe-open");

  // Right-to-left layouts swipe in from the other edge.
  await closeNavigation.click();
  await expect(closeNavigation).toHaveCount(0);
  await page.locator("html").evaluate((html) => html.setAttribute("dir", "rtl"));
  const edgeBox = await edge.boundingBox();
  expect(edgeBox?.x).toBeGreaterThan(350);
  await swipe(page, [374, 420], [298, 426]);
  await expect(closeNavigation).toBeVisible();
  await expect(page.getByTestId("bots-sidebar")).toContainText("Chief");
});
