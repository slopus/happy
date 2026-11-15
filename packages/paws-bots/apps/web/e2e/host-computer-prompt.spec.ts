import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

// win32 shares the non-darwin "this computer" branch with linux.
for (const platform of ["darwin", "linux"]) {
  test(`host computer choice explains file access on ${platform}`, async ({ page }, testInfo) => {
    await signup(
      page,
      `host-choice-${platform}-${Date.now()}@rakazo.test`,
      "password12",
      "Host Tester",
    );
    await completeOnboarding(page);
    await page.addInitScript((platform) => {
      Object.defineProperty(window, "rakazoDesktop", {
        value: {
          platform,
          computer: {
            managesHostChoice: true,
            requestAccess: async () => false,
            revokeAccess: async () => {},
            onConfigure: (listener: () => void) => {
              window.addEventListener("test-computer-configure", listener);
              return () => window.removeEventListener("test-computer-configure", listener);
            },
          },
          window: {
            close: async () => {},
            minimize: async () => {},
            toggleMaximize: async () => {},
            state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
          },
          oauth: { onCallback: () => () => {} },
          update: {
            state: async () => ({ phase: "idle", currentVersion: "0.1.0" }),
          },
        },
      });
    }, platform);
    let chosen: "this-mac" | null = null;
    await page.route(/\/rpc\/(me|bootstrap)$/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const me = route.request().url().endsWith("/me") ? body.json : body.json.me;
      me.canChooseHostComputer = true;
      me.computerHost = chosen;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "Where should bots run?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      /Local access lets bots run commands without asking\. Avoid it on shared or public servers\./,
    );
    const configuredProfile = page.waitForResponse(/\/rpc\/me$/);
    await page.evaluate(() => window.dispatchEvent(new Event("test-computer-configure")));
    await (await configuredProfile).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const host = platform === "darwin" ? "this Mac" : "this computer";
    await expect(
      dialog.getByText(
        `Docker limits access to your computer for added security. Using ${host} lets bots work with your local files and tools.`,
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Local access lets bots run commands without asking. Avoid it on shared or public servers.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Docker", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Use ${host}` })).toBeVisible();
    await captureScreenshot(page, testInfo, `host-computer-choice-${platform}`);
    let updates = 0;
    await page.route("**/__test/native-host", async (route) => {
      updates++;
      chosen = "this-mac";
      await route.fulfill({ json: { json: {} } });
    });
    await dialog.getByRole("button", { name: `Use ${host}` }).click();
    await expect(dialog).toBeVisible();
    expect(updates).toBe(0);
    await page.evaluate(() => {
      window.rakazoDesktop!.computer!.requestAccess = async () => {
        await fetch("/__test/native-host", { method: "POST" });
        return true;
      };
    });
    await dialog.getByRole("button", { name: `Use ${host}` }).click();
    await expect(dialog).toBeHidden();
    expect(updates).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("test-computer-configure")));
    await expect(dialog).toBeVisible();
    await captureScreenshot(page, testInfo, `host-computer-configure-${platform}`);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    // Settings keeps the choice reachable after the one-time prompt.
    const settings = await openUserSettings(page);
    const toggle = settings.getByTestId("this-computer-toggle");
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeChecked();
    await captureScreenshot(page, testInfo, `host-computer-settings-${platform}`);
  });
}

test("a saved host choice closes when refreshing the profile fails", async ({ page }) => {
  await signup(page, `host-choice-refresh-${Date.now()}@rakazo.test`, "password12", "Host Tester");
  await completeOnboarding(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        computer: {
          managesHostChoice: true,
          requestAccess: async () => false,
          revokeAccess: async () => {
            await fetch("/__test/native-host", { method: "POST" });
          },
          onConfigure: () => () => {},
        },
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => ({ phase: "idle", currentVersion: "0.1.0" }),
        },
      },
    });
  });
  let failMe = false;
  await page.route("**/__test/native-host", async (route) => {
    failMe = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/rpc\/(me|bootstrap)$/, async (route) => {
    const url = route.request().url();
    if (url.endsWith("/me") && failMe) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            defined: false,
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "profile unavailable",
          },
        }),
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const me = url.endsWith("/me") ? body.json : body.json.me;
    me.canChooseHostComputer = true;
    me.computerHost = null;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const dialog = page.getByRole("dialog", { name: "Where should bots run?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Docker", exact: true }).click();
  await expect(dialog).toBeHidden();
});
