import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

// Tall enough that each scenario's transcript fits without scrolling inside the chat pane.
test.use({ viewport: { width: 1280, height: 2200 } });

test("gallery keeps a paginated call closed and its follow-up visible", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?scenario=calls&theme=light");
  const call = page.getByTestId("voice-chat-card").first();
  await expect(call.getByText("Deploy check", { exact: true })).toBeVisible();
  await expect(call.getByText("2:05", { exact: true })).toBeVisible();
  await expect(page.getByText("Here is the deployment checklist.", { exact: true })).toBeVisible();
  await expect(call.getByText("Here is the deployment checklist.")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "paginated-call-marker");
});

test("gallery renders every chat scenario in both themes", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e/fixtures/gallery.html?theme=light");
  const nav = page.getByRole("navigation");
  const scenarios = await nav.locator("button:not([aria-pressed])").all();
  expect(scenarios.length).toBeGreaterThan(5);

  for (const scenario of scenarios) {
    const label = (await scenario.textContent())!;
    await scenario.click();
    await expect(scenario).toHaveAttribute("aria-current", "page");
    for (const theme of ["light", "dark"]) {
      const dark = nav.getByRole("button", { name: "Dark" });
      if ((await dark.getAttribute("aria-pressed")) !== String(theme === "dark"))
        await dark.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("gallery-frame")).not.toBeEmpty();
      if (label === "Rich content") {
        // Both load after mount and fall back quietly, so wait for the real content.
        await expect(page.locator("svg[class^='plot-']")).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator('img[alt="whiteboard.svg"]')
              .evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
      }
      await captureScreenshot(
        page,
        testInfo,
        `gallery-${label.toLowerCase().replaceAll(" ", "-")}-${theme}`,
      );
    }
  }

  await nav.getByRole("button", { name: "Questions" }).click();
  await nav.getByRole("button", { name: "Phone width" }).click();
  const phone = page.frameLocator('iframe[title="Phone preview"]');
  await expect(phone.getByText("Which city should I use?")).toBeVisible();
  expect(
    await phone.locator("main").evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(390);
  await captureScreenshot(page, testInfo, "gallery-questions-phone");
  expect(errors).toEqual([]);
});
