import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("an ongoing call stays in reach on a page outside the shell", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `call-controls-${stamp}@rakazo.test`, "password12", "Call Controls");
  await completeOnboarding(page);
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-call-voice-key" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  // Until the voice status loads, the call button opens voice settings instead of calling.
  const callButton = page.getByTestId("call-button");
  await expect(callButton).toHaveAttribute("data-voice-ready", "");

  await callButton.click();
  const call = page.getByTestId("call-view");
  await expect(call).toBeVisible();

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/artifacts$/);
  await expect(page.getByRole("heading", { name: "Artifacts", exact: true })).toBeVisible();
  await expect(call).toBeVisible();
  await captureScreenshot(page, testInfo, "call-card-artifacts");

  await call.getByRole("button", { name: "Minimize call" }).click();
  const returnBar = page.getByTestId("call-return-bar");
  await expect(returnBar).toBeVisible();
  await expect(call).toBeHidden();
  await captureScreenshot(page, testInfo, "call-return-bar-artifacts");

  await returnBar.click();
  await expect(call).toBeVisible();
  await call.getByRole("button", { name: "Hang up" }).click();
  await expect(call).toBeHidden();
  await expect(returnBar).toBeHidden();
});

test("an active call keeps a chat read-aloud from starting", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `read-aloud-call-${stamp}@rakazo.test`, "password12", "Read Aloud Call");
  await completeOnboarding(page);

  // A scripted reply gives the read-aloud control a message to act on.
  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill(`read-aloud-call-${stamp}`);
  await composer.press("Enter");
  const replyText = `i handled: read-aloud-call-${stamp}`;
  await expect(page.getByTestId("message-bot-bubble").filter({ hasText: replyText })).toBeVisible({
    timeout: 20_000,
  });

  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-call-voice-key" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const callButton = page.getByTestId("call-button");
  await expect(callButton).toHaveAttribute("data-voice-ready", "");
  // After the reload only the durable reply is on screen, so the locator is unambiguous.
  const speak = page
    .getByTestId("message-bot-bubble")
    .filter({ hasText: replyText })
    .getByRole("button", { name: "Speak this reply" });
  await expect(speak).toBeEnabled();

  // The call owns the speaker: starting another read must stay unavailable for its length.
  await callButton.click();
  const call = page.getByTestId("call-view");
  await expect(call).toBeVisible();
  await expect(speak).toBeDisabled();

  await call.getByRole("button", { name: "Minimize call" }).click();
  const returnBar = page.getByTestId("call-return-bar");
  await expect(returnBar).toBeVisible();
  await expect(call).toBeHidden();
  await expect(speak).toBeDisabled();
  await captureScreenshot(page, testInfo, "read-aloud-paused-during-call");

  // Hanging up hands the speaker back to the chat.
  await returnBar.click();
  await expect(call).toBeVisible();
  await call.getByRole("button", { name: "Hang up" }).click();
  await expect(call).toBeHidden();
  await expect(speak).toBeEnabled();
});
