import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("titled sidebar section expands and collapses", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `sidebar-collapse-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Projects");
  await dialog.getByRole("button", { name: "Create" }).click();

  const projects = sidebar.locator('[data-sidebar-group^="section:"]');
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");

  const toggle = projects.getByRole("button", { name: /Collapse Projects|Expand Projects/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "sidebar-section-expanded");

  // Hover header with Chief selected underneath — outer edges must match.
  await bot.click();
  await toggle.hover();
  const headerBox = await toggle.boundingBox();
  const botBox = await bot.boundingBox();
  expect(headerBox).toBeTruthy();
  expect(botBox).toBeTruthy();
  expect(headerBox!.x).toBeCloseTo(botBox!.x, 0);
  expect(headerBox!.x + headerBox!.width).toBeCloseTo(botBox!.x + botBox!.width, 0);
  await captureScreenshot(page, testInfo, "sidebar-section-hover");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(projects.getByRole("button", { name: /^Chief/ })).toHaveCount(0);
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "sidebar-section-collapsed");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(projects.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
});
