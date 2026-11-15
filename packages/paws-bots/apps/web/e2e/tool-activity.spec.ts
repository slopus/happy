import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/tool-activity.html";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const NOTE_TEXT = "Anna is free all Tuesday afternoon.";
const STORAGE_KEY = "rakazo.showToolActivity";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

async function openThread(page: Page, phase: "live" | "done") {
  await page.goto(`${fixture}?view=thread&phase=${phase}`);
  await expect(page.getByTestId("message-user-bubble")).toBeVisible();
}

/** Cards stay hidden until this browser saved "on". Seed only when a test needs them visible. */
async function seedToolActivityOn(page: Page) {
  await page.addInitScript((key) => {
    if (localStorage.getItem(key) == null) localStorage.setItem(key, "on");
  }, STORAGE_KEY);
}

async function setToggle(page: Page, on: boolean) {
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const toggle = settings.getByTestId("tool-activity-toggle");
  await expect(toggle).toBeVisible();
  if (on) await expect(toggle).not.toBeChecked();
  else await expect(toggle).toBeChecked();
  await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBe(on ? "on" : "off");
  await toggle.scrollIntoViewIfNeeded();
}

test("tool activity shows for live and finished runs when the user turned it on", async ({
  page,
}, testInfo) => {
  await seedToolActivityOn(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);

    await openThread(page, "live");
    const liveLine = page.getByTestId("tool-activity-line");
    await expect(liveLine).toHaveCount(1);
    await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
    const liveCard = page.getByTestId("tool-activity");
    await expect(liveCard.locator("button[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(liveCard.locator("button[aria-expanded]")).toContainText(/Working…\s*8 tools/);
    await expect(page.getByTestId("tool-rows-hidden")).toHaveText("+2 earlier steps");
    await expect(page.getByTestId("tool-rows")).not.toContainText("Open calendar");
    await expect(page.getByTestId("tool-rows")).toContainText("Check conflicts");
    await expect(page.getByTestId("tool-step-note")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-live-${viewport.name}`);

    await liveCard.locator("button[aria-expanded]").click();
    await expect(liveCard.locator("button[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await openThread(page, "done");
    await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
    const doneCard = page.getByTestId("tool-activity");
    await expect(doneCard).toHaveCount(1);
    await expect(doneCard.locator("button[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(doneCard.locator("button[aria-expanded]")).toContainText(/Done\s*8 tools\s*12s/);
    await captureScreenshot(page, testInfo, `default-done-collapsed-${viewport.name}`);

    await doneCard.locator("button[aria-expanded]").click();
    await expect(doneCard.locator("button[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("tool-rows-hidden")).toHaveCount(0);
    await expect(page.getByTestId("tool-rows")).toContainText("Open calendar");
    await expect(page.getByTestId("tool-rows")).toContainText("Check conflicts");
    await expect(page.getByTestId("tool-step-note")).toHaveText(NOTE_TEXT);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-done-expanded-${viewport.name}`);
  }
});

test("the settings toggle hides and restores tool activity", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // Nothing saved leaves the switch off and the cards hidden.
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const initialToggle = settings.getByTestId("tool-activity-toggle");
  await expect(initialToggle).toBeVisible();
  await expect(initialToggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBeNull();
  await initialToggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-tool-activity-off");

  await openThread(page, "done");
  await expect(page.getByTestId("message-bot-bubble")).toHaveText(REPLY_TEXT);
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByText(/Done\s*8 tools/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-done");

  await openThread(page, "live");
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByTestId("tool-activity-line")).toHaveCount(0);
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-live");

  await setToggle(page, true);
  await captureScreenshot(page, testInfo, "settings-tool-activity-on");

  await openThread(page, "done");
  await expect(page.getByTestId("tool-activity")).toHaveCount(1);
  await expect(page.getByTestId("tool-activity").locator("button[aria-expanded]")).toContainText(
    /Done\s*8 tools/,
  );
  await captureScreenshot(page, testInfo, "on-again-done");
});
