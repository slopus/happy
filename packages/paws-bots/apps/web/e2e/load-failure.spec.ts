import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a failed integrations load offers Retry instead of an empty catalog", async ({
  page,
}, testInfo) => {
  await signup(page, `catalog-load-${Date.now()}@rakazo.test`, "password12", "Catalog Load");
  await completeOnboarding(page);

  // A 502 is what the proxy answers while the API restarts.
  let failCatalog = true;
  await page.route("**/rpc/connections/catalog", async (route) => {
    if (failCatalog) {
      await route.fulfill({ status: 502 });
      return;
    }
    await route.fulfill({
      json: {
        json: [
          {
            connectorId: "demo",
            slug: "slack",
            name: "Slack",
            logo: null,
            connected: false,
            noAuth: false,
          },
        ],
      },
    });
  });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();

  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText("Could not reach the server", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Configure a plugin catalog on the server to connect apps.", { exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-load-failed");

  failCatalog = false;
  await retry.click();
  // Add appears only on a tile backed by a loaded catalog entry.
  const slack = page
    .getByTestId("featured-connectors")
    .getByText("Slack", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await expect(slack.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByText("Could not reach the server", { exact: true })).toHaveCount(0);
  await expect(retry).toHaveCount(0);
});

for (const result of ["empty", "plugin", "unavailable"] as const) {
  test(`integrations waits for plugins before showing an empty catalog (${result})`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `catalog-pending-${result}-${Date.now()}@rakazo.test`,
      "password12",
      "Catalog Load",
    );
    await completeOnboarding(page);
    await page.route("**/rpc/connections/catalog", (route) =>
      route.fulfill({ json: { json: [] } }),
    );
    let finishLoading!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    await page.route("**/rpc/marketplace/catalog", async (route) => {
      await pending;
      await route.fulfill({
        json: {
          json: {
            entries:
              result === "plugin"
                ? [
                    {
                      id: "demo",
                      name: "demo",
                      displayName: "Demo app",
                      description: "Demo integration",
                      keywords: [],
                      category: "productivity",
                      logo: null,
                      homepage: null,
                      domains: [],
                      registry: "demo",
                      source: "demo",
                      installedSource: "demo",
                      hasConnector: true,
                      skillCount: 0,
                    },
                  ]
                : [],
            unavailableRegistries: result === "unavailable" ? ["demo"] : [],
            skippedEntries: 0,
          },
        },
      });
    });
    await page.getByRole("button", { name: "Connect apps", exact: true }).click();
    const loading = page.getByLabel("Loading plugins…", { exact: true });
    const configure = page.getByText("Configure a plugin catalog on the server to connect apps.", {
      exact: true,
    });
    try {
      await expect(loading).toBeVisible();
      await expect(configure).toHaveCount(0);
      await page.getByPlaceholder("Search apps", { exact: true }).fill("missing");
      await expect(page.getByText("No apps match your search.", { exact: true })).toHaveCount(0);
      await page.getByPlaceholder("Search apps", { exact: true }).clear();
      if (result === "empty")
        await captureScreenshot(page, testInfo, "integrations-plugins-loading");
    } finally {
      finishLoading();
    }
    await expect(loading).toHaveCount(0);
    if (result === "empty") {
      await expect(configure).toBeVisible();
      await captureScreenshot(page, testInfo, "integrations-catalog-empty");
    } else {
      await expect(configure).toHaveCount(0);
      if (result === "plugin") {
        await expect(page.getByText("Demo app", { exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("alert")).toContainText("Some plugins could not be loaded.");
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      }
    }
  });
}
