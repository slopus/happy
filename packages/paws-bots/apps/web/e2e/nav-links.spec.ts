import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("an operator menu link opens its page sandboxed inside the app", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/ext/clients/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Clients</title><h1>Client list</h1>",
    }),
  );
  await signup(page, `nav-links-${Date.now()}@rakazo.test`, "password12", "Links QA");
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Clients", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/x\/clients$/);
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  const frame = page.locator("iframe[title='Clients']");
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-popups allow-downloads",
  );
  await expect(page.frameLocator("iframe[title='Clients']").getByRole("heading")).toHaveText(
    "Client list",
  );
  await captureScreenshot(page, testInfo, "nav-link-page");

  // /app reopens the last chat, so only check that the page was left.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(frame).toBeHidden();
  await expect(page).not.toHaveURL(/\/app\/x\//);
  await page.goto("/app/x/unknown");
  await expect(page).not.toHaveURL(/\/app\/x\//);
});
