import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  expectCardWidth,
  openBotPanelTab,
  signup,
} from "./helpers";

test("teach a task records interaction and saves a draft", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `teach-${stamp}@rakazo.test`, "password12", "Teach");
  await completeOnboarding(page);

  await openBotPanelTab(page, "Computer");
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(sidePanel.getByText("Teach a task")).toHaveCount(0);
  await expect(sidePanel.getByTestId("teach-start-button")).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await expect(sidePanel.getByTestId("computer-preview")).toBeVisible();
  await captureScreenshot(page, testInfo, "teach-sidepanel-simple");

  const openButton = sidePanel.getByTestId("computer-preview-open");
  await expect(openButton).toHaveText("Wake");

  await openButton.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  const chrome = page.getByTestId("computer-chrome");
  await chrome.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(
    chrome.getByRole("button", { name: "Hand back control", exact: true }),
  ).toBeVisible();
  await expect(chrome.getByTestId("teach-start-button")).toBeVisible();
  await captureScreenshot(page, testInfo, "teach-computer-chrome");

  const teachStart = chrome.getByTestId("teach-start-button");
  await expect(teachStart).toBeEnabled();
  await teachStart.click();
  await page.getByTestId("teach-goal-input").fill("Export weekly CRM list");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByTestId("teach-recording-overlay")).toBeVisible();
  await expect(page.getByTestId("teach-capture-overlay")).toBeVisible();
  await expect(page.getByTestId("teach-protected-input")).toBeVisible();
  await expect(
    page.getByTestId("teach-capture-overlay").getByTestId("teach-protected-input"),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "teach-protected-input");
  await page.getByTestId("teach-capture-overlay").click({ position: { x: 200, y: 200 } });
  await page.keyboard.type("demo");
  await page.getByTestId("teach-stop-overlay").click();
  const draftCard = page.getByTestId("skill-draft-card");
  await expect(draftCard).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "teach-skill-draft-card");
  await expectCardWidth(draftCard, 520);
  await page.getByTestId("skill-draft-card").getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByTestId("skill-draft-card").getByRole("button", { name: "Saved" }),
  ).toBeVisible({ timeout: 10_000 });

  // Each card labels its own fields.
  const nameId = await draftCard.getByRole("textbox", { name: "Name" }).getAttribute("id");
  expect(nameId).not.toBe("skill-draft-name");
  await expect(draftCard.getByText("Name", { exact: true })).toHaveAttribute("for", nameId ?? "");

  // Any edit after saving is unsaved until saved again.
  const save = draftCard.getByRole("button", { name: "Save", exact: true });
  const saved = draftCard.getByRole("button", { name: "Saved", exact: true });
  await draftCard.getByLabel("Steps").fill("Open the CRM\nExport the weekly list");
  await expect(save).toBeVisible();
  await save.click();
  await expect(saved).toBeVisible();
  await draftCard.getByLabel("Name").fill("Weekly CRM export");
  await expect(save).toBeVisible();

  // Failed writes say so, and a successful retry clears the error.
  await page.route("**/rpc/skills/updateDraft", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "INTERNAL_SERVER_ERROR",
        },
      }),
    }),
  );
  await save.click();
  await expect(draftCard.getByText("Could not save skill")).toBeVisible();
  await captureScreenshot(page, testInfo, "teach-skill-draft-save-failed");
  await draftCard.getByRole("button", { name: "Test", exact: true }).click();
  await expect(draftCard.getByText("Something went wrong. Try again.")).toBeVisible();
  await page.unroute("**/rpc/skills/updateDraft");
  // Testing a saved skill writes the edit too, so the card reads Saved again.
  await draftCard.getByRole("button", { name: "Test", exact: true }).click();
  await expect(saved).toBeVisible();
  await expect(draftCard.getByText("Something went wrong. Try again.")).toHaveCount(0);
});
