import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("user bubbles stay close to the avatar color with white text in both themes", async ({
  page,
}, testInfo) => {
  await signup(page, `bubble-colors-${Date.now()}@rakazo.test`, "password12", "Bubble Demo");
  await completeOnboarding(page);
  await rpc(page, "bots/update", { botId: activeBotId(page), color: "#FF781C" });
  await page.reload();

  const message = "Let's plan the week ahead.";
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const bubble = page.getByTestId("message-user-bubble").filter({ hasText: message });
  await expect(bubble).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => localStorage.setItem("rakazo.uiAppearance", theme), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(bubble).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(bubble).toHaveCSS("background-color", "rgb(241, 107, 0)");
    // The send button stays quiet on an empty draft...
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await expect(send).not.toHaveCSS("background-color", "rgb(241, 107, 0)");
    await captureScreenshot(page, testInfo, `chat-bubble-avatar-color-${theme}`);
    // ...and wears the bubble's color once there is something to send.
    await composer.fill("And the week after.");
    await expect(send).toHaveCSS("background-color", "rgb(241, 107, 0)");
    await expect(send).toHaveCSS("color", "rgb(255, 255, 255)");
    await captureScreenshot(page, testInfo, `chat-send-button-bot-color-${theme}`);
    await composer.fill("");
  }
});
