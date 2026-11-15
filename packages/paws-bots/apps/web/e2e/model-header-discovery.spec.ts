import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openModelConnection,
  openUserSettings,
  signup,
} from "./helpers";

const probePath = "**/rpc/models/probeOpenAiCompatible";

const edits = {
  add: (page: Page) => page.getByRole("button", { name: "Add header", exact: true }).click(),
  name: (page: Page) => page.getByLabel("Header name", { exact: true }).first().fill("x-updated"),
  value: (page: Page) =>
    page.getByLabel("Header value", { exact: true }).first().fill("updated-fixture"),
  remove: (page: Page) =>
    page.getByRole("button", { name: "Remove header", exact: true }).first().click(),
};

for (const surface of ["settings", "onboarding"] as const) {
  for (const [action, edit] of Object.entries(edits)) {
    test(`${surface} header ${action} clears discovered models and ignores an in-flight result`, async ({
      page,
    }, testInfo) => {
      if (surface === "onboarding") {
        await page.route("**/rpc/me", async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as { json: Record<string, unknown> };
          await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
        });
      }
      await signup(
        page,
        `header-${surface}-${action}-${Date.now()}@rakazo.test`,
        "password12",
        "Header discovery",
      );
      if (surface === "settings") {
        await completeOnboarding(page);
        await openUserSettings(page, "models");
        await openModelConnection(page, "OpenAI-compatible");
      } else {
        await page.getByRole("combobox", { name: "Provider", exact: true }).click();
        await page.getByRole("option", { name: "OpenAI-compatible", exact: true }).click();
      }
      await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
      await page.getByLabel("Model id", { exact: true }).fill("manual-model");
      await page.getByText("Advanced", { exact: true }).click();

      async function prepareHeader() {
        const remove = page.getByRole("button", { name: "Remove header", exact: true });
        while (await remove.count()) await remove.first().click();
        await page.getByRole("button", { name: "Add header", exact: true }).click();
        await page.getByLabel("Header name", { exact: true }).fill("x-fixture");
        await page.getByLabel("Header value", { exact: true }).fill("fixture-value");
      }
      await prepareHeader();
      await page.route(probePath, (route) =>
        route.fulfill({ json: { json: { models: ["old-header-model"] } } }),
      );
      await page.getByRole("button", { name: "Find models", exact: true }).click();
      const useFound = page.getByRole("button", { name: "Use a found model", exact: true });
      await expect(useFound).toBeVisible();
      await edit(page);
      await expect(useFound).toHaveCount(0);
      await expect(page.getByLabel("Model id", { exact: true })).toHaveValue("manual-model");

      await prepareHeader();
      await page.unroute(probePath);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(probePath, async (route) => {
        await held;
        await route.fulfill({ json: { json: { models: ["stale-header-model"] } } });
      });
      const response = page.waitForResponse(probePath);
      try {
        const request = page.waitForRequest(probePath);
        await page.getByRole("button", { name: "Find models", exact: true }).click();
        await request;
        await expect(page.getByRole("button", { name: "Finding…", exact: true })).toBeDisabled();
        await edit(page);
        await expect(page.getByRole("button", { name: "Find models", exact: true })).toBeEnabled();
      } finally {
        release();
      }
      await (await response).finished();
      // Let the RPC continuation and React's render run before checking stale state.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(useFound).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Models from server" })).toHaveCount(0);
      await expect(page.getByLabel("Model id", { exact: true })).toHaveValue("manual-model");
      await expect(page.getByRole("button", { name: "Find models", exact: true })).toBeEnabled();
      if (action === "remove")
        await captureScreenshot(page, testInfo, `${surface}-header-discovery-reset`);
    });
  }
}
