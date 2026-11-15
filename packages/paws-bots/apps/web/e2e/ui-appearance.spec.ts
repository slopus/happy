import { expect, test } from "@playwright/test";
import { completeOnboarding, rpc, signup } from "./helpers";

test("sidebar list fades above the transparent footer and keeps the last row reachable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `footer-scroll-${Date.now()}@rakazo.test`, "password12", "Demo User");
  await completeOnboarding(page);
  for (let index = 0; index < 20; index++) {
    await rpc(page, "bots/create", {
      name: `Demo chat ${index}`,
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const footer = page.getByTestId("sidebar-footer");
  const list = sidebar.locator(".rk-scroll").first();
  const lastRow = list.getByRole("button", { name: /^Demo chat 19/ }).first();
  await expect(lastRow).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => localStorage.setItem("rakazo.uiAppearance", theme), theme);
    await page.reload();
    await expect(lastRow).toHaveCount(1);
    await expect(footer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(footer).toHaveCSS("background-image", "none");
    await list.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
    await expect
      .poll(() =>
        list.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-fade-b"))),
      )
      .toBeGreaterThan(20);
    const listBox = await list.boundingBox();
    const avatarBox = await page.getByTestId("user-menu-trigger").boundingBox();
    expect(listBox!.y + listBox!.height).toBeLessThan(avatarBox!.y);
    // Disabling animations fast-forwards the scroll timeline and removes its fade.
    const screenshotPath = testInfo.outputPath(`sidebar-footer-scrolled-${theme}.png`);
    await page.screenshot({ path: screenshotPath, animations: "allow" });
    await testInfo.attach(`sidebar-footer-scrolled-${theme}`, {
      contentType: "image/png",
      path: screenshotPath,
    });
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(() =>
        list.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--scroll-fade-b"))),
      )
      .toBe(0);
    await lastRow.focus();
    await expect(lastRow).toBeFocused();
    await expect(lastRow).toBeInViewport();
    const rowBox = await lastRow.boundingBox();
    expect(rowBox!.y + rowBox!.height).toBeLessThan(avatarBox!.y);
  }
});
