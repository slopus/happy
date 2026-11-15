import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("saves a website login from a username and password card without echoing either", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `login-card-${stamp}@rakazo.test`, "password12", "Login Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  await page.getByPlaceholder(/Message/).fill("show a login card");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("login.example.test", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "login-card-ask");
  await card.getByRole("button", { name: "Add", exact: true }).click();
  // The card's fields open in the vault's own form.
  const form = page.getByTestId("vault-editor");
  const usernameField = form.getByLabel("Username", { exact: true });
  // Exact: the password reveal button is labelled "Show password".
  const passwordField = form.getByLabel("Password", { exact: true });
  // The default card starts as logins always have: Username visible, Password hidden.
  await expect(usernameField).toHaveAttribute("type", "text");
  await expect(passwordField).toHaveAttribute("type", "password");
  const hiddenToggle = (label: string) =>
    form
      .getByTestId("login-field")
      .filter({ has: page.getByLabel(label, { exact: true }) })
      .getByRole("button", { name: "Hidden" });
  await expect(hiddenToggle("Username")).toHaveAttribute("aria-pressed", "false");
  await expect(hiddenToggle("Password")).toHaveAttribute("aria-pressed", "true");
  const save = form.getByRole("button", { name: "Save", exact: true });

  const username = `fake-user-${stamp}@example.test`;
  const password = `fake-password-${stamp}`;
  await passwordField.fill(password);
  await expect(save).toBeDisabled();
  await usernameField.fill(username);
  await expect(save).toBeEnabled();
  await captureScreenshot(page, testInfo, "login-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(usernameField).toBeVisible();
  await expect(passwordField).toBeVisible();
  await captureScreenshot(page, testInfo, "login-card-narrow");
  await page.setViewportSize({ width: 1280, height: 720 });

  // Saving clears both fields immediately, including when the save fails.
  await page.route("**/rpc/threads/answer", (route) =>
    route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: "fail" } },
    }),
  );
  await save.click();
  await expect(form.getByText("Could not submit this answer", { exact: true })).toBeVisible();
  await expect(passwordField).toHaveValue("");
  await expect(usernameField).toHaveValue("");
  await page.unroute("**/rpc/threads/answer");

  await usernameField.fill(username);
  await passwordField.fill(password);
  await save.click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(form).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
  const history = JSON.stringify(await rpc(page, "threads/messages", { botId }));
  expect(history).not.toContain(username);
  expect(history).not.toContain(password);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText(username)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "login-card-saved");
});
