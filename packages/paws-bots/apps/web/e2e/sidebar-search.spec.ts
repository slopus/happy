import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("sidebar search opens from its icon and closes without moving chats mid-click", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-search-${Date.now()}@rakazo.test`, "password12", "Search Sample");
  await completeOnboarding(page);
  const sidebar = page.locator("aside").first();
  const trigger = sidebar.getByTestId("sidebar-search-trigger");
  const search = sidebar.getByRole("textbox", { name: "Search", exact: true });
  await expect(search).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-search-closed");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-pressed", "true");
  await expect(search).toBeFocused();
  await captureScreenshot(page, testInfo, "sidebar-search-open");

  // Leaving an empty field keeps the roster still, so a chat click lands.
  const chief = sidebar.getByRole("button", { name: /^Chief/ }).first();
  const before = await chief.boundingBox();
  await chief.click();
  await expect(search).toBeVisible();
  expect((await chief.boundingBox())?.y).toBe(before?.y);

  await search.fill("no roster matches");
  const originalSearch = (await search.elementHandle())!;
  // These synthetic keyboard events exercise the browser event flags; they do not start an OS IME.
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await search.dispatchEvent("keydown", { key: "Escape", ...composition });
    await expect(search).toBeVisible();
    expect(await originalSearch.evaluate((element) => element.isConnected)).toBe(true);
    await expect(search).toHaveValue("no roster matches");
  }
  await captureScreenshot(page, testInfo, "sidebar-search-composing-escape");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-pressed", "false");

  await trigger.click();
  await expect(search).toHaveValue("");
  await search.fill("kept");
  await trigger.click();
  await expect(search).toHaveCount(0);

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await trigger.click();
  const runSearch = sidebar.getByRole("textbox", { name: "Search runs", exact: true });
  await runSearch.fill("kept activity search");
  const originalRunSearch = (await runSearch.elementHandle())!;
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await runSearch.dispatchEvent("keydown", { key: "Escape", ...composition });
    await expect(runSearch).toBeVisible();
    expect(await originalRunSearch.evaluate((element) => element.isConnected)).toBe(true);
    await expect(runSearch).toHaveValue("kept activity search");
  }
  // Escape clears the run search and closes it, as it does for the space search.
  await runSearch.press("Escape");
  await expect(runSearch).toHaveCount(0);
});

test("a failed space search says so instead of No results", async ({ page }, testInfo) => {
  await signup(
    page,
    `sidebar-search-failed-${Date.now()}@rakazo.test`,
    "password12",
    "Search Fail",
  );
  await completeOnboarding(page);
  let failSearch = true;
  await page.route("**/rpc/search/query", (route) =>
    failSearch ? route.fulfill({ status: 502 }) : route.fallback(),
  );
  const sidebar = page.locator("aside").first();
  await sidebar.getByTestId("sidebar-search-trigger").click();
  const search = sidebar.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("quarterly notes");

  const failure = sidebar.getByRole("alert");
  await expect(failure).toHaveText("Could not reach the server");
  await expect(sidebar.getByText("No results", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sidebar-search-failed");

  failSearch = false;
  const retried = page.waitForRequest("**/rpc/search/query");
  await sidebar.getByRole("button", { name: "Try again", exact: true }).click();
  expect((await retried).postData()).toContain("quarterly notes");
  await expect(sidebar.getByText("No results", { exact: true })).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test("a bot found by search can be pinned from its result", async ({ page }, testInfo) => {
  await signup(page, `sidebar-search-pin-${Date.now()}@rakazo.test`, "password12", "Search Pin");
  await completeOnboarding(page);
  const sidebar = page.locator("aside").first();
  await sidebar.getByTestId("sidebar-search-trigger").click();
  const search = sidebar.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("Chief");

  const result = sidebar.getByRole("button", { name: /^Chief.*Bot/ }).first();
  await result.click({ button: "right" });
  const pin = page.getByRole("menuitem", { name: "Pin", exact: true });
  await expect(pin).toBeVisible();
  await captureScreenshot(page, testInfo, "sidebar-search-result-menu");
  await pin.click();

  await search.press("Escape");
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
});
