import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

const screenUrl = "https://screen.example/vnc.html";

async function routeScreen(page: Page) {
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    }),
  );
}

test("a retrying computer can be closed and keeps booting without a stale error label", async ({
  page,
}, testInfo) => {
  await signup(page, `boot-leave-${Date.now()}@rakazo.test`, "password12", "Boot Leave");
  await completeOnboarding(page);
  await routeScreen(page);
  let staleError = true;
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { computer?: { state?: string } } };
    if (staleError && body.json?.computer) body.json.computer.state = "error";
    await route.fulfill({ response, json: body });
  });
  const held: Route[] = [];
  await page.route("**/rpc/computer/boot", (route) => {
    held.push(route);
  });

  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText("Computer failed to boot");
  await expect(page.getByText("error", { exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview).toContainText("Booting live desktop…");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect.poll(() => held.length).toBe(1);

  const close = page.getByRole("button", { name: "Close computer" });
  await expect(close).toBeVisible();
  await expect(page.getByText("Booting live desktop…")).toBeVisible();
  await expect(page.getByText(/Booting up/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-booting-inline");

  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0);
  await expect(preview).toContainText("Booting live desktop…");
  await expect(page.getByText("error", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-panel-retrying-boot");

  // Reopening shows the same boot without starting another one.
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toHaveCount(0);
  expect(held).toHaveLength(1);

  staleError = false;
  const response = await held[0]!.fetch();
  await held[0]!.fulfill({ response });
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(close).toHaveCount(0);
});

test("opening a computer refreshes a stale booting snapshot", async ({ page }, testInfo) => {
  await signup(page, `boot-stale-${Date.now()}@rakazo.test`, "password12", "Boot Stale");
  await completeOnboarding(page);
  await rpc(page, "computer/boot", { botId: activeBotId(page) });
  await routeScreen(page);
  let stale = true;
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { computer?: { state?: string } } };
    if (stale && body.json?.computer) body.json.computer.state = "booting";
    await route.fulfill({ response, json: body });
  });
  const boots: Route[] = [];
  await page.route("**/rpc/computer/boot", (route) => {
    boots.push(route);
  });
  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText("Booting live desktop…");
  stale = false;
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(
    page.getByTestId("computer-chrome").getByRole("button", { name: "Take control", exact: true }),
  ).toBeVisible();
  await expect(page.locator('iframe[title="Bot screen"]')).toHaveAttribute("src", screenUrl);
  expect(boots).toHaveLength(0);
  await captureScreenshot(page, testInfo, "computer-open-refreshed-boot");
  await page.unrouteAll({ behavior: "wait" });
});

test("opening a computer the server reports as booting does not start a second boot", async ({
  page,
}) => {
  await signup(page, `boot-server-${Date.now()}@rakazo.test`, "password12", "Boot Server");
  await completeOnboarding(page);
  // Another tab or the phone started this computer; the server reports it booting.
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { computer?: { state?: string } } };
    if (body.json?.computer) body.json.computer.state = "booting";
    await route.fulfill({ response, json: body });
  });
  const boots: Route[] = [];
  await page.route("**/rpc/computer/boot", (route) => {
    boots.push(route);
  });

  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  await expect(preview).toContainText("Booting live desktop…");
  const bootsBefore = boots.length;
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByText("Booting live desktop…").first()).toBeVisible();
  expect(boots).toHaveLength(bootsBefore);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
});

test("Retry screen clears a failed takeover on a running computer", async ({ page }) => {
  await signup(page, `boot-takeover-${Date.now()}@rakazo.test`, "password12", "Boot Takeover");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });
  await routeScreen(page);
  await page.route("**/rpc/computer/takeover", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Takeover failed",
        },
      }),
    }),
  );

  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  const screen = page.locator('iframe[title="Bot screen"]');
  await expect(screen).toHaveAttribute("src", screenUrl);
  await page
    .getByTestId("computer-chrome")
    .getByRole("button", { name: "Take control", exact: true })
    .click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Takeover failed");
  await expect(screen).toHaveCount(0);

  await alert.getByRole("button", { name: "Retry screen" }).click();
  await expect(screen).toHaveAttribute("src", screenUrl);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
