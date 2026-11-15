import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, signup } from "./helpers";

test("a nearly full computer offers to clean up its disk", async ({ page }, testInfo) => {
  await signup(page, `disk-warning-${Date.now()}@rakazo.test`, "password12", "Disk Warning");
  await completeOnboarding(page);
  let full = true;
  // The fixture computer reports no disk use, so the reads it answers say it is 93% full.
  const withFullDisk = async (
    route: Route,
    computerOf: (json: Record<string, unknown>) => unknown,
  ) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as { json?: Record<string, unknown> };
      const computer = body.json && (computerOf(body.json) as Record<string, unknown> | undefined);
      if (full && computer) computer.diskFullPercent = 93;
      await route.fulfill({ response, json: body });
    } catch (error) {
      // The reload below can cancel a read that was already in flight.
      if (!String(error).includes("Route is already handled")) throw error;
    }
  };
  await page.route("**/rpc/computer/status", (route) => withFullDisk(route, (json) => json));
  await page.route("**/rpc/threads/get", (route) => withFullDisk(route, (json) => json.computer));
  let sent: unknown;
  await page.route("**/rpc/threads/send", async (route) => {
    sent = route.request().postDataJSON().json;
    full = false;
    await route.continue();
  });
  await page.reload();
  await openBotPanelTab(page, "Computer");
  const warning = page.getByTestId("computer-disk-warning");
  await expect(warning).toContainText("Computer is 93% full");
  await captureScreenshot(page, testInfo, "computer-disk-warning");
  await warning.getByRole("button", { name: "Clean up", exact: true }).click();
  await expect(warning).toHaveCount(0);
  expect(sent).toMatchObject({ text: expect.stringContaining("disk is nearly full") });
  // A status read still in flight would otherwise fail once the page closes. Waiting is not an
  // option: with two reads intercepted at once, the first to settle makes the server drop the
  // interception, so the other's fulfill fails "Route is already handled"; the swallow above then
  // strands that handler and the wait would never return.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
