import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("A change asks without an approval model, and approvals settings shape what asks", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `action-approvals-${stamp}@rakazo.test`, "password12", "Approval UI");
  await completeOnboarding(page, testInfo);

  await requestDestinationWrite(page, "write this to the destination crm as a note");
  const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
  const alwaysAllow = page.getByRole("button", { name: "Always allow this tool", exact: true });
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(alwaysAllow).toBeVisible();
  await expect(deny).toBeVisible();
  const allowBox = await allowOnce.boundingBox();
  const alwaysBox = await alwaysAllow.boundingBox();
  const denyBox = await deny.boundingBox();
  expect(allowBox).toBeTruthy();
  expect(alwaysBox).toBeTruthy();
  expect(denyBox).toBeTruthy();
  expect(alwaysBox!.y).toBe(allowBox!.y);
  expect(denyBox!.y).toBe(allowBox!.y);
  expect(alwaysBox!.x).toBeGreaterThan(allowBox!.x);
  expect(denyBox!.x).toBeGreaterThan(alwaysBox!.x);
  await captureScreenshot(page, testInfo, "53-action-confirmation-pending");
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(allowOnce).toBeVisible();
  await expect(alwaysAllow).toBeVisible();
  await expect(deny).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  if (viewport) await page.setViewportSize(viewport);

  await deny.click();
  await expect(page.getByTestId("transcript").getByText("Denied", { exact: true })).toHaveClass(
    /text-muted-foreground/,
  );
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "54-action-confirmation-denied");

  await requestDestinationWrite(page, "write this to the destination crm once more");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByText("Allowed once", { exact: true })).toBeVisible();
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "55-action-confirmation-allowed-once");

  await requestDestinationWrite(page, "write this to the destination crm one more time");
  await page.getByRole("button", { name: "Always allow this tool", exact: true }).click();
  await expect(page.getByText("Always allowed", { exact: true })).toBeVisible();
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await captureScreenshot(page, testInfo, "56-action-confirmation-always-allowed");

  await sendDestinationWrite(page, "write this to the destination crm after always allow");
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);

  const settings = await openUserSettings(page);
  await expect(settings).toHaveAttribute("role", "dialog");
  await expect(settings).toBeFocused();
  await settings.getByTestId("settings-nav-confirmations").click();
  await expect(settings.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible();
  const mode = settings.getByTestId("approval-mode");
  await expect(mode.getByRole("button", { name: "Auto", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const allowed = settings.getByTestId("approval-rules-always_allow");
  await expect(allowed.getByText("Destination.write", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "52-approvals-settings");
  await settings
    .getByRole("group", { name: "Destination.write", exact: true })
    .getByRole("button", { name: "Block", exact: true })
    .click();
  await expect(
    settings.getByTestId("approval-rules-deny").getByText("Destination.write", { exact: true }),
  ).toBeVisible();
  await mode.getByRole("button", { name: "Never ask", exact: true }).click();
  await expect(mode.getByRole("button", { name: "Never ask", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "52b-approvals-never-ask-with-block");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  // A blocked tool is refused without a card, even in Never ask.
  await sendDestinationWrite(page, "write this to the destination crm while it is blocked");
  await waitForRunIdle(page);
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
});

test("A webhook run follows Always allow without asking", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `webhook-approval-${stamp}@rakazo.test`, "password12", "Webhook Approval");
  await completeOnboarding(page);

  await requestDestinationWrite(page, "write this to the destination crm as a note");
  await page.getByRole("button", { name: "Always allow this tool", exact: true }).click();
  await expect(page.getByText("Always allowed", { exact: true })).toBeVisible();
  await waitForRunIdle(page);

  const botId = activeBotId(page);
  // A delivery with no active webhook routine is ignored.
  await rpc(page, "routines/create", {
    botId,
    name: "Relay",
    prompt: "Handle the relay's request.",
    webhookEnabled: true,
    active: true,
    notify: false,
  });
  const hook = await rpc<{ secret: string; path: string }>(page, "bots/rotateWebhookSecret", {
    botId,
  });
  const delivered = await page.request.post(hook.path, {
    headers: { authorization: `Bearer ${hook.secret}` },
    data: { text: "write this to the destination crm from the relay" },
  });
  expect(delivered.ok()).toBe(true);
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status ?? null,
      { timeout: 30_000 },
    )
    .toBeNull();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectComposerReady(page);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
});

async function sendDestinationWrite(page: Page, prompt: string) {
  await expectComposerReady(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(prompt);
  const sent = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await page.keyboard.press("Enter");
  await sent;
}

async function expectComposerReady(page: Page) {
  const composer = page.getByPlaceholder(/Message/);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

async function requestDestinationWrite(page: Page, prompt: string) {
  await sendDestinationWrite(page, prompt);
  const botId = activeBotId(page);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe("waiting_input");
  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  if ((await page.getByRole("button", { name: "Allow once" }).count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({
    timeout: 15_000,
  });
}

async function waitForRunIdle(page: Page) {
  const botId = activeBotId(page);
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 30_000 },
    )
    .toBeNull();
}
