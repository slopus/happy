import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, signup } from "./helpers";

async function patchJson(route: Route, patch: (body: { json?: Record<string, unknown> }) => void) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  patch(body);
  await route.fulfill({ response, json: body });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stopComputer(computer: unknown) {
  const record = asRecord(computer);
  if (!record) return;
  record.state = "stopped";
  record.screenAvailable = false;
}

test("unavailable computers say so plainly and link setup help", async ({ page }, testInfo) => {
  await signup(page, `computers-off-${Date.now()}@rakazo.test`, "password12", "Computers Off");
  await completeOnboarding(page);
  let sandboxProvider = "none";
  let meFails = false;
  await page.route("**/rpc/me", (route) => {
    if (meFails) return route.fulfill({ status: 500, json: {} });
    return patchJson(route, (body) => {
      if (!body.json) return;
      body.json.sandboxProvider = sandboxProvider;
      body.json.computerSettingsEnabled = true;
    });
  });
  await page.route("**/rpc/bootstrap", (route) =>
    patchJson(route, (body) => {
      const me = asRecord(body.json?.me);
      if (me) {
        me.sandboxProvider = sandboxProvider;
        me.computerSettingsEnabled = true;
      }
      const thread = asRecord(body.json?.thread);
      stopComputer(thread?.computer);
    }),
  );
  for (const procedure of ["computer/status", "computer/boot"]) {
    await page.route(`**/rpc/${procedure}`, (route) =>
      patchJson(route, (body) => stopComputer(body.json)),
    );
  }
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({ json: { json: { url: null } } }),
  );
  await page.route("**/rpc/threads/get", (route) =>
    patchJson(route, (body) => stopComputer(body.json?.computer)),
  );
  await page.reload();

  await openBotPanelTab(page, "Computer");
  const preview = page.getByTestId("computer-preview");
  const hint = preview.getByTestId("computers-unavailable-hint");
  await expect(hint.getByText("Computers are off on this server.", { exact: true })).toBeVisible();
  await expect(hint).not.toContainText("SANDBOX_");
  await expect(hint).not.toContainText(".env");
  await expect(hint.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Open computer settings" })).toBeVisible();
  await expect(hint.getByRole("link", { name: "Setup help" })).toHaveAttribute(
    "href",
    "https://github.com/elie222/rakazo/blob/main/docs/self-host-sandbox-providers.md",
  );
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computers-unavailable-preview");

  await hint.getByRole("button", { name: "Check again" }).click();
  await expect(hint.getByText("Computers are off on this server.", { exact: true })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Check again" })).toBeEnabled();

  await hint.getByRole("button", { name: "Open computer settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "computer");
  await expect(settings.getByTestId("settings-nav-computer")).toHaveAttribute(
    "aria-current",
    "page",
  );
  const settingsHint = settings.getByTestId("computers-unavailable-hint");
  await expect(
    settingsHint.getByText("Computers are off on this server.", { exact: true }),
  ).toBeVisible();
  await expect(settingsHint.getByRole("link", { name: "Setup help" })).toBeVisible();
  await captureScreenshot(page, testInfo, "computers-unavailable-settings");

  meFails = true;
  await settingsHint.getByRole("button", { name: "Check again" }).click();
  const failure = settings.getByRole("alert");
  await expect(failure).toHaveAttribute("data-testid", "computers-unavailable-hint");
  await expect(
    failure.getByText(
      /^Could not verify computer setup \(.+\)\. Fix the connection, then check again\.$/,
    ),
  ).toBeVisible();
  await expect(failure.getByRole("link", { name: "Setup help" })).toBeVisible();
  meFails = false;

  sandboxProvider = "docker";
  await settingsHint.getByRole("button", { name: "Check again" }).click();
  const recovered = settingsHint.getByText(
    "Computers are available. Reload or open a bot to continue.",
  );
  await expect(recovered).toBeVisible();
  await expect(recovered).toBeHidden({ timeout: 10_000 });
  await expect(settingsHint).toHaveCount(0);
});
