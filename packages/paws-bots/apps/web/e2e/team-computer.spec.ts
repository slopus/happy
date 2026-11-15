import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

test("opening and releasing the computer keep a view-only stream; a failed release can be retried", async ({
  page,
}, testInfo) => {
  await signup(page, `view-only-${Date.now()}@rakazo.test`, "password12", "Computer");
  await completeOnboarding(page);
  let takeovers = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/computer/takeover")) takeovers += 1;
  });
  await openComputerPanel(page);
  await captureScreenshot(page, testInfo, "computer-tab-asleep");
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  const screen = page.getByTitle("Bot screen").last();
  const take = chrome.getByRole("button", { name: "Take control", exact: true });
  const release = chrome.getByRole("button", { name: "Hand back control", exact: true });
  // The overlay covers the conversation header, which drags the desktop window.
  await expect(chrome).toHaveCSS("-webkit-app-region", "no-drag");
  const checkViewOnly = async () => {
    await expect(take).toBeVisible();
    await expect(release).toHaveCount(0);
    await expect(screen).toHaveAttribute("src", /view_only=true/);
    await expect(screen).toHaveCSS("pointer-events", "none");
  };
  await checkViewOnly();
  expect(takeovers).toBe(0);
  await captureScreenshot(page, testInfo, "computer-open-view-only");
  await take.click();
  await expect(release).toBeVisible();
  await expect(take).toHaveCount(0);
  await expect(screen).toHaveAttribute("src", /view_only=false/);
  await expect(screen).toHaveCSS("pointer-events", "auto");
  expect(takeovers).toBe(1);
  await captureScreenshot(page, testInfo, "computer-controlling");
  await release.click();
  await checkViewOnly();
  expect(takeovers).toBe(1);
  await captureScreenshot(page, testInfo, "computer-released-view-only");
  await page.getByRole("button", { name: "Close computer" }).click();
  await expect(page.getByTitle("Bot screen preview")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-tab-running");
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await expect(take).toBeVisible();

  // A release that fails keeps the computer open so it can be retried.
  await take.click();
  await expect(release).toBeVisible();
  await page.route("**/rpc/computer/release", (route) =>
    route.fulfill({ status: 500, body: "release unavailable" }),
  );
  await release.click();
  await expect(page.getByText("Could not continue", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await captureScreenshot(page, testInfo, "48-team-computer-release-retry");
  await page.unroute("**/rpc/computer/release");
  await release.click();
  await expect(take).toBeVisible();
  await chrome.getByRole("button", { name: "Close computer" }).click();
  await expect(chrome).toBeHidden();
});

test("a person can take control while a Team bot works", async ({ page }, testInfo) => {
  const stamp = Date.now();

  await signup(
    page,
    `active-team-control-${stamp}@rakazo.test`,
    "password12",
    "Active Team Control",
  );
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await sendMessage(page, "keep working until I stop you");
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");
  await captureScreenshot(page, testInfo, "48-active-team-bot-working");
  await expect
    .poll(
      async () => (await rpc<{ state: string }>(page, "computer/status", { botId: chiefId })).state,
    )
    .toBe("running");
  await expect
    .poll(
      async () =>
        (
          await rpc<{ busyBotName: string | null }>(page, "computer/status", {
            botId: chiefId,
          })
        ).busyBotName,
    )
    .not.toBeNull();

  // A person can take control while the bot works; the bot's screen actions wait or are refused.
  await openBotPanelTab(page, "Computer");
  const sidePanel = page.getByTestId("side-panel");
  await page.getByTestId("computer-preview").hover();
  await sidePanel.getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  await chrome.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(
    chrome.getByRole("button", { name: "Hand back control", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "48b-take-control-while-busy");

  // Closing the computer hands control back.
  await page.getByRole("button", { name: "Close computer" }).click();
  await expect
    .poll(
      async () =>
        (
          await rpc<{ controlHolder: string }>(page, "computer/status", {
            botId: chiefId,
          })
        ).controlHolder,
    )
    .toBe("none");
});

async function openComputerPanel(page: Page) {
  await openBotPanelTab(page, "Computer");
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await expect(page.getByTestId("computer-preview-open")).toHaveCount(1);
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(text);
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/send") && response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  const response = await sent;
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as { json?: { runId?: string } };
  if (!result.json?.runId) throw new Error("threads/send did not return a run id");
  return result.json.runId;
}

function threadSnapshot(page: Page, botId: string) {
  return rpc<{
    run: { id: string; status: string } | null;
    messages: Array<{ runId?: string | null }>;
  }>(page, "threads/get", { botId });
}
