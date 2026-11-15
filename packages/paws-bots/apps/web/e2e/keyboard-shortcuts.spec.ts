import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("keyboard shortcuts list and focus the composer", async ({ page }, testInfo) => {
  await signup(page, `shortcuts-${Date.now()}@rakazo.test`, "password12", "Shortcut Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const composer = page.getByRole("combobox", { name: /^Message / });
  await expect(composer).toBeVisible();

  await page.keyboard.press("ControlOrMeta+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Command menu")).toBeVisible();
  // The browser keeps these chords, so only the desktop app lists them.
  await expect(dialog.getByText("New group chat")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "keyboard-shortcuts");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await composer.blur();
  await page.keyboard.press("ControlOrMeta+I");
  await expect(composer).toBeFocused();

  await page.keyboard.press("ControlOrMeta+K");
  await page.getByTestId("command-palette-action-keyboard-shortcuts").click();
  await expect(dialog).toBeVisible();
});
