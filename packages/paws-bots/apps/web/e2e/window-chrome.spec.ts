import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const [platform, nativeWindowFrame, controls] of [
  ["win32", true, false],
  ["win32", false, true],
  ["linux", false, true],
  ["darwin", false, false],
] as const) {
  test(`window controls: ${platform}, native frame ${nativeWindowFrame}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      ({ platform, nativeWindowFrame }) => {
        Object.defineProperty(window, "rakazoDesktop", {
          value: {
            platform,
            nativeWindowFrame,
            window: {
              close: async () => {},
              minimize: async () => {},
              toggleMaximize: async () => {},
              state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
            },
          },
        });
      },
      { platform, nativeWindowFrame },
    );
    await page.goto("/e2e/fixtures/window-chrome.html");
    await expect(page.getByText("Window controls preview")).toBeVisible();
    for (const name of ["Close", "Minimize", "Fullscreen"]) {
      await expect(page.getByRole("button", { name })).toHaveCount(controls ? 1 : 0);
    }
    await captureScreenshot(page, testInfo, `window-chrome-${platform}-${nativeWindowFrame}`);
  });
}
