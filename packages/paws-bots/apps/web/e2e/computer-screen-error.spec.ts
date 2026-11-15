import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

test(
  "screen connection failures stay visible and can be retried",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    await signup(page, `screen-error-${Date.now()}@rakazo.test`, "password12", "Screen Error");
    await completeOnboarding(page);
    const botId = activeBotId(page);
    await rpc(page, "computer/boot", { botId });
    await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject(
      {
        state: "running",
      },
    );

    let failScreen = true;
    const screenUrl = "https://screen.example/vnc.html";
    await page.route("https://screen.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
      }),
    );
    await page.route("**/rpc/computer/screenUrl", (route) =>
      route.fulfill({
        status: failScreen ? 409 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          failScreen
            ? {
                json: {
                  defined: false,
                  code: "CONFLICT",
                  status: 409,
                  message:
                    "The computer screen is temporarily busy. Retry in a moment. File and shell tools still work.",
                },
              }
            : { json: { url: screenUrl } },
        ),
      }),
    );

    await openBotPanelTab(page, "Computer");
    const preview = page.getByTestId("computer-preview");
    await expect(preview.getByRole("alert")).toContainText("temporarily busy");
    await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "computer-screen-connection-error");

    await expect(preview.getByRole("alert")).toContainText("Screen not connected");
    await preview.getByRole("button", { name: "Recover computer", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Recover computer?");
    await captureScreenshot(page, testInfo, "computer-screen-recover-confirm");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    failScreen = false;
    await preview.getByRole("button", { name: "Retry screen" }).click();
    await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
    await expect(preview.getByRole("alert")).toHaveCount(0);

    await captureScreenshot(page, testInfo, "computer-screen-healthy");
    failScreen = true;
    await preview.hover();
    await preview.getByTestId("computer-preview-open").click();
    await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("temporarily busy");
    await captureScreenshot(page, testInfo, "computer-full-screen-connection-error");

    await page
      .getByRole("alert")
      .getByRole("button", { name: "Recover computer", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText("Recover computer?");
    await captureScreenshot(page, testInfo, "computer-full-screen-recover-confirm");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    failScreen = false;
    await page.getByRole("button", { name: "Retry screen" }).click();
    await expect(page.locator('iframe[title="Bot screen"]')).toHaveAttribute("src", screenUrl);
    await expect(page.getByRole("alert")).toHaveCount(0);
  },
);

test(
  "a running computer without a screen URL offers recovery",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    await signup(page, `screen-missing-${Date.now()}@rakazo.test`, "password12", "Screen Missing");
    await completeOnboarding(page);
    const botId = activeBotId(page);
    await rpc(page, "computer/boot", { botId });
    let screenReads = 0;
    await page.route("**/rpc/computer/screenUrl", (route) => {
      screenReads += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: { url: null } }),
      });
    });
    await openBotPanelTab(page, "Computer");
    const preview = page.getByTestId("computer-preview");
    await expect(preview.getByRole("alert")).toContainText("Screen not connected");
    await expect(preview.getByRole("button", { name: "Retry screen" })).toBeVisible();
    await expect(
      preview.getByRole("button", { name: "Recover computer", exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "computer-screen-url-missing");

    await preview.getByRole("button", { name: "Recover computer", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Recover computer?");
    // A control change re-reads the screen in the background; the open confirmation stays.
    const readsBefore = screenReads;
    await rpc(page, "computer/takeover", { botId });
    await expect.poll(() => screenReads).toBeGreaterThan(readsBefore);
    await page.waitForTimeout(500);
    await expect(confirmation).toContainText("Recover computer?");
  },
);

test("a healthy running computer is not diagnosed while its screen URL loads", async ({
  page,
}, testInfo) => {
  await signup(page, `screen-loading-${Date.now()}@rakazo.test`, "password12", "Screen Loading");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Desktop connected</title>",
    }),
  );
  let readStarted!: () => void;
  const reading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  await page.route("**/rpc/computer/screenUrl", async (route) => {
    readStarted();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    });
  });
  await openBotPanelTab(page, "Computer");
  await reading;
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Screen not connected", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-url-loading");
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Screen not connected", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-url-loaded");
});

test("a takeover failure does not diagnose a screen connection failure", async ({
  page,
}, testInfo) => {
  await signup(page, `screen-control-${Date.now()}@rakazo.test`, "password12", "Screen Control");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Desktop</title>" }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: "https://screen.example/vnc.html" } }),
    }),
  );
  await page.route("**/rpc/computer/takeover", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Could not take control",
        },
      }),
    }),
  );
  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toBeVisible();
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not take control");
  await expect(page.getByText("Screen not connected", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("alert").getByRole("button", { name: "Recover computer", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-takeover-error");
});

test("a framed screen that drops after connecting loads again by itself through every restart", async ({
  page,
}) => {
  await signup(page, `screen-drop-${Date.now()}@rakazo.test`, "password12", "Screen Drop");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  // The first load connects and then loses its socket, as when the proxy closes it. The app
  // also asks for the page with fetch: on opening, then while it waits to reconnect, when the
  // first two answers say the access check couldn't reach the API. From the fourth load on,
  // the screen server is gone: the page loads but its connection is refused every time.
  let loads = 0;
  let probes = 0;
  let dropAt = 0;
  let reloadedAt = 0;
  await page.route("**/novnc/session/view/1.drop-test/**", (route) => {
    const document = route.request().resourceType() === "document";
    if (!document) {
      probes += 1;
      if (probes === 2 || probes === 3) {
        return route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "Screen unavailable",
        });
      }
    }
    if (document) {
      loads += 1;
      if (loads === 2) reloadedAt = Date.now();
    }
    const drop = document && loads === 1;
    if (drop) dropAt = Date.now() + 300;
    const stuck = document && loads >= 4;
    return route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": "sandbox allow-scripts allow-pointer-lock" },
      body: `<!doctype html><title>Test desktop</title><script>
        parent.postMessage({ rakazoScreen: "loading" }, "*");
        parent.postMessage({ rakazoScreen: "${stuck ? "failed" : "connected"}" }, "*");
        ${drop ? 'setTimeout(() => parent.postMessage({ rakazoScreen: "disconnected" }, "*"), 300);' : ""}
      </script><p>Desktop</p>`,
    });
  });
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        json: { url: "/novnc/session/view/1.drop-test/vnc.html?autoconnect=true" },
      }),
    }),
  );

  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toHaveAttribute("src", /1\.drop-test\/vnc\.html/);
  await expect.poll(() => loads).toBe(2);
  expect(probes).toBeGreaterThanOrEqual(4);
  expect(reloadedAt - dropAt).toBeGreaterThanOrEqual(2_500);
  await page.waitForTimeout(1_000);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(preview.locator("iframe")).toHaveCount(1);

  // A screen that keeps coming back reconnects through every drop. The reconnected frame is
  // a new element, so find it again for each report.
  const postState = (state: string) =>
    page
      .frames()
      .find((candidate) => candidate.url().includes("1.drop-test"))
      ?.evaluate((rakazoScreen) => parent.postMessage({ rakazoScreen }, "*"), state);
  await postState("disconnected");
  await expect.poll(() => loads).toBe(3);
  await page.waitForTimeout(1_000);
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(preview.locator("iframe")).toHaveCount(1);

  // A screen whose connections only flash up, and whose reloads stop connecting, runs out of
  // quiet reconnects and shows the error and Retry.
  await postState("disconnected");
  await expect.poll(() => loads, { timeout: 15_000 }).toBe(4);
  await expect(preview.getByRole("alert")).toContainText(
    "Could not connect to the computer screen",
  );
  await expect(preview.getByRole("button", { name: "Retry screen" })).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(loads).toBe(4);
});
